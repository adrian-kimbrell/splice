use crate::state::AppState;
use std::io::Write;
use std::sync::Mutex;
use tauri::{AppHandle, State};
use tracing::{info, warn};

const ALLOWED_SHELLS: &[&str] = &[
    "/bin/bash",
    "/bin/zsh",
    "/bin/sh",
    "/usr/bin/fish",
    "/usr/local/bin/fish",
    "/opt/homebrew/bin/fish",
];

fn clamp_terminal_size(cols: u16, rows: u16) -> (u16, u16) {
    (cols.clamp(1, 500), rows.clamp(1, 500))
}

#[tauri::command]
pub fn spawn_terminal(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
    shell: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    // Validate shell
    if !ALLOWED_SHELLS.contains(&shell.as_str()) {
        warn!(shell = %shell, "Rejected disallowed shell");
        return Err(format!("Shell not allowed: '{}'. Allowed: {:?}", shell, ALLOWED_SHELLS));
    }

    // Validate CWD: must exist and be under home directory. Fall back to HOME if invalid.
    let home_dir = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/"));
    let canonical_cwd = {
        let cwd_path = std::path::Path::new(&cwd);
        if !cwd_path.is_dir() {
            warn!(cwd = %cwd, "CWD does not exist, falling back to HOME");
            std::fs::canonicalize(&home_dir)
                .unwrap_or_else(|_| home_dir.clone())
        } else {
            match std::fs::canonicalize(&cwd) {
                Ok(c) => {
                    if let Ok(canonical_home) = std::fs::canonicalize(&home_dir) {
                        if c.starts_with(&canonical_home) {
                            c
                        } else {
                            warn!(cwd = %cwd, "CWD is outside HOME, falling back to HOME");
                            canonical_home
                        }
                    } else {
                        c
                    }
                }
                Err(_) => {
                    warn!(cwd = %cwd, "Failed to canonicalize CWD, falling back to HOME");
                    std::fs::canonicalize(&home_dir)
                        .unwrap_or_else(|_| home_dir.clone())
                }
            }
        }
    };

    let (cols, rows) = clamp_terminal_size(cols, rows);

    let mut state = state.lock().map_err(|e| e.to_string())?;
    let id = state.next_terminal_id;
    state.next_terminal_id += 1;

    let session =
        crate::terminal::pty::PtySession::spawn(app, id, &shell, &canonical_cwd.to_string_lossy(), cols, rows)?;
    state.terminals.insert(id, session);

    info!(id, shell = %shell, cwd = %canonical_cwd.display(), "Spawned terminal");
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
    let (cols, rows) = clamp_terminal_size(cols, rows);
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

#[tauri::command]
pub fn install_claude_hook(state: State<'_, Mutex<AppState>>) -> Result<(), String> {
    let port = state
        .lock()
        .map_err(|e| e.to_string())?
        .attention_port
        .ok_or("Attention server not started")?;
    crate::attention::install_hook(port)
}
