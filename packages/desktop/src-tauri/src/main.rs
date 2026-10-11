// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod projects;
mod terminal;
mod mock_preview;
#[cfg(unix)] mod mock_file;
use projects::{ProjectEntry, Registry, DEMO};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, path::{Path, PathBuf}, process::{Child, Command, Stdio}, sync::{atomic::{AtomicBool, Ordering}, Mutex}, time::{Duration, Instant}};
use sha2::{Digest, Sha256};
use tauri::{Manager, State};

/// One authenticated daemon endpoint. Each project has its own URL and install token; they are
/// looked up by project identity on every call and never shared between projects.
#[derive(Clone)]
struct Connection { url: String, token: String }
struct Engine { child: Child, connection: Connection }
struct Desktop {
    engines: Mutex<HashMap<String, Engine>>,
    registry: Mutex<Registry>,
    starting: tauri::async_runtime::Mutex<()>,
    restored: AtomicBool,
    terminals: terminal::Terminals,
    gate: projects::Gate,
}
#[derive(Serialize)]
struct Bootstrap { websocket: String, mode: String, project: String, name: String }
#[derive(Deserialize)]
struct Info { url: String }

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> { app.path().app_data_dir().map_err(|e| e.to_string()) }
fn lock<'a, T>(m: &'a Mutex<T>) -> Result<std::sync::MutexGuard<'a, T>, String> { m.lock().map_err(|_| "State unavailable".to_string()) }
fn known_project(state: &Desktop, id: &str) -> Result<(), String> {
    if !projects::valid_id(id) { return Err("Invalid project".into()); }
    if id != DEMO && lock(&state.registry)?.get(id).is_none() { return Err("Unknown project".into()); }
    Ok(())
}
/// The live connection for exactly this project, or an error if its engine is not running.
pub(crate) fn ensure_connection(state: &Desktop, project: &str) -> Result<Connection, String> {
    let mut engines = lock(&state.engines)?;
    let alive = match engines.get_mut(project) { Some(e) => e.child.try_wait().ok().flatten().is_none(), None => return Err("This project is not running. Start it from Projects.".into()) };
    if !alive { engines.remove(project); return Err("This project's engine stopped. Start it again from Projects.".into()); }
    Ok(engines[project].connection.clone())
}
fn api_path(p: &str) -> Result<(), String> {
    if !p.starts_with("/api/") || p.contains("..") || p.contains(['\\', '#', '\r', '\n']) || p.starts_with("/api/mcp/") { return Err("Invalid daemon API path".into()); }
    Ok(())
}
async fn request(c: &Connection, path: &str, method: &str, body: Option<Value>) -> Result<Value, String> {
    api_path(path)?;
    let method = match method { "GET" => reqwest::Method::GET, "POST" => reqwest::Method::POST, "PUT" => reqwest::Method::PUT, "PATCH" => reqwest::Method::PATCH, "DELETE" => reqwest::Method::DELETE, _ => return Err("Method not supported".into()) };
    let mut r = reqwest::Client::new().request(method, format!("{}{}", c.url, path)).bearer_auth(&c.token).timeout(Duration::from_secs(65));
    if let Some(b) = body { r = r.json(&b); }
    let response = r.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&text).unwrap_or(Value::String(text));
    if !status.is_success() { return Err(value.get("error").and_then(Value::as_str).unwrap_or("Daemon request failed").to_string()); }
    Ok(value)
}
fn engine_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(root) = std::env::var("ACC_ENGINE_ROOT") { return Ok(PathBuf::from(root)); }
    let archive = app.path().resource_dir().map_err(|e| e.to_string())?.join("resources/engine.tar.gz");
    if archive.is_file() {
        let digest = Sha256::digest(fs::read(&archive).map_err(|e| e.to_string())?);
        let destination = data_dir(app)?.join("runtimes").join(format!("{:x}", digest));
        if !destination.join("ready").exists() {
            fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
            let status = Command::new("/usr/bin/tar").arg("xzf").arg(&archive).arg("-C").arg(&destination).status().map_err(|e| e.to_string())?;
            if !status.success() { return Err("Could not unpack bundled engine".into()); }
            fs::write(destination.join("ready"), b"ok").map_err(|e| e.to_string())?;
        }
        return Ok(destination.join("engine"));
    }
    // Dev uses the same prepared bundle as a packaged app.
    Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/engine"))
}
fn engine_path(root: &Path) -> String {
    format!("{}:/opt/homebrew/bin:/usr/local/bin:{}/.local/bin:{}", root.join("runtime").display(), std::env::var("HOME").unwrap_or_default(), std::env::var("PATH").unwrap_or_default())
}
fn runtime(root: &Path) -> Result<PathBuf, String> {
    let r = root.join("runtime/node");
    if !r.is_file() { return Err("Runtime not prepared. Run pnpm desktop:prepare before launching.".into()); }
    Ok(r)
}
/// Run `acc project <args>` from the bundled engine. It prints one JSON object; `ok: false` is an error.
async fn engine_cli(app: &tauri::AppHandle, args: Vec<String>) -> Result<Value, String> {
    let root = engine_root(app)?;
    let node = runtime(&root)?;
    let out = tauri::async_runtime::spawn_blocking(move || Command::new(node).current_dir(&root).arg("packages/daemon/src/cli.ts").arg("project").args(args).env("PATH", engine_path(&root)).stdin(Stdio::null()).output())
        .await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    parse_cli(&String::from_utf8_lossy(&out.stdout))
}
fn parse_cli(stdout: &str) -> Result<Value, String> {
    let line = stdout.lines().rev().find(|l| l.trim_start().starts_with('{')).ok_or("Project engine returned no result")?;
    let v: Value = serde_json::from_str(line).map_err(|_| "Project engine returned invalid JSON".to_string())?;
    if v["ok"] == Value::Bool(true) { Ok(v) } else { Err(v["error"].as_str().unwrap_or("Project command failed").to_string()) }
}
/// A daemon left by a crashed app would share this project's database. Stop it only when its
/// command line proves it is this project's engine; an unrelated process is never signalled.
fn stop_stale_daemon(daemon_data: &Path) {
    let Ok(raw) = fs::read_to_string(daemon_data.join("daemon.json")) else { return };
    let Ok(info) = serde_json::from_str::<Value>(&raw) else { return };
    let (Some(pid), Some(config)) = (info["pid"].as_u64(), info["config"].as_str()) else { return };
    let pid = pid.to_string();
    let Ok(out) = Command::new("/bin/ps").args(["-o", "command=", "-p", &pid]).output() else { return };
    let cmdline = String::from_utf8_lossy(&out.stdout);
    if !(cmdline.contains("runtime/node") && cmdline.contains(&format!("cli.ts daemon --config {config}"))) { return; }
    let _ = Command::new("/bin/kill").args(["-TERM", &pid]).status();
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(25) && Command::new("/bin/kill").args(["-0", &pid]).stderr(Stdio::null()).status().is_ok_and(|s| s.success()) { std::thread::sleep(Duration::from_millis(200)); }
}
async fn tokio_sleep() { tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(100))).await.ok(); }

/// Start (or reuse) the engine for one project, verifying its exact repository binding.
async fn start_engine(app: &tauri::AppHandle, id: &str) -> Result<Connection, String> {
    let state = app.state::<Desktop>();
    let _guard = state.starting.lock().await;
    known_project(&state, id)?;
    if let Ok(c) = ensure_connection(&state, id) { return Ok(c); }
    let root = engine_root(app)?;
    let node = runtime(&root)?;
    let data = data_dir(app)?;
    fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let daemon_data = projects::state_dir(&data, id);
    fs::create_dir_all(&daemon_data).map_err(|e| e.to_string())?;
    let mut command = Command::new(node);
    let expected_repo = if id == DEMO {
        command.arg("scripts/demo.mjs").env("ACC_DEMO_DIR", data.join("demo"));
        None
    } else {
        let entry = lock(&state.registry)?.get(id).cloned().ok_or("Unknown project")?;
        // Re-verify before every start: an edited configuration must not silently rebind the project.
        let described = engine_cli(app, vec!["describe-config".into(), "--config".into(), entry.config.clone()]).await?;
        let repo = described["project"]["repo"].as_str().ok_or("Configuration has no repository")?.to_string();
        if projects::project_id(described["project"]["config"].as_str().unwrap_or("")) != id { return Err("Configuration path changed; add the project again".into()); }
        if !entry.repo.is_empty() && entry.repo != repo { return Err(format!("{} now points at {repo}, not {}. Restore the configuration or add it as a new project.", entry.config, entry.repo)); }
        if entry.repo.is_empty() {
            let mut reg = lock(&state.registry)?;
            reg.upsert(ProjectEntry { repo: repo.clone(), name: described["project"]["name"].as_str().unwrap_or(&entry.name).to_string(), ..entry.clone() })?;
            reg.save(&data)?;
        }
        command.args(["packages/daemon/src/cli.ts", "daemon", "--config", &entry.config, "--port", "0"]);
        Some(repo)
    };
    let stale_dir = daemon_data.clone();
    tauri::async_runtime::spawn_blocking(move || stop_stale_daemon(&stale_dir)).await.map_err(|e| e.to_string())?;
    let info_path = daemon_data.join("daemon.json");
    // The app owns this daemon; stale endpoint files from an earlier crash are never trusted.
    let _ = fs::remove_file(&info_path);
    let log = fs::OpenOptions::new().create(true).append(true).open(data.join("daemon.log")).map_err(|e| e.to_string())?;
    command.current_dir(&root).env("ACC_DATA_DIR", &daemon_data).env("ACC_PORT", "0").env("ACC_DESKTOP", "1").env("ACC_NATIVE_FILE_HELPER", std::env::current_exe().map_err(|e| e.to_string())?).env("PATH", engine_path(&root))
        .stdin(Stdio::null()).stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?)).stderr(Stdio::from(log));
    // Bundled local models (summary and embeddings) ship as app resources; the engine uses them only when present.
    if let Ok(models) = app.path().resource_dir().map(|d| d.join("resources/models")) { if models.join("llama").is_dir() { command.env("ACC_LOCAL_MODELS_DIR", &models); } }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let started = Instant::now();
    let fail = |child: &mut Child, msg: String| { let _ = child.kill(); msg };
    let info = loop {
        if let Ok(raw) = fs::read_to_string(&info_path) { if let Ok(i) = serde_json::from_str::<Info>(&raw) { break i; } }
        if child.try_wait().ok().flatten().is_some() { return Err(format!("Daemon exited during startup. See {}", data.join("daemon.log").display())); }
        if started.elapsed() > Duration::from_secs(25) { return Err(fail(&mut child, format!("Daemon startup timed out. See {}", data.join("daemon.log").display()))); }
        tokio_sleep().await;
    };
    let parsed = reqwest::Url::parse(&info.url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "http" || parsed.host_str() != Some("127.0.0.1") { return Err(fail(&mut child, "Daemon must bind to loopback".into())); }
    let token = match fs::read_to_string(daemon_data.join("secrets/install-token")) { Ok(t) => t.trim().to_string(), Err(e) => return Err(fail(&mut child, e.to_string())) };
    let connection = Connection { url: info.url, token };
    if let Some(repo) = expected_repo {
        let live = match request(&connection, "/api/state", "GET", None).await { Ok(v) => v, Err(e) => return Err(fail(&mut child, e)) };
        let served = projects::canonical(live["state"]["project"]["repo"].as_str().unwrap_or(""));
        if served.to_string_lossy() != repo { return Err(fail(&mut child, "Engine is serving a different repository than this project".into())); }
    }
    lock(&state.engines)?.insert(id.to_string(), Engine { child, connection: connection.clone() });
    let mut reg = lock(&state.registry)?;
    reg.set_running(id, true);
    reg.save(&data)?;
    Ok(connection)
}

fn project_name(state: &Desktop, id: &str) -> String {
    if id == DEMO { return "Offline demo".into(); }
    state.registry.lock().ok().and_then(|r| r.get(id).map(|p| p.name.clone())).unwrap_or_default()
}

#[tauri::command]
async fn desktop_bootstrap(app: tauri::AppHandle, state: State<'_, Desktop>, project: Option<String>) -> Result<Bootstrap, String> {
    let id = match project {
        Some(p) => p,
        None => { let r = lock(&state.registry)?; r.active.clone().or_else(|| r.projects.first().map(|p| p.id.clone())).unwrap_or_else(|| DEMO.into()) }
    };
    let c = start_engine(&app, &id).await?;
    if !state.restored.swap(true, Ordering::SeqCst) {
        // Restart recovery: engines that were running at the last quit come back in the background,
        // so their supervisors reattach detached runs even before their dashboards are opened.
        let others: Vec<String> = lock(&state.registry)?.running.iter().filter(|r| **r != id).cloned().collect();
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            for other in others {
                if start_engine(&handle, &other).await.is_err() {
                    let state = handle.state::<Desktop>();
                    if let (Ok(mut reg), Ok(data)) = (state.registry.lock(), data_dir(&handle)) { reg.set_running(&other, false); let _ = reg.save(&data); };
                }
            }
        });
    }
    let ticket = request(&c, "/api/auth/ws-ticket", "POST", Some(json!({}))).await?;
    Ok(Bootstrap { websocket: format!("{}/ws?ticket={}", c.url.replacen("http:", "ws:", 1), ticket["ticket"].as_str().ok_or("No ticket")?), mode: if id == DEMO { "offline-demo".into() } else { "project".into() }, name: project_name(&state, &id), project: id })
}
#[tauri::command]
async fn daemon_request(state: State<'_, Desktop>, project: String, path: String, method: String, body: Option<Value>) -> Result<Value, String> {
    request(&ensure_connection(&state, &project)?, &path, &method, body).await
}
#[tauri::command]
fn projects_list(state: State<'_, Desktop>) -> Result<Value, String> {
    let running: Vec<String> = { let mut e = lock(&state.engines)?; e.retain(|_, x| x.child.try_wait().ok().flatten().is_none()); e.keys().cloned().collect() };
    let reg = lock(&state.registry)?;
    let view = |id: &str| json!({ "running": running.iter().any(|r| r == id), "active": reg.active.as_deref() == Some(id), "terminals": state.terminals.count(id) });
    let projects: Vec<Value> = reg.projects.iter().map(|p| { let mut v = serde_json::to_value(p).unwrap_or(Value::Null); if let (Some(o), Value::Object(extra)) = (v.as_object_mut(), view(&p.id)) { o.extend(extra); } v }).collect();
    Ok(json!({ "projects": projects, "active": reg.active, "demo": view(DEMO) }))
}
fn register(state: &Desktop, data: &Path, prepared: &Value) -> Result<ProjectEntry, String> {
    let p = &prepared["project"];
    let config = p["config"].as_str().ok_or("No configuration")?.to_string();
    let entry = ProjectEntry { id: projects::project_id(&config), name: p["name"].as_str().unwrap_or("Project").into(), repo: p["repo"].as_str().ok_or("No repository")?.into(), config, generated: prepared["generated"].as_bool().unwrap_or(false), added_at: projects::now_secs(), last_opened_at: None, onboarding: prepared.get("inspection").cloned() };
    let mut reg = lock(&state.registry)?;
    let saved = reg.upsert(entry)?.clone();
    reg.save(data)?;
    Ok(saved)
}
#[tauri::command]
async fn project_choose_folder(purpose: String) -> Result<String, String> {
    let prompt = match purpose.as_str() { "project" => "Choose the project repository folder", "parent" => "Choose where to put the cloned repository", _ => return Err("Unknown folder purpose".into()) };
    #[cfg(target_os = "macos")]
    {
        let script = format!("POSIX path of (choose folder with prompt \"{prompt}\")");
        let out = tauri::async_runtime::spawn_blocking(move || Command::new("osascript").args(["-e", &script]).output()).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
        if !out.status.success() { return Err("Folder selection canceled".into()); }
        Ok(String::from_utf8_lossy(&out.stdout).trim().trim_end_matches('/').to_string())
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = prompt; Err("Folder picker currently supports macOS".into()) }
}
#[tauri::command]
async fn project_inspect(app: tauri::AppHandle, path: String) -> Result<Value, String> {
    Ok(engine_cli(&app, vec!["inspect".into(), "--dir".into(), path]).await?["inspection"].take())
}
async fn prepare_and_register(app: &tauri::AppHandle, dir: String, name: Option<String>) -> Result<ProjectEntry, String> {
    let data = data_dir(app)?;
    let mut args = vec!["prepare".into(), "--dir".into(), dir, "--config-dir".into(), data.join("project-configs").to_string_lossy().to_string()];
    if let Some(n) = name.filter(|n| !n.trim().is_empty()) { args.extend(["--name".into(), n]); }
    let prepared = engine_cli(app, args).await?;
    register(&app.state::<Desktop>(), &data, &prepared)
}
#[tauri::command]
async fn project_add(app: tauri::AppHandle, path: String, name: Option<String>) -> Result<ProjectEntry, String> { prepare_and_register(&app, path, name).await }
#[tauri::command]
async fn project_activate(app: tauri::AppHandle, state: State<'_, Desktop>, project: String) -> Result<(), String> {
    known_project(&state, &project)?;
    let data = data_dir(&app)?;
    {
        let mut reg = lock(&state.registry)?;
        reg.activate(&project)?;
        // Keep the pre-registry selection file meaningful for older builds.
        match reg.get(&project) { Some(p) => fs::write(data.join("selected-config"), &p.config).map_err(|e| e.to_string())?, None => { let _ = fs::remove_file(data.join("selected-config")); } }
        reg.save(&data)?;
    }
    start_engine(&app, &project).await.map(|_| ())
}
#[tauri::command]
async fn project_start(app: tauri::AppHandle, project: String) -> Result<(), String> { start_engine(&app, &project).await.map(|_| ()) }
/// Graceful per-project stop: the daemon finishes in-flight work, detached agent runs keep going
/// and reattach on the next start, and this project's terminals close.
#[tauri::command]
async fn project_stop(app: tauri::AppHandle, state: State<'_, Desktop>, project: String) -> Result<(), String> {
    known_project(&state, &project)?;
    let engine = lock(&state.engines)?.remove(&project);
    if let Some(mut e) = engine {
        let _ = request(&e.connection, "/api/desktop/shutdown", "POST", Some(json!({}))).await;
        tauri::async_runtime::spawn_blocking(move || {
            let start = Instant::now();
            while start.elapsed() < Duration::from_secs(30) { if e.child.try_wait().ok().flatten().is_some() { return; } std::thread::sleep(Duration::from_millis(100)); }
            let _ = e.child.kill();
        }).await.map_err(|e| e.to_string())?;
    }
    let terminals_closed = state.terminals.close_project(&project);
    let mut reg = lock(&state.registry)?;
    reg.set_running(&project, false);
    reg.save(&data_dir(&app)?)?;
    terminals_closed.map(|_| ())
}
#[tauri::command]
fn project_remove(app: tauri::AppHandle, state: State<'_, Desktop>, project: String) -> Result<(), String> {
    if lock(&state.engines)?.contains_key(&project) { return Err("Stop this project before removing it".into()); }
    if state.terminals.count(&project) > 0 { return Err("Close this project's remaining terminals before removing it".into()); }
    let mut reg = lock(&state.registry)?;
    reg.remove(&project)?;
    reg.save(&data_dir(&app)?)
}
/// Engage every running project's kill switch. Each project reports separately.
#[tauri::command]
async fn projects_kill_all(state: State<'_, Desktop>) -> Result<Value, String> {
    let targets: Vec<(String, Connection)> = lock(&state.engines)?.iter().map(|(id, e)| (id.clone(), e.connection.clone())).collect();
    let mut out = serde_json::Map::new();
    for (id, c) in targets {
        out.insert(id, match request(&c, "/api/kill-switch", "POST", Some(json!({ "engaged": true }))).await { Ok(v) => json!({ "stopped": v["stopped"] }), Err(e) => json!({ "error": e }) });
    }
    Ok(Value::Object(out))
}
#[tauri::command]
async fn project_clone_plan(app: tauri::AppHandle, state: State<'_, Desktop>, url: String, parent: String, name: Option<String>) -> Result<Value, String> {
    let mut args = vec!["clone-plan".into(), "--url".into(), url.clone(), "--parent".into(), parent.clone()];
    if let Some(n) = name.clone().filter(|n| !n.trim().is_empty()) { args.extend(["--name".into(), n]); }
    let plan = engine_cli(&app, args).await?["plan"].take();
    let digest = plan["digest"].as_str().ok_or("Plan has no digest")?;
    let approval = state.gate.create("clone", digest, vec![url, parent, name.unwrap_or_default()], projects::APPROVAL_TTL)?;
    Ok(json!({ "approvalId": approval, "plan": plan, "expiresInSeconds": projects::APPROVAL_TTL.as_secs() }))
}
/// Executes the exact approved clone (the engine re-plans and must reproduce the digest), then adds the project.
#[tauri::command]
async fn project_clone_approve(app: tauri::AppHandle, state: State<'_, Desktop>, approval_id: String, digest: String) -> Result<ProjectEntry, String> {
    let p = state.gate.consume(&approval_id, "clone", &digest)?;
    let [url, parent, name] = <[String; 3]>::try_from(p.args).map_err(|_| "Invalid approval")?;
    let mut args = vec!["clone".into(), "--url".into(), url, "--parent".into(), parent, "--digest".into(), digest];
    if !name.is_empty() { args.extend(["--name".into(), name]); }
    let cloned = engine_cli(&app, args).await?;
    let dir = cloned["inspection"]["path"].as_str().ok_or("Clone produced no folder")?.to_string();
    prepare_and_register(&app, dir, None).await
}
#[tauri::command]
async fn project_init_plan(app: tauri::AppHandle, state: State<'_, Desktop>, path: String) -> Result<Value, String> {
    let plan = engine_cli(&app, vec!["init-plan".into(), "--dir".into(), path.clone()]).await?["plan"].take();
    let approval = state.gate.create("git-init", plan["digest"].as_str().ok_or("Plan has no digest")?, vec![path], projects::APPROVAL_TTL)?;
    Ok(json!({ "approvalId": approval, "plan": plan, "expiresInSeconds": projects::APPROVAL_TTL.as_secs() }))
}
#[tauri::command]
async fn project_init_approve(app: tauri::AppHandle, state: State<'_, Desktop>, approval_id: String, digest: String) -> Result<Value, String> {
    let p = state.gate.consume(&approval_id, "git-init", &digest)?;
    let dir = p.args.into_iter().next().ok_or("Invalid approval")?;
    Ok(engine_cli(&app, vec!["init".into(), "--dir".into(), dir, "--digest".into(), digest]).await?["inspection"].take())
}
/// Open an existing control-center.yaml. Switching no longer requires stopping other projects' runs.
#[tauri::command]
async fn choose_project(app: tauri::AppHandle, state: State<'_, Desktop>) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    let out = tauri::async_runtime::spawn_blocking(|| Command::new("osascript").args(["-e", "POSIX path of (choose file with prompt \"Choose control-center.yaml\")"]).output()).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    return Err("Project picker currently supports macOS".into());
    #[cfg(target_os = "macos")]
    {
        if !out.status.success() { return Err("Project selection canceled".into()); }
        let selected = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let p = PathBuf::from(&selected);
        if !p.is_file() || !matches!(p.extension().and_then(|x| x.to_str()), Some("yaml" | "yml")) { return Err("Choose a YAML project configuration".into()); }
        let described = engine_cli(&app, vec!["describe-config".into(), "--config".into(), selected]).await?;
        let entry = register(&state, &data_dir(&app)?, &json!({ "project": described["project"], "generated": false }))?;
        project_activate(app.clone(), state, entry.id.clone()).await?;
        Ok(entry.id)
    }
}
#[tauri::command]
async fn choose_vault() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let out = tauri::async_runtime::spawn_blocking(|| Command::new("osascript").args(["-e", "POSIX path of (choose folder with prompt \"Choose the markdown or Obsidian vault for One Connect\")"]).output()).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
        if !out.status.success() { return Err("Folder selection canceled".into()); }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }
    #[cfg(not(target_os = "macos"))]
    { Err("Folder picker currently supports macOS".into()) }
}
/// Quit: ask every engine to shut down gracefully. Their running set is kept so the next launch restores them.
fn shutdown_all(state: &Desktop) {
    if let Err(e) = state.terminals.close_all() { eprintln!("One Connect terminal shutdown: {e}"); }
    let engines: Vec<Engine> = state.engines.lock().map(|mut e| e.drain().map(|(_, v)| v).collect()).unwrap_or_default();
    for e in &engines {
        let _ = reqwest::blocking::Client::new().post(format!("{}/api/desktop/shutdown", e.connection.url)).bearer_auth(&e.connection.token).timeout(Duration::from_secs(3)).json(&json!({})).send();
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    for mut e in engines { while Instant::now() < deadline && e.child.try_wait().ok().flatten().is_none() { std::thread::sleep(Duration::from_millis(100)); } }
}
/// What an available update offers, for the dashboard's update banner.
#[derive(serde::Serialize)]
struct UpdateInfo { version: String, current: String, notes: Option<String>, date: Option<String> }

/// Ask the signed update feed for a newer build. `None` when this build is current.
#[tauri::command]
async fn update_check(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo { version: u.version.clone(), current: u.current_version.clone(), notes: u.body.clone(), date: u.date.map(|d| d.to_string()) }))
}

/// Download, verify against the bundled public key, install, stop every project engine
/// gracefully, then relaunch into the new version.
#[tauri::command]
async fn update_install(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?
        .ok_or_else(|| "This build is already current.".to_string())?;
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    if let Some(state) = app.try_state::<Desktop>() { shutdown_all(&state); }
    app.restart();
}

fn main() {
    #[cfg(unix)] mock_file::run_mode();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(mock_preview::Previews::default())
        .register_uri_scheme_protocol(mock_preview::SCHEME, mock_preview::response)
        .invoke_handler(|invoke: tauri::ipc::Invoke<tauri::Wry>| {
            // Application commands (project registry, terminals, daemon proxy) are dashboard-only;
            // an untrusted mock preview window can never reach them.
            if !mock_preview::dashboard_caller(invoke.message.webview_ref().label()) {
                invoke.resolver.reject("Preview IPC denied"); return true;
            }
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![mock_preview::open_mock_preview, desktop_bootstrap, daemon_request, projects_list, project_choose_folder, project_inspect, project_add, project_activate, project_start, project_stop, project_remove, projects_kill_all, project_clone_plan, project_clone_approve, project_init_plan, project_init_approve, choose_project, choose_vault, terminal::terminal_open, terminal::terminal_list, terminal::terminal_attach, terminal::terminal_write, terminal::terminal_resize, terminal::terminal_close, update_check, update_install];
            handler(invoke)
        })
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            fs::create_dir_all(&data)?;
            app.manage(Desktop { engines: Mutex::new(HashMap::new()), registry: Mutex::new(Registry::load(&data)), starting: tauri::async_runtime::Mutex::new(()), restored: AtomicBool::new(false), terminals: terminal::Terminals::default(), gate: projects::Gate::default() });
            use tauri::menu::{Menu, MenuItem};
            let show = MenuItem::with_id(app, "show", "Show dashboard", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit One Connect", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = tauri::tray::TrayIconBuilder::new().menu(&menu).tooltip("One Connect")
                .on_menu_event(|app, event| match event.id.as_ref() { "show" => { if let Some(w) = app.get_webview_window("main") { let _ = w.show(); let _ = w.set_focus(); } }, "quit" => app.exit(0), _ => {} });
            if let Some(icon) = app.default_window_icon() { tray = tray.icon(icon.clone()); }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| if let tauri::WindowEvent::CloseRequested { api, .. } = event { if window.label() != "main" { return; } api.prevent_close(); let _ = window.hide(); })
        .build(tauri::generate_context!()).expect("Desktop application could not start");
    app.run(|app, event| if let tauri::RunEvent::Exit = event { if let Some(state) = app.try_state::<Desktop>() { shutdown_all(&state); } });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn proxy_paths_cannot_escape() {
        assert!(api_path("/api/state").is_ok());
        for p in ["https://evil.test", "/api/../secrets", "/api/mcp/run", "/api/\\evil", "/not-api"] { assert!(api_path(p).is_err()); }
    }
    #[test] fn project_state_is_isolated_and_stable() {
        let data = std::path::Path::new("/tmp/acc-data");
        assert_eq!(projects::state_dir(data, DEMO), data.join("demo/state"));
        let one = projects::project_id("/tmp/one.yaml");
        assert_eq!(one, projects::project_id("/tmp/one.yaml\n"));
        assert_ne!(projects::state_dir(data, &one), projects::state_dir(data, &projects::project_id("/tmp/two.yaml")));
    }
    #[test] fn engine_cli_results_are_strict() {
        assert_eq!(parse_cli("(node) warning\n{\"ok\":true,\"plan\":{}}\n").unwrap()["plan"], json!({}));
        assert_eq!(parse_cli("{\"ok\":false,\"error\":\"nope\"}").unwrap_err(), "nope");
        assert!(parse_cli("").is_err());
        assert!(parse_cli("{bad").is_err());
    }
    #[test] fn draft_put_crosses_the_authenticated_native_http_bridge() {
        use std::io::{Read, Write};
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = server.local_addr().unwrap().port();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = server.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut data = Vec::new();
            loop {
                let mut buf = [0u8; 1024]; let n = stream.read(&mut buf).unwrap();
                assert!(n > 0); data.extend_from_slice(&buf[..n]);
                if let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&data[..end]);
                    let len: usize = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap())).unwrap();
                    if data.len() >= end + 4 + len { break; }
                }
            }
            let sent = String::from_utf8(data).unwrap();
            assert!(sent.starts_with("PUT /api/designer/drafts/brief HTTP/1.1"));
            assert!(sent.to_ascii_lowercase().contains("authorization: bearer fixture-only"));
            assert!(sent.contains(r#"{"value":"project alpha draft"}"#));
            let body = r#"{"draft":{"value":"project alpha draft"}}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let connection = Connection { url: format!("http://127.0.0.1:{}", port), token: "fixture-only".into() };
        let result = tauri::async_runtime::block_on(request(&connection, "/api/designer/drafts/brief", "PUT", Some(serde_json::json!({"value":"project alpha draft"})))).unwrap();
        assert_eq!(result["draft"]["value"], "project alpha draft"); worker.join().unwrap();
        assert!(tauri::async_runtime::block_on(request(&connection, "/api/mcp/secrets", "PUT", None)).is_err());
        assert!(tauri::async_runtime::block_on(request(&connection, "/api/designer/drafts/brief", "CONNECT", None)).is_err());
    }
    #[test] fn connections_are_bound_to_one_project() {
        let state = Desktop { engines: Mutex::new(HashMap::new()), registry: Mutex::new(Registry::default()), starting: tauri::async_runtime::Mutex::new(()), restored: AtomicBool::new(false), terminals: terminal::Terminals::default(), gate: projects::Gate::default() };
        let spawn = || Command::new("/bin/sleep").arg("5").spawn().unwrap();
        lock(&state.engines).unwrap().insert("a".repeat(64), Engine { child: spawn(), connection: Connection { url: "http://127.0.0.1:1".into(), token: "token-a".into() } });
        lock(&state.engines).unwrap().insert("b".repeat(64), Engine { child: spawn(), connection: Connection { url: "http://127.0.0.1:2".into(), token: "token-b".into() } });
        assert_eq!(ensure_connection(&state, &"a".repeat(64)).unwrap().token, "token-a");
        assert_eq!(ensure_connection(&state, &"b".repeat(64)).unwrap().token, "token-b");
        assert!(ensure_connection(&state, &"c".repeat(64)).is_err());
        assert!(known_project(&state, "../x").is_err());
        assert!(known_project(&state, &"a".repeat(64)).is_err(), "engines alone do not make a project known");
        let mut b = lock(&state.engines).unwrap().remove(&"b".repeat(64)).unwrap();
        b.child.kill().unwrap(); b.child.wait().unwrap();
        lock(&state.engines).unwrap().insert("b".repeat(64), b);
        assert!(matches!(ensure_connection(&state, &"b".repeat(64)), Err(e) if e.contains("stopped")));
        for (_, mut e) in lock(&state.engines).unwrap().drain() { let _ = e.child.kill(); let _ = e.child.wait(); }
    }
}
