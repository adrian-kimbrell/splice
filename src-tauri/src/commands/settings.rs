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
    std::fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_settings(state: State<'_, Mutex<AppState>>) -> Result<Settings, String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;

    // Try to load from disk on first access
    if let Some(disk_settings) = load_settings_from_disk() {
        state.settings = disk_settings;
        info!("Loaded settings from disk");
    }

    Ok(state.settings.clone())
}

#[tauri::command]
pub fn update_settings(
    state: State<'_, Mutex<AppState>>,
    settings: Settings,
) -> Result<(), String> {
    let settings_clone = {
        let mut state = state.lock().map_err(|e| e.to_string())?;
        state.settings = settings;
        state.settings.clone()
    };

    // Persist outside of lock
    save_settings_to_disk(&settings_clone)?;
    info!("Settings saved to disk");
    Ok(())
}
