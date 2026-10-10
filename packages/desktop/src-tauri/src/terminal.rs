// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
use portable_pty::{native_pty_system, CommandBuilder, Child, ChildKiller, ExitStatus, MasterPty, PtySize};
use serde::Serialize;
use std::{collections::HashMap, io::{ErrorKind, Read, Write}, path::Path, sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex}, time::{Duration, Instant}};
use tauri::{Emitter, Manager, State};
use super::{ensure_connection, projects, request, Desktop};
const SCROLLBACK: usize = 256 * 1024;
/// How a terminal session ended. Distinct from process exit when the PTY output stops early.
#[derive(Clone, Copy, PartialEq, Eq)]
enum EndReason { ProcessExit, OutputEnded, ReadFailed }
/// Bounded output kept so a project's terminals can be reattached after switching back to it.
/// `seq` counts emitted chunks; an attach returns the seq it covers so live events are not duplicated.
#[derive(Default)]
pub struct Scrollback {
    text: String,
    seq: u64,
    exited: bool,
    exit_code: Option<u32>,
    exit_signal: Option<String>,
    output_ended: bool,
    read_failed: bool,
}
impl Scrollback {
    fn push(&mut self, chunk: &str) -> u64 {
        self.text.push_str(chunk);
        if self.text.len() > SCROLLBACK {
            let mut cut = self.text.len() - SCROLLBACK;
            while !self.text.is_char_boundary(cut) { cut += 1; }
            self.text.drain(..cut);
        }
        self.seq += 1;
        self.seq
    }
    fn finish(&mut self, status: Option<ExitStatus>, reason: EndReason) {
        self.exited = true;
        self.output_ended = reason == EndReason::OutputEnded;
        self.read_failed = reason == EndReason::ReadFailed;
        if let Some(s) = status {
            self.exit_code = Some(s.exit_code());
            self.exit_signal = s.signal().map(|x| x.to_string());
        }
    }
}
struct Session {
    project: String,
    label: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    #[allow(dead_code)] // reader threads clone this Arc; shutdown uses killer instead
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    output: Arc<Mutex<Scrollback>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView { id: String, label: String, exited: bool, exit_code: Option<u32>, exit_signal: Option<String>, output_ended: bool, read_failed: bool }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attached { text: String, seq: u64, exited: bool, exit_code: Option<u32>, exit_signal: Option<String>, output_ended: bool, read_failed: bool }
/// Native terminals. Every session belongs to one project; calls naming another project are refused.
#[derive(Default)]
pub struct Terminals { sessions: Mutex<HashMap<String, Session>>, next: AtomicU64 }
impl Terminals {
    pub fn close_all(&self) -> Result<usize, String> { self.close_matching(None) }
    pub fn close_project(&self, project: &str) -> Result<usize, String> { self.close_matching(Some(project)) }
    fn close_matching(&self, project: Option<&str>) -> Result<usize, String> {
        let targets: Vec<(String, String)> = self.sessions.lock().map_err(|_| "Terminal state unavailable")?
            .iter().filter(|(_, s)| project.map(|p| s.project == p).unwrap_or(true))
            .map(|(id, s)| (id.clone(), s.project.clone())).collect();
        let mut closed = 0;
        let mut errors = Vec::new();
        // Attempt every session even if an earlier stop fails. Failures keep their handles.
        for (id, owner) in targets {
            match self.close(&owner, &id) {
                Ok(()) => closed += 1,
                Err(e) => errors.push(format!("{id}: {e}")),
            }
        }
        if errors.is_empty() { Ok(closed) }
        else { Err(format!("Closed {closed} terminal sessions; {} could not be closed and remain owned: {}", errors.len(), errors.join("; "))) }
    }
    pub fn count(&self, project: &str) -> usize { self.sessions.lock().map(|s| s.values().filter(|x| x.project == project).count()).unwrap_or(0) }
    fn insert(&self, project: &str, label: &str, master: Box<dyn MasterPty + Send>, writer: Box<dyn Write + Send>, child: Box<dyn Child + Send + Sync>) -> Result<(String, Arc<Mutex<Scrollback>>, Arc<Mutex<Box<dyn Child + Send + Sync>>>, Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>), String> {
        let id = format!("terminal-{}", self.next.fetch_add(1, Ordering::Relaxed));
        let output = Arc::new(Mutex::new(Scrollback::default()));
        let killer = Arc::new(Mutex::new(child.clone_killer()));
        let child = Arc::new(Mutex::new(child));
        self.sessions.lock().map_err(|_| "Terminal state unavailable")?.insert(id.clone(), Session { project: project.into(), label: label.into(), master, writer, child: child.clone(), killer: killer.clone(), output: output.clone() });
        Ok((id, output, child, killer))
    }
    pub fn list(&self, project: &str) -> Vec<SessionView> {
        let Ok(sessions) = self.sessions.lock() else { return vec![] };
        let mut out: Vec<SessionView> = sessions.iter().filter(|(_, s)| s.project == project).map(|(id, s)| {
            let o = s.output.lock();
            let (exited, exit_code, exit_signal, output_ended, read_failed) = o.as_ref().map(|x| (x.exited, x.exit_code, x.exit_signal.clone(), x.output_ended, x.read_failed)).unwrap_or((true, None, None, false, false));
            SessionView { id: id.clone(), label: s.label.clone(), exited, exit_code, exit_signal, output_ended, read_failed }
        }).collect();
        out.sort_by_key(|s| s.id.trim_start_matches("terminal-").parse::<u64>().unwrap_or(0));
        out
    }
    pub fn attach(&self, project: &str, id: &str) -> Result<Attached, String> {
        self.with(project, id, |s| {
            let o = s.output.lock().map_err(|_| "Terminal state unavailable")?;
            Ok(Attached { text: o.text.clone(), seq: o.seq, exited: o.exited, exit_code: o.exit_code, exit_signal: o.exit_signal.clone(), output_ended: o.output_ended, read_failed: o.read_failed })
        })
    }
    fn with<T>(&self, project: &str, id: &str, f: impl FnOnce(&mut Session) -> Result<T, String>) -> Result<T, String> {
        let mut sessions = self.sessions.lock().map_err(|_| "Terminal state unavailable")?;
        let s = sessions.get_mut(id).ok_or("Terminal closed")?;
        if s.project != project { return Err("This terminal belongs to another project".into()); }
        f(s)
    }
    pub fn write(&self, project: &str, id: &str, text: &str) -> Result<(), String> {
        if text.len() > 64_000 { return Err("Input too large".into()); }
        self.with(project, id, |s| {
            if s.output.lock().map_err(|_| "Terminal state unavailable")?.exited {
                return Err("Terminal exited".into());
            }
            s.writer.write_all(text.as_bytes()).and_then(|_| s.writer.flush()).map_err(|e| e.to_string())
        })
    }
    pub fn resize(&self, project: &str, id: &str, rows: u16, cols: u16) -> Result<(), String> {
        self.with(project, id, |s| {
            if s.output.lock().map_err(|_| "Terminal state unavailable")?.exited {
                return Err("Terminal exited".into());
            }
            s.master.resize(PtySize { rows: rows.clamp(2, 200), cols: cols.clamp(2, 500), pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
        })
    }
    pub fn close(&self, project: &str, id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|_| "Terminal state unavailable")?;
        let s = sessions.get(id).ok_or("Terminal closed")?;
        if s.project != project { return Err("This terminal belongs to another project".into()); }
        let exited = s.child.lock().map_err(|_| "Terminal process state unavailable")?.try_wait().map_err(|e| e.to_string())?.is_some();
        if !exited {
            if let Err(e) = s.killer.lock().map_err(|_| "Terminal stop state unavailable")?.kill() {
                // The process may have exited between try_wait and kill. Only a real status
                // permits forgetting a failed stop; PTY EOF/read failure is not that proof.
                let ended = s.child.lock().map_err(|_| "Terminal process state unavailable")?.try_wait().map_err(|e| e.to_string())?.is_some();
                if !ended { return Err(format!("Could not stop terminal; session retained for retry: {e}")); }
            }
        }
        sessions.remove(id);
        Ok(())
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Output { project: String, id: String, text: String, seq: u64, exited: bool, exit_code: Option<u32>, exit_signal: Option<String>, output_ended: bool, read_failed: bool }
fn decode_output(pending: &mut Vec<u8>, eof: bool) -> String {
    let mut text = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(s) => { text.push_str(s); pending.clear(); break; }
            Err(e) => {
                let valid = e.valid_up_to();
                text.push_str(&String::from_utf8_lossy(&pending[..valid]));
                pending.drain(..valid);
                if let Some(invalid) = e.error_len() { text.push('\u{FFFD}'); pending.drain(..invalid); }
                else { if eof { text.push_str(&String::from_utf8_lossy(pending)); pending.clear(); } break; }
            }
        }
    }
    text
}
fn format_exit(status: Option<&ExitStatus>) -> String {
    match status {
        Some(s) if s.signal().is_some() => format!("\r\n[process exited on signal {}]\r\n", s.signal().unwrap_or("unknown")),
        Some(s) => format!("\r\n[process exited with code {}]\r\n", s.exit_code()),
        None => "\r\n[terminal session ended]\r\n".to_string(),
    }
}
fn format_end(reason: EndReason, status: Option<&ExitStatus>) -> String {
    match reason {
        EndReason::ProcessExit => format_exit(status),
        EndReason::OutputEnded => "\r\n[terminal output ended; process may still be running]\r\n".to_string(),
        EndReason::ReadFailed => "\r\n[terminal output read failed; process may still be running]\r\n".to_string(),
    }
}
/// Prefer the pinned config binary and refuse stale probed paths after a pin change.
fn login_binary(a: &serde_json::Value) -> Result<&str, String> {
    let pinned = a["config"]["binary"].as_str();
    let probed = a["binary"]["path"].as_str();
    match (pinned, probed) {
        (Some(p), Some(b)) if p != b && !(Path::new(p).canonicalize().ok().zip(Path::new(b).canonicalize().ok()).is_some_and(|(p, b)| p == b)) => Err("Re-check this agent to refresh its CLI binding before signing in.".into()),
        (Some(_), Some(b)) => Ok(b),
        (None, Some(b)) => Ok(b),
        _ => Err("Probe this agent to locate its official CLI".into()),
    }
}
/// Poll for child exit without holding the sessions or output mutex.
fn poll_child(child: &Arc<Mutex<Box<dyn Child + Send + Sync>>>, timeout: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let status = child.lock().ok().and_then(|mut c| c.try_wait().ok().flatten());
        if status.is_some() { return status; }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}
/// A terminal may start only in the project's own repository or one of its own agent worktrees.
fn terminal_dir(repo: &str, state_worktrees: &Path, candidate: &str) -> Result<String, String> {
    let c = projects::canonical(candidate);
    let worktrees = projects::canonical(&state_worktrees.to_string_lossy());
    let allowed = c == projects::canonical(repo) || (c.starts_with(&worktrees) && c != worktrees);
    if !allowed || !c.is_dir() { return Err("Terminal directory is outside this project".into()); }
    Ok(c.to_string_lossy().to_string())
}
#[tauri::command]
pub async fn terminal_open(app: tauri::AppHandle, state: State<'_, Desktop>, project: String, kind: String, agent_id: Option<String>, assignment_id: Option<String>) -> Result<String, String> {
    let c = ensure_connection(&state, &project)?;
    let live = request(&c, "/api/state", "GET", None).await?;
    let s = &live["state"];
    let repo = s["project"]["repo"].as_str().ok_or("Project missing")?.to_string();
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let worktrees = projects::state_dir(&data, &project).join("worktrees");
    let cwd = if let Some(id) = assignment_id {
        terminal_dir(&repo, &worktrees, s["assignments"][&id]["worktree"].as_str().ok_or("Assignment has no worktree")?)?
    } else { terminal_dir(&repo, &worktrees, &repo)? };
    let mut cmd;
    let label;
    if kind == "login" {
        let id = agent_id.ok_or("Choose an agent")?;
        let a = &s["agents"][&id];
        if a["config"]["enabled"].as_bool() == Some(false) {
            return Err("Enable this agent or choose another before running its official login".into());
        }
        label = format!("Sign in · {}", a["config"]["name"].as_str().unwrap_or(&id));
        let binary = login_binary(a)?;
        cmd = CommandBuilder::new(binary);
        match a["config"]["adapter"].as_str().unwrap_or("") {
            "codex-cli" => cmd.arg("login"),
            "claude-headless" => cmd.args(["auth", "login"]),
            "cursor-agent-cli" => cmd.arg("login"),
            _ => return Err("This adapter has no native login command".into()),
        }
    } else if kind == "shell" {
        label = if cwd == terminal_dir(&repo, &worktrees, &repo)? { "Project shell".to_string() } else { format!("Worktree · {}", Path::new(&cwd).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()) };
        #[cfg(unix)] { cmd = CommandBuilder::new(std::env::var("SHELL").unwrap_or("/bin/zsh".into())); cmd.arg("-l"); }
        #[cfg(windows)] { cmd = CommandBuilder::new("powershell.exe"); }
    } else { return Err("Unsupported terminal type".into()); }
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    // The control center never gives API keys to a subscription login terminal.
    for k in ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY", "OPENROUTER_API_KEY", "CURSOR_API_KEY"] { cmd.env_remove(k); }
    let pair = native_pty_system().openpty(PtySize { rows: 28, cols: 100, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let (id, output, child_arc, _killer) = state.terminals.insert(&project, &label, pair.master, writer, child)?;
    let thread_id = id.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0; 8192];
        let mut pending = Vec::new();
        let mut read_failed = false;
        // Record then emit under one lock so an attach sees either the chunk or its event, never both.
        let send = |text: String, done: bool, status: Option<ExitStatus>, reason: EndReason| {
            if let Ok(mut o) = output.lock() {
                let seq = o.push(&text);
                if done { o.finish(status, reason); }
                let _ = app.emit("terminal-output", Output {
                    project: project.clone(),
                    id: thread_id.clone(),
                    text,
                    seq,
                    exited: done,
                    exit_code: if done && reason == EndReason::ProcessExit { o.exit_code } else { None },
                    exit_signal: if done && reason == EndReason::ProcessExit { o.exit_signal.clone() } else { None },
                    output_ended: done && reason == EndReason::OutputEnded,
                    read_failed: done && reason == EndReason::ReadFailed,
                });
            }
        };
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let text = decode_output(&mut pending, false);
                    if !text.is_empty() { send(text, false, None, EndReason::ProcessExit); }
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(_) => { read_failed = true; break; }
            }
        }
        let tail = decode_output(&mut pending, true);
        let (reason, status) = if let Some(s) = poll_child(&child_arc, Duration::from_secs(2)) {
            (EndReason::ProcessExit, Some(s))
        } else if read_failed {
            (EndReason::ReadFailed, None)
        } else {
            // PTY output ended but the child may still be running.
            (EndReason::OutputEnded, None)
        };
        let needs_reap = status.is_none();
        let end_line = format_end(reason, status.as_ref());
        send(format!("{tail}{end_line}"), true, status, reason);
        // Losing the output stream must not lose process ownership or leave an unreaped child.
        // Polling releases the child mutex on every attempt; the independent killer remains usable.
        if needs_reap {
            loop {
                if let Some(status) = poll_child(&child_arc, Duration::from_secs(2)) {
                    send(format_exit(Some(&status)), true, Some(status), EndReason::ProcessExit);
                    break;
                }
            }
        }
    });
    Ok(id)
}
#[tauri::command]
pub fn terminal_list(state: State<'_, Desktop>, project: String) -> Vec<SessionView> { state.terminals.list(&project) }
#[tauri::command]
pub fn terminal_attach(state: State<'_, Desktop>, project: String, id: String) -> Result<Attached, String> { state.terminals.attach(&project, &id) }
#[tauri::command]
pub fn terminal_write(state: State<'_, Desktop>, project: String, id: String, text: String) -> Result<(), String> { state.terminals.write(&project, &id, &text) }
#[tauri::command]
pub fn terminal_resize(state: State<'_, Desktop>, project: String, id: String, rows: u16, cols: u16) -> Result<(), String> { state.terminals.resize(&project, &id, rows, cols) }
#[tauri::command]
pub fn terminal_close(state: State<'_, Desktop>, project: String, id: String) -> Result<(), String> { state.terminals.close(&project, &id) }
#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Debug)]
    struct FailFirstStops { inner: Box<dyn ChildKiller + Send + Sync>, remaining: Arc<AtomicU64> }
    impl ChildKiller for FailFirstStops {
        fn kill(&mut self) -> std::io::Result<()> {
            if self.remaining.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1)).is_ok() {
                return Err(std::io::Error::new(ErrorKind::PermissionDenied, "fixture denied stop"));
            }
            self.inner.kill()
        }
        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(Self { inner: self.inner.clone_killer(), remaining: self.remaining.clone() })
        }
    }
    #[test]
    #[cfg(unix)]
    fn failed_stops_keep_live_sessions_and_batch_stop_attempts_every_target() {
        let terminals = Terminals::default();
        let open = |project: &str| {
            let pair = native_pty_system().openpty(PtySize { rows: 20, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
            let child = pair.slave.spawn_command(CommandBuilder::new("/bin/cat")).unwrap();
            drop(pair.slave);
            let writer = pair.master.take_writer().unwrap();
            terminals.insert(project, "Project shell", pair.master, writer, child).unwrap()
        };
        let (failed, output, child, _) = open("project-a");
        let (healthy, _, _, _) = open("project-a");
        let (other, _, _, _) = open("project-b");
        {
            let mut sessions = terminals.sessions.lock().unwrap();
            let session = sessions.get_mut(&failed).unwrap();
            let inner = session.killer.lock().unwrap().clone_killer();
            session.killer = Arc::new(Mutex::new(Box::new(FailFirstStops { inner, remaining: Arc::new(AtomicU64::new(2)) })));
        }
        output.lock().unwrap().push("retained output");
        assert!(terminals.close("project-a", &failed).unwrap_err().contains("retained for retry"));
        assert_eq!(terminals.attach("project-a", &failed).unwrap().text, "retained output");
        assert!(child.lock().unwrap().try_wait().unwrap().is_none(), "failed stop must leave a real live child owned");
        let error = terminals.close_project("project-a").unwrap_err();
        assert!(error.contains("Closed 1 terminal sessions"));
        assert_eq!(terminals.count("project-a"), 1);
        assert!(terminals.attach("project-a", &healthy).is_err());
        assert!(terminals.attach("project-b", &other).is_ok(), "project stop must not reach another project");
        assert_eq!(terminals.close_all().unwrap(), 2);
        let deadline = Instant::now() + Duration::from_secs(2);
        while child.lock().unwrap().try_wait().unwrap().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(child.lock().unwrap().try_wait().unwrap().is_some(), "retry should actually terminate the child");
        assert_eq!(terminals.count("project-a"), 0);
        assert_eq!(terminals.count("project-b"), 0);
    }
    #[test] fn output_survives_split_unicode_and_invalid_bytes() {
        let mut p = vec![b'a', 0xe2];
        assert_eq!(decode_output(&mut p, false), "a");
        p.extend_from_slice(&[0x9c, 0x93, 0xff, b'b']);
        assert_eq!(decode_output(&mut p, false), "✓\u{FFFD}b");
        p.push(0xe2);
        assert_eq!(decode_output(&mut p, true), "\u{FFFD}");
        assert!(p.is_empty());
    }
    #[test] fn exit_message_reports_code_or_honest_unknown() {
        assert!(format_exit(Some(&ExitStatus::with_exit_code(0))).contains("code 0"));
        assert!(format_exit(Some(&ExitStatus::with_exit_code(2))).contains("code 2"));
        assert!(format_exit(Some(&ExitStatus::with_signal("SIGTERM"))).contains("signal SIGTERM"));
        assert_eq!(format_exit(None), "\r\n[terminal session ended]\r\n");
        assert!(format_end(EndReason::OutputEnded, None).contains("may still be running"));
        assert!(format_end(EndReason::ReadFailed, None).contains("read failed"));
    }
    #[test] fn login_binary_prefers_pin_and_refuses_stale_probe() {
        let stale = serde_json::json!({ "config": { "binary": "/new/cli" }, "binary": { "path": "/old/cli" } });
        assert!(login_binary(&stale).unwrap_err().contains("Re-check"));
        let pinned = serde_json::json!({ "config": { "binary": "/new/cli" }, "binary": { "path": "/new/cli" } });
        assert_eq!(login_binary(&pinned).unwrap(), "/new/cli");
        let probed = serde_json::json!({ "config": {}, "binary": { "path": "/probed/cli" } });
        assert_eq!(login_binary(&probed).unwrap(), "/probed/cli");
    }
    #[test] fn session_view_serializes_camel_case_exit_metadata() {
        let view = SessionView { id: "terminal-1".into(), label: "shell".into(), exited: true, exit_code: Some(0), exit_signal: None, output_ended: false, read_failed: false };
        let json = serde_json::to_value(view).unwrap();
        assert_eq!(json["exitCode"], 0);
        assert!(json.get("exit_code").is_none());
        assert_eq!(json["outputEnded"], false);
    }
    #[test]
    #[cfg(unix)]
    fn real_pty_runs_and_resizes() {
        let pair = native_pty_system().openpty(PtySize { rows: 20, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        pair.master.resize(PtySize { rows: 30, cols: 100, pixel_width: 0, pixel_height: 0 }).unwrap();
        assert_eq!(pair.master.get_size().unwrap().cols, 100);
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "printf '\\342\\234\\223\\n'"]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        // A PTY master can remain open after the child exits. Read the expected frame rather
        // than waiting for EOF on the terminal device.
        let mut bytes = [0; 5];
        reader.read_exact(&mut bytes).unwrap();
        assert_eq!(std::str::from_utf8(&bytes).unwrap(), "✓\r\n");
        assert!(child.wait().unwrap().success());
    }
    #[test]
    #[cfg(unix)]
    fn real_pty_reports_exit_code() {
        let pair = native_pty_system().openpty(PtySize { rows: 20, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "exit 7"]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut buf = [0u8; 64];
        while reader.read(&mut buf).unwrap_or(0) > 0 {}
        assert_eq!(child.wait().unwrap().exit_code(), 7);
    }
    #[test]
    #[cfg(unix)]
    fn sessions_belong_to_one_project() {
        let terminals = Terminals::default();
        let pair = native_pty_system().openpty(PtySize { rows: 20, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let child = pair.slave.spawn_command(CommandBuilder::new("/bin/cat")).unwrap();
        drop(pair.slave);
        let writer = pair.master.take_writer().unwrap();
        let (id, output, _, _) = terminals.insert("project-a", "Project shell", pair.master, writer, child).unwrap();
        assert!(terminals.write("project-b", &id, "x").unwrap_err().contains("another project"));
        assert!(terminals.resize("project-b", &id, 10, 10).is_err());
        assert!(terminals.close("project-b", &id).is_err());
        assert!(terminals.attach("project-b", &id).is_err());
        assert!(terminals.list("project-b").is_empty());
        output.lock().unwrap().push("hello");
        let attached = terminals.attach("project-a", &id).unwrap();
        assert_eq!((attached.text.as_str(), attached.seq), ("hello", 1));
        assert_eq!(terminals.list("project-a")[0].label, "Project shell");
        terminals.write("project-a", &id, "ok\n").unwrap();
        terminals.resize("project-a", &id, 24, 90).unwrap();
        assert_eq!(terminals.count("project-a"), 1);
        assert_eq!(terminals.close_project("project-b").unwrap(), 0);
        assert_eq!(terminals.close_project("project-a").unwrap(), 1);
        assert!(terminals.write("project-a", &id, "x").is_err());
    }
    #[test]
    #[cfg(unix)]
    fn write_and_resize_fail_after_exit() {
        let terminals = Terminals::default();
        let pair = native_pty_system().openpty(PtySize { rows: 20, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "exit 0"]);
        let child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let writer = pair.master.take_writer().unwrap();
        let (id, output, _, _) = terminals.insert("project-a", "Project shell", pair.master, writer, child).unwrap();
        output.lock().unwrap().finish(Some(ExitStatus::with_exit_code(0)), EndReason::ProcessExit);
        assert_eq!(terminals.write("project-a", &id, "x").unwrap_err(), "Terminal exited");
        assert_eq!(terminals.resize("project-a", &id, 10, 10).unwrap_err(), "Terminal exited");
    }
    #[test] fn scrollback_is_bounded_on_char_boundaries() {
        let mut s = Scrollback::default();
        s.push("✓");
        s.push(&"x".repeat(SCROLLBACK));
        assert!(s.text.len() <= SCROLLBACK);
        assert_eq!(s.seq, 2);
        assert!(s.text.chars().all(|c| c == 'x'));
    }
    #[test]
    #[cfg(unix)]
    fn close_completes_when_pty_output_ends_before_child() {
        let terminals = Terminals::default();
        let pair = native_pty_system().openpty(PtySize { rows: 20, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        // A macOS session leader retains its controlling terminal even after redirecting stdio.
        // This fixture needs actual slave EOF while the child remains alive; avoid that extra
        // kernel reference in the fixture only. Production shells keep controlling terminals.
        command.set_controlling_tty(false);
        command.args(["-c", "exec 0</dev/null 1>/dev/null 2>/dev/null; exec sleep 30"]);
        let child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().unwrap();
        let writer = pair.master.take_writer().unwrap();
        let (id, output, child_arc, killer) = terminals.insert("project-a", "Project shell", pair.master, writer, child).unwrap();
        let output_clone = output.clone();
        let child_clone = child_arc.clone();
        let reader_done = Arc::new(AtomicU64::new(0));
        let reader_flag = reader_done.clone();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 256];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(_) => continue,
                    Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            reader_flag.store(1, Ordering::Relaxed);
            let still_running = child_clone.lock().ok().and_then(|mut c| c.try_wait().ok().flatten()).is_none();
            if still_running {
                if let Ok(mut o) = output_clone.lock() { o.finish(None, EndReason::OutputEnded); }
            }
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if reader_done.load(Ordering::Relaxed) > 0 { break; }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(reader_done.load(Ordering::Relaxed) > 0, "real PTY reader must finish before the child process");
        assert!(child_arc.lock().unwrap().try_wait().ok().flatten().is_none(), "child should still be running");
        let started = Instant::now();
        assert!(terminals.close("project-a", &id).is_ok());
        assert!(started.elapsed() < Duration::from_secs(2), "close must not block on child wait");
        let _ = killer.lock().unwrap().kill();
        if reader_done.load(Ordering::Relaxed) > 0 {
            assert!(output.lock().unwrap().output_ended, "reader should distinguish output end from process exit");
        }
    }
    #[test]
    fn terminal_directories_stay_inside_the_project() {
        let base = std::env::temp_dir().join(format!("acc-term-{}", projects::random_id()));
        let repo = base.join("repo");
        let worktrees = base.join("state/worktrees");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::create_dir_all(worktrees.join("p/agent-1")).unwrap();
        std::fs::create_dir_all(base.join("other")).unwrap();
        let r = repo.to_string_lossy().to_string();
        assert!(terminal_dir(&r, &worktrees, &r).is_ok());
        assert!(terminal_dir(&r, &worktrees, &worktrees.join("p/agent-1").to_string_lossy()).is_ok());
        assert!(terminal_dir(&r, &worktrees, &worktrees.to_string_lossy()).is_err());
        assert!(terminal_dir(&r, &worktrees, &base.join("other").to_string_lossy()).is_err());
        assert!(terminal_dir(&r, &worktrees, &repo.join("../other").to_string_lossy()).is_err());
        assert!(terminal_dir(&r, &worktrees, &repo.join("src").to_string_lossy()).is_err());
    }
}
