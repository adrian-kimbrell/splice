use crate::state::AppState;
use crate::workspace::layout::Workspace;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;
extern crate libc;

fn config_path() -> std::path::PathBuf {
    let dir = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("Splice");
    std::fs::create_dir_all(&dir).ok();
    dir.join("workspaces.json")
}

/// On-disk format (new). Backward-compatible with old `Vec<Workspace>` via fallback parsing.
#[derive(Serialize, Deserialize, Default)]
struct WorkspacesFile {
    #[serde(default)]
    active_workspace_id: Option<String>,
    #[serde(default)]
    workspaces: Vec<Workspace>,
}

#[derive(Serialize)]
pub struct WorkspacesResponse {
    pub active_workspace_id: Option<String>,
    pub workspaces: Vec<Workspace>,
}

fn read_workspaces_file() -> Result<WorkspacesFile, String> {
    let path = config_path();
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
    workspaces: &[Workspace],
    active_workspace_id: Option<&str>,
) -> Result<(), String> {
    let file = WorkspacesFile {
        active_workspace_id: active_workspace_id.map(|s| s.to_string()),
        workspaces: workspaces.to_vec(),
    };
    let data = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    // Atomic write: write to a temp file then rename to avoid corruption on crash
    let dest = config_path();
    let tmp = dest.with_extension("json.tmp");
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())
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
) -> Result<WorkspacesResponse, String> {
    // Double-checked lock: fast path returns cached workspaces without file I/O.
    // TOCTOU is benign here because save_workspace always updates the in-memory cache
    // before writing to disk — any concurrent save that wins the lock will be reflected
    // in the second lock acquisition below.
    {
        let state = state.lock().map_err(|e| e.to_string())?;
        if !state.workspaces.is_empty() {
            return Ok(WorkspacesResponse {
                active_workspace_id: state.active_workspace_id.clone(),
                workspaces: state.workspaces.clone(),
            });
        }
    }

    let file = read_workspaces_file()?;
    // Populate the in-memory cache if still empty, then return from state so
    // any concurrent save_workspace that won the lock is reflected in the response.
    let mut s = state.lock().map_err(|e| e.to_string())?;
    if s.workspaces.is_empty() {
        s.workspaces = file.workspaces;
        s.active_workspace_id = file.active_workspace_id;
    }
    Ok(WorkspacesResponse {
        active_workspace_id: s.active_workspace_id.clone(),
        workspaces: s.workspaces.clone(),
    })
}

#[tauri::command]
pub fn save_workspace(
    state: State<'_, Mutex<AppState>>,
    workspace: Workspace,
) -> Result<(), String> {
    // Update cache and collect state for writing under lock
    let (workspaces, active_id) = {
        let mut state = state.lock().map_err(|e| e.to_string())?;

        // Register workspace root as an allowed path.
        // Canonicalize so symlinks / relative segments can't bypass the root check.
        if !workspace.root_path.is_empty() {
            let root = std::fs::canonicalize(&workspace.root_path)
                .unwrap_or_else(|_| std::path::PathBuf::from(&workspace.root_path));
            if !state.allowed_roots.contains(&root) {
                state.allowed_roots.push(root);
            }
        }

        if let Some(existing) = state.workspaces.iter_mut().find(|w| w.id == workspace.id) {
            *existing = workspace;
        } else {
            state.workspaces.push(workspace);
        }

        (
            state.workspaces.clone(),
            state.active_workspace_id.clone(),
        )
    };

    // Write file outside of lock
    write_workspaces_file(&workspaces, active_id.as_deref())
}

#[tauri::command]
pub fn delete_workspace(
    state: State<'_, Mutex<AppState>>,
    id: String,
) -> Result<(), String> {
    let (workspaces, active_id) = {
        let mut state = state.lock().map_err(|e| e.to_string())?;
        state.workspaces.retain(|w| w.id != id);

        if state.active_workspace_id.as_deref() == Some(&id) {
            state.active_workspace_id = state.workspaces.first().map(|w| w.id.clone());
        }

        // Revoke file-system roots no longer referenced by any remaining workspace.
        // Pre-compute from workspaces to avoid simultaneous mutable+immutable borrows.
        let active_roots: Vec<std::path::PathBuf> = state.workspaces.iter()
            .filter(|w| !w.root_path.is_empty())
            .map(|w| std::fs::canonicalize(&w.root_path)
                .unwrap_or_else(|_| std::path::PathBuf::from(&w.root_path)))
            .collect();
        revoke_unused_roots(&mut state.allowed_roots, &active_roots);

        (
            state.workspaces.clone(),
            state.active_workspace_id.clone(),
        )
    };

    write_workspaces_file(&workspaces, active_id.as_deref())
}

#[tauri::command]
pub fn close_workspace(
    state: State<'_, Mutex<AppState>>,
    id: String,
) -> Result<Vec<u32>, String> {
    let (terminal_ids, workspaces, active_id) = {
        let mut state = state.lock().map_err(|e| e.to_string())?;

        // Find workspace and collect its terminal IDs before removing
        let terminal_ids: Vec<u32> = state
            .workspaces
            .iter()
            .find(|w| w.id == id)
            .map(|w| w.terminal_ids.clone())
            .unwrap_or_default();

        // Kill all owned terminals
        for tid in &terminal_ids {
            state.terminals.remove(tid);
            state.terminal_claude_sessions.remove(tid);
        }
        // Evict pid cache entries for the killed terminals
        state.pid_to_terminal_cache.retain(|_, cached_tid| !terminal_ids.contains(cached_tid));

        // Remove workspace
        state.workspaces.retain(|w| w.id != id);

        // Update active workspace
        if state.active_workspace_id.as_deref() == Some(&id) {
            state.active_workspace_id = state.workspaces.first().map(|w| w.id.clone());
        }

        // Revoke file-system roots no longer referenced by any remaining workspace.
        let active_roots: Vec<std::path::PathBuf> = state.workspaces.iter()
            .filter(|w| !w.root_path.is_empty())
            .map(|w| std::fs::canonicalize(&w.root_path)
                .unwrap_or_else(|_| std::path::PathBuf::from(&w.root_path)))
            .collect();
        revoke_unused_roots(&mut state.allowed_roots, &active_roots);

        (
            terminal_ids,
            state.workspaces.clone(),
            state.active_workspace_id.clone(),
        )
    };

    // Write file outside of lock
    write_workspaces_file(&workspaces, active_id.as_deref())?;

    Ok(terminal_ids)
}

#[tauri::command]
pub fn set_active_workspace_id(
    state: State<'_, Mutex<AppState>>,
    id: Option<String>,
) -> Result<(), String> {
    let (workspaces, active_id) = {
        let mut state = state.lock().map_err(|e| e.to_string())?;
        state.active_workspace_id = id;
        (
            state.workspaces.clone(),
            state.active_workspace_id.clone(),
        )
    };

    write_workspaces_file(&workspaces, active_id.as_deref())
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
