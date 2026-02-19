use crate::state::AppState;
use std::io::Write;
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
    // Clone Arc refs quickly, then release the AppState lock before writing
    let (writer, scroll_offset) = {
        let state = state.lock().map_err(|e| e.to_string())?;
        let session = state
            .terminals
            .get(&id)
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        (
            std::sync::Arc::clone(&session.writer),
            std::sync::Arc::clone(&session.scroll_offset),
        )
    };
    // Snap to live on any input
    scroll_offset.store(0, std::sync::atomic::Ordering::Relaxed);
    let mut w = writer.lock().map_err(|e| e.to_string())?;
    w.write_all(&data).map_err(|e| e.to_string())
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
pub fn scroll_terminal(
    state: State<'_, Mutex<AppState>>,
    id: u32,
    delta: i32,
) -> Result<(), String> {
    let state = state.lock().map_err(|e| e.to_string())?;
    let session = state
        .terminals
        .get(&id)
        .ok_or_else(|| format!("Terminal {} not found", id))?;
    session.scroll(delta);
    Ok(())
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
