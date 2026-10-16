//! Global application state, stored as `Mutex<AppState>` in Tauri's managed state.
//!
//! Every Tauri command that touches backend data locks this single mutex. Key collections:
//! - `terminals`: live PTY sessions keyed by a monotonic u32 ID
//! - `window_workspaces`: per-Tauri-window workspace list; key is the window label string
//! - `terminal_claude_sessions`: maps terminal_id → (claude_session_id, claude_pid)
//!   used by the attention system to verify Claude is still running at persist time
//! - `lsp_sessions`: one LSP server process per language_id (lazily started)
//! - `ssh_sessions`: one openssh ControlMaster session per workspace_id
//!
//! `validate_path` is the security boundary for all filesystem commands — it canonicalizes
//! the path and checks it falls under `allowed_roots` (defaults to HOME; expanded by
//! `add_allowed_root` when a workspace outside HOME is opened).

use crate::terminal::pty::PtySession;
use crate::workspace::layout::{Settings, Workspace};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Splice's own config directory: `~/Library/Application Support/<name>` on macOS,
/// `~/.config/<name>` on Linux. `SPLICE_CONFIG_DIR` overrides the whole path so a
/// sandboxed instance (the E2E harness) never touches the user's real settings,
/// workspaces, or attention port file. Callers pass the per-file folder name they
/// already use (`"Splice"`, or `"Splice-dev"` for debug-build workspaces).
pub fn splice_config_dir(name: &str) -> PathBuf {
    if let Some(dir) = std::env::var_os("SPLICE_CONFIG_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(name)
}

/// True when `SPLICE_CONFIG_DIR` is set, i.e. this instance runs against a scratch
/// config directory and must not modify anything outside it (such as the Claude hook).
pub fn config_dir_is_sandboxed() -> bool {
    std::env::var_os("SPLICE_CONFIG_DIR").is_some_and(|v| !v.is_empty())
}

pub struct AppState {
    pub terminals: HashMap<u32, PtySession>,
    pub next_terminal_id: u32,
    /// window label → (active_workspace_id, workspaces)
    pub window_workspaces: HashMap<String, (Option<String>, Vec<Workspace>)>,
    pub settings: Settings,
    pub settings_loaded: bool,
    pub allowed_roots: Vec<PathBuf>,
    pub attention_port: Option<u16>,
    /// Auth token for this process's attention server — injected into each terminal's
    /// environment as `SPLICE_ATTENTION_TOKEN` so hooks know which instance to call.
    pub attention_token: Option<String>,
    /// Reference-counted filesystem watchers keyed by canonical path (see fs/watch.rs).
    pub watchers: HashMap<String, crate::commands::fs::watch::WatchEntry>,
    /// terminal_id → (session_id, claude_pid)
    /// claude_pid lets us verify Claude is still running at persist time.
    pub terminal_claude_sessions: HashMap<u32, (String, u32)>,
    /// language_id → active LSP session
    pub lsp_sessions: HashMap<String, crate::lsp::LspSession>,
    /// workspace_id → established SSH ControlMaster session
    pub ssh_sessions: HashMap<String, Arc<openssh::Session>>,
    /// Paths the OS asked us to open (Finder "Open With") that arrived before
    /// the frontend was listening. Drained on startup via take_pending_open_paths.
    pub pending_open_paths: Vec<OpenTarget>,
}

/// A file or folder the OS handed us to open (macOS `RunEvent::Opened`).
#[derive(Clone, serde::Serialize)]
pub struct OpenTarget {
    pub path: String,
    pub is_dir: bool,
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    pub fn new() -> Self {
        let mut allowed_roots = Vec::new();
        if let Some(home) = dirs::home_dir() {
            allowed_roots.push(home);
        }
        Self {
            terminals: HashMap::new(),
            next_terminal_id: 1,
            window_workspaces: HashMap::new(),
            settings: Settings::default(),
            settings_loaded: false,
            allowed_roots,
            attention_port: None,
            attention_token: None,
            watchers: HashMap::new(),
            terminal_claude_sessions: HashMap::new(),
            lsp_sessions: HashMap::new(),
            ssh_sessions: HashMap::new(),
            pending_open_paths: Vec::new(),
        }
    }
}

/// Validates that a path resolves to a location under one of the allowed roots.
/// Returns the canonicalized path on success.
pub fn validate_path(path: &str, allowed_roots: &[PathBuf]) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| format!("Invalid path '{}': {}", path, e))?;
    for root in allowed_roots {
        if let Ok(canonical_root) = std::fs::canonicalize(root) {
            if canonical.starts_with(&canonical_root) {
                return Ok(canonical);
            }
        }
    }
    Err(format!("Access denied: '{}' is outside allowed directories", path))
}

/// Validates a path that names a directory *entry* to be created, renamed, deleted
/// or duplicated. The parent is canonicalised and checked against the allowed roots
/// (it must exist); the final component is kept verbatim and must be a plain name,
/// never `.` or `..`. Unlike `validate_path`, the leaf is not resolved, so a symlink
/// inside a root is addressed as the link itself rather than as its target, and the
/// entry does not have to exist yet.
pub fn validate_entry_path(path: &str, allowed_roots: &[PathBuf]) -> Result<PathBuf, String> {
    let p = Path::new(path);
    let name = match p.components().next_back() {
        Some(std::path::Component::Normal(n)) => n.to_os_string(),
        _ => return Err(format!("Invalid path '{}': no file name", path)),
    };
    let parent = p
        .parent()
        .filter(|q| !q.as_os_str().is_empty())
        .ok_or_else(|| format!("Invalid path '{}': no parent directory", path))?;
    let canonical_parent = validate_path(&parent.to_string_lossy(), allowed_roots)?;
    Ok(canonical_parent.join(name))
}

#[cfg(test)]
mod config_dir_tests {
    use super::*;

    #[test]
    fn splice_config_dir_honours_override_or_appends_name() {
        // Never mutate the env here: cargo runs tests in parallel and other tests
        // write real config files through this helper.
        match std::env::var_os("SPLICE_CONFIG_DIR").filter(|v| !v.is_empty()) {
            Some(dir) => {
                assert_eq!(splice_config_dir("Splice-x"), PathBuf::from(&dir));
                assert_eq!(splice_config_dir("Other"), PathBuf::from(dir));
                assert!(config_dir_is_sandboxed());
            }
            None => {
                let p = splice_config_dir("Splice-x");
                assert_eq!(p.file_name().and_then(|n| n.to_str()), Some("Splice-x"));
                assert!(!config_dir_is_sandboxed());
            }
        }
    }
}
