//! Serde types for workspace persistence and application settings.
//!
//! `Workspace`: one project — root path, pane layout tree, open files, active pane/file,
//! terminal IDs, SSH config, and explorer visibility. Serialized per-window to
//! `~/.config/Splice/workspaces[-{label}].json`.
//!
//! `LayoutNode`: binary tree that mirrors the frontend `LayoutNode` in
//! `src/lib/stores/layout.svelte.ts` — keep both in sync when adding fields.
//! `Leaf { pane_id }` | `Split { direction, ratio, children }`.
//!
//! `PaneInfo.claude_session_id` / `claude_pid`: written at persist time by the attention
//! system so a Claude session can be resumed after app restart.
//!
//! Backward compat: files written before the `WorkspacesFile` wrapper (bare `Vec<Workspace>`
//! JSON arrays) are handled by a fallback parse in `commands::workspace::read_workspaces_file`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub key_path: String,
    pub remote_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub layout: LayoutNode,
    pub panes: Vec<PaneInfo>,
    pub terminal_ids: Vec<u32>,
    pub open_file_paths: Vec<String>,
    pub active_file_path: Option<String>,
    #[serde(default)]
    pub active_pane_id: Option<String>,
    #[serde(default = "default_true")]
    pub explorer_visible: bool,
    #[serde(default)]
    pub ssh_config: Option<SshConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum LayoutNode {
    Leaf { pane_id: String },
    Split {
        direction: SplitDirection,
        ratio: f64,
        children: Vec<LayoutNode>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SplitDirection {
    Horizontal,
    Vertical,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaneInfo {
    pub id: String,
    pub pane_type: PaneType,
    pub title: String,
    #[serde(default)]
    pub file_paths: Vec<String>,
    #[serde(default)]
    pub active_file_path: Option<String>,
    #[serde(default)]
    pub claude_session_id: Option<String>,
    #[serde(default)]
    pub claude_pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PaneType {
    Terminal { shell: String, cwd: String },
    Editor { file_path: String },
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Settings {
    #[serde(default)]
    pub general: GeneralSettings,
    pub editor: EditorSettings,
    pub appearance: AppearanceSettings,
    pub terminal: TerminalSettings,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneralSettings {
    #[serde(default = "default_auto_save")]
    pub auto_save: String,
    #[serde(default = "default_auto_save_delay")]
    pub auto_save_delay: u32,
    #[serde(default = "default_true")]
    pub restore_previous_session: bool,
    #[serde(default = "default_true")]
    pub claude_notifications: bool,
}

fn default_auto_save() -> String {
    "off".to_string()
}

fn default_auto_save_delay() -> u32 {
    1000
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            auto_save: default_auto_save(),
            auto_save_delay: default_auto_save_delay(),
            restore_previous_session: true,
            claude_notifications: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditorSettings {
    pub font_family: String,
    pub font_size: u32,
    pub tab_size: u32,
    pub word_wrap: bool,
    pub line_numbers: bool,
    pub minimap: bool,
    #[serde(default = "default_true")]
    pub insert_spaces: bool,
    #[serde(default = "default_true")]
    pub bracket_matching: bool,
    #[serde(default = "default_true")]
    pub auto_close_brackets: bool,
    #[serde(default = "default_true")]
    pub highlight_active_line: bool,
    #[serde(default = "default_true")]
    pub scroll_past_end: bool,
    #[serde(default = "default_true")]
    pub indent_guides: bool,
}

impl Default for EditorSettings {
    fn default() -> Self {
        Self {
            font_family: "Menlo".to_string(),
            font_size: 15,
            tab_size: 4,
            word_wrap: false,
            line_numbers: true,
            minimap: false,
            insert_spaces: true,
            bracket_matching: true,
            auto_close_brackets: true,
            highlight_active_line: true,
            scroll_past_end: true,
            indent_guides: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppearanceSettings {
    pub theme: String,
    #[serde(default = "default_app_font_size")]
    pub font_size: u32,
    pub ui_scale: u32,
    pub show_status_bar: bool,
    #[serde(default = "default_explorer_side")]
    pub explorer_side: String,
    #[serde(default = "default_explorer_width")]
    pub explorer_width: u32,
    #[serde(default = "default_workspaces_width")]
    pub workspaces_width: u32,
}

fn default_app_font_size() -> u32 {
    15
}
fn default_explorer_side() -> String {
    "left".to_string()
}
fn default_explorer_width() -> u32 {
    240
}
fn default_workspaces_width() -> u32 {
    220
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            theme: "One Dark".to_string(),
            font_size: default_app_font_size(),
            ui_scale: 100,
            show_status_bar: true,
            explorer_side: default_explorer_side(),
            explorer_width: default_explorer_width(),
            workspaces_width: default_workspaces_width(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalSettings {
    pub default_shell: String,
    pub font_size: u32,
    pub cursor_style: String,
    pub cursor_blink: bool,
    pub scrollback_lines: u32,
    #[serde(default = "default_terminal_font")]
    pub font_family: String,
    #[serde(default)]
    pub copy_on_select: bool,
}

fn default_terminal_font() -> String {
    "Menlo".to_string()
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            default_shell: "/bin/zsh".to_string(),
            font_size: 15,
            cursor_style: "Block".to_string(),
            cursor_blink: true,
            scrollback_lines: 10000,
            font_family: default_terminal_font(),
            copy_on_select: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_pane_json(extra: &str) -> String {
        format!(
            r#"{{"id":"p1","pane_type":{{"Terminal":{{"shell":"/bin/zsh","cwd":"/tmp"}}}},"title":"Term"{}}}"#,
            extra
        )
    }

    #[test]
    fn claude_fields_default_to_none() {
        let json = make_pane_json("");
        let pane: PaneInfo = serde_json::from_str(&json).unwrap();
        assert!(pane.claude_session_id.is_none());
        assert!(pane.claude_pid.is_none());
    }

    #[test]
    fn claude_fields_round_trip() {
        let json = make_pane_json(r#","claude_session_id":"abc123","claude_pid":42"#);
        let pane: PaneInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(pane.claude_session_id.as_deref(), Some("abc123"));
        assert_eq!(pane.claude_pid, Some(42));

        let serialized = serde_json::to_string(&pane).unwrap();
        let pane2: PaneInfo = serde_json::from_str(&serialized).unwrap();
        assert_eq!(pane2.claude_session_id.as_deref(), Some("abc123"));
        assert_eq!(pane2.claude_pid, Some(42));
    }

    #[test]
    fn null_session_id_deserializes_to_none() {
        let json = make_pane_json(r#","claude_session_id":null"#);
        let pane: PaneInfo = serde_json::from_str(&json).unwrap();
        assert!(pane.claude_session_id.is_none());
    }

    #[test]
    fn workspace_file_migration_from_old_vec_format() {
        // Old format: bare JSON array of workspaces
        let old_json = r#"[{"id":"ws1","name":"My WS","root_path":"/home/user","layout":{"type":"Leaf","pane_id":"p1"},"panes":[],"terminal_ids":[],"open_file_paths":[],"active_file_path":null}]"#;

        // WorkspacesFile is private, so test via the public read path used in get_workspaces.
        // Simulate the fallback: parse as Vec<Workspace> if WorkspacesFile fails.
        #[derive(serde::Deserialize, Default)]
        struct WorkspacesFile {
            #[serde(default)]
            active_workspace_id: Option<String>,
            #[serde(default)]
            workspaces: Vec<Workspace>,
        }

        let result: Result<WorkspacesFile, _> = serde_json::from_str(old_json);
        // New format parse should fail (array at root, not object)
        assert!(result.is_err(), "bare array should not parse as WorkspacesFile object");

        let workspaces: Vec<Workspace> = serde_json::from_str(old_json).unwrap();
        let migrated = WorkspacesFile {
            active_workspace_id: None,
            workspaces,
        };
        assert_eq!(migrated.workspaces.len(), 1);
        assert_eq!(migrated.workspaces[0].id, "ws1");
        assert!(migrated.active_workspace_id.is_none());
    }
}
