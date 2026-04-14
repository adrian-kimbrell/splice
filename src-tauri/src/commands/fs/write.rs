use crate::state::{validate_path, AppState};
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use tauri::State;

#[tauri::command]
pub fn write_file(
    state: State<'_, Mutex<AppState>>,
    path: String,
    content: String,
) -> Result<(), String> {
    let allowed_roots = {
        let state = state.lock().map_err(|e| e.to_string())?;
        state.allowed_roots.clone()
    };
    let p = Path::new(&path);
    // Build a canonical write target so we always write to the validated path,
    // not the original (potentially symlink-escaped) string.
    let canonical_write_target = if p.exists() {
        validate_path(&path, &allowed_roots)?
    } else if let Some(parent) = p.parent() {
        if parent.as_os_str().is_empty() || !parent.exists() {
            return Err(format!("Parent directory does not exist for path '{}'", path));
        }
        let canonical_parent = validate_path(&parent.to_string_lossy(), &allowed_roots)?;
        let file_name = p
            .file_name()
            .ok_or_else(|| format!("Invalid path '{}': no filename", path))?;
        canonical_parent.join(file_name)
    } else {
        return Err(format!("Invalid path: '{}'", path));
    };

    // Atomic write: write to a sibling tmp file then rename so a crash or disk-full
    // leaves the original intact rather than truncated/empty.
    let tmp_name = format!(
        "{}.splicetmp",
        canonical_write_target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
    );
    let tmp = canonical_write_target.with_file_name(&tmp_name);
    std::fs::write(&tmp, &content)
        .map_err(|e| format!("Failed to write '{}': {}", canonical_write_target.display(), e))?;
    std::fs::rename(&tmp, &canonical_write_target)
        .map_err(|e| format!("Failed to write '{}': {}", canonical_write_target.display(), e))
}

#[tauri::command]
pub fn create_file_at(
    state: State<'_, Mutex<AppState>>,
    dir_path: String,
    name: String,
) -> Result<String, String> {
    let allowed_roots = {
        let state = state.lock().map_err(|e| e.to_string())?;
        state.allowed_roots.clone()
    };
    // Reject names that could escape the directory via path traversal
    if name.contains('/') || name.contains('\0') || name == ".." || name == "." {
        return Err(format!("Invalid file name: '{}'", name));
    }
    let canonical_dir = validate_path(&dir_path, &allowed_roots)?;
    if !canonical_dir.is_dir() {
        return Err(format!("Not a directory: {}", dir_path));
    }
    let file_path = canonical_dir.join(&name);
    if file_path.exists() {
        return Err(format!("Already exists: {}", file_path.display()));
    }
    fs::write(&file_path, "").map_err(|e| format!("Failed to create file: {}", e))?;
    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn create_directory_at(
    state: State<'_, Mutex<AppState>>,
    dir_path: String,
    name: String,
) -> Result<String, String> {
    let allowed_roots = {
        let state = state.lock().map_err(|e| e.to_string())?;
        state.allowed_roots.clone()
    };
    // Reject names that could escape the directory via path traversal
    if name.contains('/') || name.contains('\0') || name == ".." || name == "." {
        return Err(format!("Invalid directory name: '{}'", name));
    }
    let canonical_dir = validate_path(&dir_path, &allowed_roots)?;
    if !canonical_dir.is_dir() {
        return Err(format!("Not a directory: {}", dir_path));
    }
    let new_dir = canonical_dir.join(&name);
    if new_dir.exists() {
        return Err(format!("Already exists: {}", new_dir.display()));
    }
    fs::create_dir_all(&new_dir).map_err(|e| format!("Failed to create directory: {}", e))?;
    Ok(new_dir.to_string_lossy().to_string())
}
