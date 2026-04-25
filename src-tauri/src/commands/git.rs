//! Tauri commands for git operations.
//!
//! All commands validate the workspace root path through `state::validate_path`.
//! Git is invoked as a subprocess (not via git2) for consistency with the existing
//! `get_git_branch` command and to avoid a heavy native dependency.

use crate::state::validate_path;
use crate::state::AppState;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

const GIT_TIMEOUT_SECS: u64 = 10;

/// Run a git command in the given directory with a timeout.
async fn run_git(dir: &PathBuf, args: &[&str]) -> Result<std::process::Output, String> {
    let child = tokio::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .output();
    tokio::time::timeout(std::time::Duration::from_secs(GIT_TIMEOUT_SECS), child)
        .await
        .map_err(|_| format!("git timed out after {}s", GIT_TIMEOUT_SECS))?
        .map_err(|e| format!("Failed to run git: {}", e))
}

/// Run a git command and return stdout as a String, or an error if it fails.
async fn run_git_ok(dir: &PathBuf, args: &[&str]) -> Result<String, String> {
    let output = run_git(dir, args).await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git error: {}", stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn get_allowed_roots(state: &State<'_, Mutex<AppState>>) -> Result<Vec<PathBuf>, String> {
    let state = state.lock().map_err(|e| e.to_string())?;
    Ok(state.allowed_roots.clone())
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct GitFileStatus {
    /// Relative path from repo root
    pub path: String,
    /// Index (staged) status character: ' ', M, A, D, R, C, U, ?
    pub index_status: char,
    /// Working tree status character: ' ', M, A, D, R, C, U, ?
    pub worktree_status: char,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitDiffContents {
    pub old_content: String,
    pub new_content: String,
    pub is_new: bool,
    pub is_deleted: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitLogEntry {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub timestamp: i64,
    pub message: String,
    pub parents: Vec<String>,
    pub refs: String,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Parse git status porcelain v1 output into a list of file statuses.
fn parse_porcelain_v1(stdout: &str) -> Vec<GitFileStatus> {
    let mut files = Vec::new();
    for line in stdout.lines() {
        if line.len() < 4 {
            continue;
        }
        let bytes = line.as_bytes();
        let index_status = bytes[0] as char;
        let worktree_status = bytes[1] as char;
        // bytes[2] is a space separator
        let file_path = &line[3..];
        // Handle renames: "R  old -> new" — use the new path.
        // Only apply when the status is R to avoid mishandling filenames
        // that happen to contain " -> ".
        let is_rename = index_status == 'R' || worktree_status == 'R';
        let file_path = if is_rename {
            if let Some(arrow_pos) = file_path.find(" -> ") {
                &file_path[arrow_pos + 4..]
            } else {
                file_path
            }
        } else {
            file_path
        };
        files.push(GitFileStatus {
            path: file_path.to_string(),
            index_status,
            worktree_status,
        });
    }
    files
}

/// Parse git log output (using \x1f separator) into log entries.
fn parse_git_log(stdout: &str) -> Vec<GitLogEntry> {
    let mut entries = Vec::new();
    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('\x1f').collect();
        if parts.len() < 7 {
            continue;
        }
        let timestamp = parts[3].parse::<i64>().unwrap_or(0);
        let parents: Vec<String> = if parts[5].is_empty() {
            Vec::new()
        } else {
            parts[5].split(' ').map(|s| s.to_string()).collect()
        };
        entries.push(GitLogEntry {
            hash: parts[0].to_string(),
            short_hash: parts[1].to_string(),
            author: parts[2].to_string(),
            timestamp,
            message: parts[4].to_string(),
            parents,
            refs: parts[6].to_string(),
        });
    }
    entries
}

/// Get the git status of all files in the repo.
/// Returns parsed porcelain v1 output.
#[tauri::command]
pub async fn git_status(
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<Vec<GitFileStatus>, String> {
    let allowed_roots = get_allowed_roots(&state)?;
    let canonical = validate_path(&path, &allowed_roots)?;

    let stdout = run_git_ok(&canonical, &["status", "--porcelain=v1", "-uall"]).await?;
    Ok(parse_porcelain_v1(&stdout))
}

/// Stage files for commit.
#[tauri::command]
pub async fn git_stage(
    state: State<'_, Mutex<AppState>>,
    path: String,
    file_paths: Vec<String>,
) -> Result<(), String> {
    let allowed_roots = get_allowed_roots(&state)?;
    let canonical = validate_path(&path, &allowed_roots)?;

    let mut args = vec!["add", "--"];
    let file_refs: Vec<&str> = file_paths.iter().map(|s| s.as_str()).collect();
    args.extend(file_refs);
    run_git_ok(&canonical, &args).await?;
    Ok(())
}

/// Unstage files (reset from index).
#[tauri::command]
pub async fn git_unstage(
    state: State<'_, Mutex<AppState>>,
    path: String,
    file_paths: Vec<String>,
) -> Result<(), String> {
    let allowed_roots = get_allowed_roots(&state)?;
    let canonical = validate_path(&path, &allowed_roots)?;

    let mut args = vec!["reset", "HEAD", "--"];
    let file_refs: Vec<&str> = file_paths.iter().map(|s| s.as_str()).collect();
    args.extend(file_refs);
    run_git_ok(&canonical, &args).await?;
    Ok(())
}

/// Commit staged changes. Returns the commit hash.
#[tauri::command]
pub async fn git_commit(
    state: State<'_, Mutex<AppState>>,
    path: String,
    message: String,
) -> Result<String, String> {
    let allowed_roots = get_allowed_roots(&state)?;
    let canonical = validate_path(&path, &allowed_roots)?;

    run_git_ok(&canonical, &["commit", "-m", &message]).await?;
    // Get the hash of the commit we just made
    let hash = run_git_ok(&canonical, &["rev-parse", "HEAD"]).await?;
    Ok(hash.trim().to_string())
}

/// Discard working tree changes for the given files.
/// For tracked files: `git checkout -- <paths>`
/// For untracked files: `git clean -f -- <paths>`
#[tauri::command]
pub async fn git_discard(
    state: State<'_, Mutex<AppState>>,
    path: String,
    file_paths: Vec<String>,
) -> Result<(), String> {
    let allowed_roots = get_allowed_roots(&state)?;
    let canonical = validate_path(&path, &allowed_roots)?;

    // Separate tracked vs untracked by checking git status
    let stdout = run_git_ok(&canonical, &["status", "--porcelain=v1", "-uall"]).await?;
    let mut untracked = Vec::new();
    let mut tracked = Vec::new();

    let untracked_set: std::collections::HashSet<&str> = stdout
        .lines()
        .filter(|l| l.starts_with("??"))
        .filter_map(|l| l.get(3..))
        .collect();

    for fp in &file_paths {
        if untracked_set.contains(fp.as_str()) {
            untracked.push(fp.as_str());
        } else {
            tracked.push(fp.as_str());
        }
    }

    if !tracked.is_empty() {
        let mut args = vec!["checkout", "--"];
        args.extend(&tracked);
        run_git_ok(&canonical, &args).await?;
    }
    if !untracked.is_empty() {
        let mut args = vec!["clean", "-f", "--"];
        args.extend(&untracked);
        run_git_ok(&canonical, &args).await?;
    }
    Ok(())
}

/// Validate that a relative file path is safe: no `..` components, not absolute,
/// and does not contain null bytes or other shell-dangerous sequences.
fn validate_relative_path(file_path: &str) -> Result<(), String> {
    if file_path.is_empty() {
        return Err("file_path must not be empty".to_string());
    }
    if std::path::Path::new(file_path).is_absolute() {
        return Err(format!("file_path must be relative, got: {}", file_path));
    }
    for component in std::path::Path::new(file_path).components() {
        if component == std::path::Component::ParentDir {
            return Err(format!("file_path must not contain '..': {}", file_path));
        }
    }
    if file_path.contains('\0') {
        return Err("file_path must not contain null bytes".to_string());
    }
    Ok(())
}

/// Returns true if the byte slice looks like binary content (contains a NUL byte).
fn is_binary(data: &[u8]) -> bool {
    data.contains(&0u8)
}

/// Get old and new content for a file diff.
/// If `staged` is true, compares HEAD vs index. Otherwise compares HEAD vs working tree.
#[tauri::command]
pub async fn git_diff_file(
    state: State<'_, Mutex<AppState>>,
    path: String,
    file_path: String,
    staged: bool,
) -> Result<GitDiffContents, String> {
    let allowed_roots = get_allowed_roots(&state)?;
    let canonical = validate_path(&path, &allowed_roots)?;

    // Reject paths with traversal or absolute paths before passing to git
    validate_relative_path(&file_path)?;

    // Get old content from HEAD
    let old_result = run_git(&canonical, &["show", &format!("HEAD:{}", file_path)]).await?;
    let is_new = !old_result.status.success();
    let old_content = if is_new {
        String::new()
    } else if is_binary(&old_result.stdout) {
        return Err(format!("Binary file: {}", file_path));
    } else {
        String::from_utf8_lossy(&old_result.stdout).to_string()
    };

    // Check if the file exists on disk (for is_deleted detection)
    let file_on_disk = canonical.join(&file_path);
    let file_exists = tokio::fs::metadata(&file_on_disk).await.is_ok();

    // Get new content
    let new_content = if staged {
        // From the index
        let result = run_git(&canonical, &["show", &format!(":{}", file_path)]).await?;
        if result.status.success() {
            if is_binary(&result.stdout) {
                return Err(format!("Binary file: {}", file_path));
            }
            String::from_utf8_lossy(&result.stdout).to_string()
        } else {
            // File deleted from index
            String::new()
        }
    } else if file_exists {
        // From the working tree — validate the resolved path stays under the workspace root
        let resolved = file_on_disk.canonicalize()
            .map_err(|e| format!("Failed to resolve {}: {}", file_path, e))?;
        if !resolved.starts_with(&canonical) {
            return Err(format!("Path {} escapes workspace root", file_path));
        }
        let bytes = tokio::fs::read(&resolved).await
            .map_err(|e| format!("Failed to read {}: {}", file_path, e))?;
        if is_binary(&bytes) {
            return Err(format!("Binary file: {}", file_path));
        }
        String::from_utf8_lossy(&bytes).to_string()
    } else {
        String::new()
    };

    let is_deleted = !file_exists && !is_new;

    Ok(GitDiffContents {
        old_content,
        new_content,
        is_new,
        is_deleted,
    })
}

/// Get git log entries.
#[tauri::command]
pub async fn git_log(
    state: State<'_, Mutex<AppState>>,
    path: String,
    max_count: Option<u32>,
) -> Result<Vec<GitLogEntry>, String> {
    let allowed_roots = get_allowed_roots(&state)?;
    let canonical = validate_path(&path, &allowed_roots)?;

    let count = max_count.unwrap_or(100).to_string();
    let format = "%H\x1f%h\x1f%an\x1f%at\x1f%s\x1f%P\x1f%D";
    let stdout = run_git_ok(
        &canonical,
        &["log", "--all", "--topo-order", &format!("--pretty=format:{}", format), "-n", &count],
    )
    .await?;

    Ok(parse_git_log(&stdout))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // parse_porcelain_v1
    // -----------------------------------------------------------------------

    #[test]
    fn parse_empty_output() {
        assert!(parse_porcelain_v1("").is_empty());
    }

    #[test]
    fn parse_modified_in_worktree() {
        let files = parse_porcelain_v1(" M src/main.rs\n");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src/main.rs");
        assert_eq!(files[0].index_status, ' ');
        assert_eq!(files[0].worktree_status, 'M');
    }

    #[test]
    fn parse_staged_added() {
        let files = parse_porcelain_v1("A  new_file.txt\n");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "new_file.txt");
        assert_eq!(files[0].index_status, 'A');
        assert_eq!(files[0].worktree_status, ' ');
    }

    #[test]
    fn parse_untracked() {
        let files = parse_porcelain_v1("?? untracked.txt\n");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "untracked.txt");
        assert_eq!(files[0].index_status, '?');
        assert_eq!(files[0].worktree_status, '?');
    }

    #[test]
    fn parse_both_staged_and_modified() {
        let files = parse_porcelain_v1("MM both.ts\n");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].index_status, 'M');
        assert_eq!(files[0].worktree_status, 'M');
    }

    #[test]
    fn parse_deleted_in_worktree() {
        let files = parse_porcelain_v1(" D gone.txt\n");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "gone.txt");
        assert_eq!(files[0].index_status, ' ');
        assert_eq!(files[0].worktree_status, 'D');
    }

    #[test]
    fn parse_renamed_extracts_new_path() {
        let files = parse_porcelain_v1("R  old.txt -> new.txt\n");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "new.txt");
        assert_eq!(files[0].index_status, 'R');
    }

    #[test]
    fn parse_file_with_spaces() {
        let files = parse_porcelain_v1(" M src/my file.ts\n");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src/my file.ts");
    }

    #[test]
    fn parse_skips_short_lines() {
        let files = parse_porcelain_v1("AB\nABC\n M valid.ts\n");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "valid.ts");
    }

    #[test]
    fn parse_multiple_files() {
        let input = " M src/a.ts\nA  src/b.ts\n?? new.txt\n D gone.rs\n";
        let files = parse_porcelain_v1(input);
        assert_eq!(files.len(), 4);
        assert_eq!(files[0].path, "src/a.ts");
        assert_eq!(files[1].path, "src/b.ts");
        assert_eq!(files[2].path, "new.txt");
        assert_eq!(files[3].path, "gone.rs");
    }

    #[test]
    fn parse_staged_deleted() {
        let files = parse_porcelain_v1("D  removed.txt\n");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "removed.txt");
        assert_eq!(files[0].index_status, 'D');
        assert_eq!(files[0].worktree_status, ' ');
    }

    #[test]
    fn parse_conflict_both_modified() {
        let files = parse_porcelain_v1("UU conflicted.txt\n");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].index_status, 'U');
        assert_eq!(files[0].worktree_status, 'U');
    }

    // -----------------------------------------------------------------------
    // parse_git_log
    // -----------------------------------------------------------------------

    #[test]
    fn parse_log_empty() {
        assert!(parse_git_log("").is_empty());
    }

    #[test]
    fn parse_log_single_entry() {
        let input = "abc123full\x1fabc123\x1fJohn Doe\x1f1700000000\x1fInitial commit\x1f\x1fHEAD -> main";
        let entries = parse_git_log(input);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].hash, "abc123full");
        assert_eq!(entries[0].short_hash, "abc123");
        assert_eq!(entries[0].author, "John Doe");
        assert_eq!(entries[0].timestamp, 1700000000);
        assert_eq!(entries[0].message, "Initial commit");
        assert!(entries[0].parents.is_empty());
        assert_eq!(entries[0].refs, "HEAD -> main");
    }

    #[test]
    fn parse_log_with_parents() {
        let input = "def456\x1fdef4\x1fJane\x1f1700001000\x1fMerge branch\x1faaa bbb\x1f";
        let entries = parse_git_log(input);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].parents, vec!["aaa", "bbb"]);
    }

    #[test]
    fn parse_log_multiple_entries() {
        let input = "aaa\x1fa\x1fAlice\x1f100\x1fFirst\x1f\x1fmain\nbbb\x1fb\x1fBob\x1f200\x1fSecond\x1faaa\x1f";
        let entries = parse_git_log(input);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].short_hash, "a");
        assert_eq!(entries[1].short_hash, "b");
        assert_eq!(entries[1].parents, vec!["aaa"]);
    }

    #[test]
    fn parse_log_skips_malformed_lines() {
        let input = "too\x1ffew\x1ffields\naaa\x1fa\x1fAlice\x1f100\x1fOK\x1f\x1f";
        let entries = parse_git_log(input);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].message, "OK");
    }

    #[test]
    fn parse_log_invalid_timestamp_defaults_to_zero() {
        let input = "aaa\x1fa\x1fAlice\x1fnotanumber\x1fMsg\x1f\x1f";
        let entries = parse_git_log(input);
        assert_eq!(entries[0].timestamp, 0);
    }
}
