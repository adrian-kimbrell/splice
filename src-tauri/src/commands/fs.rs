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
    // For new files, validate the parent directory
    let p = Path::new(&path);
    if p.exists() {
        validate_path(&path, &allowed_roots)?;
    } else if let Some(parent) = p.parent() {
        if parent.exists() {
            validate_path(&parent.to_string_lossy(), &allowed_roots)?;
        } else {
            return Err(format!("Parent directory does not exist: {}", path));
        }
    }

    fs::write(&path, content).map_err(|e| format!("Failed to write {}: {}", path, e))
}

#[tauri::command]
pub fn get_git_branch(path: String) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;
    if !output.status.success() {
        return Err("Not a git repository".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

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
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_recent_file(path: String) -> Result<(), String> {
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
    fs::write(&file_path, json).map_err(|e| e.to_string())
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
                    line_content: line.to_string(),
                    col_start: m.start(),
                    col_end: m.end(),
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
    let watch_path = path.clone();
    let emit_path = path.clone();

    // Debounce: track last emit time per path
    let last_emit = std::sync::Arc::new(std::sync::Mutex::new(std::time::Instant::now()));

    let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        if let Ok(event) = res {
            match event.kind {
                EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_) => {
                    let mut last = last_emit.lock().unwrap();
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
        .watch(Path::new(&watch_path), RecursiveMode::NonRecursive)
        .map_err(|e| format!("Failed to watch path: {}", e))?;

    info!(path = %watch_path, "Watching file");
    let mut state = state.lock().map_err(|e| e.to_string())?;
    state.watchers.insert(watch_path, watcher);
    Ok(())
}

#[tauri::command]
pub fn unwatch_path(
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<(), String> {
    let mut state = state.lock().map_err(|e| e.to_string())?;
    state.watchers.remove(&path);
    info!(path = %path, "Unwatched file");
    Ok(())
}
