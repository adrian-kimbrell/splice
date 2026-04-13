//! Tauri commands for workspace and multi-window management.
//!
//! Commands: get_workspaces, save_workspace, delete_workspace, close_workspace,
//! set_active_workspace_id, reorder_workspaces, add_allowed_root, check_pid_alive,
//! register_window, unregister_window, get_secondary_window_labels.
//!
//! Persistence model: each Tauri window has its own config file on disk.
//! - main window  → `~/.config/Splice/workspaces.json`
//! - other windows → `~/.config/Splice/workspaces-{label}.json`
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
#[derive(Serialize, Deserialize, Default)]
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

fn read_workspaces_file(label: &str) -> Result<WorkspacesFile, String> {
    let path = config_path(label);
    if !path.exists() {
        return Ok(WorkspacesFile::default());
    }
    let data = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;

    // Try new object format first; fall back to old array format
    if let Ok(file) = serde_json::from_str::<WorkspacesFile>(&data) {
        Ok(file)
    } else if let Ok(workspaces) = serde_json::from_str::<Vec<Workspace>>(&data) {
        Ok(WorkspacesFile {
            active_workspace_id: None,
            workspaces,
        })
    } else {
        Err("Failed to parse workspaces file".to_string())
    }
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
    serde_json::from_str::<WindowsRegistry>(&data).unwrap_or_default()
}

fn write_windows_registry(registry: &WindowsRegistry) -> Result<(), String> {
    let data = serde_json::to_string_pretty(registry).map_err(|e| e.to_string())?;
    std::fs::write(windows_registry_path(), data).map_err(|e| e.to_string())
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

/// Remove entries from `allowed_roots` that are not in `active_roots`.
/// Called after a workspace is deleted or closed so the app doesn't retain fs access to
/// directories that are no longer open.
fn revoke_unused_roots(
    allowed_roots: &mut Vec<std::path::PathBuf>,
    active_roots: &[std::path::PathBuf],
) {
    allowed_roots.retain(|root| active_roots.contains(root));
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
}
