//! Tauri commands for terminal lifecycle management.
//!
//! Commands: spawn_terminal, write_to_terminal, resize_terminal, scroll_terminal,
//! set_terminal_scroll_offset, kill_terminal, search_terminal, get_terminal_cwd,
//! get_terminal_text_range, install_claude_hook, get_debug_stats (e2e feature only).
//!
//! Security constraints applied before any PTY work:
//! - Shell must be in `ALLOWED_SHELLS` allowlist
//! - CWD is validated; falls back to HOME if missing or outside HOME
//! - Terminal dimensions are clamped to MAX_TERMINAL_COLS × MAX_TERMINAL_ROWS
//!
//! `resize_terminal` clones `Arc<Mutex<MasterPty>>` and releases the AppState lock
//! before issuing the PTY resize ioctl — the ioctl can block on some platforms.

use crate::state::AppState;
use portable_pty::PtySize;
use serde::Serialize;
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, State};
use tracing::{info, warn};

const ALLOWED_SHELLS: &[&str] = &[
    "/bin/bash",
    "/bin/zsh",
    "/bin/sh",
    "/usr/bin/fish",
    "/usr/local/bin/fish",
    "/opt/homebrew/bin/fish",
    "/usr/bin/ssh",
];

const MAX_TERMINAL_COLS: u16 = 350;
const MAX_TERMINAL_ROWS: u16 = 200;
const MAX_SEARCH_RESULTS: usize = 1000;

fn clamp_terminal_size(cols: u16, rows: u16) -> (u16, u16) {
    (cols.clamp(1, MAX_TERMINAL_COLS), rows.clamp(1, MAX_TERMINAL_ROWS))
}

#[tauri::command]
pub fn spawn_terminal(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
    shell: String,
    cwd: String,
    cols: u16,
    rows: u16,
    extra_args: Option<Vec<String>>,
) -> Result<u32, String> {
    let extra_args = extra_args.unwrap_or_default();
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
    state.next_terminal_id = state.next_terminal_id
        .checked_add(1)
        .ok_or_else(|| "Terminal ID overflow".to_string())?;
    let scrollback = state.settings.terminal.scrollback_lines as usize;

    let session =
        crate::terminal::pty::PtySession::spawn(app, id, &shell, &canonical_cwd.to_string_lossy(), cols, rows, scrollback, &extra_args)?;
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
    let mut w = writer.lock().map_err(|e| e.to_string())?;
    w.write_all(&data).map_err(|e| e.to_string())?;
    // Snap to live only after a successful write
    scroll_offset.store(0, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn resize_terminal(
    state: State<'_, Mutex<AppState>>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let (cols, rows) = clamp_terminal_size(cols, rows);
    // Clone Arcs out from under AppState lock so the PTY ioctl (may block)
    // does not hold the AppState mutex and prevent other terminal operations.
    let (emulator, version, notify, master) = {
        let state = state.lock().map_err(|e| e.to_string())?;
        let session = state
            .terminals
            .get(&id)
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        (
            Arc::clone(&session.emulator),
            Arc::clone(&session.version),
            Arc::clone(&session.notify),
            Arc::clone(&session.master),
        )
    }; // AppState lock released here

    // Resize emulator grid (no syscall)
    {
        let mut emu = emulator.write().map_err(|e| e.to_string())?;
        emu.resize(cols, rows);
    }

    // Resize PTY master (syscall; outside AppState lock)
    master
        .lock().map_err(|e| e.to_string())?
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    version.fetch_add(1, Ordering::Relaxed);
    notify.notify();
    Ok(())
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
pub fn set_terminal_scroll_offset(
    state: State<'_, Mutex<AppState>>,
    id: u32,
    offset: i32,
) -> Result<(), String> {
    let state = state.lock().map_err(|e| e.to_string())?;
    let session = state
        .terminals
        .get(&id)
        .ok_or_else(|| format!("Terminal {} not found", id))?;
    session.set_scroll_offset(offset);
    Ok(())
}

#[tauri::command]
pub fn kill_terminal(state: State<'_, Mutex<AppState>>, id: u32) -> Result<(), String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;
    state
        .terminals
        .remove(&id)
        .ok_or_else(|| format!("Terminal {} not found", id))?;
    state.terminal_claude_sessions.remove(&id);
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalSearchMatch {
    pub row: i64,     // negative = scrollback, 0+ = visible
    pub col_start: usize,
    pub col_end: usize,
}

#[tauri::command]
pub fn search_terminal(
    state: State<'_, Mutex<AppState>>,
    id: u32,
    query: String,
    case_sensitive: bool,
) -> Result<Vec<TerminalSearchMatch>, String> {
    // Step 1: clone Arc out from under AppState mutex
    let emulator_arc = {
        let state = state.lock().map_err(|e| e.to_string())?;
        let session = state
            .terminals
            .get(&id)
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        std::sync::Arc::clone(&session.emulator)
    }; // AppState mutex released here

    // Step 2: hold read lock only for text extraction (strings, not full Row structs)
    let (scrollback_strings, scrollback_len, lines_strings) = {
        let emulator = emulator_arc.read().map_err(|e| e.to_string())?;
        let buf = emulator.grid.active();
        let sb: Vec<String> = buf.scrollback.iter()
            .map(|row| row.cells.iter().map(|c| c.ch).collect())
            .collect();
        let len = sb.len();
        let ls: Vec<String> = buf.lines.iter()
            .map(|row| row.cells.iter().map(|c| c.ch).collect())
            .collect();
        (sb, len, ls)
    }; // read lock released here

    // Step 3: search strings — all searching happens after locks are released
    let query_lower = if case_sensitive { query.clone() } else { query.to_lowercase() };
    let advance = query_lower.len().max(1);
    let query_chars_len = query_lower.chars().count();
    let mut results = Vec::new();

    // Search scrollback (negative row indices)
    let scrollback_len_i64 = scrollback_len as i64;
    for (i, line) in scrollback_strings.iter().enumerate() {
        let line_search = if case_sensitive { line.clone() } else { line.to_lowercase() };
        let line_char_count = line_search.chars().count();
        let mut start = 0;
        while let Some(pos) = line_search[start..].find(&query_lower) {
            let byte_col = start + pos;
            let col_start = line_search[..byte_col].chars().count();
            results.push(TerminalSearchMatch {
                row: i as i64 - scrollback_len_i64,
                col_start,
                col_end: (col_start + query_chars_len).min(line_char_count),
            });
            // Advance past the match. Clamp to len and round up to the next
            // char boundary defensively — prevents any panic on edge-case input.
            let next_start = (byte_col + advance).min(line_search.len());
            let mut safe_start = next_start;
            while safe_start < line_search.len() && !line_search.is_char_boundary(safe_start) {
                safe_start += 1;
            }
            start = safe_start;
            if results.len() >= MAX_SEARCH_RESULTS { return Ok(results); }
        }
    }

    // Search visible lines
    for (i, line) in lines_strings.iter().enumerate() {
        let line_search = if case_sensitive { line.clone() } else { line.to_lowercase() };
        let line_char_count = line_search.chars().count();
        let mut start = 0;
        while let Some(pos) = line_search[start..].find(&query_lower) {
            let byte_col = start + pos;
            let col_start = line_search[..byte_col].chars().count();
            results.push(TerminalSearchMatch {
                row: i as i64,
                col_start,
                col_end: (col_start + query_chars_len).min(line_char_count),
            });
            // Advance past the match. Clamp to len and round up to the next
            // char boundary defensively — prevents any panic on edge-case input.
            let next_start = (byte_col + advance).min(line_search.len());
            let mut safe_start = next_start;
            while safe_start < line_search.len() && !line_search.is_char_boundary(safe_start) {
                safe_start += 1;
            }
            start = safe_start;
            if results.len() >= MAX_SEARCH_RESULTS { return Ok(results); }
        }
    }

    Ok(results)
}

#[tauri::command]
pub fn get_terminal_cwd(state: State<'_, Mutex<AppState>>, id: u32) -> Option<String> {
    let state = state.lock().ok()?;
    let session = state.terminals.get(&id)?;
    let pid = session.child_pid?;
    cwd_of_pid(pid)
}

#[cfg(target_os = "macos")]
fn cwd_of_pid(pid: u32) -> Option<String> {
    // lsof -a -p PID -d cwd -Fn  →  lines: "p<pid>", "fcwd", "n<path>"
    let out = std::process::Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        if let Some(path) = line.strip_prefix('n') {
            let s = path.trim().to_string();
            if !s.is_empty() { return Some(s); }
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn cwd_of_pid(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{}/cwd", pid))
        .ok()
        .and_then(|p| p.to_str().map(str::to_string))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn cwd_of_pid(_pid: u32) -> Option<String> { None }

/// Returns lines for the given history row range, ordered top-to-bottom (oldest first).
/// `history_start` and `history_end` are direct indices into the combined
///   [scrollback[0..scrollback_len], live[0..rows]] array:
///   0 = oldest scrollback row, scrollback_len + rows - 1 = newest live row.
/// history_start ≤ history_end; result[0] = history_start (top/older), result[last] = history_end.
#[tauri::command]
pub fn get_terminal_text_range(
    state: State<'_, Mutex<AppState>>,
    id: u32,
    history_start: i32,
    history_end: i32,
) -> Result<Vec<String>, String> {
    let emulator_arc = {
        let state = state.lock().map_err(|e| e.to_string())?;
        let session = state
            .terminals
            .get(&id)
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        std::sync::Arc::clone(&session.emulator)
    };

    let emu = emulator_arc.read().map_err(|e| e.to_string())?;
    let buf = emu.grid.active();
    let scrollback_len = buf.scrollback.len();
    let cols = emu.grid.cols as usize;

    let lo = history_start.max(0) as usize;
    let hi = history_end.max(0) as usize;
    if lo > hi {
        return Ok(vec![]);
    }

    let mut result = Vec::with_capacity(hi - lo + 1);
    for history_row in lo..=hi {
        let text = if history_row < scrollback_len {
            let row = &buf.scrollback[history_row];
            row.cells[..cols.min(row.cells.len())]
                .iter()
                .map(|c| if c.ch == '\0' { ' ' } else { c.ch })
                .collect()
        } else {
            let live_idx = history_row - scrollback_len;
            if live_idx < buf.lines.len() {
                let row = &buf.lines[live_idx];
                row.cells[..cols.min(row.cells.len())]
                    .iter()
                    .map(|c| if c.ch == '\0' { ' ' } else { c.ch })
                    .collect()
            } else {
                String::new()
            }
        };
        result.push(text);
    }

    Ok(result)
}

#[tauri::command]
pub fn install_claude_hook(state: State<'_, Mutex<AppState>>) -> Result<(), String> {
    // Guard: ensure the attention server is actually running before installing the hook
    state
        .lock()
        .map_err(|e| e.to_string())?
        .attention_port
        .ok_or("Attention server not started")?;
    crate::attention::install_hook()
}

#[cfg(test)]
mod tests {
    fn kill_terminal_sessions(
        sessions: &mut std::collections::HashMap<u32, (String, u32)>,
        id: u32,
    ) {
        sessions.remove(&id);
    }

    #[test]
    fn session_removed_when_terminal_killed() {
        let mut sessions = std::collections::HashMap::new();
        sessions.insert(1u32, ("sess-abc".to_string(), 1234u32));

        kill_terminal_sessions(&mut sessions, 1);

        assert!(!sessions.contains_key(&1));
    }

    #[test]
    fn other_terminal_sessions_unaffected() {
        let mut sessions = std::collections::HashMap::new();
        sessions.insert(1u32, ("sess-1".to_string(), 100u32));
        sessions.insert(2u32, ("sess-2".to_string(), 200u32));

        kill_terminal_sessions(&mut sessions, 1);

        assert!(!sessions.contains_key(&1));
        assert_eq!(sessions.get(&2).map(|(s, _)| s.as_str()), Some("sess-2"));
    }
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub fn get_debug_stats(
    state: tauri::State<'_, std::sync::Mutex<crate::state::AppState>>,
) -> serde_json::Value {
    let state = state.lock().unwrap();
    serde_json::json!({
        "terminal_count": state.terminals.len(),
        "watcher_count":  state.watchers.len(),
        "workspace_count": state.window_workspaces.len(),
        "lsp_session_count": state.lsp_sessions.len(),
    })
}
