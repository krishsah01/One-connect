// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Native-only boundary for hostile interactive documents. No dashboard CSP relaxation, daemon
// credentials, or application IPC is granted to preview webviews. Unsupported hosts fail closed.
use std::{collections::HashMap, sync::{atomic::{AtomicU64, Ordering}, Mutex}};
use tauri::Manager;

pub const SCHEME: &str = "mock-preview";
pub const CSP: &str = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'";
// Engine-level resource filtering applies before untrusted content is loaded, in every frame.
pub const NETWORK_RULES: &str = r#"[{"trigger":{"url-filter":".*"},"action":{"type":"block"}},{"trigger":{"url-filter":"^mock-preview://localhost/"},"action":{"type":"ignore-previous-rules"}},{"trigger":{"url-filter":"^data:"},"action":{"type":"ignore-previous-rules"}},{"trigger":{"url-filter":"^blob:"},"action":{"type":"ignore-previous-rules"}}]"#;

#[derive(Default)]
pub struct Previews { documents: Mutex<HashMap<String, String>>, next: AtomicU64 }
pub fn dashboard_caller(label: &str) -> bool { label == "main" }
fn initial_url(label: &str) -> String { format!("{SCHEME}://localhost/{label}/index.html") }

pub fn response(ctx: tauri::UriSchemeContext<'_, tauri::Wry>, req: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let state = ctx.app_handle().state::<Previews>();
    let body = state.documents.lock().ok().and_then(|docs| {
        if req.method() != "GET" || req.uri().to_string() != initial_url(ctx.webview_label()) { return None; }
        docs.get(ctx.webview_label()).cloned()
    });
    tauri::http::Response::builder().status(if body.is_some() { 200 } else { 403 })
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", CSP)
        .header("Cache-Control", "no-store")
        .header("X-DNS-Prefetch-Control", "off")
        .header("Referrer-Policy", "no-referrer")
        .body(body.unwrap_or_default().into_bytes()).expect("constant preview headers")
}

#[tauri::command]
pub async fn open_mock_preview(app: tauri::AppHandle, webview: tauri::Webview, shell: String, width: u32, height: u32) -> Result<(), String> {
    if !dashboard_caller(webview.label()) { return Err("Preview IPC denied".into()); }
    if shell.len() > 16 * 1024 * 1024 || !(240..=3840).contains(&width) || !(240..=3840).contains(&height) { return Err("Invalid preview size".into()); }
    #[cfg(not(target_os = "macos"))]
    { let _ = (app, shell, width, height); Err("Interactive preview isolation is currently available on macOS only".into()) }
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let handle = app.clone();
        app.run_on_main_thread(move || macos::open(handle, shell, width, height, tx)).map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|_| "Preview setup failed".to_string())?)
            .await.map_err(|e| e.to_string())?
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use block2::RcBlock;
    use objc2::{msg_send, sel, MainThreadMarker};
    use objc2_foundation::{NSError, NSObjectProtocol, NSString};
    use objc2_web_kit::{WKContentRuleList, WKContentRuleListStore, WKWebViewConfiguration, WKWebsiteDataStore};

    pub fn open(app: tauri::AppHandle, shell: String, width: u32, height: u32, tx: std::sync::mpsc::SyncSender<Result<(), String>>) {
        // These private selectors are deliberately capability checked and fail closed. A JS shim
        // cannot disable WebRTC in freshly-created realms; the engine preference can.
        let mtm = MainThreadMarker::new().expect("Tauri main thread");
        let config = unsafe { WKWebViewConfiguration::new(mtm) };
        unsafe {
            let preferences = config.preferences();
            if !preferences.respondsToSelector(sel!(_setPeerConnectionEnabled:)) || !preferences.respondsToSelector(sel!(_peerConnectionEnabled)) {
                let _ = tx.send(Err("This WebKit cannot enforce preview WebRTC isolation".into())); return;
            }
            let _: () = msg_send![&*preferences, _setPeerConnectionEnabled: false];
            let enabled: bool = msg_send![&*preferences, _peerConnectionEnabled];
            if enabled { let _ = tx.send(Err("WebRTC isolation unavailable".into())); return; }
            config.setWebsiteDataStore(&WKWebsiteDataStore::nonPersistentDataStore(mtm));
        }
        let Some(store) = (unsafe { WKContentRuleListStore::defaultStore(mtm) }) else {
            let _ = tx.send(Err("Preview network filter unavailable".into())); return;
        };
        let shell = Mutex::new(Some(shell));
        let completion = RcBlock::new(move |rules: *mut WKContentRuleList, error: *mut NSError| {
            if !error.is_null() || rules.is_null() { let _ = tx.send(Err("Preview network filter compilation failed".into())); return; }
            unsafe { config.userContentController().addContentRuleList(&*rules); }
            let state = app.state::<Previews>();
            let label = format!("mock-preview-{}", state.next.fetch_add(1, Ordering::Relaxed));
            let Some(shell) = shell.lock().ok().and_then(|mut s| s.take()) else { return; };
            let Ok(mut docs) = state.documents.lock() else { let _ = tx.send(Err("Preview state unavailable".into())); return; };
            docs.insert(label.clone(), shell); drop(docs);
            let url = initial_url(&label);
            let initial = std::sync::atomic::AtomicBool::new(true);
            let allowed = url.clone();
            let result = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url.parse().expect("constant preview URL")))
                .with_webview_configuration(config.clone())
                .title("Interactive mock · isolated preview").inner_size(width as f64, height as f64)
                .disable_drag_drop_handler()
                .on_navigation(move |url| {
                    // srcdoc is necessary for the opaque child. Every real URL navigation is
                    // denied after the single trusted shell load, including data/blob/ipc/file.
                    url.as_str() == "about:srcdoc" || (url.as_str() == allowed && initial.swap(false, Ordering::SeqCst))
                })
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build();
            match result {
                Ok(window) => {
                    let app = app.clone(); let label = label.clone();
                    window.on_window_event(move |event| if matches!(event, tauri::WindowEvent::Destroyed) {
                        if let Ok(mut docs) = app.state::<Previews>().documents.lock() { docs.remove(&label); }
                    });
                    let _ = tx.send(Ok(()));
                }
                Err(e) => { if let Ok(mut docs) = state.documents.lock() { docs.remove(&label); } let _ = tx.send(Err(e.to_string())); }
            }
        });
        unsafe { store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
            Some(&NSString::from_str("one-connect-mock-deny-network-v1")), Some(&NSString::from_str(NETWORK_RULES)), Some(&completion)); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn only_dashboard_gets_application_commands() {
        assert!(dashboard_caller("main"));
        for label in ["mock-preview-0", "main-child", "", "remote"] { assert!(!dashboard_caller(label)); }
    }
}
