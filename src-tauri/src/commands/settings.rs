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
use tauri::State;
use tracing::{error, info};

fn settings_path() -> std::path::PathBuf {
    let dir = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("Splice");
    std::fs::create_dir_all(&dir).ok();
    dir.join("settings.json")
}

fn load_settings_from_disk() -> Option<Settings> {
    let path = settings_path();
    if !path.exists() {
        return None;
    }
    match std::fs::read_to_string(&path) {
        Ok(data) => match serde_json::from_str(&data) {
            Ok(settings) => Some(settings),
            Err(e) => {
                error!("Failed to parse settings: {}", e);
                None
            }
        },
        Err(e) => {
            error!("Failed to read settings file: {}", e);
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
    state: State<'_, Mutex<AppState>>,
    settings: Settings,
) -> Result<(), String> {
    let settings_clone = {
        let mut state = state.lock().map_err(|e| e.to_string())?;
        state.settings = settings;
        state.settings_loaded = true;
        state.settings.clone()
    };

    // Persist outside of lock
    save_settings_to_disk(&settings_clone)?;
    info!("Settings saved to disk");
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
pub fn read_project_settings(workspace_root: String) -> Result<String, String> {
    let path = std::path::Path::new(&workspace_root)
        .join(".splice")
        .join("settings.json");
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Write the given JSON string to `<workspace_root>/.splice/settings.json`,
/// creating the `.splice` directory if needed. Atomic temp+rename like the
/// user-settings write.
#[tauri::command]
pub fn write_project_settings(workspace_root: String, json: String) -> Result<(), String> {
    let dir = std::path::Path::new(&workspace_root).join(".splice");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("settings.json");
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    info!("Project settings saved to {}", path.display());
    Ok(())
}
