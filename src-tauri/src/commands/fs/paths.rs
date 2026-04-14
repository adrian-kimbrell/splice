use crate::state::{validate_path, AppState};
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use tauri::State;

#[tauri::command]
pub fn rename_path(
    state: State<'_, Mutex<AppState>>,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let allowed_roots = {
        let state = state.lock().map_err(|e| e.to_string())?;
        state.allowed_roots.clone()
    };
    let canonical_old = validate_path(&old_path, &allowed_roots)?;
    // Validate new_path's parent is within allowed roots, then build canonical target
    let new = Path::new(&new_path);
    let new_path_final = if let Some(parent) = new.parent() {
        let canonical_parent = validate_path(&parent.to_string_lossy(), &allowed_roots)?;
        let fname = new.file_name().ok_or_else(|| format!("No filename in '{}'", new_path))?;
        canonical_parent.join(fname)
    } else {
        return Err(format!("Invalid target path: '{}'", new_path));
    };
    fs::rename(&canonical_old, &new_path_final)
        .map_err(|e| format!("Failed to rename '{}' to '{}': {}", old_path, new_path, e))
}

#[tauri::command]
pub fn delete_path(
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<(), String> {
    let allowed_roots = {
        let state = state.lock().map_err(|e| e.to_string())?;
        state.allowed_roots.clone()
    };
    let canonical = validate_path(&path, &allowed_roots)?;
    if canonical.is_dir() {
        fs::remove_dir_all(&canonical)
            .map_err(|e| format!("Failed to delete directory '{}': {}", path, e))
    } else {
        fs::remove_file(&canonical)
            .map_err(|e| format!("Failed to delete file '{}': {}", path, e))
    }
}

#[tauri::command]
pub fn duplicate_path(
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<String, String> {
    let allowed_roots = {
        let state = state.lock().map_err(|e| e.to_string())?;
        state.allowed_roots.clone()
    };
    let canonical = validate_path(&path, &allowed_roots)?;
    let parent = canonical.parent().ok_or("No parent directory")?;
    let stem = canonical
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = canonical
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let new_name = format!("{} copy{}", stem, ext);
    let mut new_path = parent.join(&new_name);
    // If "copy" already exists, try "copy 2", "copy 3", etc.
    let mut counter = 2u32;
    while new_path.exists() {
        if counter > 10_000 {
            return Err(format!("Could not find a unique copy name for '{}'", path));
        }
        let numbered = format!("{} copy {}{}", stem, counter, ext);
        new_path = parent.join(&numbered);
        counter += 1;
    }
    if canonical.is_dir() {
        copy_dir_recursive(&canonical, &new_path)?;
    } else {
        fs::copy(&canonical, &new_path)
            .map_err(|e| format!("Failed to duplicate '{}': {}", path, e))?;
    }
    Ok(new_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn copy_path(
    state: State<'_, Mutex<AppState>>,
    src: String,
    dest: String,
) -> Result<(), String> {
    let allowed_roots = {
        let state = state.lock().map_err(|e| e.to_string())?;
        state.allowed_roots.clone()
    };
    let src_path = validate_path(&src, &allowed_roots)?;
    // Validate dest parent is under allowed roots
    let dest_path = Path::new(&dest);
    let dest_parent = dest_path.parent().ok_or_else(|| format!("Invalid destination path: '{}'", dest))?;
    if dest_parent.as_os_str().is_empty() || !dest_parent.exists() {
        return Err(format!("Destination parent directory does not exist: '{}'", dest_parent.display()));
    }
    validate_path(&dest_parent.to_string_lossy(), &allowed_roots)?;
    if src_path.is_dir() {
        copy_dir_recursive(&src_path, dest_path)
    } else {
        fs::copy(&src_path, dest_path)
            .map(|_| ())
            .map_err(|e| format!("Failed to copy '{}' to '{}': {}", src, dest, e))
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("Failed to create dir '{}': {}", dst.display(), e))?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        // Skip symlinks to prevent following them outside the source tree
        if entry.file_type().map(|t| t.is_symlink()).unwrap_or(false) {
            continue;
        }
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("Failed to copy '{}': {}", src_path.display(), e))?;
        }
    }
    Ok(())
}
