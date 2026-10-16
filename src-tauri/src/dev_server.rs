//! Dev-only local HTTP API — lets Claude (or any local process) drive the Splice UI
//! programmatically without needing accessibility/keystroke permissions.
//!
//! Listens on 127.0.0.1 on the first available port in 19990-19992.
//! Port is written to `/tmp/splice-dev-api.port` for easy discovery.
//!
//! # Endpoints
//!
//! - `GET  /dev/ping`               → `{"ok":true}`
//! - `GET  /dev/state`              → full JSON snapshot of app state (workspaces, panes, UI)
//! - `POST /dev/reset`              → close all workspaces, restore default UI state
//! - `POST /dev/pr-mode`            → `{"enabled":bool}` — toggle PR mode
//! - `POST /dev/open-folder`        → `{"path":"..."}` — create workspace from directory
//! - `POST /dev/open-file`          → `{"path":"..."}` — open file in active workspace
//! - `POST /dev/close-workspace`    → `{"index":0}` or `{"id":"..."}` — close workspace
//! - `POST /dev/switch-workspace`   → `{"index":0}` or `{"id":"..."}` — switch workspace
//! - `POST /dev/run-terminal`       → `{"cmd":"...","terminalId":1}` — write to terminal PTY
//! - `POST /dev/split-pane`         → `{"direction":"vertical"|"horizontal"}` — split active pane
//! - `POST /dev/activate-pane`      → `{"terminalId":1}` or `{"paneId":"term-1"}`
//! - `POST /dev/zoom-pane`          → `{"paneId":"term-1"}` or `{}` — toggle zoom
//! - `POST /dev/expand-paths`       → `{"paths":[...]}` — expand file tree nodes
//! - `POST /dev/resize-split`       → `{"ratio":0.6}` — set outermost split ratio
//! - `POST /dev/ui`                 → set any ui state fields (explorerVisible, etc.)
//! - `POST /dev/resize`             → `{"width":1280,"height":800}` — resize window
//! - `POST /dev/notify`             → `{"terminalId":1,"notifType":"idle","message":"..."}` — fake notification
//! - `POST /dev/clear-notify`       → `{"terminalId":1}` or `{}` — clear notifications
//! - `POST /dev/set-zdotdir`        → `{"dir":"/path"}` — set ZDOTDIR for shell customisation
//! - `POST /dev/screenshot`         → `{"name":"..."}` — capture PNG, returns `{"path":"..."}`
//! - `GET  /dev/logs`               → drain console log buffer `[{level,message,ts_ms}]`
//! - `POST /dev/dom-query`          → `{"selector":"..."}` — query DOM elements, returns `[{tagName,id,classes,text,rect,attrs,visible}]`
//! - `POST /dev/keyboard`           → `{"key":"n","meta":true,...}` — dispatch KeyboardEvent to document
//! - `POST /dev/set-file-content`   → `{"content":"..."}` — replace active editor file content
//!
//! No auth token required — localhost only, debug builds only.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tracing::{info, warn};

// ---------------------------------------------------------------------------
// Console log buffer — stores frontend console output for GET /dev/logs.
// Capped at 500 entries (oldest dropped first). Flushed on read.
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, Clone)]
pub struct LogEntry {
    pub level: String,
    pub message: String,
    pub ts_ms: u64,
}

type LogBuffer = Mutex<Vec<LogEntry>>;
static LOGS: OnceLock<LogBuffer> = OnceLock::new();
fn log_buf() -> &'static LogBuffer {
    LOGS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Called by the `dev_log` Tauri command — buffers a frontend log entry.
pub fn push_log(level: &str, message: &str) {
    let ts_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if let Ok(mut buf) = log_buf().lock() {
        if buf.len() >= 500 {
            buf.remove(0);
        }
        buf.push(LogEntry { level: level.to_string(), message: message.to_string(), ts_ms });
    }
}

// ---------------------------------------------------------------------------
// Screenshot waiter registry — maps request_id → oneshot sender.
// The HTTP handler parks here; the `screenshot_done` IPC command resolves it.
// ---------------------------------------------------------------------------

type Waiters = Mutex<HashMap<String, oneshot::Sender<Result<String, String>>>>;

static WAITERS: OnceLock<Waiters> = OnceLock::new();

fn waiters() -> &'static Waiters {
    WAITERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Called by the `screenshot_done` Tauri IPC command (invoked from the frontend
/// after it finishes capturing and saving the PNG).
pub fn resolve_screenshot(request_id: &str, result: Result<String, String>) {
    if let Ok(mut map) = waiters().lock() {
        if let Some(tx) = map.remove(request_id) {
            let _ = tx.send(result);
        }
    }
}

// ---------------------------------------------------------------------------
// State waiter registry — maps request_id → oneshot sender for /dev/state.
// ---------------------------------------------------------------------------

type StateWaiters = Mutex<HashMap<String, oneshot::Sender<String>>>;

static STATE_WAITERS: OnceLock<StateWaiters> = OnceLock::new();

fn state_waiters() -> &'static StateWaiters {
    STATE_WAITERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Called by the `resolve_dev_state` Tauri IPC command.
pub fn resolve_state(request_id: &str, state_json: String) {
    if let Ok(mut map) = state_waiters().lock() {
        if let Some(tx) = map.remove(request_id) {
            let _ = tx.send(state_json);
        }
    }
}

// ---------------------------------------------------------------------------
// DOM query waiter registry — maps request_id → oneshot sender for /dev/dom-query.
// ---------------------------------------------------------------------------

type DomWaiters = Mutex<HashMap<String, oneshot::Sender<String>>>;

static DOM_WAITERS: OnceLock<DomWaiters> = OnceLock::new();

fn dom_waiters() -> &'static DomWaiters {
    DOM_WAITERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Called by the `resolve_dev_dom` Tauri IPC command.
pub fn resolve_dom(request_id: &str, results_json: String) {
    if let Ok(mut map) = dom_waiters().lock() {
        if let Some(tx) = map.remove(request_id) {
            let _ = tx.send(results_json);
        }
    }
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

pub async fn start_dev_server(app: AppHandle) -> u16 {
    for port in [19990u16, 19991, 19992] {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => {
                info!(port, "Dev API server listening");
                let _ = std::fs::write("/tmp/splice-dev-api.port", port.to_string());
                let app_arc = Arc::new(app);
                tokio::spawn(async move {
                    loop {
                        match listener.accept().await {
                            Ok((stream, _)) => {
                                let app = Arc::clone(&app_arc);
                                tokio::spawn(handle_connection(stream, app));
                            }
                            Err(e) => warn!("Dev API accept error: {}", e),
                        }
                    }
                });
                return port;
            }
            Err(_) => continue,
        }
    }
    warn!("Could not bind dev API server on ports 19990-19992");
    0
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

async fn handle_connection(mut stream: TcpStream, app: Arc<AppHandle>) {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let header_end;
    loop {
        match stream.read(&mut tmp).await {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    header_end = pos;
                    break;
                }
                if buf.len() > 8192 {
                    return;
                }
            }
        }
    }

    let header_str = match std::str::from_utf8(&buf[..header_end]) {
        Ok(s) => s,
        Err(_) => return,
    };

    let path = header_str
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("/")
        .to_string();

    let content_length = header_str
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("content-length:"))
        .and_then(|l| l.split_once(':').map(|(_, v)| v.trim().parse::<usize>().ok()))
        .flatten()
        .unwrap_or(0);

    let body_start = header_end + 4;
    let mut body = buf[body_start..].to_vec();
    let remaining = content_length.saturating_sub(body.len());
    if remaining > 0 {
        let mut rest = vec![0u8; remaining];
        if tokio::time::timeout(
            std::time::Duration::from_secs(5),
            stream.read_exact(&mut rest),
        )
        .await
        .is_err()
        {
            return;
        }
        body.extend_from_slice(&rest);
    }

    let json: serde_json::Value = if body.is_empty() {
        serde_json::Value::Object(serde_json::Map::new())
    } else {
        serde_json::from_slice(&body)
            .unwrap_or_else(|_| serde_json::Value::Object(serde_json::Map::new()))
    };

    let response = handle_request(&path, json, &app).await;
    let _ = stream.write_all(response.as_bytes()).await;
}

async fn handle_request(path: &str, json: serde_json::Value, app: &AppHandle) -> String {
    match path {
        "/dev/ping" => ok("{\"ok\":true}"),

        "/dev/pr-mode" => {
            let enabled = json.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
            match app.emit("dev:pr-mode", enabled) {
                Ok(_) => ok(&format!("{{\"enabled\":{enabled}}}")),
                Err(e) => err(&e.to_string()),
            }
        }

        "/dev/open-folder" => {
            let folder = match json.get("path").and_then(|v| v.as_str()) {
                Some(p) if !p.is_empty() => p.to_string(),
                _ => return err("missing 'path'"),
            };
            match app.emit("dev:open-folder", &folder) {
                Ok(_) => ok("{\"ok\":true}"),
                Err(e) => err(&e.to_string()),
            }
        }

        "/dev/open-file" => {
            let file = match json.get("path").and_then(|v| v.as_str()) {
                Some(p) if !p.is_empty() => p.to_string(),
                _ => return err("missing 'path'"),
            };
            match app.emit("dev:open-file", &file) {
                Ok(_) => ok("{\"ok\":true}"),
                Err(e) => err(&e.to_string()),
            }
        }

        "/dev/screenshot" => {
            let name = json
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("screenshot")
                .to_string();

            // Unique request ID so multiple concurrent calls don't collide
            let request_id = format!(
                "{:x}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            );

            let (tx, rx) = oneshot::channel();
            waiters().lock().unwrap().insert(request_id.clone(), tx);

            let payload = serde_json::json!({ "name": name, "requestId": request_id });
            if let Err(e) = app.emit("dev:capture-screenshot", payload) {
                waiters().lock().unwrap().remove(&request_id);
                return err(&e.to_string());
            }

            // Wait up to 30 seconds for the frontend to capture and save
            match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
                Ok(Ok(Ok(saved_path))) => {
                    let escaped = saved_path.replace('\\', "\\\\").replace('"', "\\\"");
                    ok(&format!("{{\"path\":\"{escaped}\"}}"))
                }
                Ok(Ok(Err(e))) => err(&e),
                Ok(Err(_)) => err("screenshot cancelled"),
                Err(_) => {
                    waiters().lock().unwrap().remove(&request_id);
                    err("screenshot timed out after 15s")
                }
            }
        }

        "/dev/run-terminal" => {
            // Requires at least a "cmd" field; optional "terminalId"
            if json.get("cmd").and_then(|v| v.as_str()).map(|s| s.is_empty()).unwrap_or(true) {
                return err("missing 'cmd'");
            }
            match app.emit("dev:run-terminal", &json) {
                Ok(_) => ok("{\"ok\":true}"),
                Err(e) => err(&e.to_string()),
            }
        }

        "/dev/ui" => {
            // Set arbitrary UI state: workspacesVisible, explorerVisible, etc.
            match app.emit("dev:ui", &json) {
                Ok(_) => ok("{\"ok\":true}"),
                Err(e) => err(&e.to_string()),
            }
        }

        "/dev/resize" => {
            match app.emit("dev:resize", &json) {
                Ok(_) => ok("{\"ok\":true}"),
                Err(e) => err(&e.to_string()),
            }
        }

        "/dev/reset" => match app.emit("dev:reset", ()) {
            Ok(_) => ok("{\"ok\":true}"),
            Err(e) => err(&e.to_string()),
        },

        // Set ZDOTDIR so the next spawned zsh reads a custom .zshrc (clean prompt, no username).
        // Pass {"dir": "/path/to/dir"} to set, or {"dir": ""} to clear.
        "/dev/set-zdotdir" => {
            let dir = json.get("dir").and_then(|v| v.as_str()).unwrap_or("");
            if dir.is_empty() {
                // Safety: debug-only, single-threaded in practice
                #[allow(deprecated)]
                std::env::remove_var("ZDOTDIR");
            } else {
                #[allow(deprecated)]
                std::env::set_var("ZDOTDIR", dir);
            }
            ok("{\"ok\":true}")
        }

        // Inject a fake attention notification into the topbar.
        // { "terminalId": 1, "notifType": "permission"|"idle", "message": "..." }
        "/dev/notify" => {
            match app.emit("dev:notify", &json) {
                Ok(_) => ok("{\"ok\":true}"),
                Err(e) => err(&e.to_string()),
            }
        }

        // Clear one or all attention notifications.
        // { "terminalId": 1 }  or  {}  to clear all
        "/dev/clear-notify" => {
            match app.emit("dev:clear-notify", &json) {
                Ok(_) => ok("{\"ok\":true}"),
                Err(e) => err(&e.to_string()),
            }
        }

        // Switch active workspace by zero-based index.
        // { "index": 0 }
        "/dev/switch-workspace" => {
            match app.emit("dev:switch-workspace", &json) {
                Ok(_) => ok("{\"ok\":true}"),
                Err(e) => err(&e.to_string()),
            }
        }

        // Expand folders in the active workspace file tree.
        // { "paths": ["/tmp/splice-demo/api/src", ...] }
        "/dev/expand-paths" => {
            let paths = json.get("paths").and_then(|v| v.as_array()).map(|arr| {
                arr.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>()
            }).unwrap_or_default();
            match app.emit("dev:expand-paths", paths) {
                Ok(_) => ok("{\"ok\":true}"),
                Err(e) => err(&e.to_string()),
            }
        }

        // Adjust the outermost split ratio in the active workspace layout.
        // { "ratio": 0.55 }
        "/dev/resize-split" => {
            match app.emit("dev:resize-split", &json) {
                Ok(_) => ok("{\"ok\":true}"),
                Err(e) => err(&e.to_string()),
            }
        }

        // Split the active terminal pane.
        // { "direction": "vertical"|"horizontal" }
        "/dev/split-pane" => {
            match app.emit("dev:split-pane", &json) {
                Ok(_) => ok("{\"ok\":true}"),
                Err(e) => err(&e.to_string()),
            }
        }

        // Kill a specific pane (and its terminal) in the active workspace.
        // { "paneId": "term-1" }  or  { "terminalId": 1 }  or  {} (active pane)
        "/dev/kill-pane" => {
            match app.emit("dev:kill-pane", &json) {
                Ok(_) => ok("{\"ok\":true}"),
                Err(e) => err(&e.to_string()),
            }
        }

        // Close a workspace by zero-based index or ID.
        // { "index": 0 }  or  { "id": "..." }
        "/dev/close-workspace" => {
            match app.emit("dev:close-workspace", &json) {
                Ok(_) => ok("{\"ok\":true}"),
                Err(e) => err(&e.to_string()),
            }
        }

        // Dispatch a synthetic KeyboardEvent to the frontend document.
        // { "key": "n", "meta": true, "ctrl": false, "shift": false, "alt": false }
        // Useful for testing keyboard shortcuts without WebDriver.
        "/dev/keyboard" => {
            match app.emit("dev:keyboard", &json) {
                Ok(_) => ok("{\"ok\":true}"),
                Err(e) => err(&e.to_string()),
            }
        }

        // Set the content of the currently active file in the editor.
        // { "content": "..." }
        "/dev/set-file-content" => {
            match app.emit("dev:set-file-content", &json) {
                Ok(_) => ok("{\"ok\":true}"),
                Err(e) => err(&e.to_string()),
            }
        }

        // Toggle zoom on a pane by pane ID or active terminal pane.
        // { "paneId": "term-1" }  or  {}
        "/dev/zoom-pane" => {
            match app.emit("dev:zoom-pane", &json) {
                Ok(_) => ok("{\"ok\":true}"),
                Err(e) => err(&e.to_string()),
            }
        }

        // Set the active terminal by pane ID or terminal ID.
        // { "terminalId": 1 }  or  { "paneId": "term-1" }
        "/dev/activate-pane" => {
            match app.emit("dev:activate-pane", &json) {
                Ok(_) => ok("{\"ok\":true}"),
                Err(e) => err(&e.to_string()),
            }
        }

        // Return a JSON snapshot of current app state (workspaces, panes, UI).
        // Waits up to 5s for the frontend to respond.
        "/dev/state" => {
            let request_id = format!(
                "state-{:x}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            );

            let (tx, rx) = oneshot::channel();
            state_waiters().lock().unwrap().insert(request_id.clone(), tx);

            let payload = serde_json::json!({ "requestId": request_id });
            if let Err(e) = app.emit("dev:state", payload) {
                state_waiters().lock().unwrap().remove(&request_id);
                return err(&e.to_string());
            }

            match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
                Ok(Ok(state_json)) => ok(&state_json),
                Ok(Err(_)) => err("state request cancelled"),
                Err(_) => {
                    state_waiters().lock().unwrap().remove(&request_id);
                    err("state request timed out")
                }
            }
        }

        // Query DOM elements by CSS selector and return their properties.
        // { "selector": "canvas.terminal-canvas" }
        // Returns an array of { tagName, id, classes, text, rect, attrs, visible } objects.
        // Times out after 5s if the frontend doesn't respond.
        "/dev/dom-query" => {
            let selector = match json.get("selector").and_then(|v| v.as_str()) {
                Some(s) if !s.is_empty() => s.to_string(),
                _ => return err("missing 'selector'"),
            };
            let request_id = format!(
                "dom-{:x}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            );
            let (tx, rx) = oneshot::channel();
            dom_waiters().lock().unwrap().insert(request_id.clone(), tx);

            let payload = serde_json::json!({ "selector": selector, "requestId": request_id });
            if let Err(e) = app.emit("dev:dom-query", payload) {
                dom_waiters().lock().unwrap().remove(&request_id);
                return err(&e.to_string());
            }

            match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
                Ok(Ok(results_json)) => ok(&results_json),
                Ok(Err(_)) => err("dom-query cancelled"),
                Err(_) => {
                    dom_waiters().lock().unwrap().remove(&request_id);
                    err("dom-query timed out")
                }
            }
        }

        // Drain and return the frontend console log buffer as a JSON array.
        // Each entry: { level: "error"|"warn"|"log", message: string, ts_ms: number }
        // Destructive read — buffer is cleared after each GET.
        "/dev/logs" => {
            let entries = if let Ok(mut buf) = log_buf().lock() {
                std::mem::take(&mut *buf)
            } else {
                vec![]
            };
            match serde_json::to_string(&entries) {
                Ok(body) => ok(&body),
                Err(e) => err(&e.to_string()),
            }
        }

        _ => "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: 17\r\n\r\n{\"error\":\"not found\"}".to_string(),
    }
}

fn ok(body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        body.len(),
        body
    )
}

fn err(msg: &str) -> String {
    let body = format!("{{\"error\":\"{}\"}}", msg.replace('"', "\\\""));
    format!(
        "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        body.len(),
        body
    )
}
