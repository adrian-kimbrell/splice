//! LSP server proxy — spawns and manages language server processes.
//!
//! `LspSession` owns one language server process per `language_id`. Internal architecture:
//! - A tokio **writer task** drains an `mpsc` channel into the process stdin
//! - A tokio **reader task** (`lsp_reader`) parses JSON-RPC frames from stdout:
//!     - Client responses (have `id`, no `method`) → routed to oneshot receivers in `pending` map
//!     - Server notifications (have `method`, no `id`) → forwarded as Tauri events
//!       (e.g. `lsp:diagnostics` for `textDocument/publishDiagnostics`)
//!     - Server-initiated requests (have both `method` and `id`, e.g. `workspace/configuration`,
//!       `client/registerCapability`) → answered inline by `handle_server_request`
//!
//! Tauri commands: `lsp_start` (idempotent — noop if already running), `lsp_notify`,
//! `lsp_request`. `lsp_request` clones channel handles out of the AppState lock then awaits
//! the oneshot outside the lock to avoid blocking other commands during long LSP calls.
//!
//! `augmented_path()` prepends Homebrew / cargo / npm-global dirs that the GUI app's PATH
//! often lacks when launched from Finder or Spotlight.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

pub struct LspSession {
    pub stdin_tx: mpsc::UnboundedSender<Vec<u8>>,
    pub pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    pub next_id: Arc<AtomicU64>,
    pub language_id: String,
    pub app_handle: tauri::AppHandle,
}

/// Returns an augmented PATH string that includes common developer tool locations
/// which may be absent when the app is launched from Finder/Dock.
fn augmented_path() -> String {
    let home = env::var("HOME").unwrap_or_default();
    let current = env::var("PATH").unwrap_or_default();
    let extras = [
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        &format!("{}/.cargo/bin", home),
        &format!("{}/.local/bin", home),
        &format!("{}/.npm-global/bin", home),
        "/usr/bin",
        "/bin",
    ];
    let extra_str = extras.join(":");
    if current.is_empty() {
        extra_str
    } else {
        format!("{}:{}", extra_str, current)
    }
}

/// Resolve a binary name to its full path by searching the augmented PATH.
fn resolve_binary(cmd: &str) -> Option<std::path::PathBuf> {
    let path_var = augmented_path();
    for dir in path_var.split(':') {
        if dir.is_empty() {
            continue;
        }
        let full = Path::new(dir).join(cmd);
        if full.is_file() {
            return Some(full);
        }
    }
    None
}

fn get_lsp_command(language_id: &str) -> Result<(std::path::PathBuf, Vec<String>), String> {
    let (cmd, args): (&str, &[&str]) = match language_id {
        "typescript" | "javascript" | "typescriptreact" | "javascriptreact" => {
            ("typescript-language-server", &["--stdio"])
        }
        "rust" => ("rust-analyzer", &[]),
        "python" => {
            // Prefer pyright (Node.js, no venv needed) over pylsp (requires Python env)
            if resolve_binary("pyright-langserver").is_some() {
                ("pyright-langserver", &["--stdio"])
            } else if resolve_binary("pylsp").is_some() {
                ("pylsp", &[])
            } else {
                return Err("Python LSP not found. Run: npm install -g pyright".to_string());
            }
        }
        "html" => ("vscode-html-language-server", &["--stdio"]),
        "css" => ("vscode-css-language-server", &["--stdio"]),
        "json" => ("vscode-json-language-server", &["--stdio"]),
        _ => return Err(format!("No LSP for language: {}", language_id)),
    };

    let install_hint = match language_id {
        "typescript" | "javascript" | "typescriptreact" | "javascriptreact" =>
            " — run: npm install -g typescript-language-server typescript",
        "rust" => " — run: rustup component add rust-analyzer",
        "html" | "css" | "json" =>
            " — run: npm install -g vscode-langservers-extracted",
        _ => "",
    };
    let resolved = resolve_binary(cmd)
        .ok_or_else(|| format!("{} not found{}", cmd, install_hint))?;
    Ok((resolved, args.iter().map(|s| s.to_string()).collect()))
}

/// Per-server initializationOptions passed in the initialize request.
fn get_initialization_options(language_id: &str) -> Option<Value> {
    match language_id {
        "typescript" | "javascript" | "typescriptreact" | "javascriptreact" => {
            Some(json!({ "hostInfo": "splice-editor" }))
        }
        "rust" => Some(json!({
            "cargo": { "buildScripts": { "enable": true } },
            "procMacro": { "enable": true }
        })),
        _ => None,
    }
}

fn encode_message(msg: &Value) -> Vec<u8> {
    let body = serde_json::to_string(msg).unwrap_or_default();
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    let mut bytes = header.into_bytes();
    bytes.extend_from_slice(body.as_bytes());
    bytes
}

/// Build a JSON-RPC success response to a server-initiated request.
fn make_response(id: &Value, result: Value) -> Vec<u8> {
    encode_message(&json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

/// Handle a server-to-client JSON-RPC request and return the bytes to send back.
/// Returns None if the message should be ignored.
fn handle_server_request(msg: &Value) -> Option<Vec<u8>> {
    let method = msg.get("method")?.as_str()?;
    let id = msg.get("id")?;

    let result = match method {
        // Server asks client for configuration — return one empty object per requested item
        "workspace/configuration" => {
            let n = msg
                .get("params")
                .and_then(|p| p.get("items"))
                .and_then(Value::as_array)
                .map(|a| a.len())
                .unwrap_or(1);
            Value::Array(vec![json!({}); n])
        }
        // Server registers new capabilities dynamically — acknowledge with null
        "client/registerCapability" | "client/unregisterCapability" => Value::Null,
        // Server requests a progress token — acknowledge with null
        "window/workDoneProgress/create" => Value::Null,
        // Server wants to show a message that requires user choice — always pick first option
        "window/showMessageRequest" => {
            msg.get("params")
                .and_then(|p| p.get("actions"))
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .cloned()
                .unwrap_or(Value::Null)
        }
        _ => return None, // notifications or unknown requests — ignore
    };

    Some(make_response(id, result))
}

async fn lsp_reader(
    stdout: impl tokio::io::AsyncRead + Unpin,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    reply_tx: mpsc::UnboundedSender<Vec<u8>>,
    app_handle: tauri::AppHandle,
) {
    let mut reader = BufReader::new(stdout);
    loop {
        let mut content_length: usize = 0;
        // Read headers until blank line
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            let trimmed = line.trim_end_matches(|c| c == '\r' || c == '\n');
            if trimmed.is_empty() {
                break;
            }
            if let Some(rest) = trimmed.strip_prefix("Content-Length: ") {
                if let Ok(n) = rest.trim().parse::<usize>() {
                    content_length = n;
                }
            }
        }
        if content_length == 0 {
            continue;
        }
        let mut body = vec![0u8; content_length];
        if reader.read_exact(&mut body).await.is_err() {
            return;
        }
        let Ok(msg): Result<Value, _> = serde_json::from_slice(&body) else {
            continue;
        };

        // Server-to-client requests have both "id" and "method".
        // We must respond to them or the server will stall waiting.
        if msg.get("method").is_some() {
            if msg.get("id").is_none() {
                // Pure notification (no id) — handle specific ones we care about
                if let Some("textDocument/publishDiagnostics") = msg.get("method").and_then(Value::as_str) {
                    if let Some(params) = msg.get("params") {
                        let _ = app_handle.emit("lsp:diagnostics", params);
                    }
                }
                continue;
            }
            // Server-initiated request (has both method and id) — respond
            if let Some(reply) = handle_server_request(&msg) {
                let _ = reply_tx.send(reply);
            }
            continue;
        }

        // Client-to-server response: route to the waiting oneshot receiver.
        // JSON-RPC id may come back as a number or a string depending on the server.
        if let Some(id_val) = msg.get("id") {
            let id_u64 = id_val
                .as_u64()
                .or_else(|| id_val.as_str().and_then(|s| s.parse().ok()));
            if let Some(id) = id_u64 {
                let tx = pending
                    .lock()
                    .ok()
                    .and_then(|mut map| map.remove(&id));
                if let Some(tx) = tx {
                    let _ = tx.send(msg);
                }
            }
        }
    }
}

impl LspSession {
    pub async fn spawn(language_id: &str, workspace_root: &str, app_handle: tauri::AppHandle) -> Result<Self, String> {
        let (cmd_path, args) = get_lsp_command(language_id)?;

        let mut command = Command::new(&cmd_path);
        command
            .args(&args)
            .env("PATH", augmented_path())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        if !workspace_root.is_empty() {
            command.current_dir(workspace_root);
        }
        let cmd_name = cmd_path.display().to_string();
        let mut child = command
            .spawn()
            .map_err(|e| format!("Failed to spawn {}: {}", cmd_name, e))?;

        let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to get stdout")?;

        let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<Vec<u8>>();

        // Writer task: drains channel into process stdin
        let mut stdin = stdin;
        tokio::spawn(async move {
            while let Some(data) = stdin_rx.recv().await {
                if stdin.write_all(&data).await.is_err() {
                    break;
                }
                if stdin.flush().await.is_err() {
                    break;
                }
            }
        });

        let pending = Arc::new(Mutex::new(
            HashMap::<u64, oneshot::Sender<Value>>::new(),
        ));
        let pending_clone = pending.clone();
        // Pass a clone of stdin_tx to the reader so it can reply to server requests
        let reply_tx = stdin_tx.clone();

        // Reader task: parses JSON-RPC and handles both responses and server requests
        let app_handle_clone = app_handle.clone();
        tokio::spawn(async move {
            lsp_reader(stdout, pending_clone, reply_tx, app_handle_clone).await;
        });

        // Child-wait task: reaps the process to prevent zombies
        tokio::spawn(async move {
            let _ = child.wait().await;
        });

        let session = Self {
            stdin_tx,
            pending,
            next_id: Arc::new(AtomicU64::new(1)),
            language_id: language_id.to_string(),
            app_handle,
        };

        session.initialize(language_id, workspace_root).await?;

        Ok(session)
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let msg = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });
        let bytes = encode_message(&msg);
        self.stdin_tx
            .send(bytes)
            .map_err(|e| format!("Send error: {}", e))
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        {
            let mut map = self
                .pending
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?;
            map.insert(id, tx);
        }
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });
        let bytes = encode_message(&msg);
        self.stdin_tx
            .send(bytes)
            .map_err(|e| format!("Send error: {}", e))?;

        tokio::time::timeout(std::time::Duration::from_secs(30), rx)
            .await
            .map_err(|_| "LSP request timed out".to_string())?
            .map_err(|_| "LSP channel closed".to_string())
    }

    async fn initialize(&self, language_id: &str, workspace_root: &str) -> Result<(), String> {
        let (root_uri, workspace_folders) = if workspace_root.is_empty() {
            (Value::Null, Value::Null)
        } else {
            let uri = format!("file://{}", workspace_root);
            let folders = json!([{"uri": uri, "name": "workspace"}]);
            (Value::String(uri), folders)
        };

        let mut params = json!({
            "processId": std::process::id(),
            "clientInfo": { "name": "splice-editor", "version": "0.1.0" },
            "rootUri": root_uri,
            "workspaceFolders": workspace_folders,
            "capabilities": {
                // Advertise workspace capabilities so the server can pull config
                // and register capabilities dynamically (handled in lsp_reader)
                "workspace": {
                    "configuration": true,
                    "didChangeConfiguration": { "dynamicRegistration": true },
                    "workspaceFolders": true
                },
                // Allow servers to report progress (rust-analyzer uses this
                // to signal when workspace indexing is complete)
                "window": {
                    "workDoneProgress": true
                },
                "textDocument": {
                    // linkSupport:false → servers return Location[] not LocationLink[]
                    "definition":       { "dynamicRegistration": true, "linkSupport": false },
                    "declaration":      { "dynamicRegistration": true, "linkSupport": false },
                    "typeDefinition":   { "dynamicRegistration": true, "linkSupport": false },
                    "implementation":   { "dynamicRegistration": true, "linkSupport": false },
                    "references":       { "dynamicRegistration": true },
                    "rename":           { "prepareSupport": true },
                    "codeAction": {
                        "codeActionLiteralSupport": {
                            "codeActionKind": { "valueSet": [] }
                        }
                    },
                    "synchronization": {
                        "dynamicRegistration": true,
                        "didSave": true,
                        "willSave": false
                    },
                    "hover": {
                        "contentFormat": ["plaintext", "markdown"]
                    }
                }
            }
        });

        // Inject server-specific initializationOptions
        if let Some(opts) = get_initialization_options(language_id) {
            params["initializationOptions"] = opts;
        }

        let _result = self.request("initialize", params).await?;
        self.notify("initialized", json!({}))?;

        // Push an empty configuration change so servers that use the push model
        // (workspace/didChangeConfiguration) also get a chance to reload settings.
        let _ = self.notify("workspace/didChangeConfiguration", json!({ "settings": {} }));

        Ok(())
    }
}

#[tauri::command]
pub async fn lsp_check(language_id: String) -> Result<bool, String> {
    match get_lsp_command(&language_id) {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

fn get_install_command(language_id: &str) -> Result<(String, Vec<String>), String> {
    match language_id {
        "typescript" | "javascript" | "typescriptreact" | "javascriptreact" => Ok((
            "npm".into(),
            vec![
                "install".into(),
                "-g".into(),
                "typescript-language-server".into(),
                "typescript".into(),
            ],
        )),
        "python" => Ok((
            "npm".into(),
            vec!["install".into(), "-g".into(), "pyright".into()],
        )),
        "rust" => Ok((
            "rustup".into(),
            vec!["component".into(), "add".into(), "rust-analyzer".into()],
        )),
        "html" | "css" | "json" => Ok((
            "npm".into(),
            vec![
                "install".into(),
                "-g".into(),
                "vscode-langservers-extracted".into(),
            ],
        )),
        _ => Err(format!("No installer for language: {}", language_id)),
    }
}

#[tauri::command]
pub async fn lsp_install(language_id: String) -> Result<(), String> {
    let (cmd, args) = get_install_command(&language_id)?;
    let output = Command::new(&cmd)
        .args(&args)
        .env("PATH", augmented_path())
        .output()
        .await
        .map_err(|e| format!("Failed to run installer: {}", e))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Install failed: {}", stderr.trim()))
    }
}

#[tauri::command]
pub async fn lsp_start(
    app: tauri::AppHandle,
    state: State<'_, Mutex<crate::state::AppState>>,
    language_id: String,
    workspace_root: String,
) -> Result<(), String> {
    // Idempotent: return early if already running
    {
        let locked = state
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        if locked.lsp_sessions.contains_key(&language_id) {
            return Ok(());
        }
    }
    // Spawn outside the lock — this awaits the initialize handshake
    let session = LspSession::spawn(&language_id, &workspace_root, app).await?;
    {
        let mut locked = state
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        locked.lsp_sessions.insert(language_id, session);
    }
    Ok(())
}

#[tauri::command]
pub async fn lsp_notify(
    state: State<'_, Mutex<crate::state::AppState>>,
    language_id: String,
    method: String,
    params: Value,
) -> Result<(), String> {
    let stdin_tx = {
        let locked = state
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        locked
            .lsp_sessions
            .get(&language_id)
            .map(|s| s.stdin_tx.clone())
            .ok_or_else(|| format!("No LSP session for {}", language_id))?
    };
    let msg = json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params
    });
    let bytes = encode_message(&msg);
    stdin_tx
        .send(bytes)
        .map_err(|e| format!("Send error: {}", e))
}

#[tauri::command]
pub async fn lsp_request(
    state: State<'_, Mutex<crate::state::AppState>>,
    language_id: String,
    method: String,
    params: Value,
) -> Result<Value, String> {
    let (stdin_tx, pending, next_id) = {
        let locked = state
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        let session = locked
            .lsp_sessions
            .get(&language_id)
            .ok_or_else(|| format!("No LSP session for {}", language_id))?;
        (
            session.stdin_tx.clone(),
            session.pending.clone(),
            session.next_id.clone(),
        )
    };

    let id = next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    {
        let mut map = pending
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        map.insert(id, tx);
    }
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params
    });
    let bytes = encode_message(&msg);
    stdin_tx
        .send(bytes)
        .map_err(|e| format!("Send error: {}", e))?;

    let response = tokio::time::timeout(std::time::Duration::from_secs(30), rx)
        .await
        .map_err(|_| "LSP request timed out".to_string())?
        .map_err(|_| "LSP channel closed".to_string())?;

    if let Some(err) = response.get("error") {
        return Err(format!("LSP error: {}", err));
    }

    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}
