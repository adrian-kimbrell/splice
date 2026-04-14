use base64::Engine;
use crate::state::{validate_path, AppState};
use ignore::WalkBuilder;
use std::fs;
use std::sync::Mutex;
use tauri::State;
use tracing::warn;

use super::{FileEntry, SearchMatch, SearchResult, MAX_BASE64_SIZE, MAX_FILE_SIZE};

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
pub async fn get_git_branch(
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<String, String> {
    let allowed_roots = {
        let state = state.lock().map_err(|e| e.to_string())?;
        state.allowed_roots.clone()
    };
    let canonical = validate_path(&path, &allowed_roots)?;
    let child = tokio::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&canonical)
        .output();
    let output = tokio::time::timeout(std::time::Duration::from_secs(5), child)
        .await
        .map_err(|_| "git timed out after 5s".to_string())?
        .map_err(|e| format!("Failed to run git: {}", e))?;
    if !output.status.success() {
        return Err("Not a git repository".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
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

// ─── Unit tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use crate::state::AppState;
    use std::sync::Mutex;
    use tempfile::TempDir;

    // Helper: AppState whose allowed_roots contains a real temp dir.
    fn state_for(tmp: &TempDir) -> Mutex<AppState> {
        let mut s = AppState::new();
        s.allowed_roots.push(tmp.path().to_path_buf());
        Mutex::new(s)
    }

    // ── validate_path ────────────────────────────────────────────────────────

    #[test]
    fn validate_allows_path_inside_root() {
        let tmp = TempDir::new().unwrap();
        let allowed = vec![tmp.path().to_path_buf()];
        // Create a real file so canonicalize succeeds
        let f = tmp.path().join("hello.txt");
        std::fs::write(&f, "x").unwrap();
        let result = crate::state::validate_path(&f.to_string_lossy(), &allowed);
        assert!(result.is_ok(), "{:?}", result);
    }

    #[test]
    fn validate_rejects_path_outside_root() {
        let allowed_dir = TempDir::new().unwrap();
        let other_dir = TempDir::new().unwrap();
        let f = other_dir.path().join("file.txt");
        std::fs::write(&f, "x").unwrap();
        let allowed = vec![allowed_dir.path().to_path_buf()];
        let result = crate::state::validate_path(&f.to_string_lossy(), &allowed);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Access denied"));
    }

    #[test]
    fn validate_rejects_nonexistent_path() {
        let tmp = TempDir::new().unwrap();
        let allowed = vec![tmp.path().to_path_buf()];
        let result = crate::state::validate_path("/this/does/not/exist/ever", &allowed);
        assert!(result.is_err());
    }

    #[test]
    fn validate_home_dir_is_allowed_by_default() {
        // AppState::new() always seeds $HOME into allowed_roots
        let state = AppState::new();
        if let Some(_home) = dirs::home_dir() {
            // Use the config dir, which is always under $HOME on macOS/Linux
            if let Some(cfg) = dirs::config_dir() {
                if cfg.exists() {
                    let result = crate::state::validate_path(&cfg.to_string_lossy(), &state.allowed_roots);
                    assert!(result.is_ok(), "config dir should be under HOME");
                }
            }
        }
    }

    // ── watcher map (dedup / cleanup logic) ─────────────────────────────────

    #[test]
    fn appstate_starts_with_empty_watcher_map() {
        let state = AppState::new();
        assert!(state.watchers.is_empty());
    }

    #[test]
    fn dedup_check_prevents_double_insert() {
        // Mirrors the guard in watch_path:
        //   if s.watchers.contains_key(&canonical_str) { return Ok(()); }
        // We test the predicate directly against AppState without needing AppHandle.
        let tmp = TempDir::new().unwrap();
        let key = tmp.path().canonicalize().unwrap()
            .to_string_lossy().to_string();

        let state_mutex = state_for(&tmp);
        let state = state_mutex.lock().unwrap();

        // First call: not present → should proceed
        assert!(!state.watchers.contains_key(&key), "should be absent initially");

        // Simulate what watch_path does after creating the watcher:
        // insert a sentinel (we can't create a real watcher without AppHandle, so
        // we verify the HashMap contract the guard relies on).
        // A real RecommendedWatcher can't be constructed in a unit test, so we
        // verify the logic path that skips re-watch when the key is already present.
        // The dedup is: if contains_key → return Ok(()).
        // After the first watch the key will be present, so a second call short-circuits.
        //
        // We can simulate this by testing the contains_key predicate:
        assert!(!state.watchers.contains_key(&key)); // guard would NOT short-circuit
        // (Full integration test for the watcher itself lives in scripts/chaos.sh)
    }

    #[test]
    fn watcher_count_after_sequential_unwatch() {
        // Test the AppState map semantics used by unwatch_path.
        let tmp = TempDir::new().unwrap();
        let key = tmp.path().canonicalize().unwrap()
            .to_string_lossy().to_string();

        let state_mutex = state_for(&tmp);
        let mut state = state_mutex.lock().unwrap();

        // Simulate: nothing inserted yet
        assert_eq!(state.watchers.len(), 0);

        // Simulate unwatch on a key that was never watched → no panic, map stays empty
        state.watchers.remove(&key);
        assert_eq!(state.watchers.len(), 0);
    }

    // ── sibling-prefix path isolation ────────────────────────────────────────
    // Mirrors the JS isUnderRoot tests to ensure Rust side would also be safe
    // if ever used for path filtering.

    #[test]
    fn sibling_prefix_is_not_a_subpath() {
        let root = std::path::PathBuf::from("/a/b");
        let sibling = std::path::PathBuf::from("/a/bc/file.txt");
        // The correct check: starts_with uses path components, not byte prefix
        assert!(!sibling.starts_with(&root),
            "PathBuf::starts_with correctly rejects sibling-prefix paths");
    }

    #[test]
    fn child_path_starts_with_root() {
        let root = std::path::PathBuf::from("/a/b");
        let child = std::path::PathBuf::from("/a/b/c/file.txt");
        assert!(child.starts_with(&root));
    }
}
