// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Durable project registry and the native approval gate for outbound/irreversible intake actions.
// A project's identity is the SHA-256 of its canonical configuration path, which is also the name
// of its isolated state directory, so registries written by earlier builds keep their data.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs, io::Read, path::{Path, PathBuf}, sync::Mutex, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};

pub const DEMO: &str = "demo";
pub const APPROVAL_TTL: Duration = Duration::from_secs(120);

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntry {
    pub id: String,
    pub name: String,
    pub config: String,
    /// Canonical repository root. Empty only for an entry migrated from `selected-config` until its first start.
    pub repo: String,
    #[serde(default)]
    pub generated: bool,
    pub added_at: u64,
    #[serde(default)]
    pub last_opened_at: Option<u64>,
    /// Intake inspection recorded when the project was added (frameworks, checks, services, Git state).
    #[serde(default)]
    pub onboarding: Option<Value>,
}

#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub projects: Vec<ProjectEntry>,
    #[serde(default)]
    pub active: Option<String>,
    /// Engines that were running when the app last quit; they are restarted on the next launch.
    #[serde(default)]
    pub running: Vec<String>,
}

pub fn now_secs() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) }
pub fn canonical(p: &str) -> PathBuf { fs::canonicalize(p.trim()).unwrap_or_else(|_| PathBuf::from(p.trim())) }
pub fn project_id(config: &str) -> String { format!("{:x}", Sha256::digest(canonical(config).to_string_lossy().as_bytes())) }
pub fn valid_id(id: &str) -> bool { id == DEMO || (id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())) }
pub fn state_dir(data: &Path, id: &str) -> PathBuf {
    if id == DEMO { data.join("demo/state") } else { data.join("projects").join(id).join("state") }
}

impl Registry {
    fn file(data: &Path) -> PathBuf { data.join("projects.json") }

    /// Load the registry, migrating a pre-registry `selected-config`. A corrupt file is kept aside, not overwritten.
    pub fn load(data: &Path) -> Registry {
        let file = Self::file(data);
        let mut reg = match fs::read_to_string(&file) {
            Ok(raw) => serde_json::from_str::<Registry>(&raw).unwrap_or_else(|_| {
                let _ = fs::rename(&file, data.join(format!("projects.json.corrupt-{}", now_secs())));
                Registry::default()
            }),
            Err(_) => Registry::default(),
        };
        reg.projects.retain(|p| valid_id(&p.id) && p.id != DEMO);
        if reg.projects.is_empty() {
            if let Ok(selected) = fs::read_to_string(data.join("selected-config")) {
                let config = canonical(&selected).to_string_lossy().to_string();
                if !config.is_empty() {
                    let id = project_id(&config);
                    let name = Path::new(&config).parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "Project".into());
                    reg.projects.push(ProjectEntry { id: id.clone(), name, config, repo: String::new(), generated: false, added_at: now_secs(), last_opened_at: None, onboarding: None });
                    reg.active = Some(id);
                }
            }
        }
        let known: Vec<String> = reg.projects.iter().map(|p| p.id.clone()).collect();
        reg.running.retain(|id| id == DEMO || known.contains(id));
        if reg.active.as_deref().is_some_and(|a| a != DEMO && !known.contains(&a.to_string())) { reg.active = None; }
        reg.version = 1;
        reg
    }

    pub fn save(&self, data: &Path) -> Result<(), String> {
        fs::create_dir_all(data).map_err(|e| e.to_string())?;
        let tmp = data.join(format!("projects.json.{}.tmp", std::process::id()));
        let body = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        write_private(&tmp, &body)?;
        fs::rename(&tmp, Self::file(data)).map_err(|e| e.to_string())
    }

    pub fn get(&self, id: &str) -> Option<&ProjectEntry> { self.projects.iter().find(|p| p.id == id) }

    /// Add or update a project. One repository maps to one project so state is never split.
    pub fn upsert(&mut self, entry: ProjectEntry) -> Result<&ProjectEntry, String> {
        if !valid_id(&entry.id) || entry.id == DEMO { return Err("Invalid project identity".into()); }
        if let Some(other) = self.projects.iter().find(|p| p.id != entry.id && !p.repo.is_empty() && p.repo == entry.repo) {
            return Err(format!("This repository is already added as {}", other.name));
        }
        match self.projects.iter().position(|p| p.id == entry.id) {
            Some(i) => { let added = self.projects[i].added_at; self.projects[i] = ProjectEntry { added_at: added, ..entry }; Ok(&self.projects[i]) }
            None => { self.projects.push(entry); Ok(self.projects.last().unwrap()) }
        }
    }

    pub fn remove(&mut self, id: &str) -> Result<ProjectEntry, String> {
        if self.running.iter().any(|r| r == id) { return Err("Stop this project before removing it".into()); }
        let i = self.projects.iter().position(|p| p.id == id).ok_or("Unknown project")?;
        if self.active.as_deref() == Some(id) { self.active = None; }
        Ok(self.projects.remove(i))
    }

    pub fn set_running(&mut self, id: &str, running: bool) {
        self.running.retain(|r| r != id);
        if running { self.running.push(id.to_string()); }
    }

    pub fn activate(&mut self, id: &str) -> Result<(), String> {
        if id != DEMO && self.get(id).is_none() { return Err("Unknown project".into()); }
        self.active = Some(id.to_string());
        if let Some(p) = self.projects.iter_mut().find(|p| p.id == id) { p.last_opened_at = Some(now_secs()); }
        Ok(())
    }
}

pub fn write_private(file: &Path, body: &[u8]) -> Result<(), String> {
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let mut o = fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    o.mode(0o600);
    let mut f = o.open(file).map_err(|e| e.to_string())?;
    f.write_all(body).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; fs::set_permissions(file, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?; }
    Ok(())
}

pub fn random_id() -> String {
    let mut bytes = [0u8; 16];
    if fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes)).is_err() {
        bytes.copy_from_slice(&Sha256::digest(format!("{:?}{}", Instant::now(), std::process::id()).as_bytes())[..16]);
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Clone, Debug)]
pub struct PendingAction { pub kind: String, pub digest: String, pub args: Vec<String>, pub expires: Instant }

/// Human approvals for an exact intake action. Each is bound to the plan digest, expires, and is
/// removed on first use whether or not it succeeds.
#[derive(Default)]
pub struct Gate { pending: Mutex<HashMap<String, PendingAction>> }

impl Gate {
    pub fn create(&self, kind: &str, digest: &str, args: Vec<String>, ttl: Duration) -> Result<String, String> {
        if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("Invalid plan digest".into()); }
        let mut pending = self.pending.lock().map_err(|_| "Approval state unavailable")?;
        let now = Instant::now();
        pending.retain(|_, p| p.expires > now);
        let id = random_id();
        pending.insert(id.clone(), PendingAction { kind: kind.into(), digest: digest.into(), args, expires: now + ttl });
        Ok(id)
    }

    pub fn consume(&self, id: &str, kind: &str, digest: &str) -> Result<PendingAction, String> {
        let p = self.pending.lock().map_err(|_| "Approval state unavailable")?.remove(id).ok_or("Approval missing, expired or already used")?;
        if p.kind != kind { return Err("Approval is for a different action".into()); }
        if p.expires <= Instant::now() { return Err("Approval expired. Review the plan again.".into()); }
        if p.digest != digest { return Err("Approval does not match this plan".into()); }
        Ok(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("acc-registry-{name}-{}", random_id()));
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn entry(config: &str, repo: &str) -> ProjectEntry {
        ProjectEntry { id: project_id(config), name: "p".into(), config: config.into(), repo: repo.into(), generated: true, added_at: 1, last_opened_at: None, onboarding: None }
    }

    #[test]
    fn ids_match_existing_state_directories() {
        let data = Path::new("/tmp/acc-data");
        let id = project_id("/tmp/one.yaml\n");
        assert_eq!(id, project_id("/tmp/one.yaml"));
        assert!(valid_id(&id));
        assert_eq!(state_dir(data, &id), data.join("projects").join(&id).join("state"));
        assert_eq!(state_dir(data, DEMO), data.join("demo/state"));
        for bad in ["", "../x", "ABC", &"g".repeat(64)] { assert!(!valid_id(bad)); }
    }

    #[test]
    fn registry_survives_restart_with_private_permissions_and_migrates_selected_config() {
        let data = temp("persist");
        let cfg = data.join("legacy.yaml");
        fs::write(&cfg, "project: {}").unwrap();
        fs::write(data.join("selected-config"), cfg.to_string_lossy().as_bytes()).unwrap();
        let mut reg = Registry::load(&data);
        assert_eq!(reg.projects.len(), 1);
        let legacy = reg.projects[0].id.clone();
        assert_eq!(reg.active.as_deref(), Some(legacy.as_str()));
        reg.upsert(entry("/tmp/a.yaml", "/repos/a")).unwrap();
        reg.set_running(&legacy, true);
        reg.save(&data).unwrap();
        #[cfg(unix)]
        { use std::os::unix::fs::PermissionsExt; assert_eq!(fs::metadata(data.join("projects.json")).unwrap().permissions().mode() & 0o777, 0o600); }
        let again = Registry::load(&data);
        assert_eq!(again, Registry { version: 1, ..reg });
        assert_eq!(again.running, vec![legacy]);
    }

    #[test]
    fn one_repository_maps_to_one_project_and_running_projects_cannot_be_removed() {
        let mut reg = Registry::default();
        reg.upsert(entry("/tmp/a.yaml", "/repos/a")).unwrap();
        assert!(reg.upsert(entry("/tmp/b.yaml", "/repos/a")).unwrap_err().contains("already added"));
        let a = project_id("/tmp/a.yaml");
        reg.upsert(ProjectEntry { name: "renamed".into(), added_at: 99, ..entry("/tmp/a.yaml", "/repos/a") }).unwrap();
        assert_eq!(reg.get(&a).unwrap().name, "renamed");
        assert_eq!(reg.get(&a).unwrap().added_at, 1);
        reg.activate(&a).unwrap();
        reg.set_running(&a, true);
        assert!(reg.remove(&a).is_err());
        reg.set_running(&a, false);
        reg.remove(&a).unwrap();
        assert_eq!(reg.active, None);
        assert!(reg.activate("f".repeat(64).as_str()).is_err());
    }

    #[test]
    fn corrupt_registry_is_kept_aside() {
        let data = temp("corrupt");
        fs::write(data.join("projects.json"), "{not json").unwrap();
        let reg = Registry::load(&data);
        assert!(reg.projects.is_empty());
        assert!(fs::read_dir(&data).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("projects.json.corrupt-")));
    }

    #[test]
    fn approvals_are_digest_bound_single_use_and_expire() {
        let gate = Gate::default();
        let digest = "a".repeat(64);
        assert!(gate.create("clone", "short", vec![], APPROVAL_TTL).is_err());
        let id = gate.create("clone", &digest, vec!["url".into()], APPROVAL_TTL).unwrap();
        assert!(gate.consume(&id, "clone", &"b".repeat(64)).is_err());
        assert!(gate.consume(&id, "clone", &digest).is_err(), "a failed attempt consumes the approval");
        let id = gate.create("clone", &digest, vec![], APPROVAL_TTL).unwrap();
        assert!(gate.consume(&id, "git-init", &digest).is_err());
        let id = gate.create("clone", &digest, vec!["u".into()], APPROVAL_TTL).unwrap();
        assert_eq!(gate.consume(&id, "clone", &digest).unwrap().args, vec!["u".to_string()]);
        assert!(gate.consume(&id, "clone", &digest).is_err());
        let id = gate.create("clone", &digest, vec![], Duration::from_millis(0)).unwrap();
        assert!(gate.consume(&id, "clone", &digest).unwrap_err().contains("expired"));
    }
}
