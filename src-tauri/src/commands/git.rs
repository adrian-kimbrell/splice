//! Tauri commands for git operations.
//!
//! All commands validate the workspace root path through `state::validate_path`.
//! Git is invoked as a subprocess (not via git2) for consistency with the existing
//! `get_git_branch` command and to avoid a heavy native dependency.
//!
//! Paths in `git status` output are always relative to the *repository* root, not
//! to the directory git was run from. A workspace may be a subdirectory of its repo
//! (`~/repo/packages/app`), so every pathspec command runs from the repo root
//! (`git rev-parse --show-toplevel`) and `git_status` reports that root so the
//! frontend can join paths against it. Status is read with `-z`: NUL-separated
//! records, no C-style quoting of non-ASCII names, renames as two records.

use crate::state::validate_path;
use crate::state::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

const GIT_TIMEOUT_SECS: u64 = 10;
/// Commits run hooks (lint, tests, gpg) and legitimately take longer.
const GIT_COMMIT_TIMEOUT_SECS: u64 = 120;

/// Run a git command in the given directory with a timeout. The child is killed if
/// the future is dropped on timeout, so a stuck hook cannot linger as an orphan and
/// finish the operation behind the user's back after we reported an error.
async fn run_git_timeout(dir: &Path, args: &[&str], secs: u64) -> Result<std::process::Output, String> {
    let child = tokio::process::Command::new("git")
        .args(args)
        // `git status` otherwise takes `.git/index.lock` and rewrites `.git/index`
        // on every run. The explorer watches the workspace recursively, saw those
        // writes, refreshed, ran `git status` again, and so on, forever. Optional
        // locks only cover such opportunistic index refreshes; commands that must
        // write (add, commit, checkout) still lock as usual.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .current_dir(dir)
        .kill_on_drop(true)
        .output();
    tokio::time::timeout(std::time::Duration::from_secs(secs), child)
        .await
        .map_err(|_| format!("git timed out after {}s", secs))?
        .map_err(|e| format!("Failed to run git: {}", e))
}

async fn run_git(dir: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    run_git_timeout(dir, args, GIT_TIMEOUT_SECS).await
}

/// Run a git command and return stdout as a String, or an error if it fails.
async fn run_git_ok(dir: &Path, args: &[&str]) -> Result<String, String> {
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

/// The repository root that contains `dir` (canonicalised). Pathspecs from
/// `git status` are relative to this, not to `dir`.
pub(crate) async fn repo_root(dir: &Path) -> Result<PathBuf, String> {
    let out = run_git_ok(dir, &["rev-parse", "--show-toplevel"]).await?;
    let top = PathBuf::from(out.trim_end_matches(['\n', '\r']));
    Ok(std::fs::canonicalize(&top).unwrap_or(top))
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
pub struct GitStatusResult {
    /// Canonical repository root; `files[].path` is relative to this.
    pub repo_root: String,
    pub files: Vec<GitFileStatus>,
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
// Parsing
// ---------------------------------------------------------------------------

/// Parse `git status --porcelain=v1 -z` output.
///
/// Records are NUL-terminated: `XY <path>`. With `-z` git never quotes paths, so
/// `café.txt` arrives as-is (the line-oriented form produced `"caf\303\251.txt"`
/// with literal quotes, which no later command could resolve). For renames and
/// copies the *original* path follows as its own NUL-terminated record; it is
/// consumed and dropped so the entry carries the new path.
fn parse_porcelain_z(stdout: &str) -> Vec<GitFileStatus> {
    let mut files = Vec::new();
    let mut records = stdout.split('\0');
    while let Some(rec) = records.next() {
        if rec.len() < 4 {
            continue;
        }
        let bytes = rec.as_bytes();
        let index_status = bytes[0] as char;
        let worktree_status = bytes[1] as char;
        // bytes[2] is the space separator; `get` guards the (impossible) non-boundary.
        let Some(file_path) = rec.get(3..) else { continue };
        if matches!(index_status, 'R' | 'C') || matches!(worktree_status, 'R' | 'C') {
            let _original_path = records.next();
        }
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

/// Split the requested paths into tracked and untracked according to a status
/// listing, so discard can `checkout` the former and `clean` the latter.
fn split_tracked_untracked<'a>(
    status: &[GitFileStatus],
    requested: &'a [String],
) -> (Vec<&'a str>, Vec<&'a str>) {
    let untracked_set: std::collections::HashSet<&str> = status
        .iter()
        .filter(|f| f.index_status == '?')
        .map(|f| f.path.as_str())
        .collect();
    let mut tracked = Vec::new();
    let mut untracked = Vec::new();
    for fp in requested {
        if untracked_set.contains(fp.as_str()) {
            untracked.push(fp.as_str());
        } else {
            tracked.push(fp.as_str());
        }
    }
    (tracked, untracked)
}

// ---------------------------------------------------------------------------
// Implementations (no Tauri state; unit-testable against a real repo)
// ---------------------------------------------------------------------------

pub(crate) async fn status_impl(dir: &Path) -> Result<GitStatusResult, String> {
    let root = repo_root(dir).await?;
    let stdout = run_git_ok(&root, &["status", "--porcelain=v1", "-z", "-uall"]).await?;
    Ok(GitStatusResult {
        repo_root: root.to_string_lossy().to_string(),
        files: parse_porcelain_z(&stdout),
    })
}

pub(crate) async fn stage_impl(dir: &Path, file_paths: &[String]) -> Result<(), String> {
    if file_paths.is_empty() {
        return Ok(());
    }
    let root = repo_root(dir).await?;
    let mut args = vec!["add", "--"];
    args.extend(file_paths.iter().map(|s| s.as_str()));
    run_git_ok(&root, &args).await?;
    Ok(())
}

pub(crate) async fn unstage_impl(dir: &Path, file_paths: &[String]) -> Result<(), String> {
    // `git reset HEAD --` with no pathspec resets the whole index.
    if file_paths.is_empty() {
        return Ok(());
    }
    let root = repo_root(dir).await?;
    let mut args = vec!["reset", "HEAD", "--"];
    args.extend(file_paths.iter().map(|s| s.as_str()));
    run_git_ok(&root, &args).await?;
    Ok(())
}

pub(crate) async fn discard_impl(dir: &Path, file_paths: &[String]) -> Result<(), String> {
    if file_paths.is_empty() {
        return Ok(());
    }
    let status = status_impl(dir).await?;
    let root = PathBuf::from(&status.repo_root);
    let (tracked, untracked) = split_tracked_untracked(&status.files, file_paths);
    if !tracked.is_empty() {
        let mut args = vec!["checkout", "--"];
        args.extend(&tracked);
        run_git_ok(&root, &args).await?;
    }
    if !untracked.is_empty() {
        let mut args = vec!["clean", "-f", "--"];
        args.extend(&untracked);
        run_git_ok(&root, &args).await?;
    }
    Ok(())
}

/// Validate that a relative file path is safe: no `..` components, not absolute,
/// and does not contain null bytes or other shell-dangerous sequences.
fn validate_relative_path(file_path: &str) -> Result<(), String> {
    if file_path.is_empty() {
        return Err("file_path must not be empty".to_string());
    }
    if Path::new(file_path).is_absolute() {
        return Err(format!("file_path must be relative, got: {}", file_path));
    }
    for component in Path::new(file_path).components() {
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

pub(crate) async fn diff_impl(
    dir: &Path,
    file_path: &str,
    staged: bool,
    allowed_roots: &[PathBuf],
) -> Result<GitDiffContents, String> {
    // Reject paths with traversal or absolute paths before passing to git
    validate_relative_path(file_path)?;
    let root = repo_root(dir).await?;

    // Get old content from HEAD
    let old_result = run_git(&root, &["show", &format!("HEAD:{}", file_path)]).await?;
    let is_new = !old_result.status.success();
    let old_content = if is_new {
        String::new()
    } else if is_binary(&old_result.stdout) {
        return Err(format!("Binary file: {}", file_path));
    } else {
        String::from_utf8_lossy(&old_result.stdout).to_string()
    };

    // Check if the file exists on disk (for is_deleted detection)
    let file_on_disk = root.join(file_path);
    let file_exists = tokio::fs::metadata(&file_on_disk).await.is_ok();

    // Get new content
    let new_content = if staged {
        // From the index
        let result = run_git(&root, &["show", &format!(":{}", file_path)]).await?;
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
        // From the working tree. The resolved path must stay inside the repo and
        // inside the allowed roots (the repo root can lie above the workspace).
        let resolved = file_on_disk
            .canonicalize()
            .map_err(|e| format!("Failed to resolve {}: {}", file_path, e))?;
        if !resolved.starts_with(&root) {
            return Err(format!("Path {} escapes repository root", file_path));
        }
        validate_path(&resolved.to_string_lossy(), allowed_roots)?;
        let bytes = tokio::fs::read(&resolved)
            .await
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

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Get the git status of all files in the repo containing `path`.
#[tauri::command]
pub async fn git_status(
    state: State<'_, Mutex<AppState>>,
    path: String,
) -> Result<GitStatusResult, String> {
    let allowed_roots = get_allowed_roots(&state)?;
    let canonical = validate_path(&path, &allowed_roots)?;
    status_impl(&canonical).await
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
    stage_impl(&canonical, &file_paths).await
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
    unstage_impl(&canonical, &file_paths).await
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

    let output = run_git_timeout(&canonical, &["commit", "-m", &message], GIT_COMMIT_TIMEOUT_SECS).await?;
    if !output.status.success() {
        return Err(format!("git error: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
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
    discard_impl(&canonical, &file_paths).await
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
    diff_impl(&canonical, &file_path, staged, &allowed_roots).await
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
    // parse_porcelain_z
    // -----------------------------------------------------------------------

    #[test]
    fn parse_empty_output() {
        assert!(parse_porcelain_z("").is_empty());
    }

    #[test]
    fn parse_modified_in_worktree() {
        let files = parse_porcelain_z(" M src/main.rs\0");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src/main.rs");
        assert_eq!(files[0].index_status, ' ');
        assert_eq!(files[0].worktree_status, 'M');
    }

    #[test]
    fn parse_staged_added() {
        let files = parse_porcelain_z("A  new_file.txt\0");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "new_file.txt");
        assert_eq!(files[0].index_status, 'A');
        assert_eq!(files[0].worktree_status, ' ');
    }

    #[test]
    fn parse_untracked() {
        let files = parse_porcelain_z("?? untracked.txt\0");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "untracked.txt");
        assert_eq!(files[0].index_status, '?');
        assert_eq!(files[0].worktree_status, '?');
    }

    #[test]
    fn parse_both_staged_and_modified() {
        let files = parse_porcelain_z("MM both.ts\0");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].index_status, 'M');
        assert_eq!(files[0].worktree_status, 'M');
    }

    #[test]
    fn parse_deleted_in_worktree() {
        let files = parse_porcelain_z(" D gone.txt\0");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "gone.txt");
        assert_eq!(files[0].worktree_status, 'D');
    }

    #[test]
    fn parse_renamed_keeps_new_path_and_consumes_original_record() {
        // -z emits "R  new\0old\0": the original path is a separate record.
        let files = parse_porcelain_z("R  new.txt\0old.txt\0 M other.rs\0");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "new.txt");
        assert_eq!(files[0].index_status, 'R');
        assert_eq!(files[1].path, "other.rs");
    }

    #[test]
    fn parse_copied_consumes_original_record_too() {
        let files = parse_porcelain_z("C  copy.txt\0orig.txt\0");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "copy.txt");
    }

    #[test]
    fn parse_non_ascii_and_odd_names_arrive_unquoted() {
        // The line-oriented form gave "\"caf\\303\\251.txt\"" with literal quotes.
        let files = parse_porcelain_z(" M café.txt\0?? weird\nname -> arrow.txt\0");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "café.txt");
        assert_eq!(files[1].path, "weird\nname -> arrow.txt", "not a rename: arrow kept verbatim");
    }

    #[test]
    fn parse_file_with_spaces() {
        let files = parse_porcelain_z(" M src/my file.ts\0");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src/my file.ts");
    }

    #[test]
    fn parse_skips_short_records() {
        let files = parse_porcelain_z("AB\0ABC\0 M valid.ts\0");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "valid.ts");
    }

    #[test]
    fn parse_multiple_files() {
        let input = " M src/a.ts\0A  src/b.ts\0?? new.txt\0 D gone.rs\0";
        let files = parse_porcelain_z(input);
        assert_eq!(
            files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            vec!["src/a.ts", "src/b.ts", "new.txt", "gone.rs"]
        );
    }

    #[test]
    fn parse_conflict_both_modified() {
        let files = parse_porcelain_z("UU conflicted.txt\0");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].index_status, 'U');
        assert_eq!(files[0].worktree_status, 'U');
    }

    #[test]
    fn split_tracked_untracked_uses_status_not_guesswork() {
        let status = parse_porcelain_z(" M a.ts\0?? b.ts\0");
        let req = vec!["a.ts".to_string(), "b.ts".to_string(), "c.ts".to_string()];
        let (tracked, untracked) = split_tracked_untracked(&status, &req);
        assert_eq!(tracked, vec!["a.ts", "c.ts"]);
        assert_eq!(untracked, vec!["b.ts"]);
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

    // -----------------------------------------------------------------------
    // Against a real repository: non-ASCII names and a sub-directory workspace.
    // -----------------------------------------------------------------------

    fn git_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    fn sh_git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("run git");
        assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
    }

    /// A repo with one commit, a `café.txt` and a `packages/app/x.ts`, both modified.
    fn make_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        sh_git(p, &["init", "-q"]);
        sh_git(p, &["config", "user.email", "t@example.com"]);
        sh_git(p, &["config", "user.name", "Test"]);
        sh_git(p, &["config", "commit.gpgsign", "false"]);
        std::fs::create_dir_all(p.join("packages/app")).unwrap();
        std::fs::write(p.join("café.txt"), "one\n").unwrap();
        std::fs::write(p.join("packages/app/x.ts"), "let a = 1;\n").unwrap();
        sh_git(p, &["add", "-A"]);
        sh_git(p, &["commit", "-q", "-m", "init"]);
        std::fs::write(p.join("café.txt"), "two\n").unwrap();
        std::fs::write(p.join("packages/app/x.ts"), "let a = 2;\n").unwrap();
        dir
    }

    #[tokio::test]
    async fn status_from_a_subdirectory_reports_repo_root_and_repo_relative_paths() {
        if !git_available() { return; }
        let repo = make_repo();
        let sub = repo.path().join("packages/app");

        let status = status_impl(&sub).await.unwrap();

        assert_eq!(PathBuf::from(&status.repo_root), std::fs::canonicalize(repo.path()).unwrap());
        let mut paths: Vec<_> = status.files.iter().map(|f| f.path.clone()).collect();
        paths.sort();
        assert_eq!(paths, vec!["café.txt".to_string(), "packages/app/x.ts".to_string()]);
    }

    #[tokio::test]
    async fn stage_unstage_and_diff_work_for_non_ascii_names_from_a_subdirectory() {
        if !git_available() { return; }
        let repo = make_repo();
        let sub = repo.path().join("packages/app");
        let roots = vec![repo.path().to_path_buf()];
        let files = vec!["café.txt".to_string(), "packages/app/x.ts".to_string()];

        stage_impl(&sub, &files).await.expect("stage");
        let staged = status_impl(&sub).await.unwrap();
        assert!(staged.files.iter().all(|f| f.index_status == 'M'), "{:?}", staged.files);

        unstage_impl(&sub, &files).await.expect("unstage");
        let unstaged = status_impl(&sub).await.unwrap();
        assert!(unstaged.files.iter().all(|f| f.worktree_status == 'M'), "{:?}", unstaged.files);

        // Diff joins against the repo root, not the (sub-directory) workspace root.
        let d = diff_impl(&sub, "packages/app/x.ts", false, &roots).await.expect("diff");
        assert_eq!(d.old_content, "let a = 1;\n");
        assert_eq!(d.new_content, "let a = 2;\n");
        assert!(!d.is_deleted && !d.is_new);
        let d = diff_impl(&sub, "café.txt", false, &roots).await.expect("diff non-ascii");
        assert_eq!(d.new_content, "two\n");
    }

    #[tokio::test]
    async fn empty_pathspecs_are_no_ops_and_do_not_touch_the_index() {
        if !git_available() { return; }
        let repo = make_repo();
        let p = repo.path();
        stage_impl(p, &["café.txt".to_string()]).await.unwrap();

        // Used to run `git reset HEAD --`, which unstages everything.
        unstage_impl(p, &[]).await.unwrap();
        stage_impl(p, &[]).await.unwrap();
        discard_impl(p, &[]).await.unwrap();

        let status = status_impl(p).await.unwrap();
        let cafe = status.files.iter().find(|f| f.path == "café.txt").unwrap();
        assert_eq!(cafe.index_status, 'M', "staged change must survive an empty unstage");
    }

    #[tokio::test]
    async fn discard_restores_tracked_and_removes_untracked() {
        if !git_available() { return; }
        let repo = make_repo();
        let p = repo.path();
        std::fs::write(p.join("scratch.txt"), "tmp").unwrap();

        discard_impl(p, &["café.txt".to_string(), "scratch.txt".to_string()]).await.unwrap();

        assert_eq!(std::fs::read_to_string(p.join("café.txt")).unwrap(), "one\n");
        assert!(!p.join("scratch.txt").exists());
    }
}
