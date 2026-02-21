use serde::{Deserialize, Serialize};

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PaneType {
    Terminal { shell: String, cwd: String },
    Editor { file_path: String },
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub general: GeneralSettings,
    pub editor: EditorSettings,
    pub appearance: AppearanceSettings,
    pub terminal: TerminalSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            general: GeneralSettings::default(),
            editor: EditorSettings::default(),
            appearance: AppearanceSettings::default(),
            terminal: TerminalSettings::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneralSettings {
    #[serde(default = "default_auto_save")]
    pub auto_save: String,
    #[serde(default = "default_auto_save_delay")]
    pub auto_save_delay: u32,
    #[serde(default = "default_true")]
    pub restore_previous_session: bool,
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
            font_size: 13,
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
    pub ui_scale: u32,
    pub show_status_bar: bool,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            theme: "One Dark".to_string(),
            ui_scale: 100,
            show_status_bar: true,
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
            font_size: 12,
            cursor_style: "Block".to_string(),
            cursor_blink: true,
            scrollback_lines: 10000,
            font_family: default_terminal_font(),
            copy_on_select: false,
        }
    }
}
