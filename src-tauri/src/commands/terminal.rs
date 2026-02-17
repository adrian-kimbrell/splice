use crate::state::AppState;
use std::sync::Mutex;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn spawn_terminal(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
    shell: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;
    let id = state.next_terminal_id;
    state.next_terminal_id += 1;

    let session =
        crate::terminal::pty::PtySession::spawn(app, id, &shell, &cwd, cols, rows)?;
    state.terminals.insert(id, session);

    Ok(id)
}

#[tauri::command]
pub fn write_to_terminal(
    state: State<'_, Mutex<AppState>>,
    id: u32,
    data: Vec<u8>,
) -> Result<(), String> {
    let state = state.lock().map_err(|e| e.to_string())?;
    let session = state
        .terminals
        .get(&id)
        .ok_or_else(|| format!("Terminal {} not found", id))?;
    session.write(&data)
}

#[tauri::command]
pub fn resize_terminal(
    state: State<'_, Mutex<AppState>>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let state = state.lock().map_err(|e| e.to_string())?;
    let session = state
        .terminals
        .get(&id)
        .ok_or_else(|| format!("Terminal {} not found", id))?;
    session.resize(cols, rows)
}

#[tauri::command]
pub fn get_terminal_buffer(state: State<'_, Mutex<AppState>>, id: u32) -> Result<Vec<u8>, String> {
    let state = state.lock().map_err(|e| e.to_string())?;
    let session = state
        .terminals
        .get(&id)
        .ok_or_else(|| format!("Terminal {} not found", id))?;
    session.get_scrollback()
}

#[tauri::command]
pub fn kill_terminal(state: State<'_, Mutex<AppState>>, id: u32) -> Result<(), String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;
    state
        .terminals
        .remove(&id)
        .ok_or_else(|| format!("Terminal {} not found", id))?;
    Ok(())
}
