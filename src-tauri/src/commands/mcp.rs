//! Tauri commands for the MCP bridge: the window's half of `spawn_agent`, the
//! settings panel (status, registration, remote token, webhooks) and the inbox.

use crate::mcp::{self, inbox::InboxItem, register::Registration, webhooks};
use crate::state::AppState;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

/// The window answers an `mcp:request` event.
#[tauri::command]
pub fn mcp_resolve(request_id: String, ok: bool, value: serde_json::Value) {
    let result = if ok {
        Ok(value)
    } else {
        Err(value.as_str().unwrap_or("the request failed").to_string())
    };
    mcp::resolve(&request_id, result);
}

#[derive(Serialize)]
pub struct McpStatus {
    pub enabled: bool,
    pub remote_enabled: bool,
    /// Port of the local endpoint (0 if the server could not bind).
    pub port: u16,
    /// Only present while remote access is on.
    pub remote_token: Option<String>,
    pub registration: Registration,
}

#[tauri::command]
pub fn mcp_status(state: State<'_, Mutex<AppState>>) -> Result<McpStatus, String> {
    let (enabled, remote_enabled, port) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let g = &s.settings.general;
        (g.mcp_enabled, g.mcp_enabled && g.mcp_remote_access, s.attention_port.unwrap_or(0))
    };
    Ok(McpStatus {
        enabled,
        remote_enabled,
        port,
        remote_token: remote_enabled.then(mcp::remote_token),
        registration: mcp::register::load_registration(&mcp::config_dir()),
    })
}

/// Bring the agent CLIs' configuration in line with `enabled` on a background
/// thread, then tell every window so the settings panel can refresh.
pub fn sync_registration_in_background(app: AppHandle, enabled: bool, force: bool) {
    std::thread::spawn(move || {
        let reg = mcp::register::sync(&mcp::config_dir(), enabled, force);
        let _ = app.emit("mcp:registration", &reg);
    });
}

/// Re-run the registration (the "Retry" button after a CLI was installed).
#[tauri::command]
pub fn mcp_reregister(app: AppHandle, state: State<'_, Mutex<AppState>>) -> Result<(), String> {
    let enabled = state.lock().map_err(|e| e.to_string())?.settings.general.mcp_enabled;
    sync_registration_in_background(app, enabled, true);
    Ok(())
}

#[tauri::command]
pub fn mcp_regenerate_remote_token() -> Result<String, String> {
    mcp::regenerate_remote_token()
}

// --- inbox -----------------------------------------------------------------

#[tauri::command]
pub fn inbox_list() -> Vec<InboxItem> {
    mcp::with_inbox(|inbox| inbox.items.clone())
}

#[tauri::command]
pub fn inbox_delete(app: AppHandle, id: String) -> Result<(), String> {
    mcp::with_inbox(|inbox| inbox.delete(&id))?;
    mcp::emit_inbox_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn inbox_clear(app: AppHandle) -> Result<(), String> {
    mcp::with_inbox(|inbox| inbox.clear())?;
    mcp::emit_inbox_changed(&app);
    Ok(())
}

/// Turn an inbox item into a handoff: returns the shell command that starts
/// `agent` with the item (labelled as third-party content) as its first prompt.
#[tauri::command]
pub fn inbox_handoff(id: String, agent: String) -> Result<String, String> {
    let text = mcp::with_inbox(|inbox| inbox.get(&id).map(mcp::inbox::render_for_agent))
        .ok_or_else(|| "That inbox item no longer exists".to_string())?;
    let agent = if agent == "codex" { "codex" } else { "claude" };
    mcp::prepare_handoff(&text, agent)
}

// --- webhooks --------------------------------------------------------------

#[tauri::command]
pub fn webhooks_list() -> Vec<webhooks::WebhookSummary> {
    mcp::with_webhooks(|w| w.summaries())
}

#[tauri::command]
pub fn webhook_save(name: String, url: String, key: String, auth: webhooks::AuthStyle) -> Result<(), String> {
    mcp::with_webhooks(|w| w.upsert(webhooks::Webhook { name, url, key, auth }))
}

#[tauri::command]
pub fn webhook_delete(name: String) -> Result<(), String> {
    mcp::with_webhooks(|w| w.delete(&name)).map(|_| ())
}

/// Send a message to a webhook from the UI (the "Send test" button).
#[tauri::command]
pub async fn webhook_send(name: String, message: String) -> Result<webhooks::SendOutcome, String> {
    let hook = mcp::with_webhooks(|w| w.find(&name).cloned()).ok_or_else(|| format!("No webhook named \"{name}\""))?;
    tokio::task::spawn_blocking(move || webhooks::send(&hook, &message, None))
        .await
        .map_err(|e| e.to_string())?
}
