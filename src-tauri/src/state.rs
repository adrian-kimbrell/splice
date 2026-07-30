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
use notify::RecommendedWatcher;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

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
    pub watchers: HashMap<String, RecommendedWatcher>,
    /// terminal_id → (session_id, claude_pid)
    /// claude_pid lets us verify Claude is still running at persist time.
    pub terminal_claude_sessions: HashMap<u32, (String, u32)>,
    /// language_id → active LSP session
    pub lsp_sessions: HashMap<String, crate::lsp::LspSession>,
    /// workspace_id → established SSH ControlMaster session (Unix-only; openssh)
    #[cfg(not(windows))]
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
            #[cfg(not(windows))]
            ssh_sessions: HashMap::new(),
            pending_open_paths: Vec::new(),
        }
    }
}

/// Validates that a path resolves to a location under one of the allowed roots.
/// Returns the canonicalized path on success.
/// Render a path for the frontend: forward slashes, no `\\?\` prefix.
///
/// The UI splits paths on `/` to derive basenames and breadcrumbs, and compares them
/// as plain strings, so a Windows path has to be normalized before it crosses IPC —
/// otherwise every tab title shows the full `C:\a\b\c` instead of `c`. Handing one
/// back to Rust or Win32 later is safe: both accept `/` as a separator.
///
/// `std::fs::canonicalize` on Windows also returns extended-length paths
/// (`\\?\C:\x`, or `\\?\UNC\server\share` for network paths); that prefix is stripped
/// here so canonicalized and user-supplied paths still compare equal.
#[cfg(windows)]
pub fn to_ui_path(path: &std::path::Path) -> String {
    let s = path.to_string_lossy();
    let s = match s.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{}", rest),
        None => s.strip_prefix(r"\\?\").unwrap_or(&s).to_string(),
    };
    s.replace('\\', "/")
}

#[cfg(not(windows))]
pub fn to_ui_path(path: &std::path::Path) -> String {
    path.to_string_lossy().into_owned()
}

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
