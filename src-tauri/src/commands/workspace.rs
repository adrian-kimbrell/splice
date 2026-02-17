use crate::state::AppState;
use crate::workspace::layout::Workspace;
use std::sync::Mutex;
use tauri::State;

fn config_path() -> std::path::PathBuf {
    let dir = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("malloc");
    std::fs::create_dir_all(&dir).ok();
    dir.join("workspaces.json")
}

#[tauri::command]
pub fn get_workspaces(state: State<'_, Mutex<AppState>>) -> Result<Vec<Workspace>, String> {
    let state = state.lock().map_err(|e| e.to_string())?;
    if !state.workspaces.is_empty() {
        return Ok(state.workspaces.clone());
    }

    let path = config_path();
    if path.exists() {
        let data = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let workspaces: Vec<Workspace> = serde_json::from_str(&data).map_err(|e| e.to_string())?;
        Ok(workspaces)
    } else {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub fn save_workspace(
    state: State<'_, Mutex<AppState>>,
    workspace: Workspace,
) -> Result<(), String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;

    if let Some(existing) = state.workspaces.iter_mut().find(|w| w.id == workspace.id) {
        *existing = workspace;
    } else {
        state.workspaces.push(workspace);
    }

    let path = config_path();
    let data = serde_json::to_string_pretty(&state.workspaces).map_err(|e| e.to_string())?;
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_workspace(
    state: State<'_, Mutex<AppState>>,
    id: String,
) -> Result<(), String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;
    state.workspaces.retain(|w| w.id != id);

    if state.active_workspace_id.as_deref() == Some(&id) {
        state.active_workspace_id = state.workspaces.first().map(|w| w.id.clone());
    }

    let path = config_path();
    let data = serde_json::to_string_pretty(&state.workspaces).map_err(|e| e.to_string())?;
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_workspace(
    state: State<'_, Mutex<AppState>>,
    id: String,
) -> Result<Vec<u32>, String> {
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
    }

    // Remove workspace
    state.workspaces.retain(|w| w.id != id);

    // Update active workspace
    if state.active_workspace_id.as_deref() == Some(&id) {
        state.active_workspace_id = state.workspaces.first().map(|w| w.id.clone());
    }

    // Persist
    let path = config_path();
    let data = serde_json::to_string_pretty(&state.workspaces).map_err(|e| e.to_string())?;
    std::fs::write(&path, data).map_err(|e| e.to_string())?;

    Ok(terminal_ids)
}
