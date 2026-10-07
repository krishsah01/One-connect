// SPDX-License-Identifier: Apache-2.0
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize, Child};
use serde::Serialize;
use std::{collections::HashMap, io::{Read, Write}, path::Path, sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex}};
use tauri::{Emitter, Manager, State};
use super::{ensure_connection, projects, request, Desktop};
const SCROLLBACK: usize = 256 * 1024;
/// Bounded output kept so a project's terminals can be reattached after switching back to it.
/// `seq` counts emitted chunks; an attach returns the seq it covers so live events are not duplicated.
#[derive(Default)]
pub struct Scrollback { text: String, seq: u64, exited: bool }
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
}
struct Session { project: String, label: String, master: Box<dyn MasterPty + Send>, writer: Box<dyn Write + Send>, child: Box<dyn Child + Send + Sync>, output: Arc<Mutex<Scrollback>> }
#[derive(Serialize)]
pub struct SessionView { id: String, label: String, exited: bool }
#[derive(Serialize)]
pub struct Attached { text: String, seq: u64, exited: bool }
/// Native terminals. Every session belongs to one project; calls naming another project are refused.
#[derive(Default)]
pub struct Terminals { sessions: Mutex<HashMap<String, Session>>, next: AtomicU64 }
impl Terminals {
    pub fn close_all(&self) { if let Ok(mut sessions) = self.sessions.lock() { for (_, mut s) in sessions.drain() { let _ = s.child.kill(); } } }
    pub fn close_project(&self, project: &str) -> usize {
        let Ok(mut sessions) = self.sessions.lock() else { return 0 };
        let ids: Vec<String> = sessions.iter().filter(|(_, s)| s.project == project).map(|(id, _)| id.clone()).collect();
        for id in &ids { if let Some(mut s) = sessions.remove(id) { let _ = s.child.kill(); } }
        ids.len()
    }
    pub fn count(&self, project: &str) -> usize { self.sessions.lock().map(|s| s.values().filter(|x| x.project == project).count()).unwrap_or(0) }
    fn insert(&self, project: &str, label: &str, master: Box<dyn MasterPty + Send>, writer: Box<dyn Write + Send>, child: Box<dyn Child + Send + Sync>) -> Result<(String, Arc<Mutex<Scrollback>>), String> {
        let id = format!("terminal-{}", self.next.fetch_add(1, Ordering::Relaxed));
        let output = Arc::new(Mutex::new(Scrollback::default()));
        self.sessions.lock().map_err(|_| "Terminal state unavailable")?.insert(id.clone(), Session { project: project.into(), label: label.into(), master, writer, child, output: output.clone() });
        Ok((id, output))
    }
    pub fn list(&self, project: &str) -> Vec<SessionView> {
        let Ok(sessions) = self.sessions.lock() else { return vec![] };
        let mut out: Vec<SessionView> = sessions.iter().filter(|(_, s)| s.project == project).map(|(id, s)| SessionView { id: id.clone(), label: s.label.clone(), exited: s.output.lock().map(|o| o.exited).unwrap_or(true) }).collect();
        out.sort_by_key(|s| s.id.trim_start_matches("terminal-").parse::<u64>().unwrap_or(0));
        out
    }
    pub fn attach(&self, project: &str, id: &str) -> Result<Attached, String> {
        self.with(project, id, |s| { let o = s.output.lock().map_err(|_| "Terminal state unavailable")?; Ok(Attached { text: o.text.clone(), seq: o.seq, exited: o.exited }) })
    }
    fn with<T>(&self, project: &str, id: &str, f: impl FnOnce(&mut Session) -> Result<T, String>) -> Result<T, String> {
        let mut sessions = self.sessions.lock().map_err(|_| "Terminal state unavailable")?;
        let s = sessions.get_mut(id).ok_or("Terminal closed")?;
        if s.project != project { return Err("This terminal belongs to another project".into()); }
        f(s)
    }
    pub fn write(&self, project: &str, id: &str, text: &str) -> Result<(), String> {
        if text.len() > 64_000 { return Err("Input too large".into()); }
        self.with(project, id, |s| s.writer.write_all(text.as_bytes()).and_then(|_| s.writer.flush()).map_err(|e| e.to_string()))
    }
    pub fn resize(&self, project: &str, id: &str, rows: u16, cols: u16) -> Result<(), String> {
        self.with(project, id, |s| s.master.resize(PtySize { rows: rows.clamp(2, 200), cols: cols.clamp(2, 500), pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string()))
    }
    pub fn close(&self, project: &str, id: &str) -> Result<(), String> {
        self.with(project, id, |_| Ok(()))?;
        if let Some(mut s) = self.sessions.lock().map_err(|_| "Terminal state unavailable")?.remove(id) { s.child.kill().map_err(|e| e.to_string())?; }
        Ok(())
    }
}
#[derive(Clone, Serialize)]
struct Output { project: String, id: String, text: String, seq: u64 }
fn decode_output(pending: &mut Vec<u8>, eof: bool) -> String {
    let mut text = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(s) => { text.push_str(s); pending.clear(); break; }
            Err(e) => {
                let valid = e.valid_up_to();
                text.push_str(&String::from_utf8_lossy(&pending[..valid]));
                pending.drain(..valid);
                if let Some(invalid) = e.error_len() { text.push('�'); pending.drain(..invalid); }
                else { if eof { text.push_str(&String::from_utf8_lossy(pending)); pending.clear(); } break; }
            }
        }
    }
    text
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
        label = format!("Sign in · {}", a["config"]["name"].as_str().unwrap_or(&id));
        let binary = a["binary"]["path"].as_str().or_else(|| a["config"]["binary"].as_str()).ok_or("Probe this agent to locate its official CLI")?;
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
    let (id, output) = state.terminals.insert(&project, &label, pair.master, writer, child)?;
    let thread_id = id.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0; 8192];
        let mut pending = Vec::new();
        // Record then emit under one lock so an attach sees either the chunk or its event, never both.
        let send = |text: String, done: bool| {
            if let Ok(mut o) = output.lock() {
                let seq = o.push(&text);
                if done { o.exited = true; }
                let _ = app.emit("terminal-output", Output { project: project.clone(), id: thread_id.clone(), text, seq });
            }
        };
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let text = decode_output(&mut pending, false);
                    if !text.is_empty() { send(text, false); }
                }
            }
        }
        let tail = decode_output(&mut pending, true);
        send(format!("{tail}\r\n[terminal exited]\r\n"), true);
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
    #[test] fn output_survives_split_unicode_and_invalid_bytes() {
        let mut p = vec![b'a', 0xe2];
        assert_eq!(decode_output(&mut p, false), "a");
        p.extend_from_slice(&[0x9c, 0x93, 0xff, b'b']);
        assert_eq!(decode_output(&mut p, false), "✓�b");
        p.push(0xe2);
        assert_eq!(decode_output(&mut p, true), "�");
        assert!(p.is_empty());
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
    fn sessions_belong_to_one_project() {
        let terminals = Terminals::default();
        let pair = native_pty_system().openpty(PtySize { rows: 20, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let child = pair.slave.spawn_command(CommandBuilder::new("/bin/cat")).unwrap();
        drop(pair.slave);
        let writer = pair.master.take_writer().unwrap();
        let (id, output) = terminals.insert("project-a", "Project shell", pair.master, writer, child).unwrap();
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
        assert_eq!(terminals.close_project("project-b"), 0);
        assert_eq!(terminals.close_project("project-a"), 1);
        assert!(terminals.write("project-a", &id, "x").is_err());
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
