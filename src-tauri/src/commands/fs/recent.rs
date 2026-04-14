use crate::state::{validate_path, AppState};
use std::fs;
use std::sync::Mutex;
use tauri::State;

use super::MAX_RECENT_LIST_SIZE;

#[tauri::command]
pub fn get_recent_files() -> Result<Vec<String>, String> {
    let path = dirs::config_dir()
        .ok_or("No config dir")?
        .join("Splice")
        .join("recent_files.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_RECENT_LIST_SIZE {
        return Err("recent_files.json is too large".to_string());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_recent_file(
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<(), String> {
    let allowed_roots = {
        let state = state.lock().map_err(|e| e.to_string())?;
        state.allowed_roots.clone()
    };
    validate_path(&path, &allowed_roots)?;

    let config_dir = dirs::config_dir()
        .ok_or("No config dir")?
        .join("Splice");
    fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let file_path = config_dir.join("recent_files.json");

    let mut files: Vec<String> = if file_path.exists() {
        let content = fs::read_to_string(&file_path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        Vec::new()
    };

    // Remove duplicates, prepend
    files.retain(|f| f != &path);
    files.insert(0, path);
    files.truncate(50);

    let json = serde_json::to_string_pretty(&files).map_err(|e| e.to_string())?;
    let tmp = file_path.with_extension("json.tmp");
    std::fs::write(&tmp, &json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_recent_projects() -> Result<Vec<String>, String> {
    let path = dirs::config_dir()
        .ok_or("No config dir")?
        .join("Splice")
        .join("recent_projects.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_RECENT_LIST_SIZE {
        return Err("recent_projects.json is too large".to_string());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_recent_project(path: String) -> Result<(), String> {
    // Canonicalize to prevent path traversal strings persisting in recent_projects.json
    let canonical = std::path::PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("Invalid path '{}': {}", path, e))?
        .to_string_lossy()
        .to_string();

    let config_dir = dirs::config_dir()
        .ok_or("No config dir")?
        .join("Splice");
    fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let file_path = config_dir.join("recent_projects.json");

    let mut projects: Vec<String> = if file_path.exists() {
        let content = fs::read_to_string(&file_path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        Vec::new()
    };

    // Remove duplicates, prepend
    projects.retain(|p| p != &canonical);
    projects.insert(0, canonical);
    projects.truncate(20);

    let json = serde_json::to_string_pretty(&projects).map_err(|e| e.to_string())?;
    let tmp = file_path.with_extension("json.tmp");
    std::fs::write(&tmp, &json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file_path).map_err(|e| e.to_string())
}
