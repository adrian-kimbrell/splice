use base64::Engine;
use crate::state::{validate_path, AppState};
use ignore::WalkBuilder;
use notify::{EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tracing::{info, warn};

const MAX_FILE_SIZE: u64 = 50 * 1024 * 1024; // 50 MB
const MAX_RECENT_LIST_SIZE: u64 = 1 * 1024 * 1024; // 1 MB

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileEntry>>,
}

#[tauri::command]
pub fn read_dir_tree(
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    let allowed_roots = {
        let state = state.lock().map_err(|e| e.to_string())?;
        state.allowed_roots.clone()
    };
    let canonical = validate_path(&path, &allowed_roots)?;

    let dir = canonical.as_path();
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let mut entries: Vec<FileEntry> = Vec::new();
    let read_dir = fs::read_dir(dir).map_err(|e| e.to_string())?;

    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files by default
        if name.starts_with('.') {
            continue;
        }

        let path = entry.path();
        let is_dir = path.is_dir();

        entries.push(FileEntry {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            children: None,
        });
    }

    entries.sort_by(|a, b| {
        if a.is_dir == b.is_dir {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        } else if a.is_dir {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });

    Ok(entries)
}

#[tauri::command]
pub fn read_file(
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<String, String> {
    let allowed_roots = {
        let state = state.lock().map_err(|e| e.to_string())?;
        state.allowed_roots.clone()
    };
    let canonical = validate_path(&path, &allowed_roots)?;

    let metadata = fs::metadata(&canonical).map_err(|e| format!("Failed to stat {}: {}", path, e))?;
    if metadata.len() > MAX_FILE_SIZE {
        warn!(path = %path, size = metadata.len(), "File exceeds size limit");
        return Err(format!(
            "File too large ({:.1} MB, max {} MB): {}",
            metadata.len() as f64 / (1024.0 * 1024.0),
            MAX_FILE_SIZE / (1024 * 1024),
            path
        ));
    }

    fs::read_to_string(&canonical).map_err(|e| format!("Failed to read {}: {}", path, e))
}

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
pub fn get_git_branch(
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<String, String> {
    let allowed_roots = {
        let state = state.lock().map_err(|e| e.to_string())?;
        state.allowed_roots.clone()
    };
    let canonical = validate_path(&path, &allowed_roots)?;
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&canonical)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;
    if !output.status.success() {
        return Err("Not a git repository".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

const MAX_BASE64_SIZE: u64 = 20 * 1024 * 1024; // 20 MB

#[tauri::command]
pub fn read_file_base64(
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<String, String> {
    let allowed_roots = {
        let state = state.lock().map_err(|e| e.to_string())?;
        state.allowed_roots.clone()
    };
    let canonical = validate_path(&path, &allowed_roots)?;
    let metadata = fs::metadata(&canonical)
        .map_err(|e| format!("Failed to stat {}: {}", path, e))?;
    if metadata.len() > MAX_BASE64_SIZE {
        return Err(format!(
            "File too large ({:.1} MB, max {} MB): {}",
            metadata.len() as f64 / (1024.0 * 1024.0),
            MAX_BASE64_SIZE / (1024 * 1024),
            path
        ));
    }
    let bytes = fs::read(&canonical).map_err(|e| format!("Failed to read {}: {}", path, e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

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

#[derive(Debug, Clone, Serialize)]
pub struct SearchMatch {
    pub path: String,
    pub line_number: usize,
    pub line_content: String,
    pub col_start: usize,
    pub col_end: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
    pub total_files_searched: usize,
}

#[tauri::command]
pub fn search_files(
    state: State<'_, Mutex<AppState>>,
    root_path: String,
    query: String,
    case_sensitive: bool,
    max_results: Option<usize>,
) -> Result<SearchResult, String> {
    let allowed_roots = {
        let state = state.lock().map_err(|e| e.to_string())?;
        state.allowed_roots.clone()
    };
    let canonical = validate_path(&root_path, &allowed_roots)?;
    let limit = max_results.unwrap_or(500);

    if query.is_empty() {
        return Ok(SearchResult {
            matches: Vec::new(),
            truncated: false,
            total_files_searched: 0,
        });
    }

    let pattern = if case_sensitive {
        regex::Regex::new(&regex::escape(&query))
    } else {
        regex::RegexBuilder::new(&regex::escape(&query))
            .case_insensitive(true)
            .build()
    }
    .map_err(|e| format!("Invalid search pattern: {}", e))?;

    let mut matches = Vec::new();
    let mut total_files = 0usize;
    let mut truncated = false;

    let walker = WalkBuilder::new(&canonical)
        .hidden(true) // respect hidden files via .gitignore
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .build();

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        // Guard: skip entries that escaped the validated root (e.g., via followed symlinks)
        if !path.starts_with(&canonical) {
            continue;
        }

        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue, // skip binary / unreadable files
        };

        total_files += 1;

        for (line_idx, line) in content.lines().enumerate() {
            for m in pattern.find_iter(line) {
                matches.push(SearchMatch {
                    path: path.to_string_lossy().to_string(),
                    line_number: line_idx + 1,
                    line_content: line.chars().take(300).collect(),
                    col_start: line[..m.start()].chars().count(),
                    col_end: line[..m.end()].chars().count(),
                });

                if matches.len() >= limit {
                    truncated = true;
                    return Ok(SearchResult {
                        matches,
                        truncated,
                        total_files_searched: total_files,
                    });
                }
            }
        }
    }

    Ok(SearchResult {
        matches,
        truncated,
        total_files_searched: total_files,
    })
}

#[tauri::command]
pub fn watch_path(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<(), String> {
    // Validate before creating the watcher
    let allowed_roots = {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.allowed_roots.clone()
    };
    let canonical = validate_path(&path, &allowed_roots)?;
    let canonical_str = canonical.to_string_lossy().to_string();

    let emit_path = canonical_str.clone();
    let last_emit = std::sync::Arc::new(std::sync::Mutex::new(std::time::Instant::now()));

    let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        if let Ok(event) = res {
            match event.kind {
                EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_) => {
                    let mut last = last_emit.lock().unwrap_or_else(|e| e.into_inner());
                    if last.elapsed() < std::time::Duration::from_millis(200) {
                        return;
                    }
                    *last = std::time::Instant::now();
                    let _ = app.emit("file:changed", emit_path.clone());
                }
                _ => {}
            }
        }
    })
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    watcher
        .watch(canonical.as_path(), RecursiveMode::NonRecursive)
        .map_err(|e| format!("Failed to watch path: {}", e))?;

    info!(path = %canonical_str, "Watching file");
    let mut state = state.lock().map_err(|e| e.to_string())?;
    state.watchers.insert(canonical_str, watcher);
    Ok(())
}

#[tauri::command]
pub fn unwatch_path(
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<(), String> {
    // Must canonicalise the same way watch_path does.
    // Use std::fs::canonicalize (not validate_path) — the file may no longer exist.
    let key = std::fs::canonicalize(&path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.clone());
    let mut state = state.lock().map_err(|e| e.to_string())?;
    // Try canonical key first; fall back to raw path for pre-fix watchers still in map.
    if state.watchers.remove(&key).is_none() {
        state.watchers.remove(&path);
    }
    info!(path = %key, "Unwatched file");
    Ok(())
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

#[tauri::command]
pub fn reveal_in_file_manager(
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<(), String> {
    let allowed_roots = {
        let state = state.lock().map_err(|e| e.to_string())?;
        state.allowed_roots.clone()
    };
    let canonical = validate_path(&path, &allowed_roots)?;
    std::process::Command::new("open")
        .args(["-R", &canonical.to_string_lossy()])
        .spawn()
        .map_err(|e| format!("Failed to reveal in Finder: {}", e))?;
    Ok(())
}
