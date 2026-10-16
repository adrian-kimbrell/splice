//! Tauri commands for reading and writing application settings.
//!
//! Settings are persisted to `~/.config/Splice/settings.json` (or the platform
//! equivalent via `dirs::config_dir`). The file is loaded lazily on the first
//! `get_settings` call and cached in [`AppState`] for subsequent reads.
//! `update_settings` writes through to disk using atomic rename to prevent
//! corruption on crash.
//!
//! Per-project settings live at `<workspace_root>/.splice/settings.json` and
//! are a partial subset of [`Settings`]. They are loaded by the frontend on
//! workspace switch and deep-merged on top of user settings to produce the
//! effective view.

use crate::state::AppState;
use crate::workspace::layout::Settings;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};
use tracing::{error, info, warn};

fn settings_path() -> std::path::PathBuf {
    let dir = crate::state::splice_config_dir("Splice");
    std::fs::create_dir_all(&dir).ok();
    dir.join("settings.json")
}

fn load_settings_from_disk() -> Option<Settings> {
    let path = settings_path();
    if !path.exists() {
        return None;
    }
    match std::fs::read_to_string(&path) {
        Ok(data) => parse_settings_data(&path, &data),
        Err(e) => {
            error!("Failed to read settings file: {}", e);
            None
        }
    }
}

/// Parse a settings file. Missing keys are defaults (see `Settings`), values are
/// clamped. A file that is not valid JSON at all is preserved as
/// `settings.json.corrupt-<ts>` before defaults are used, because the next
/// debounced save will otherwise overwrite it with those defaults.
fn parse_settings_data(path: &std::path::Path, data: &str) -> Option<Settings> {
    match serde_json::from_str::<Settings>(data) {
        Ok(settings) => Some(settings.clamped()),
        Err(e) => {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let backup = path.with_file_name(format!("settings.json.corrupt-{}", ts));
            match std::fs::copy(path, &backup) {
                Ok(_) => warn!(backup = %backup.display(), error = %e, "settings.json unreadable; backed up, using defaults"),
                Err(ce) => error!("Failed to parse settings ({}) and failed to back it up: {}", e, ce),
            }
            None
        }
    }
}

fn save_settings_to_disk(settings: &Settings) -> Result<(), String> {
    let path = settings_path();
    let data = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    // Atomic write: write to a temp file then rename to avoid corruption on crash
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_settings(state: State<'_, Mutex<AppState>>) -> Result<Settings, String> {
    // Fast path: already loaded — return without touching disk
    {
        let s = state.lock().map_err(|e| e.to_string())?;
        if s.settings_loaded {
            return Ok(s.settings.clone());
        }
    }

    // Slow path: read from disk WITHOUT holding the lock
    let disk_settings = load_settings_from_disk();

    let mut s = state.lock().map_err(|e| e.to_string())?;
    if !s.settings_loaded {          // re-check under lock
        if let Some(ds) = disk_settings {
            s.settings = ds;
            info!("Loaded settings from disk");
        }
        s.settings_loaded = true;
    }
    Ok(s.settings.clone())
}

#[tauri::command]
pub fn update_settings(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, Mutex<AppState>>,
    settings: Settings,
) -> Result<(), String> {
    let settings_clone = {
        let mut state = state.lock().map_err(|e| e.to_string())?;
        state.settings = settings.clamped();
        state.settings_loaded = true;
        state.settings.clone()
    };

    // Persist outside of lock
    save_settings_to_disk(&settings_clone)?;
    info!("Settings saved to disk");

    // Tell every *other* window. The sender already has this state, and echoing
    // it back could clobber an edit it made while the save was in flight.
    for (label, w) in app.webview_windows() {
        if label != window.label() {
            let _ = w.emit("settings-changed", &settings_clone);
        }
    }
    Ok(())
}

/// Read `<workspace_root>/.splice/settings.json` if it exists. Returns the raw
/// JSON value as a string so the frontend can parse it as `Partial<Settings>`
/// (Splice's `Settings` Rust struct requires all fields, so we don't deserialize
/// here — we let the frontend deep-merge on top of its user settings).
///
/// Returns an empty string if the file is absent. Returns an error only on
/// I/O failures (permissions, etc.) — malformed JSON is the caller's problem.
#[tauri::command]
pub fn read_project_settings(
    state: State<'_, Mutex<AppState>>,
    workspace_root: String,
) -> Result<String, String> {
    let roots = state.lock().map_err(|e| e.to_string())?.allowed_roots.clone();
    let root = crate::state::validate_path(&workspace_root, &roots)?;
    let path = root.join(".splice").join("settings.json");
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Write the given JSON string to `<workspace_root>/.splice/settings.json`,
/// creating the `.splice` directory if needed. Atomic temp+rename like the
/// user-settings write.
#[tauri::command]
pub fn write_project_settings(
    state: State<'_, Mutex<AppState>>,
    workspace_root: String,
    json: String,
) -> Result<(), String> {
    let roots = state.lock().map_err(|e| e.to_string())?.allowed_roots.clone();
    let root = crate::state::validate_path(&workspace_root, &roots)?;
    let dir = root.join(".splice");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("settings.json");
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    info!("Project settings saved to {}", path.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unparseable_settings_are_backed_up_before_defaults_apply() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{ nope").unwrap();

        assert!(parse_settings_data(&path, "{ nope").is_none());

        assert!(path.exists(), "original is left for the backup copy to be taken from");
        let backups: Vec<_> = std::fs::read_dir(dir.path()).unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with("settings.json.corrupt-"))
            .collect();
        assert_eq!(backups.len(), 1, "{backups:?}");
        assert_eq!(std::fs::read_to_string(dir.path().join(&backups[0])).unwrap(), "{ nope");
    }

    #[test]
    fn partial_settings_load_with_defaults_and_are_clamped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let data = r#"{"terminal":{"font_size":0}}"#;
        std::fs::write(&path, data).unwrap();

        let s = parse_settings_data(&path, data).expect("partial file must load");
        assert_eq!(s.terminal.font_size, crate::workspace::layout::FONT_SIZE_RANGE.0);
        assert_eq!(s.editor.font_size, 15);
        assert!(std::fs::read_dir(dir.path()).unwrap().count() == 1, "no backup for a readable file");
    }
}

