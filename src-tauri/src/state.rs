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
    pub watchers: HashMap<String, RecommendedWatcher>,
    /// terminal_id → (session_id, claude_pid)
    /// claude_pid lets us verify Claude is still running at persist time.
    pub terminal_claude_sessions: HashMap<u32, (String, u32)>,
    /// language_id → active LSP session
    pub lsp_sessions: HashMap<String, crate::lsp::LspSession>,
    /// workspace_id → established SSH ControlMaster session
    pub ssh_sessions: HashMap<String, Arc<openssh::Session>>,
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
            watchers: HashMap::new(),
            terminal_claude_sessions: HashMap::new(),
            lsp_sessions: HashMap::new(),
            ssh_sessions: HashMap::new(),
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
