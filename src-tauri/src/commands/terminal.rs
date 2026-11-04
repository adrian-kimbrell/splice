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
#[allow(clippy::too_many_arguments)]
pub fn spawn_terminal(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
    shell: String,
    cwd: String,
    cols: u16,
    rows: u16,
    extra_args: Option<Vec<String>>,
    terminal_id: Option<u32>,
) -> Result<u32, String> {
    let extra_args = extra_args.unwrap_or_default();
    // Validate shell
    if !ALLOWED_SHELLS.contains(&shell.as_str()) {
        warn!(shell = %shell, "Rejected disallowed shell");
        return Err(format!("Shell not allowed: '{}'. Allowed: {:?}", shell, ALLOWED_SHELLS));
    }

    // Validate CWD: must exist and be under home directory. Fall back to HOME if invalid.
    // In debug builds the restriction is relaxed to allow any valid directory (e.g. /tmp).
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
                    #[cfg(not(debug_assertions))]
                    {
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
                    #[cfg(debug_assertions)]
                    { c }
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
    let id = if let Some(requested) = terminal_id.filter(|r| !state.terminals.contains_key(r)) {
        // Caller (e.g. workspace restore) requested a specific ID — use it directly,
        // and bump the counter past it so future fresh spawns don't collide.
        let next = requested
            .checked_add(1)
            .ok_or_else(|| "Terminal ID overflow".to_string())?;
        if next > state.next_terminal_id {
            state.next_terminal_id = next;
        }
        requested
    } else {
        if let Some(requested) = terminal_id {
            // The saved id is already live (another window restored it, or a fresh
            // spawn got there first). Inserting over it would silently kill that
            // session, so hand out a fresh id instead; callers use the returned id.
            warn!(requested, "Requested terminal id is in use; allocating a fresh one");
        }
        let id = state.next_terminal_id;
        state.next_terminal_id = state.next_terminal_id
            .checked_add(1)
            .ok_or_else(|| "Terminal ID overflow".to_string())?;
        id
    };
    let scrollback = state.settings.terminal.scrollback_lines as usize;
    let attention_port = state.attention_port;
    let attention_token = state.attention_token.clone();

    let session =
        crate::terminal::pty::PtySession::spawn(app, id, &shell, &canonical_cwd.to_string_lossy(), cols, rows, scrollback, &extra_args, attention_port, attention_token)?;
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

    // Resize PTY master first (syscall; outside AppState lock). If the ioctl fails
    // we bail before touching the emulator, so grid and PTY never disagree.
    master
        .lock().map_err(|e| e.to_string())?
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    // Resize emulator grid (no syscall)
    {
        let mut emu = emulator.write().map_err(|e| e.to_string())?;
        emu.resize(cols, rows);
    }

    version.fetch_add(1, Ordering::Relaxed);
    notify.notify();
    Ok(())
}

/// Ask the emitter to re-send the current grid for `id` without touching the PTY.
///
/// The emitter only emits when the grid version changes, so a frame that was
/// emitted before the frontend listener was registered (common under heavy
/// system load, when `listen` IPC round-trips are slow) is simply lost and the
/// pane stays blank until the shell prints something. The frontend calls this
/// after registering its listener, and retries until a frame arrives.
#[tauri::command]
pub fn refresh_terminal(state: State<'_, Mutex<AppState>>, id: u32) -> Result<(), String> {
    let (version, notify) = {
        let state = state.lock().map_err(|e| e.to_string())?;
        let session = state
            .terminals
            .get(&id)
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        (Arc::clone(&session.version), Arc::clone(&session.notify))
    };
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
    let (scrollback_rows, scrollback_len, live_rows) = {
        let emulator = emulator_arc.read().map_err(|e| e.to_string())?;
        let buf = emulator.grid.active();
        let cols = emulator.grid.cols as usize;
        let sb: Vec<(String, Vec<usize>)> = buf
            .scrollback
            .iter()
            .map(|row| row_text_and_columns(&row.cells, cols))
            .collect();
        let len = sb.len();
        let ls: Vec<(String, Vec<usize>)> = buf
            .lines
            .iter()
            .map(|row| row_text_and_columns(&row.cells, cols))
            .collect();
        (sb, len, ls)
    }; // read lock released here

    // Step 3: search strings — all searching happens after locks are released
    let query_lower = if case_sensitive { query.clone() } else { query.to_lowercase() };
    let mut results = Vec::new();

    // Scrollback rows are negative, live rows 0+.
    let scrollback_len_i64 = scrollback_len as i64;
    for (i, (text, colmap)) in scrollback_rows.iter().enumerate() {
        find_in_row(text, colmap, &query_lower, case_sensitive, i as i64 - scrollback_len_i64, &mut results);
        if results.len() >= MAX_SEARCH_RESULTS { return Ok(results); }
    }
    for (i, (text, colmap)) in live_rows.iter().enumerate() {
        find_in_row(text, colmap, &query_lower, case_sensitive, i as i64, &mut results);
        if results.len() >= MAX_SEARCH_RESULTS { return Ok(results); }
    }

    Ok(results)
}

/// Text of one row for copy and search, plus a character-index → cell-column map.
///
/// A wide character occupies two cells but is one character, so the width-0
/// right-half placeholders are skipped (otherwise "漢字" copied as "漢 字" and could
/// never be found by search). `columns[i]` is the cell column where character `i`
/// starts; one extra trailing entry marks the end, so `columns[text_len]` is valid.
pub(crate) fn row_text_and_columns(
    cells: &[crate::terminal::grid::Cell],
    max_cols: usize,
) -> (String, Vec<usize>) {
    let mut text = String::new();
    let mut columns = Vec::new();
    for (i, c) in cells.iter().take(max_cols).enumerate() {
        if c.width == 0 {
            continue;
        }
        columns.push(i);
        text.push(if c.ch == '\0' { ' ' } else { c.ch });
    }
    columns.push(cells.len().min(max_cols));
    (text, columns)
}

/// Find every occurrence of `query_lower` in `text` and report it in cell columns
/// via `colmap` (see `row_text_and_columns`). `query_lower` is already lower-cased
/// when `case_sensitive` is false.
fn find_in_row(
    text: &str,
    colmap: &[usize],
    query_lower: &str,
    case_sensitive: bool,
    row: i64,
    results: &mut Vec<TerminalSearchMatch>,
) {
    if query_lower.is_empty() {
        return;
    }
    let hay = if case_sensitive { text.to_string() } else { text.to_lowercase() };
    let query_chars = query_lower.chars().count();
    let last = colmap.len().saturating_sub(1);
    let mut start = 0;
    while let Some(pos) = hay[start..].find(query_lower) {
        let byte_col = start + pos;
        let char_start = hay[..byte_col].chars().count();
        let char_end = char_start + query_chars;
        results.push(TerminalSearchMatch {
            row,
            col_start: colmap[char_start.min(last)],
            col_end: colmap[char_end.min(last)],
        });
        if results.len() >= MAX_SEARCH_RESULTS {
            return;
        }
        // Advance past the match, rounding up to a char boundary.
        let mut next = (byte_col + query_lower.len().max(1)).min(hay.len());
        while next < hay.len() && !hay.is_char_boundary(next) {
            next += 1;
        }
        start = next;
    }
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
    let total = scrollback_len + buf.lines.len();
    if total == 0 {
        return Ok(vec![]);
    }
    // Clamp the upper bound to what exists: an unbounded `hi` from a frontend bug
    // would otherwise size a Vec by `hi - lo + 1` and loop that many times.
    let hi = (history_end.max(0) as usize).min(total - 1);
    if lo > hi {
        return Ok(vec![]);
    }

    let mut result = Vec::with_capacity(hi - lo + 1);
    for history_row in lo..=hi {
        let row = if history_row < scrollback_len {
            &buf.scrollback[history_row]
        } else {
            &buf.lines[history_row - scrollback_len]
        };
        result.push(row_text_and_columns(&row.cells, cols).0);
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
    crate::attention::install_hook()?;
    crate::attention::install_codex_integration()
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

    fn cell(ch: char, width: u8) -> crate::terminal::grid::Cell {
        crate::terminal::grid::Cell { ch, width, ..Default::default() }
    }

    #[test]
    fn row_text_skips_wide_placeholders_and_maps_columns() {
        // 漢(2) ▯(0) 字(2) ▯(0) x(1)
        let cells = [cell('漢', 2), cell(' ', 0), cell('字', 2), cell(' ', 0), cell('x', 1)];
        let (text, cols) = super::row_text_and_columns(&cells, 5);
        assert_eq!(text, "漢字x");
        assert_eq!(cols, vec![0, 2, 4, 5]);
    }

    #[test]
    fn row_text_respects_max_cols_and_maps_nul_to_space() {
        let cells = [cell('a', 1), cell('\0', 1), cell('c', 1)];
        let (text, cols) = super::row_text_and_columns(&cells, 2);
        assert_eq!(text, "a ");
        assert_eq!(cols, vec![0, 1, 2]);
    }

    #[test]
    fn search_reports_cell_columns_across_wide_chars() {
        let cells = [cell('漢', 2), cell(' ', 0), cell('字', 2), cell(' ', 0), cell('x', 1)];
        let (text, cols) = super::row_text_and_columns(&cells, 5);
        let mut results = Vec::new();
        super::find_in_row(&text, &cols, "字x", true, 3, &mut results);
        assert_eq!(results.len(), 1);
        assert_eq!((results[0].row, results[0].col_start, results[0].col_end), (3, 2, 5));
        // Previously placeholders became spaces so "漢字" could never match.
        results.clear();
        super::find_in_row(&text, &cols, "漢字", true, 0, &mut results);
        assert_eq!(results.len(), 1);
        assert_eq!((results[0].col_start, results[0].col_end), (0, 4));
    }

    #[test]
    fn search_is_case_insensitive_and_finds_repeats() {
        let cells: Vec<_> = "ab AB ab".chars().map(|c| cell(c, 1)).collect();
        let (text, cols) = super::row_text_and_columns(&cells, cells.len());
        let mut results = Vec::new();
        super::find_in_row(&text, &cols, "ab", false, 0, &mut results);
        assert_eq!(results.iter().map(|r| r.col_start).collect::<Vec<_>>(), vec![0, 3, 6]);
        assert!(results.iter().all(|r| r.col_end == r.col_start + 2));
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
