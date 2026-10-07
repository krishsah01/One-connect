// SPDX-License-Identifier: Apache-2.0
// Native bounded file helper, also usable by the strip-only Node CLI via ACC_NATIVE_FILE_HELPER.
// libuv treats Darwin's O_NOFOLLOW_ANY bit as its own flag and rejects it, so Node must not emulate
// this protection with path checks. This mode starts before Tauri, with no IPC or daemon startup.
use std::{ffi::CString, fs::File, io::{Read, Write}, os::fd::{FromRawFd, AsRawFd}, os::unix::fs::MetadataExt, path::Path};
unsafe extern "C" { fn open(path: *const std::os::raw::c_char, flags: i32, ...) -> i32; fn openat(fd: i32, path: *const std::os::raw::c_char, flags: i32, ...) -> i32; }
#[cfg(target_os = "macos")] const NOFOLLOW: i32 = 0x100;
#[cfg(target_os = "macos")] const DIRECTORY: i32 = 0x100000;
#[cfg(target_os = "linux")] const NOFOLLOW: i32 = 0x20000;
#[cfg(target_os = "linux")] const DIRECTORY: i32 = 0x10000;

fn contained(root: &str, rel: &str, write: bool) -> Result<File, String> {
    if !Path::new(root).is_absolute() || rel.starts_with('/') || rel.split('/').any(|p| p.is_empty() || p == "." || p == "..") { return Err("Invalid mock path".into()); }
    let slash = CString::new("/").unwrap();
    let fd = unsafe { open(slash.as_ptr(), DIRECTORY | NOFOLLOW) };
    if fd < 0 { return Err("Cannot open filesystem root".into()); }
    let mut dir = unsafe { File::from_raw_fd(fd) };
    let absolute = format!("{}/{}", root.trim_end_matches('/'), rel);
    let parts: Vec<_> = absolute.split('/').filter(|p| !p.is_empty()).collect();
    for (i, part) in parts.iter().enumerate() {
        let name = CString::new(*part).map_err(|_| "Invalid mock path")?;
        let last = i == parts.len() - 1;
        // O_NONBLOCK prevents a FIFO swap from hanging before the regular-file check.
        #[cfg(target_os = "macos")] let nonblock = 4;
        #[cfg(target_os = "linux")] let nonblock = 0x800;
        let flags = NOFOLLOW | if last { nonblock | if write { 2 } else { 0 } } else { DIRECTORY };
        let fd = unsafe { openat(dir.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 { return Err("Mock path changed or became a symlink".into()); }
        dir = unsafe { File::from_raw_fd(fd) };
    }
    Ok(dir)
}
fn snapshot(file: &mut File, max: usize, after_open: impl FnOnce()) -> Result<Vec<u8>, String> {
    let before = file.metadata().map_err(|_| "Cannot inspect mock")?;
    if !before.is_file() || before.len() > max as u64 { return Err("Not a bounded regular mock file".into()); }
    after_open();
    let mut bytes = Vec::with_capacity(before.len() as usize);
    file.take((max + 1) as u64).read_to_end(&mut bytes).map_err(|_| "Cannot read mock")?;
    let after = file.metadata().map_err(|_| "Cannot inspect mock")?;
    if bytes.len() != before.len() as usize || after.len() != before.len() || after.mtime() != before.mtime() || after.mtime_nsec() != before.mtime_nsec() || after.ctime() != before.ctime() || after.ctime_nsec() != before.ctime_nsec() { return Err("Mock changed while reading".into()); }
    Ok(bytes)
}
pub fn run_mode() {
    let args: Vec<_> = std::env::args().collect();
    if !matches!(args.get(1).map(String::as_str), Some("--mock-file-read" | "--mock-file-write")) { return; }
    let result = (|| -> Result<(), String> {
        if args.len() != 5 { return Err("Invalid native mock helper arguments".into()); }
        let max: usize = args[4].parse().map_err(|_| "Invalid mock limit")?;
        if max > 512 * 1024 { return Err("Invalid mock limit".into()); }
        let write = args[1] == "--mock-file-write";
        let mut file = contained(&args[2], &args[3], write)?;
        let current = snapshot(&mut file, max, || {})?;
        if !write { std::io::stdout().write_all(&current).map_err(|_| "Cannot return snapshot")?; return Ok(()); }
        let mut input = Vec::new(); std::io::stdin().take((2 * max + 9) as u64).read_to_end(&mut input).map_err(|_| "Cannot read edit")?;
        if input.len() < 8 { return Err("Invalid edit".into()); }
        let expected_len = u64::from_le_bytes(input[..8].try_into().unwrap()) as usize;
        if expected_len > max || 8 + expected_len > input.len() || input.len() - 8 - expected_len > max { return Err("Invalid edit size".into()); }
        if current != input[8..8 + expected_len] { return Err("Mock changed before saving".into()); }
        use std::io::{Seek, SeekFrom};
        file.seek(SeekFrom::Start(0)).map_err(|_| "Cannot edit mock")?;
        file.set_len(0).map_err(|_| "Cannot edit mock")?;
        file.write_all(&input[8 + expected_len..]).map_err(|_| "Cannot save mock")?;
        Ok(())
    })();
    match result { Ok(()) => std::process::exit(0), Err(e) => { eprintln!("{e}"); std::process::exit(1); } }
}
// This module can be compiled alone with rustc for offline fixtures and CLI use.
#[allow(dead_code)] fn main() { run_mode(); }

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn denies_ancestor_symlink_and_detects_in_place_mutation() {
        use std::os::unix::fs::symlink;
        let root = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("mock-helper-{}", std::process::id()));
        std::fs::create_dir_all(root.join("real")).unwrap();
        std::fs::write(root.join("real/file"), b"safe").unwrap();
        symlink(root.join("real"), root.join("link")).unwrap();
        assert!(contained(root.to_str().unwrap(), "link/file", false).is_err());
        let mut file = contained(root.to_str().unwrap(), "real/file", false).unwrap();
        assert!(snapshot(&mut file, 512, || { std::fs::write(root.join("real/file"), b"changed-content").unwrap(); }).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
