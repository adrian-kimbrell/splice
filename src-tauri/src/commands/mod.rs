//! Tauri command modules exposed to the Svelte frontend via `#[tauri::command]`.
//!
//! - **fs** -- File system operations (read, write, list, rename, etc.)
//! - **git** -- Git status, diff, blame, and branch management
//! - **settings** -- Application settings persistence and macOS traffic lights
//! - **ssh** -- SSH remote workspace connections and SFTP file operations
//! - **terminal** -- PTY spawning, resize, input/output, and terminal lifecycle
//! - **themes** -- Editor theme loading and listing
//! - **workspace** -- Window layout serialization, tab state, and workspace config

pub mod fs;
pub mod git;
pub mod settings;
pub mod ssh;
pub mod terminal;
pub mod themes;
pub mod workspace;
