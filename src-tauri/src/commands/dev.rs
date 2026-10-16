/// Dev-only commands. Compiled out in release builds.
use std::fs;
use std::path::PathBuf;

/// Resolve a pending /dev/dom-query HTTP request with the DOM results JSON
/// collected by the frontend.
#[tauri::command]
pub fn resolve_dev_dom(request_id: String, results_json: String) {
    crate::dev_server::resolve_dom(&request_id, results_json);
}

/// Buffer a frontend console entry into the dev log ring buffer.
/// Exposed as a Tauri command so `dev/index.ts` can forward console output
/// without a network round-trip. Readable via `GET /dev/logs`.
#[tauri::command]
pub fn dev_log(level: String, message: String) {
    crate::dev_server::push_log(&level, &message);
}

fn docs_path(filename: &str) -> Result<PathBuf, String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    Ok(manifest_dir
        .parent()
        .ok_or("Could not find project root")?
        .join("docs")
        .join("screenshots")
        .join(filename))
}

/// Save PNG bytes sent from the frontend (captured via html-to-image) to
/// `docs/screenshots/screenshot-{name}.png` in the project root.
/// Also resolves the pending HTTP request that triggered the capture.
/// Returns the absolute path of the saved file.
#[tauri::command]
pub fn save_screenshot_bytes(name: String, request_id: String, bytes: Vec<u8>) -> Result<String, String> {
    let safe_name: String = name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let filename = format!("screenshot-{}.png", safe_name);
    let out_path = docs_path(&filename)?;

    // Ensure docs/screenshots/ exists
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    fs::write(&out_path, &bytes).map_err(|e| e.to_string())?;
    let path_str = out_path.to_string_lossy().to_string();

    // Unblock the HTTP handler that is awaiting this screenshot
    crate::dev_server::resolve_screenshot(&request_id, Ok(path_str.clone()));
    Ok(path_str)
}

/// Resolve a pending /dev/state HTTP request with the app state JSON
/// collected by the frontend.
#[tauri::command]
pub fn resolve_dev_state(request_id: String, state_json: String) {
    crate::dev_server::resolve_state(&request_id, state_json);
}

/// Return the last `n` non-empty lines from a terminal's combined scrollback+live buffer.
/// Used by the dev state endpoint to include recent terminal output in snapshots.
#[tauri::command]
pub fn get_terminal_last_lines(
    state: tauri::State<'_, std::sync::Mutex<crate::state::AppState>>,
    id: u32,
    n: u32,
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
    let cols = emu.grid.cols as usize;
    let n = n as usize;

    // Collect all rows (scrollback then live) into a flat iterator, take last n non-blank
    let scrollback_rows = buf.scrollback.iter().map(|row| {
        row.cells[..cols.min(row.cells.len())]
            .iter()
            .map(|c| if c.ch == '\0' { ' ' } else { c.ch })
            .collect::<String>()
    });
    let live_rows = buf.lines.iter().map(|row| {
        row.cells[..cols.min(row.cells.len())]
            .iter()
            .map(|c| if c.ch == '\0' { ' ' } else { c.ch })
            .collect::<String>()
    });

    let all_rows: Vec<String> = scrollback_rows.chain(live_rows).collect();

    // Take the last `n` rows, trim trailing whitespace, drop entirely blank ones
    let result: Vec<String> = all_rows
        .iter()
        .rev()
        .filter(|s| !s.trim().is_empty())
        .take(n)
        .map(|s| s.trim_end().to_string())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();

    Ok(result)
}

