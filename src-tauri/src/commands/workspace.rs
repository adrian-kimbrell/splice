//! Tauri commands for workspace and multi-window management.
//!
//! Commands: get_workspaces, save_workspace, delete_workspace, close_workspace,
//! set_active_workspace_id, reorder_workspaces, add_allowed_root, check_pid_alive,
//! register_window, unregister_window, get_secondary_window_labels.
//!
//! Persistence model: each Tauri window has its own config file on disk.
//!   - main window  → `~/.config/Splice/workspaces.json`
//!   - other windows → `~/.config/Splice/workspaces-{label}.json`
//!
//! Active window labels are tracked in `windows.json` for session restore on next launch.
//!
//! `close_workspace` kills all terminals owned by the workspace and removes their state
//! from `AppState`. `check_pid_alive` is used by the attention system to verify that a
//! Claude process is still running before persisting its session ID.

use crate::state::AppState;
use crate::workspace::layout::Workspace;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;
extern crate libc;

fn config_dir() -> std::path::PathBuf {
    #[cfg(debug_assertions)]
    let name = "Splice-dev";
    #[cfg(not(debug_assertions))]
    let name = "Splice";
    let dir = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(name);
    std::fs::create_dir_all(&dir).ok();
    dir
}

/// Returns the workspace config file path for a given window label.
/// The main window uses the backward-compatible `workspaces.json`;
/// secondary windows use `workspaces-{label}.json`.
fn config_path(label: &str) -> std::path::PathBuf {
    let dir = config_dir();
    if label == "main" {
        dir.join("workspaces.json")
    } else {
        dir.join(format!("workspaces-{}.json", label))
    }
}

fn windows_registry_path() -> std::path::PathBuf {
    config_dir().join("windows.json")
}

/// On-disk format (new). Backward-compatible with old `Vec<Workspace>` via fallback parsing.
#[derive(Debug, Serialize, Deserialize, Default)]
struct WorkspacesFile {
    #[serde(default)]
    active_workspace_id: Option<String>,
    #[serde(default)]
    workspaces: Vec<Workspace>,
}

/// On-disk format for the secondary window registry.
#[derive(Serialize, Deserialize, Default)]
struct WindowsRegistry {
    #[serde(default)]
    labels: Vec<String>,
}

#[derive(Serialize)]
pub struct WorkspacesResponse {
    pub active_workspace_id: Option<String>,
    pub workspaces: Vec<Workspace>,
}

/// Outcome of a lenient parse: whatever entries were readable, plus how many were not.
struct ParsedWorkspaces {
    file: WorkspacesFile,
    skipped: usize,
}

/// Parse a workspaces file entry-by-entry so one bad workspace (hand edit, a
/// variant from a newer build) cannot take the whole session down with it.
/// Accepts both the object format and the legacy bare-array format.
/// Returns `Err` only when the document itself is unusable.
fn parse_workspaces_lenient(data: &str) -> Result<ParsedWorkspaces, String> {
    let value: serde_json::Value =
        serde_json::from_str(data).map_err(|e| format!("invalid JSON: {}", e))?;
    let (active_workspace_id, entries) = match value {
        serde_json::Value::Object(mut map) => {
            let active = map
                .remove("active_workspace_id")
                .and_then(|v| v.as_str().map(str::to_string));
            let entries = match map.remove("workspaces") {
                Some(serde_json::Value::Array(a)) => a,
                None => Vec::new(),
                Some(_) => return Err("`workspaces` is not an array".to_string()),
            };
            (active, entries)
        }
        serde_json::Value::Array(a) => (None, a),
        _ => return Err("not a JSON object or array".to_string()),
    };

    let mut workspaces = Vec::with_capacity(entries.len());
    let mut skipped = 0usize;
    for entry in entries {
        let id = entry
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("<no id>")
            .to_string();
        match serde_json::from_value::<Workspace>(entry) {
            Ok(ws) => workspaces.push(ws),
            Err(e) => {
                skipped += 1;
                tracing::warn!(id = %id, error = %e, "skipping unparseable workspace entry");
            }
        }
    }
    Ok(ParsedWorkspaces {
        file: WorkspacesFile { active_workspace_id, workspaces },
        skipped,
    })
}

/// Path a damaged workspaces file is preserved under, next to the original.
fn quarantine_path(path: &std::path::Path) -> std::path::PathBuf {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "workspaces.json".to_string());
    path.with_file_name(format!("{}.corrupt-{}", name, ts))
}

/// Interpret the contents of a workspaces file at `path`.
///
/// - Fully unparseable: the file is *moved aside* to `<name>.corrupt-<ts>` and an
///   error is returned. Nothing may ever write over a file we could not read.
/// - Partially parseable: a copy is kept at `<name>.corrupt-<ts>` (the next save
///   will rewrite the file without the skipped entries) and the good entries load.
fn read_workspaces_data(path: &std::path::Path, data: &str) -> Result<WorkspacesFile, String> {
    match parse_workspaces_lenient(data) {
        Ok(parsed) => {
            if parsed.skipped > 0 {
                let backup = quarantine_path(path);
                match std::fs::copy(path, &backup) {
                    Ok(_) => tracing::warn!(
                        skipped = parsed.skipped,
                        backup = %backup.display(),
                        "workspaces file had unreadable entries; original preserved"
                    ),
                    Err(e) => tracing::warn!(error = %e, "failed to back up workspaces file"),
                }
            }
            Ok(parsed.file)
        }
        Err(e) => {
            let backup = quarantine_path(path);
            match std::fs::rename(path, &backup) {
                Ok(()) => Err(format!(
                    "Failed to parse workspaces file ({}); moved to {}",
                    e,
                    backup.display()
                )),
                Err(re) => Err(format!(
                    "Failed to parse workspaces file ({}); could not move it aside: {}",
                    e, re
                )),
            }
        }
    }
}

fn read_workspaces_file(label: &str) -> Result<WorkspacesFile, String> {
    let path = config_path(label);
    if !path.exists() {
        return Ok(WorkspacesFile::default());
    }
    let data = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    read_workspaces_data(&path, &data)
}

fn write_workspaces_file(
    label: &str,
    workspaces: &[Workspace],
    active_workspace_id: Option<&str>,
) -> Result<(), String> {
    let file = WorkspacesFile {
        active_workspace_id: active_workspace_id.map(|s| s.to_string()),
        workspaces: workspaces.to_vec(),
    };
    let data = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    // Atomic write: write to a temp file then rename to avoid corruption on crash
    let dest = config_path(label);
    let tmp = dest.with_extension("json.tmp");
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())
}

fn read_windows_registry() -> WindowsRegistry {
    let path = windows_registry_path();
    if !path.exists() {
        return WindowsRegistry::default();
    }
    let data = match std::fs::read_to_string(&path) {
        Ok(d) => d,
        Err(_) => return WindowsRegistry::default(),
    };
    serde_json::from_str::<WindowsRegistry>(&data).unwrap_or_else(|e| {
        tracing::debug!("Corrupted windows registry JSON, resetting: {}", e);
        WindowsRegistry::default()
    })
}

fn write_windows_registry(registry: &WindowsRegistry) -> Result<(), String> {
    let data = serde_json::to_string_pretty(registry).map_err(|e| e.to_string())?;
    atomic_write_string(&windows_registry_path(), &data)
}

/// Atomic write via temp+rename. Prevents corruption / dropped state when
/// multiple writers race (e.g. several Splice windows updating windows.json
/// during shutdown). Extracted as a helper so it can be unit-tested with a
/// `tempfile::tempdir`.
fn atomic_write_string(path: &std::path::Path, contents: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Parse the labels of any `workspaces-{label}.json` files in `dir`.
/// Pure helper used by `get_all_workspace_labels` so the disk-scan branch
/// can be unit-tested independently of `config_dir()`.
fn scan_workspace_labels_in_dir(dir: &std::path::Path) -> Vec<String> {
    let mut labels = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = match entry.file_name().into_string() {
                Ok(s) => s,
                Err(_) => continue,
            };
            if let Some(rest) = name.strip_prefix("workspaces-") {
                if let Some(label) = rest.strip_suffix(".json") {
                    if !label.is_empty() {
                        labels.push(label.to_string());
                    }
                }
            }
        }
    }
    labels
}

/// Explicitly grant the app read access to a directory chosen by the user.
/// Called whenever a workspace's root folder changes before reading the tree.
#[tauri::command]
pub fn add_allowed_root(
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<(), String> {
    let canonical = std::fs::canonicalize(&path)
        .unwrap_or_else(|_| std::path::PathBuf::from(&path));
    let mut state = state.lock().map_err(|e| e.to_string())?;
    if !state.allowed_roots.contains(&canonical) {
        state.allowed_roots.push(canonical);
    }
    Ok(())
}

/// Drain paths the OS asked us to open before the frontend was ready.
/// The frontend calls this on startup and again on every `open-path` event.
#[tauri::command]
pub fn take_pending_open_paths(
    state: State<'_, Mutex<AppState>>,
) -> Result<Vec<crate::state::OpenTarget>, String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;
    Ok(std::mem::take(&mut state.pending_open_paths))
}

/// macOS "Open With" handler: buffers the opened file/folder paths, grants read
/// access to each item's root (a file may live outside HOME), then pings the
/// frontend to drain the buffer. Called from the `RunEvent::Opened` loop in lib.rs.
#[cfg(target_os = "macos")]
pub fn handle_opened(app: &tauri::AppHandle, urls: Vec<tauri::Url>) {
    use tauri::{Emitter, Manager};
    let mut any = false;
    if let Ok(mut state) = app.state::<Mutex<AppState>>().lock() {
        for url in urls {
            let Ok(path) = url.to_file_path() else { continue };
            let is_dir = path.is_dir();
            let root = if is_dir {
                path.clone()
            } else {
                path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| path.clone())
            };
            let canonical = std::fs::canonicalize(&root).unwrap_or(root);
            if !state.allowed_roots.contains(&canonical) {
                state.allowed_roots.push(canonical);
            }
            state.pending_open_paths.push(crate::state::OpenTarget {
                path: path.to_string_lossy().into_owned(),
                is_dir,
            });
            any = true;
        }
    }
    if any {
        let _ = app.emit("open-path", ());
    }
}

/// Remove entries from `allowed_roots` that are not in `active_roots`, keeping the
/// process-default roots (the home directory) that `AppState::new` grants.
///
/// Called after a workspace is deleted or closed so the app doesn't retain fs access to
/// directories that are no longer open. Without the `protected` carve-out, closing any
/// workspace dropped HOME from the allow list and every later read outside an open
/// workspace (recent files, "Open File…", project settings) failed with "Access denied".
fn revoke_unused_roots(
    allowed_roots: &mut Vec<std::path::PathBuf>,
    active_roots: &[std::path::PathBuf],
) {
    let protected = default_allowed_roots();
    revoke_unused_roots_except(allowed_roots, active_roots, &protected);
}

/// Roots that are always allowed regardless of open workspaces (currently HOME).
fn default_allowed_roots() -> Vec<std::path::PathBuf> {
    dirs::home_dir()
        .map(|h| std::fs::canonicalize(&h).unwrap_or(h))
        .into_iter()
        .collect()
}

fn revoke_unused_roots_except(
    allowed_roots: &mut Vec<std::path::PathBuf>,
    active_roots: &[std::path::PathBuf],
    protected: &[std::path::PathBuf],
) {
    allowed_roots.retain(|root| protected.contains(root) || active_roots.contains(root));
}

#[tauri::command]
pub fn get_workspaces(
    state: State<'_, Mutex<AppState>>,
    window: tauri::WebviewWindow,
) -> Result<WorkspacesResponse, String> {
    let label = window.label().to_string();

    // Fast path: return cached workspaces if already loaded for this window.
    {
        let state = state.lock().map_err(|e| e.to_string())?;
        if let Some((active_id, workspaces)) = state.window_workspaces.get(&label) {
            if !workspaces.is_empty() {
                return Ok(WorkspacesResponse {
                    active_workspace_id: active_id.clone(),
                    workspaces: workspaces.clone(),
                });
            }
        }
    }

    let file = read_workspaces_file(&label)?;
    let mut s = state.lock().map_err(|e| e.to_string())?;
    {
        let entry = s.window_workspaces.entry(label.clone()).or_insert_with(|| (None, Vec::new()));
        if entry.1.is_empty() {
            *entry = (file.active_workspace_id, file.workspaces);
        }
    }
    let (active_id, workspaces) = s
        .window_workspaces
        .get(&label)
        .map(|(a, w)| (a.clone(), w.clone()))
        .unwrap_or_default();
    Ok(WorkspacesResponse {
        active_workspace_id: active_id,
        workspaces,
    })
}

#[tauri::command]
pub fn save_workspace(
    state: State<'_, Mutex<AppState>>,
    window: tauri::WebviewWindow,
    workspace: Workspace,
) -> Result<(), String> {
    let label = window.label().to_string();
    let (workspaces, active_id) = {
        let mut state = state.lock().map_err(|e| e.to_string())?;

        // Register workspace root as an allowed path.
        if !workspace.root_path.is_empty() {
            let root = std::fs::canonicalize(&workspace.root_path)
                .unwrap_or_else(|_| std::path::PathBuf::from(&workspace.root_path));
            if !state.allowed_roots.contains(&root) {
                state.allowed_roots.push(root);
            }
        }

        let entry = state.window_workspaces.entry(label.clone()).or_insert_with(|| (None, Vec::new()));
        if let Some(existing) = entry.1.iter_mut().find(|w| w.id == workspace.id) {
            *existing = workspace;
        } else {
            entry.1.push(workspace);
        }
        (entry.1.clone(), entry.0.clone())
    };

    write_workspaces_file(&label, &workspaces, active_id.as_deref())
}

#[tauri::command]
pub fn delete_workspace(
    state: State<'_, Mutex<AppState>>,
    window: tauri::WebviewWindow,
    id: String,
) -> Result<(), String> {
    let label = window.label().to_string();
    let (workspaces, active_id) = {
        let mut state = state.lock().map_err(|e| e.to_string())?;

        let (workspaces, active_id, active_roots) = {
            let entry = state.window_workspaces.entry(label.clone()).or_insert_with(|| (None, Vec::new()));
            entry.1.retain(|w| w.id != id);
            if entry.0.as_deref() == Some(&id) {
                entry.0 = entry.1.first().map(|w| w.id.clone());
            }
            let active_roots: Vec<std::path::PathBuf> = entry.1.iter()
                .filter(|w| !w.root_path.is_empty())
                .map(|w| std::fs::canonicalize(&w.root_path)
                    .unwrap_or_else(|_| std::path::PathBuf::from(&w.root_path)))
                .collect();
            (entry.1.clone(), entry.0.clone(), active_roots)
        };

        revoke_unused_roots(&mut state.allowed_roots, &active_roots);
        (workspaces, active_id)
    };

    write_workspaces_file(&label, &workspaces, active_id.as_deref())
}

#[tauri::command]
pub fn close_workspace(
    state: State<'_, Mutex<AppState>>,
    window: tauri::WebviewWindow,
    id: String,
) -> Result<Vec<u32>, String> {
    let label = window.label().to_string();
    let (terminal_ids, workspaces, active_id) = {
        let mut state = state.lock().map_err(|e| e.to_string())?;

        // Get terminal IDs before modifying the workspace list
        let terminal_ids: Vec<u32> = state.window_workspaces.get(&label)
            .and_then(|(_, wss)| wss.iter().find(|w| w.id == id))
            .map(|w| w.terminal_ids.clone())
            .unwrap_or_default();

        // Kill all owned terminals
        for tid in &terminal_ids {
            state.terminals.remove(tid);
            state.terminal_claude_sessions.remove(tid);
        }
        // Modify workspace list and compute active_roots in inner block
        // so that the mutable borrow of window_workspaces is released
        // before we mutably borrow allowed_roots.
        let (workspaces, active_id, active_roots) = {
            let entry = state.window_workspaces.entry(label.clone()).or_insert_with(|| (None, Vec::new()));
            entry.1.retain(|w| w.id != id);
            if entry.0.as_deref() == Some(&id) {
                entry.0 = entry.1.first().map(|w| w.id.clone());
            }
            let active_roots: Vec<std::path::PathBuf> = entry.1.iter()
                .filter(|w| !w.root_path.is_empty())
                .map(|w| std::fs::canonicalize(&w.root_path)
                    .unwrap_or_else(|_| std::path::PathBuf::from(&w.root_path)))
                .collect();
            (entry.1.clone(), entry.0.clone(), active_roots)
        };

        revoke_unused_roots(&mut state.allowed_roots, &active_roots);
        (terminal_ids, workspaces, active_id)
    };

    write_workspaces_file(&label, &workspaces, active_id.as_deref())?;
    Ok(terminal_ids)
}

#[tauri::command]
pub fn set_active_workspace_id(
    state: State<'_, Mutex<AppState>>,
    window: tauri::WebviewWindow,
    id: Option<String>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let (workspaces, active_id) = {
        let mut state = state.lock().map_err(|e| e.to_string())?;
        let entry = state.window_workspaces.entry(label.clone()).or_insert_with(|| (None, Vec::new()));
        entry.0 = id;
        (entry.1.clone(), entry.0.clone())
    };

    write_workspaces_file(&label, &workspaces, active_id.as_deref())
}

#[tauri::command]
pub fn reorder_workspaces(
    state: State<'_, Mutex<AppState>>,
    window: tauri::WebviewWindow,
    ids: Vec<String>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let (workspaces, active_id) = {
        let mut state = state.lock().map_err(|e| e.to_string())?;
        let entry = state.window_workspaces.entry(label.clone()).or_insert_with(|| (None, Vec::new()));

        let mut reordered: Vec<Workspace> = Vec::with_capacity(entry.1.len());
        for id in &ids {
            if let Some(pos) = entry.1.iter().position(|w| &w.id == id) {
                reordered.push(entry.1[pos].clone());
            }
        }
        // Append any workspaces not in the ids list (safety net)
        for ws in &entry.1 {
            if !ids.contains(&ws.id) {
                reordered.push(ws.clone());
            }
        }
        entry.1 = reordered;
        (entry.1.clone(), entry.0.clone())
    };
    write_workspaces_file(&label, &workspaces, active_id.as_deref())
}

/// Register a secondary window label in `windows.json` so it can be restored after a crash.
/// Must be called BEFORE creating the WebviewWindow.
#[tauri::command]
pub fn register_window(label: String) -> Result<(), String> {
    let mut registry = read_windows_registry();
    if !registry.labels.contains(&label) {
        registry.labels.push(label);
    }
    write_windows_registry(&registry)
}

/// Unregister a secondary window on graceful close: remove from registry and delete its workspace file.
#[tauri::command]
pub fn unregister_window(
    state: State<'_, Mutex<AppState>>,
    label: String,
) -> Result<(), String> {
    // Remove from registry
    let mut registry = read_windows_registry();
    registry.labels.retain(|l| l != &label);
    write_windows_registry(&registry)?;

    // Delete the per-window workspace file
    let ws_path = config_path(&label);
    if ws_path.exists() {
        std::fs::remove_file(&ws_path).map_err(|e| e.to_string())?;
    }

    // Clean up in-memory state for this window
    {
        let mut state = state.lock().map_err(|e| e.to_string())?;
        state.window_workspaces.remove(&label);
    }
    Ok(())
}

/// Return the list of registered secondary window labels (non-"main").
/// Used by the main window on startup to reopen windows that survived a crash.
#[tauri::command]
pub fn get_secondary_window_labels() -> Result<Vec<String>, String> {
    Ok(read_windows_registry().labels)
}

/// Return the union of every known workspace label, sorted and deduplicated.
///
/// This combines two sources to recover from crash/race conditions where a
/// `workspaces-{label}.json` file exists on disk but the corresponding label
/// was never persisted to (or was lost from) `windows.json`:
///   1. All labels currently recorded in `windows.json`.
///   2. All labels parsed from filenames matching `workspaces-*.json` in the
///      Splice config directory (the substring between `workspaces-` and `.json`).
///
/// Used by the main window on startup so orphaned per-window workspace files
/// (and the Claude sessions they reference) are restored instead of leaked.
#[tauri::command]
pub fn get_all_workspace_labels() -> Result<Vec<String>, String> {
    let mut labels: Vec<String> = read_windows_registry().labels;
    labels.extend(scan_workspace_labels_in_dir(&config_dir()));
    labels.sort();
    labels.dedup();
    Ok(labels)
}

#[tauri::command]
pub fn check_pid_alive(pid: u32) -> bool {
    is_pid_alive(pid)
}

/// Check whether a process is alive using POSIX `kill(pid, 0)` via libc.
/// Returns true if the process exists (even if we don't own it — EPERM case).
#[cfg(unix)]
fn is_pid_alive(pid: u32) -> bool {
    // SAFETY: kill(pid, 0) is a read-only check — it never delivers a signal.
    let ret = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if ret == 0 {
        return true;
    }
    let errno = std::io::Error::last_os_error()
        .raw_os_error()
        .unwrap_or(0);
    errno == libc::EPERM
}

/// On non-unix targets we cannot check process liveness; conservatively assume alive
/// so that Claude session resume is not silently disabled.
#[cfg(not(unix))]
fn is_pid_alive(_pid: u32) -> bool {
    true
}

#[cfg(test)]
mod tests {
    #[test]
    fn revoke_keeps_protected_roots_when_no_workspace_uses_them() {
        let home = std::path::PathBuf::from("/Users/me");
        let proj = std::path::PathBuf::from("/Users/me/proj");
        let other = std::path::PathBuf::from("/Volumes/ext/other");
        let mut allowed = vec![home.clone(), proj.clone(), other];
        // Only `proj` is still open; `home` must survive because it is protected.
        super::revoke_unused_roots_except(&mut allowed, std::slice::from_ref(&proj), std::slice::from_ref(&home));
        assert_eq!(allowed, vec![home, proj]);
    }

    #[test]
    fn revoke_drops_everything_but_protected_when_last_workspace_closes() {
        let home = std::path::PathBuf::from("/Users/me");
        let mut allowed = vec![home.clone(), std::path::PathBuf::from("/tmp/x")];
        super::revoke_unused_roots_except(&mut allowed, &[], std::slice::from_ref(&home));
        assert_eq!(allowed, vec![home]);
    }

    #[test]
    fn default_allowed_roots_is_home() {
        let roots = super::default_allowed_roots();
        assert_eq!(roots.len(), 1);
        let home = dirs::home_dir().unwrap();
        assert_eq!(roots[0], std::fs::canonicalize(&home).unwrap_or(home));
    }

    use super::*;

    #[test]
    fn current_process_is_alive() {
        assert!(is_pid_alive(std::process::id()));
    }

    #[test]
    #[cfg(unix)]
    fn obviously_dead_pid_is_not_alive() {
        // Spawn a trivial child, reap it, then verify its PID is gone.
        // After wait() the process is reaped so kill(pid, 0) returns ESRCH.
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert!(!is_pid_alive(pid));
    }

    #[test]
    #[cfg(unix)]
    fn pid_one_is_alive() {
        // PID 1 is init/launchd/systemd — always exists
        assert!(is_pid_alive(1));
    }

    // -----------------------------------------------------------------------
    // Restore source-of-truth helpers (workspace label scan + atomic write).
    // These exercise the regression fix for the multi-window restore bug
    // where orphaned per-window state files were silently dropped.
    // -----------------------------------------------------------------------

    #[test]
    fn scan_workspace_labels_picks_up_orphaned_files() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();

        // Three valid per-window files, plus distractors that must NOT match.
        std::fs::write(p.join("workspaces-main-19d2b4f.json"), "{}").unwrap();
        std::fs::write(p.join("workspaces-main-6d855d.json"), "{}").unwrap();
        std::fs::write(p.join("workspaces-secondary.json"), "{}").unwrap();
        // Distractors:
        std::fs::write(p.join("workspaces.json"), "{}").unwrap();         // legacy global file (no label)
        std::fs::write(p.join("workspaces-.json"), "{}").unwrap();        // empty label
        std::fs::write(p.join("settings.json"), "{}").unwrap();           // unrelated file
        std::fs::write(p.join("workspaces-noext"), "{}").unwrap();        // wrong suffix

        let mut labels = scan_workspace_labels_in_dir(p);
        labels.sort();

        assert_eq!(
            labels,
            vec!["main-19d2b4f".to_string(), "main-6d855d".to_string(), "secondary".to_string()],
        );
    }

    #[test]
    fn atomic_write_is_atomic_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("windows.json");

        atomic_write_string(&dest, r#"{"labels":["a","b"]}"#).unwrap();

        // Final file has the right content
        let read_back = std::fs::read_to_string(&dest).unwrap();
        assert_eq!(read_back, r#"{"labels":["a","b"]}"#);

        // No leftover .tmp file
        let tmp = dest.with_extension("json.tmp");
        assert!(!tmp.exists(), "atomic_write_string left a stale .tmp file");

        // Overwrite must also succeed cleanly (rename-over-existing on macOS/Linux).
        atomic_write_string(&dest, r#"{"labels":["c"]}"#).unwrap();
        let read_back2 = std::fs::read_to_string(&dest).unwrap();
        assert_eq!(read_back2, r#"{"labels":["c"]}"#);
        assert!(!tmp.exists());
    }
    // -----------------------------------------------------------------------
    // Lenient workspaces-file parsing: one bad entry must not drop the rest,
    // and a file we cannot read must never be overwritten by the next save.
    // -----------------------------------------------------------------------

    fn ws_json(id: &str) -> String {
        format!(
            r#"{{"id":"{id}","name":"{id}","root_path":"/tmp/{id}","layout":{{"type":"Leaf","pane_id":"p1"}},"panes":[],"terminal_ids":[],"open_file_paths":[],"active_file_path":null}}"#
        )
    }

    #[test]
    fn lenient_parse_reads_object_format() {
        let data = format!(r#"{{"active_workspace_id":"b","workspaces":[{},{}]}}"#, ws_json("a"), ws_json("b"));
        let parsed = parse_workspaces_lenient(&data).unwrap();
        assert_eq!(parsed.skipped, 0);
        assert_eq!(parsed.file.active_workspace_id.as_deref(), Some("b"));
        assert_eq!(parsed.file.workspaces.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
    }

    #[test]
    fn lenient_parse_reads_legacy_array_format() {
        let data = format!("[{}]", ws_json("a"));
        let parsed = parse_workspaces_lenient(&data).unwrap();
        assert_eq!(parsed.file.active_workspace_id, None);
        assert_eq!(parsed.file.workspaces.len(), 1);
    }

    #[test]
    fn lenient_parse_skips_one_bad_entry_and_keeps_the_rest() {
        // `terminal_ids` must be an array of u32 — a string makes this entry unreadable.
        let bad = r#"{"id":"bad","name":"bad","root_path":"/tmp","layout":{"type":"Leaf","pane_id":"p"},"panes":[],"terminal_ids":"oops","open_file_paths":[],"active_file_path":null}"#;
        let data = format!(r#"{{"workspaces":[{},{},{}]}}"#, ws_json("a"), bad, ws_json("c"));
        let parsed = parse_workspaces_lenient(&data).unwrap();
        assert_eq!(parsed.skipped, 1);
        assert_eq!(parsed.file.workspaces.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(), vec!["a", "c"]);
    }

    #[test]
    fn lenient_parse_rejects_unusable_documents() {
        assert!(parse_workspaces_lenient("not json").is_err());
        assert!(parse_workspaces_lenient("42").is_err());
        assert!(parse_workspaces_lenient(r#"{"workspaces":"nope"}"#).is_err());
    }

    #[test]
    fn unparseable_file_is_moved_aside_not_left_for_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspaces.json");
        std::fs::write(&path, "{ this is not json").unwrap();

        let err = read_workspaces_data(&path, "{ this is not json").unwrap_err();
        assert!(err.contains("moved to"), "error should name the backup: {err}");
        assert!(!path.exists(), "original must be moved aside");

        let backups: Vec<_> = std::fs::read_dir(dir.path()).unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with("workspaces.json.corrupt-"))
            .collect();
        assert_eq!(backups.len(), 1);
        let backup = std::fs::read_to_string(dir.path().join(&backups[0])).unwrap();
        assert_eq!(backup, "{ this is not json");
        // The backup must not be mistaken for a per-window workspaces file.
        assert!(scan_workspace_labels_in_dir(dir.path()).is_empty());
    }

    #[test]
    fn partially_readable_file_is_backed_up_and_loaded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspaces-main-abc123.json");
        let bad = r#"{"id":"bad","terminal_ids":"oops"}"#;
        let data = format!(r#"{{"workspaces":[{},{}]}}"#, ws_json("a"), bad);
        std::fs::write(&path, &data).unwrap();

        let file = read_workspaces_data(&path, &data).unwrap();
        assert_eq!(file.workspaces.len(), 1);
        assert!(path.exists(), "original stays in place (next save rewrites it)");
        let backups: Vec<_> = std::fs::read_dir(dir.path()).unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with("workspaces-main-abc123.json.corrupt-"))
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(scan_workspace_labels_in_dir(dir.path()), vec!["main-abc123".to_string()]);
    }
}
