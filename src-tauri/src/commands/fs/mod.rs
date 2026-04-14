//! Tauri commands for filesystem operations.
//!
//! All path arguments are validated through `state::validate_path`, which canonicalizes
//! the path and checks it falls under `AppState::allowed_roots`. Roots default to HOME;
//! `add_allowed_root` expands the list when a workspace outside HOME is opened.
//!
//! Commands: read_dir_tree, read_file, write_file, read_file_base64, search_files,
//! get_git_branch, get/add_recent_files, get/add_recent_projects, watch_path,
//! unwatch_path, create_file_at, create_directory_at, rename_path, delete_path,
//! duplicate_path, copy_path, reveal_in_file_manager, save_temp_image, write_to_clipboard.
//!
//! File watching uses the `notify` crate; `RecommendedWatcher` instances are stored in
//! `AppState::watchers` keyed by path string so they can be dropped on `unwatch_path`.
//! Watch events are forwarded to the frontend as Tauri `fs:change` events.

pub mod paths;
pub mod read;
pub mod recent;
pub mod utils;
pub mod watch;
pub mod write;

pub use paths::*;
pub use read::*;
pub use recent::*;
pub use utils::*;
pub use watch::*;
pub use write::*;

use serde::Serialize;

pub const MAX_FILE_SIZE: u64 = 50 * 1024 * 1024; // 50 MB
pub const MAX_RECENT_LIST_SIZE: u64 = 1024 * 1024; // 1 MB
pub const MAX_BASE64_SIZE: u64 = 20 * 1024 * 1024; // 20 MB

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileEntry>>,
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
