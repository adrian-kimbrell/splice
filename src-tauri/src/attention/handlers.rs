use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
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

    let event = AttentionEvent { terminal_id, notification_type, message };
    if let Err(e) = app.emit("attention:notify", &event) {
        warn!("Failed to emit attention:notify: {}", e);
    } else {
        info!(terminal_id, "Emitted attention:notify");
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
