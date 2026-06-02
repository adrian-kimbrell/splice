//! Splice's MCP tool surface. Each tool method on `SpliceHandler` becomes a callable
//! MCP tool registered via the `#[tool_router]` macro.
//!
//! Tools all share the same shape:
//!   - Deserialize a `<Tool>Args` struct (one field is always `verbose: Option<bool>`).
//!   - Open a `MetricsTimer`.
//!   - Do the work, capturing byte counts / subsystem timings.
//!   - On success, return `Json({ "result": ..., "metrics": <Metrics or null> })`.
//!
//! State access: the handler clones the `AppHandle`, so any tool can reach into
//! `app.state::<Mutex<AppState>>()` for `allowed_roots`, workspace info, etc.

use std::sync::Mutex;

use rmcp::{
    ErrorData as McpError,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    schemars, tool, tool_handler, tool_router,
    ServerHandler,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::mcp::metrics::{Metrics, MetricsTimer};
use crate::state::{validate_path, AppState};

/// Shared response shape: `{ "result": ..., "metrics": <Metrics or null> }`.
#[derive(Serialize)]
struct Envelope<T: Serialize> {
    result: T,
    #[serde(skip_serializing_if = "Option::is_none")]
    metrics: Option<Metrics>,
}

fn envelope<T: Serialize>(result: T, metrics: Option<Metrics>) -> Result<CallToolResult, McpError> {
    let body = serde_json::to_value(Envelope { result, metrics })
        .map_err(|e| McpError::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![Content::json(body)?]))
}

#[derive(Clone)]
pub struct SpliceHandler {
    app: AppHandle,
    tool_router: ToolRouter<SpliceHandler>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ReadFileArgs {
    /// Absolute path to read. Must resolve under the user's allowed roots.
    pub path: String,
    /// If true, return a `metrics` block with per-call timing/byte counters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verbose: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListDirArgs {
    /// Directory path. Non-recursive — returns immediate children only.
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verbose: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct NoArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verbose: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct WriteFileArgs {
    /// Absolute path. Parent dir must exist; file is created or truncated.
    pub path: String,
    /// UTF-8 file content to write.
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verbose: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ReadTerminalArgs {
    /// Terminal ID — see `list_terminals` for the active set.
    pub id: u32,
    /// How many lines from the bottom (newest) to return. Default 100, max 1000.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verbose: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GitArgs {
    /// Repository directory (workspace root). Must be under an allowed root.
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verbose: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GitDiffArgs {
    pub cwd: String,
    /// File path relative to cwd. Omit to get the full repo diff.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// If true, diff the staged index vs HEAD. Default: working tree vs index.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staged: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verbose: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SearchFilesArgs {
    /// Root directory for the search. Must resolve under an allowed root.
    pub root: String,
    /// Substring or regex query.
    pub query: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub case_sensitive: Option<bool>,
    /// Cap on returned matches. Default 100.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_results: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verbose: Option<bool>,
}

#[derive(Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize)]
struct WorkspaceSummary {
    id: String,
    name: String,
    root_path: String,
    active_file: Option<String>,
    open_files: Vec<String>,
}

#[derive(Serialize)]
struct TerminalSummary {
    id: u32,
    pid: Option<u32>,
}

#[derive(Serialize)]
struct SearchHit {
    path: String,
    line: u32,
    text: String,
}

#[tool_router]
impl SpliceHandler {
    pub fn new(app: AppHandle) -> Self {
        Self { app, tool_router: Self::tool_router() }
    }

    #[tool(description = "Read a UTF-8 text file. Returns the contents; capped at the same 10 MB limit the editor uses.")]
    async fn read_file(
        &self,
        Parameters(args): Parameters<ReadFileArgs>,
    ) -> Result<CallToolResult, McpError> {
        let mut m = MetricsTimer::start();
        let verbose = args.verbose.unwrap_or(false);

        let allowed_roots = {
            let s = self.app.state::<Mutex<AppState>>();
            let s = s.lock().map_err(|e| McpError::internal_error(e.to_string(), None))?;
            s.allowed_roots.clone()
        };

        let canonical = m.time("validate_path", || validate_path(&args.path, &allowed_roots))
            .map_err(|e| McpError::invalid_params(e, None))?;

        let content = m.time("fs_read", || std::fs::read_to_string(&canonical))
            .map_err(|e| McpError::internal_error(format!("read failed: {}", e), None))?;
        m.bytes_read(content.len() as u64);
        m.items(1);

        envelope(serde_json::json!({ "content": content }), m.finish(verbose))
    }

    #[tool(description = "List the immediate entries of a directory. Returns name/path/is_dir for each child; sorted dirs-first.")]
    async fn list_dir(
        &self,
        Parameters(args): Parameters<ListDirArgs>,
    ) -> Result<CallToolResult, McpError> {
        let mut m = MetricsTimer::start();
        let verbose = args.verbose.unwrap_or(false);

        let allowed_roots = {
            let s = self.app.state::<Mutex<AppState>>();
            let s = s.lock().map_err(|e| McpError::internal_error(e.to_string(), None))?;
            s.allowed_roots.clone()
        };

        let canonical = m.time("validate_path", || validate_path(&args.path, &allowed_roots))
            .map_err(|e| McpError::invalid_params(e, None))?;

        if !canonical.is_dir() {
            return Err(McpError::invalid_params(format!("Not a directory: {}", args.path), None));
        }

        let mut entries: Vec<DirEntry> = m.time("fs_read_dir", || -> Result<_, std::io::Error> {
            let mut v = Vec::new();
            for entry in std::fs::read_dir(&canonical)? {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') { continue; }
                let path = entry.path();
                let is_dir = path.is_dir();
                v.push(DirEntry { name, path: path.to_string_lossy().to_string(), is_dir });
            }
            Ok(v)
        }).map_err(|e| McpError::internal_error(format!("read_dir failed: {}", e), None))?;

        entries.sort_by(|a, b| {
            if a.is_dir == b.is_dir { a.name.to_lowercase().cmp(&b.name.to_lowercase()) }
            else if a.is_dir { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater }
        });
        m.items(entries.len() as u64);

        envelope(serde_json::json!({ "entries": entries }), m.finish(verbose))
    }

    #[tool(description = "Return the active workspace for the main Splice window, including its open files and the currently focused file.")]
    async fn get_active_workspace(
        &self,
        Parameters(args): Parameters<NoArgs>,
    ) -> Result<CallToolResult, McpError> {
        let m = MetricsTimer::start();
        let verbose = args.verbose.unwrap_or(false);

        let state = self.app.state::<Mutex<AppState>>();
        let s = state.lock().map_err(|e| McpError::internal_error(e.to_string(), None))?;

        // Prefer the "main" window; fall back to the first registered window.
        let (active_id, workspaces) = s.window_workspaces.get("main")
            .or_else(|| s.window_workspaces.values().next())
            .cloned()
            .unwrap_or_else(|| (None, Vec::new()));

        let active = active_id.as_deref().and_then(|id| workspaces.iter().find(|w| w.id == id));

        let result = active.map(|w| WorkspaceSummary {
            id: w.id.clone(),
            name: w.name.clone(),
            root_path: w.root_path.clone(),
            active_file: w.active_file_path.clone(),
            open_files: w.open_file_paths.clone(),
        });

        envelope(result, m.finish(verbose))
    }

    #[tool(description = "Write UTF-8 content to a file. Creates or truncates. Path must resolve under an allowed root.")]
    async fn write_file(
        &self,
        Parameters(args): Parameters<WriteFileArgs>,
    ) -> Result<CallToolResult, McpError> {
        let mut m = MetricsTimer::start();
        let verbose = args.verbose.unwrap_or(false);

        let allowed_roots = {
            let s = self.app.state::<Mutex<AppState>>();
            let s = s.lock().map_err(|e| McpError::internal_error(e.to_string(), None))?;
            s.allowed_roots.clone()
        };

        // For new files, validate the parent dir is allowed (canonicalize fails on non-existent).
        let target = std::path::PathBuf::from(&args.path);
        let parent = target.parent().ok_or_else(|| McpError::invalid_params("path has no parent".to_string(), None))?;
        m.time("validate_parent", || validate_path(&parent.to_string_lossy(), &allowed_roots))
            .map_err(|e| McpError::invalid_params(e, None))?;

        let len = args.content.len() as u64;
        m.time("fs_write", || std::fs::write(&target, &args.content))
            .map_err(|e| McpError::internal_error(format!("write failed: {}", e), None))?;
        m.bytes_written(len);
        m.items(1);

        envelope(serde_json::json!({ "path": args.path, "bytes_written": len }), m.finish(verbose))
    }

    #[tool(description = "List every workspace registered across all open Splice windows.")]
    async fn list_workspaces(
        &self,
        Parameters(args): Parameters<NoArgs>,
    ) -> Result<CallToolResult, McpError> {
        let mut m = MetricsTimer::start();
        let verbose = args.verbose.unwrap_or(false);

        let state = self.app.state::<Mutex<AppState>>();
        let s = state.lock().map_err(|e| McpError::internal_error(e.to_string(), None))?;

        let mut out: Vec<WorkspaceSummary> = Vec::new();
        for (_label, (_active, workspaces)) in s.window_workspaces.iter() {
            for w in workspaces {
                out.push(WorkspaceSummary {
                    id: w.id.clone(),
                    name: w.name.clone(),
                    root_path: w.root_path.clone(),
                    active_file: w.active_file_path.clone(),
                    open_files: w.open_file_paths.clone(),
                });
            }
        }
        m.items(out.len() as u64);
        envelope(serde_json::json!({ "workspaces": out }), m.finish(verbose))
    }

    #[tool(description = "List every running terminal PTY by id (and child pid when known).")]
    async fn list_terminals(
        &self,
        Parameters(args): Parameters<NoArgs>,
    ) -> Result<CallToolResult, McpError> {
        let mut m = MetricsTimer::start();
        let verbose = args.verbose.unwrap_or(false);

        let state = self.app.state::<Mutex<AppState>>();
        let s = state.lock().map_err(|e| McpError::internal_error(e.to_string(), None))?;

        let mut out: Vec<TerminalSummary> = s.terminals.iter()
            .map(|(&id, session)| TerminalSummary { id, pid: session.child_pid })
            .collect();
        out.sort_by_key(|t| t.id);
        m.items(out.len() as u64);
        envelope(serde_json::json!({ "terminals": out }), m.finish(verbose))
    }

    #[tool(description = "Read the most recent N lines of a terminal's combined scrollback + live buffer. Default 100, max 1000.")]
    async fn read_terminal_output(
        &self,
        Parameters(args): Parameters<ReadTerminalArgs>,
    ) -> Result<CallToolResult, McpError> {
        let mut m = MetricsTimer::start();
        let verbose = args.verbose.unwrap_or(false);
        let lines_req = args.lines.unwrap_or(100).min(1000) as usize;

        let emulator_arc = {
            let state = self.app.state::<Mutex<AppState>>();
            let s = state.lock().map_err(|e| McpError::internal_error(e.to_string(), None))?;
            let session = s.terminals.get(&args.id)
                .ok_or_else(|| McpError::invalid_params(format!("Terminal {} not found", args.id), None))?;
            std::sync::Arc::clone(&session.emulator)
        };

        let lines = m.time("read_grid", || -> Result<Vec<String>, String> {
            let emu = emulator_arc.read().map_err(|e| e.to_string())?;
            let buf = emu.grid.active();
            let cols = emu.grid.cols as usize;
            let total = buf.scrollback.len() + buf.lines.len();
            let start = total.saturating_sub(lines_req);
            let mut out: Vec<String> = Vec::with_capacity(total - start);
            for history_row in start..total {
                let row = if history_row < buf.scrollback.len() {
                    &buf.scrollback[history_row].cells
                } else {
                    let i = history_row - buf.scrollback.len();
                    if i >= buf.lines.len() { out.push(String::new()); continue; }
                    &buf.lines[i].cells
                };
                let text: String = row[..cols.min(row.len())].iter()
                    .map(|c| if c.ch == '\0' { ' ' } else { c.ch })
                    .collect();
                out.push(text.trim_end().to_string());
            }
            Ok(out)
        }).map_err(|e| McpError::internal_error(e, None))?;
        m.items(lines.len() as u64);

        envelope(serde_json::json!({ "lines": lines }), m.finish(verbose))
    }

    #[tool(description = "Run `git status --porcelain` in the given workspace and parse it into structured entries.")]
    async fn git_status(
        &self,
        Parameters(args): Parameters<GitArgs>,
    ) -> Result<CallToolResult, McpError> {
        let mut m = MetricsTimer::start();
        let verbose = args.verbose.unwrap_or(false);

        let allowed_roots = {
            let s = self.app.state::<Mutex<AppState>>();
            let s = s.lock().map_err(|e| McpError::internal_error(e.to_string(), None))?;
            s.allowed_roots.clone()
        };
        let cwd = m.time("validate_path", || validate_path(&args.cwd, &allowed_roots))
            .map_err(|e| McpError::invalid_params(e, None))?;

        let output = tokio::process::Command::new("git")
            .args(["status", "--porcelain=v1"])
            .current_dir(&cwd)
            .output()
            .await
            .map_err(|e| McpError::internal_error(format!("git status: {}", e), None))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(McpError::internal_error(format!("git status failed: {}", stderr), None));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut files: Vec<serde_json::Value> = Vec::new();
        for line in stdout.lines() {
            if line.len() < 4 { continue; }
            let mut chars = line.chars();
            let index_status = chars.next().unwrap_or(' ');
            let worktree_status = chars.next().unwrap_or(' ');
            let path = line[3..].to_string();
            files.push(serde_json::json!({
                "path": path,
                "index_status": index_status,
                "worktree_status": worktree_status,
            }));
        }
        m.items(files.len() as u64);
        envelope(serde_json::json!({ "files": files }), m.finish(verbose))
    }

    #[tool(description = "Run `git diff` for the working tree (or `git diff --cached` if staged=true). Optionally scope to a single path.")]
    async fn git_diff(
        &self,
        Parameters(args): Parameters<GitDiffArgs>,
    ) -> Result<CallToolResult, McpError> {
        let mut m = MetricsTimer::start();
        let verbose = args.verbose.unwrap_or(false);

        let allowed_roots = {
            let s = self.app.state::<Mutex<AppState>>();
            let s = s.lock().map_err(|e| McpError::internal_error(e.to_string(), None))?;
            s.allowed_roots.clone()
        };
        let cwd = m.time("validate_path", || validate_path(&args.cwd, &allowed_roots))
            .map_err(|e| McpError::invalid_params(e, None))?;

        let mut cmd = tokio::process::Command::new("git");
        cmd.arg("diff");
        if args.staged.unwrap_or(false) { cmd.arg("--cached"); }
        if let Some(p) = &args.path { cmd.arg("--").arg(p); }
        let output = cmd.current_dir(&cwd).output().await
            .map_err(|e| McpError::internal_error(format!("git diff: {}", e), None))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(McpError::internal_error(format!("git diff failed: {}", stderr), None));
        }
        let diff = String::from_utf8_lossy(&output.stdout).to_string();
        m.bytes_read(diff.len() as u64);
        envelope(serde_json::json!({ "diff": diff }), m.finish(verbose))
    }

    #[tool(description = "Substring search across files under `root`. Skips hidden files and respects .gitignore via the `ignore` crate. Default max_results=100.")]
    async fn search_files(
        &self,
        Parameters(args): Parameters<SearchFilesArgs>,
    ) -> Result<CallToolResult, McpError> {
        let mut m = MetricsTimer::start();
        let verbose = args.verbose.unwrap_or(false);
        let cap = args.max_results.unwrap_or(100).min(1000) as usize;
        let case_sensitive = args.case_sensitive.unwrap_or(false);

        let allowed_roots = {
            let s = self.app.state::<Mutex<AppState>>();
            let s = s.lock().map_err(|e| McpError::internal_error(e.to_string(), None))?;
            s.allowed_roots.clone()
        };
        let root = m.time("validate_path", || validate_path(&args.root, &allowed_roots))
            .map_err(|e| McpError::invalid_params(e, None))?;

        let needle = if case_sensitive { args.query.clone() } else { args.query.to_lowercase() };
        let mut hits: Vec<SearchHit> = Vec::new();

        m.time("walk", || {
            let walker = ignore::WalkBuilder::new(&root).build();
            for entry in walker.flatten() {
                if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) { continue; }
                let path = entry.path();
                let Ok(content) = std::fs::read_to_string(path) else { continue };
                for (i, line) in content.lines().enumerate() {
                    let hay = if case_sensitive { line.to_string() } else { line.to_lowercase() };
                    if hay.contains(&needle) {
                        hits.push(SearchHit {
                            path: path.to_string_lossy().to_string(),
                            line: (i + 1) as u32,
                            text: line.to_string(),
                        });
                        if hits.len() >= cap { return; }
                    }
                }
            }
        });
        m.items(hits.len() as u64);
        let truncated = hits.len() >= cap;
        envelope(serde_json::json!({ "matches": hits, "truncated": truncated }), m.finish(verbose))
    }
}

#[tool_handler]
impl ServerHandler for SpliceHandler {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            protocol_version: ProtocolVersion::V_2025_03_26,
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            server_info: Implementation {
                name: "splice".into(),
                version: env!("CARGO_PKG_VERSION").into(),
                ..Implementation::default()
            },
            instructions: Some("Splice MCP server. Tools expose file IO and workspace introspection. Pass {\"verbose\": true} on any call to receive a metrics block.".into()),
        }
    }
}
