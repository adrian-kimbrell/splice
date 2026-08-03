use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tracing::{info, warn};

use crate::state::AppState;

#[derive(serde::Serialize, Clone)]
pub(crate) struct AttentionEvent {
    pub terminal_id: u32,
    pub notification_type: String,
    pub message: String,
}

pub(crate) async fn handle_attention_request(app: &AppHandle, json: serde_json::Value) {
    let terminal_id = match json.get("terminal_id").and_then(|v| v.as_u64()).map(|v| v as u32) {
        Some(id) if id > 0 => id,
        _ => {
            warn!("attention request missing or zero terminal_id (non-Splice terminal?)");
            return;
        }
    };

    let notification_type = json
        .get("notification_type")
        .and_then(|v| v.as_str())
        .unwrap_or("idle")
        .to_string();

    let message = json
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    dispatch_attention(app, terminal_id, notification_type, message);
}

/// Emit an attention notification for `terminal_id` and, when the window is
/// unfocused and enabled, fire a macOS notification. Shared by the HTTP hook path
/// (local Claude) and the in-band OSC path (Claude over SSH). Synchronous — safe
/// to call from the PTY reader thread.
pub(crate) fn dispatch_attention(
    app: &AppHandle,
    terminal_id: u32,
    notification_type: String,
    message: String,
) {
    // Verify the terminal still exists before emitting
    {
        let state = app.state::<Mutex<AppState>>();
        if let Ok(locked) = state.lock() {
            if !locked.terminals.contains_key(&terminal_id) {
                warn!(terminal_id, "attention: terminal not found (may have been closed)");
                return;
            }
        };
    }

    let event = AttentionEvent { terminal_id, notification_type: notification_type.clone(), message: message.clone() };
    if let Err(e) = app.emit("attention:notify", &event) {
        warn!("Failed to emit attention:notify: {}", e);
    } else {
        info!(terminal_id, "Emitted attention:notify");
    }

    // Fire a macOS notification when the window is not focused and the setting is enabled
    let notifications_enabled = {
        let state = app.state::<Mutex<AppState>>();
        state.lock().map(|s| s.settings.general.claude_notifications).unwrap_or(false)
    };
    if notifications_enabled {
        let window_focused = app
            .get_webview_window("main")
            .and_then(|w| w.is_focused().ok())
            .unwrap_or(false);
        if !window_focused {
            let body = if message.is_empty() {
                match notification_type.as_str() {
                    "idle" => "Claude is waiting for your input.".to_string(),
                    _ => format!("Claude needs your attention ({notification_type})."),
                }
            } else {
                message.clone()
            };
            if let Err(e) = app.notification().builder()
                .title("Claude")
                .body(&body)
                .show()
            {
                warn!("Failed to send notification: {}", e);
            }
        }
    }
}

/// Extract a positive `terminal_id` from a hook payload, or `None` if absent/zero.
fn extract_terminal_id(json: &serde_json::Value) -> Option<u32> {
    json.get("terminal_id")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32)
        .filter(|id| *id > 0)
}

/// True if the terminal is still live in this Splice instance.
fn terminal_exists(app: &AppHandle, terminal_id: u32) -> bool {
    let state = app.state::<Mutex<AppState>>();
    state
        .lock()
        .map(|s| s.terminals.contains_key(&terminal_id))
        .unwrap_or(false)
}

/// statusLine command → `claude:status`. Forwards Claude's stable status JSON
/// (model, cost, context-window usage, rate limits) for the live HUD. The whole
/// payload is passed through so the frontend can read whichever fields it renders.
pub(crate) async fn handle_status_request(app: &AppHandle, json: serde_json::Value) {
    let Some(terminal_id) = extract_terminal_id(&json) else {
        return;
    };
    if !terminal_exists(app, terminal_id) {
        return;
    }
    if let Err(e) = app.emit("claude:status", &json) {
        warn!("Failed to emit claude:status: {}", e);
    }
}

pub(crate) async fn handle_session_request(app: &AppHandle, json: serde_json::Value) {
    let session_id = match json.get("session_id").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => {
            warn!("session request missing session_id");
            return;
        }
    };

    let terminal_id = match json.get("terminal_id").and_then(|v| v.as_u64()).map(|v| v as u32) {
        Some(id) if id > 0 => id,
        _ => {
            warn!("session request missing or zero terminal_id (non-Splice terminal?)");
            return;
        }
    };

    let claude_pid = json.get("claude_pid").and_then(|v| v.as_u64()).map(|v| v as u32).unwrap_or(0);

    let state = app.state::<Mutex<AppState>>();
    if let Ok(mut locked) = state.lock() {
        if !locked.terminals.contains_key(&terminal_id) {
            warn!(terminal_id, "session: terminal not found (may have been closed)");
            return;
        }
        locked.terminal_claude_sessions.insert(terminal_id, (session_id.clone(), claude_pid));
        info!(terminal_id, session_id, claude_pid, "Stored Claude session for terminal");
    };

    // Emit event so the frontend can cache the session ID without polling
    if let Err(e) = app.emit("terminal:claude-session", serde_json::json!({
        "terminal_id": terminal_id,
        "session_id": session_id,
        "claude_pid": claude_pid,
    })) {
        warn!("Failed to emit terminal:claude-session: {}", e);
    }
}
