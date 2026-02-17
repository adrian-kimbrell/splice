use crate::terminal::pty::PtySession;
use crate::workspace::layout::{Settings, Workspace};
use std::collections::HashMap;

pub struct AppState {
    pub terminals: HashMap<u32, PtySession>,
    pub next_terminal_id: u32,
    pub workspaces: Vec<Workspace>,
    pub active_workspace_id: Option<String>,
    pub settings: Settings,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            terminals: HashMap::new(),
            next_terminal_id: 1,
            workspaces: Vec::new(),
            active_workspace_id: None,
            settings: Settings::default(),
        }
    }
}
