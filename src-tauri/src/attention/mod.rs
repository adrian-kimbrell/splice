//! Attention hook server — the bridge between Claude Code hooks and the Splice UI.
//!
//! # Lifecycle
//! 1. `load_or_create_token` — loads or generates a 128-bit auth token persisted to
//!    `~/.config/Splice/.attention_token` (reused across restarts).
//! 2. `start_server` — binds a random TCP port, writes it to `.attention_port`,
//!    stores the port in `AppState::attention_port`, then listens for hook POSTs.
//! 3. `install_hook` — writes `~/.claude/hooks/` entries that point at `http://127.0.0.1:<port>`.
//!    The hook script injects `SPLICE_TERMINAL_ID` into the Claude environment so each
//!    hook POST identifies which terminal the notification belongs to.
//!
//! # Hook protocol
//! Claude Code hooks POST to `/notify` with `Authorization: Bearer <token>` and a JSON body
//! containing `terminal_id`, `notification_type`, and `message`. The server emits a Tauri
//! `attention:notify` event consumed by `src/lib/stores/attention.svelte.ts`.
//!
//! # Hook versioning
//! The installed hook script contains a version comment (currently v4). `install_hook`
//! rewrites the file if the version tag is outdated or missing.
//!
//! # Security
//! All requests must carry the correct Bearer token; mismatches are rejected with 401.

mod handlers;
mod hook;
mod http;
mod server;
mod token;

pub use hook::install_hook;
pub use server::start_server;
pub use token::load_or_create_token;
