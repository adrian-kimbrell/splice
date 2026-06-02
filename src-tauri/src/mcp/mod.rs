//! In-process MCP server that exposes Splice's file/workspace/terminal surface to
//! external LLM clients (Claude Code, Cursor, custom scripts).
//!
//! # Lifecycle
//! - `load_or_create_token` → persisted bearer token (`~/.config/Splice/.mcp_token`).
//! - `server::start` → bind 127.0.0.1 on 19880-19882, write discovery file
//!   (`~/.config/Splice/mcp.json` with `{url, token, port}`), mount the rmcp
//!   streamable-http service at `/mcp`, spawn the axum server.
//!
//! # Tool surface
//! See `handler.rs` — each `#[tool]` method on `SpliceHandler` becomes an MCP tool.
//! Tools always return `{ "result": ..., "metrics": ... }`; the metrics block is
//! populated only when the call's args include `"verbose": true`.

mod discovery;
mod handler;
mod metrics;
mod server;

pub use discovery::load_or_create_token;
pub use server::start;
