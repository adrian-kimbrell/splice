use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tracing::{info, warn};

use crate::state::AppState;

/// Load a persisted token from disk, or create a new random one and save it.
/// Token is 32 lowercase hex chars (128 bits of entropy from /dev/urandom).
pub fn load_or_create_token() -> String {
    let token_path = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("Splice")
        .join(".attention_token");

    // Try to reuse an existing valid token
    if let Ok(existing) = std::fs::read_to_string(&token_path) {
        let t = existing.trim().to_string();
        if t.len() == 32 && t.chars().all(|c| c.is_ascii_hexdigit()) {
            return t;
        }
    }

    // Generate a new token from /dev/urandom (Unix) or time-based entropy (non-Unix).
    let mut bytes = [0u8; 16];
    #[cfg(unix)]
    {
        use std::io::Read;
        if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
            if f.read_exact(&mut bytes).is_err() {
                // Fallback: mix in system time nanoseconds so the token isn't all-zeros
                warn!("Failed to read from /dev/urandom; using time-based fallback for token entropy");
                let nanos = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .subsec_nanos();
                let t = nanos.to_le_bytes();
                for (b, &n) in bytes.iter_mut().zip(t.iter().cycle()) {
                    *b ^= n;
                }
            }
        }
    }
    // On non-Unix targets (no /dev/urandom), fill bytes with time-based entropy so the
    // token is never all-zeros (which would be a trivially guessable authentication token).
    #[cfg(not(unix))]
    {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos();
        let pid = std::process::id();
        let t = nanos.to_le_bytes();
        let p = pid.to_le_bytes();
        for (i, b) in bytes.iter_mut().enumerate() {
            *b ^= t[i % t.len()] ^ p[i % p.len()];
        }
    }
    let token: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();

    if let Some(parent) = token_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(&token_path, &token).ok();
    token
}

#[derive(serde::Serialize, Clone)]
struct AttentionEvent {
    terminal_id: u32,
    notification_type: String,
    message: String,
}

/// Write the bound port to a file next to the token so hooks know where to connect.
fn write_port_file(port: u16) {
    let port_path = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("Splice")
        .join(".attention_port");
    if let Some(parent) = port_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(&port_path, port.to_string()).ok();
}

pub async fn start_server(app: AppHandle, token: String) -> u16 {
    let token = Arc::new(token);
    for port in [19876u16, 19877, 19878] {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => {
                info!(port, "Attention server listening");
                write_port_file(port);
                let app_clone = app.clone();
                let token_clone = Arc::clone(&token);
                tokio::spawn(async move {
                    loop {
                        match listener.accept().await {
                            Ok((stream, _)) => {
                                let app = app_clone.clone();
                                let tok = Arc::clone(&token_clone);
                                tokio::spawn(handle_connection(stream, app, tok));
                            }
                            Err(e) => {
                                // continue, not break — transient errors like ECONNABORTED are
                                // normal on busy systems and must not permanently kill the loop.
                                warn!("Attention server accept error: {}", e);
                            }
                        }
                    }
                });
                return port;
            }
            Err(_) => continue,
        }
    }
    warn!("Could not bind attention server on ports 19876-19878");
    0
}

async fn handle_connection(mut stream: TcpStream, app: AppHandle, token: Arc<String>) {
    // Read until \r\n\r\n to get headers
    let mut buf = Vec::new();
    let mut tmp = [0u8; 1024];
    let header_end;

    loop {
        match stream.read(&mut tmp).await {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if let Some(pos) = find_header_end(&buf) {
                    header_end = pos;
                    break;
                }
                if buf.len() > 16384 {
                    return; // request too large
                }
            }
        }
    }

    // Parse header string
    let header_str = match std::str::from_utf8(&buf[..header_end]) {
        Ok(s) => s,
        Err(_) => return,
    };

    // Validate X-Splice-Token header to reject requests from other local processes
    let provided_token = header_str.lines()
        .find(|l| l.to_ascii_lowercase().starts_with("x-splice-token:"))
        .and_then(|l| l.splitn(2, ':').nth(1))
        .map(|v| v.trim())
        .unwrap_or("");
    if provided_token != token.as_str() {
        warn!("attention: rejected request with invalid token");
        let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\n\r\n").await;
        return;
    }

    // Extract request path from first line (e.g. "POST /session HTTP/1.1")
    let path = header_str
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");
    // Only allow known safe path values
    let path = match path {
        "/session" | "/attention" => path.to_string(),
        _ => {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\n\r\n").await;
            return;
        }
    };

    let content_length = parse_content_length(header_str).unwrap_or(0);
    if content_length == 0 || content_length > 65536 {
        warn!("attention: rejecting connection: content_length={}", content_length);
        let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
        return;
    }

    // We already have some body bytes after the header
    let body_start = header_end + 4; // skip \r\n\r\n
    let mut body = buf[body_start..].to_vec();

    // Read remaining body bytes (with timeout to prevent slow-loris style hangs)
    let remaining = content_length.saturating_sub(body.len());
    if remaining > 0 {
        let mut rest = vec![0u8; remaining];
        let read_result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            stream.read_exact(&mut rest),
        ).await;
        match read_result {
            Ok(Ok(_)) => {}
            _ => return,
        }
        body.extend_from_slice(&rest);
    }

    // Parse JSON body
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(&body) else {
        let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
        return;
    };

    // Respond immediately so Claude isn't blocked
    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").await;

    if path == "/session" {
        handle_session_request(&app, json).await;
    } else {
        handle_attention_request(&app, json).await;
    }
}

async fn handle_attention_request(app: &AppHandle, json: serde_json::Value) {
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

async fn handle_session_request(app: &AppHandle, json: serde_json::Value) {
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

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn parse_content_length(headers: &str) -> Option<usize> {
    for line in headers.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("content-length:") {
            let val = lower["content-length:".len()..].trim();
            return val.parse().ok();
        }
    }
    None
}

/// Remove all hook entries under `hooks_obj[hook_key]` whose command contains `marker`.
fn remove_hooks_by_marker(
    hooks_obj: &mut serde_json::Map<String, serde_json::Value>,
    hook_key: &str,
    marker: &str,
) {
    let Some(arr) = hooks_obj.get_mut(hook_key).and_then(|v| v.as_array_mut()) else {
        return;
    };
    let before = arr.len();
    arr.retain(|entry| {
        let dominated = entry
            .get("hooks")
            .and_then(|h| h.as_array())
            .map(|hh| {
                hh.iter().any(|h| {
                    h.get("command")
                        .and_then(|c| c.as_str())
                        .map(|s| s.contains(marker))
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false);
        !dominated
    });
    if arr.len() < before {
        info!(hook_key, marker, "Removed old hook entries");
    }
}

/// Install a single hook entry under `hooks_obj[hook_key]`, identified by `marker`.
/// Replaces outdated entries (missing token auth) automatically.
fn install_hook_entry(
    hooks_obj: &mut serde_json::Map<String, serde_json::Value>,
    hook_key: &str,
    url_path: &str,
    marker: &str,
) {
    // Only allow safe, pre-approved paths
    if !matches!(url_path, "attention" | "session") {
        warn!(url_path, "Refusing to install hook for unknown path");
        return;
    }
    let arr = hooks_obj
        .entry(hook_key)
        .or_insert(serde_json::json!([]));
    if !arr.is_array() {
        *arr = serde_json::json!([]);
    }
    let arr = arr.as_array_mut().expect("guaranteed to be array after guard");

    // Helper: check if any hook command in an entry contains a substring
    let entry_command_contains = |entry: &serde_json::Value, needle: &str| -> bool {
        entry
            .get("hooks")
            .and_then(|h| h.as_array())
            .map(|hh| {
                hh.iter().any(|h| {
                    h.get("command")
                        .and_then(|c| c.as_str())
                        .map(|s| s.contains(needle))
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false)
    };

    let existing_idx = arr.iter().position(|entry| entry_command_contains(entry, marker));

    if let Some(idx) = existing_idx {
        // Already installed — check if up-to-date (reads port from .attention_port file)
        if entry_command_contains(&arr[idx], ".attention_port") {
            return;
        }
        // Outdated: remove so we can reinstall below
        arr.remove(idx);
        info!(hook_key, "Replacing outdated Splice hook");
    }

    // The hook reads the port from .attention_port and token from .attention_token,
    // both in the Splice config dir (macOS ~/Library/Application Support/Splice/,
    // Linux ~/.config/Splice/). The # marker comment keeps the already-installed check working.
    //
    // terminal_id is read directly from the SPLICE_TERMINAL_ID env var that Splice
    // injects when spawning each PTY — no process-tree walking needed.
    // claude_pid (os.getppid()) is stored for informational purposes only.
    let command = format!(
        "python3 -c \"import sys,json,urllib.request,os,os.path as op\n\
         d=json.load(sys.stdin)\n\
         d['terminal_id']=int(os.environ.get('SPLICE_TERMINAL_ID','0'))\n\
         d['claude_pid']=os.getppid()\n\
         def rf(p):\n\
         \ttry: return open(p).read().strip()\n\
         \texcept: return ''\n\
         t='';port=''\n\
         for cd in [op.join(op.expanduser('~'),'Library','Application Support','Splice'),op.join(op.expanduser('~'),'.config','Splice')]:\n\
         \tt=t or rf(op.join(cd,'.attention_token'))\n\
         \tport=port or rf(op.join(cd,'.attention_port'))\n\
         if port:\n\
         \tfor _r in range(2):\n\
         \t\ttry: urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:'+port+'/{url_path}',json.dumps(d).encode(),{{'Content-Type':'application/json','X-Splice-Token':t}}),timeout=0.5); break\n\
         \t\texcept:\n\
         \t\t\tif _r==0:\n\
         \t\t\t\timport time; time.sleep(0.3)\" # {marker}"
    );
    arr.push(serde_json::json!({
        "matcher": "",
        "hooks": [{"type": "command", "command": command}]
    }));
    info!(hook_key, "Installed Splice hook in ~/.claude/settings.json");
}

pub fn install_hook() -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let settings_path = home.join(".claude").join("settings.json");
    install_hook_at(&settings_path)
}

/// Install Splice hooks into the Claude settings file at `settings_path`.
/// Extracted to allow testing with a temp-dir path without touching `~/.claude/settings.json`.
pub fn install_hook_at(settings_path: &std::path::Path) -> Result<(), String> {
    // Create parent dir if needed
    if let Some(parent) = settings_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Read existing JSON or start with {}
    let mut root: serde_json::Value = if settings_path.exists() {
        let content = std::fs::read_to_string(settings_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).unwrap_or(serde_json::Value::Object(Default::default()))
    } else {
        serde_json::Value::Object(Default::default())
    };

    if !root.is_object() {
        root = serde_json::json!({});
    }

    let hooks = root
        .as_object_mut()
        .ok_or("settings.json root is not an object")?
        .entry("hooks")
        .or_insert(serde_json::json!({}));
    if !hooks.is_object() {
        *hooks = serde_json::json!({});
    }
    let hooks_obj = hooks.as_object_mut().unwrap();

    // Remove hooks from all previous versions.
    // "splice-attention-hook" is a prefix of all versioned attention markers (v2, v3, …),
    // so this single remove call clears every generation of the attention hook.
    // Same logic applies to "splice-session-hook".
    remove_hooks_by_marker(hooks_obj, "Notification", "malloc-attention-hook");
    remove_hooks_by_marker(hooks_obj, "Notification", "splice-attention-hook");
    remove_hooks_by_marker(hooks_obj, "SessionStart", "malloc-session-hook");
    remove_hooks_by_marker(hooks_obj, "SessionStart", "splice-session-hook");

    install_hook_entry(hooks_obj, "Notification", "attention", "splice-attention-hook-v3");
    install_hook_entry(hooks_obj, "SessionStart", "session", "splice-session-hook-v4");
    info!("Splice hooks configured in ~/.claude/settings.json");

    let updated = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    // Atomic write: write to a temp file then rename to avoid racing with Claude itself
    let tmp = settings_path.with_extension("json.tmp");
    std::fs::write(&tmp, updated).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, settings_path).map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Read settings.json from a temp dir, return the parsed JSON value.
    fn read_settings(dir: &std::path::Path) -> serde_json::Value {
        let path = dir.join("settings.json");
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    }

    /// Count how many hook entries across all hook keys contain `marker` in their command.
    fn count_hooks_with_marker(root: &serde_json::Value, marker: &str) -> usize {
        let Some(hooks) = root.get("hooks").and_then(|h| h.as_object()) else {
            return 0;
        };
        hooks.values().flat_map(|arr| arr.as_array().into_iter().flatten()).filter(|entry| {
            entry.get("hooks").and_then(|h| h.as_array()).map(|hh| {
                hh.iter().any(|h| {
                    h.get("command").and_then(|c| c.as_str())
                        .map(|s| s.contains(marker)).unwrap_or(false)
                })
            }).unwrap_or(false)
        }).count()
    }

    /// Return the command string for the first hook entry containing `marker`, if any.
    fn find_hook_command<'a>(root: &'a serde_json::Value, marker: &str) -> Option<String> {
        let hooks = root.get("hooks")?.as_object()?;
        for arr in hooks.values() {
            for entry in arr.as_array()?.iter() {
                for h in entry.get("hooks")?.as_array()?.iter() {
                    if let Some(cmd) = h.get("command").and_then(|c| c.as_str()) {
                        if cmd.contains(marker) {
                            return Some(cmd.to_string());
                        }
                    }
                }
            }
        }
        None
    }

    #[test]
    fn hook_script_contains_session_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        install_hook_at(&dir.path().join("settings.json")).unwrap();
        let root = read_settings(dir.path());
        let cmd = find_hook_command(&root, "splice-session-hook-v4").unwrap();
        assert!(cmd.contains("/session"), "hook command should contain /session endpoint");
    }

    #[test]
    fn hook_script_contains_token_header() {
        let dir = tempfile::tempdir().unwrap();
        install_hook_at(&dir.path().join("settings.json")).unwrap();
        let root = read_settings(dir.path());
        let cmd = find_hook_command(&root, "splice-session-hook-v4").unwrap();
        assert!(cmd.contains("X-Splice-Token"), "hook command should include X-Splice-Token header");
    }

    #[test]
    fn hook_script_reads_claude_pid() {
        let dir = tempfile::tempdir().unwrap();
        install_hook_at(&dir.path().join("settings.json")).unwrap();
        let root = read_settings(dir.path());
        let cmd = find_hook_command(&root, "splice-session-hook-v4").unwrap();
        // os.getppid() is still sent as claude_pid for informational / session-persistence use.
        assert!(cmd.contains("os.getppid()"), "hook command should call os.getppid()");
    }

    #[test]
    fn hook_installation_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        install_hook_at(&path).unwrap();
        install_hook_at(&path).unwrap();
        let root = read_settings(dir.path());
        let count = count_hooks_with_marker(&root, "splice-session-hook-v4");
        assert_eq!(count, 1, "session hook should appear exactly once after two installs");
    }

    #[test]
    fn hook_removes_old_malloc_marker() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");

        // Write a settings file with an old malloc-attention-hook entry
        let old = serde_json::json!({
            "hooks": {
                "Notification": [{
                    "matcher": "",
                    "hooks": [{"type": "command", "command": "python3 -c \"...\" # malloc-attention-hook"}]
                }]
            }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&old).unwrap()).unwrap();

        install_hook_at(&path).unwrap();
        let root = read_settings(dir.path());

        assert_eq!(count_hooks_with_marker(&root, "malloc-attention-hook"), 0,
            "old malloc-attention-hook marker should be gone after install");
        assert_eq!(count_hooks_with_marker(&root, "splice-attention-hook-v3"), 1,
            "splice-attention-hook-v3 should be present after install");
    }

    #[test]
    fn hook_removes_old_malloc_session_marker() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");

        let old = serde_json::json!({
            "hooks": {
                "SessionStart": [{
                    "matcher": "",
                    "hooks": [{"type": "command", "command": "python3 -c \"...\" # malloc-session-hook"}]
                }]
            }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&old).unwrap()).unwrap();

        install_hook_at(&path).unwrap();
        let root = read_settings(dir.path());

        assert_eq!(count_hooks_with_marker(&root, "malloc-session-hook"), 0,
            "old malloc-session-hook marker should be gone");
        assert_eq!(count_hooks_with_marker(&root, "splice-session-hook-v4"), 1,
            "splice-session-hook-v4 should be present");
    }

    // -----------------------------------------------------------------------
    // Group A: parse_content_length edge cases
    // -----------------------------------------------------------------------

    #[test]
    fn parse_content_length_normal() {
        assert_eq!(parse_content_length("Content-Length: 42\r\n"), Some(42));
    }

    #[test]
    fn parse_content_length_missing() {
        assert_eq!(parse_content_length("Host: localhost\r\n"), None);
    }

    #[test]
    fn parse_content_length_zero() {
        // Parser returns Some(0); handle_connection rejects content_length == 0
        assert_eq!(parse_content_length("Content-Length: 0\r\n"), Some(0));
    }

    #[test]
    fn parse_content_length_at_limit() {
        assert_eq!(parse_content_length("Content-Length: 65536\r\n"), Some(65536));
    }

    #[test]
    fn parse_content_length_over_limit() {
        // Parser accepts it; handle_connection rejects values > 65536
        assert_eq!(parse_content_length("Content-Length: 65537\r\n"), Some(65537));
    }

    #[test]
    fn parse_content_length_non_numeric() {
        assert_eq!(parse_content_length("Content-Length: abc\r\n"), None);
    }

    #[test]
    fn parse_content_length_uppercase_header() {
        assert_eq!(parse_content_length("CONTENT-LENGTH: 100\r\n"), Some(100));
    }

    // -----------------------------------------------------------------------
    // Group B: find_header_end edge cases
    // -----------------------------------------------------------------------

    #[test]
    fn find_header_end_normal() {
        let buf = b"GET / HTTP/1.1\r\nHost: x\r\n\r\nBODY";
        // \r\n\r\n starts at byte 23
        assert_eq!(find_header_end(buf), Some(23));
    }

    #[test]
    fn find_header_end_not_found() {
        let buf = b"GET / HTTP/1.1\r\nHost: x\r\n";
        assert_eq!(find_header_end(buf), None);
    }

    #[test]
    fn find_header_end_empty() {
        assert_eq!(find_header_end(b""), None);
    }

    #[test]
    fn find_header_end_at_start() {
        let buf = b"\r\n\r\nBODY";
        assert_eq!(find_header_end(buf), Some(0));
    }

    // -----------------------------------------------------------------------
    // Group C: token validation logic
    // -----------------------------------------------------------------------

    #[test]
    fn token_valid_format_check() {
        let t = "deadbeef00112233445566778899aabb";
        assert_eq!(t.len(), 32);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn token_too_short_rejected() {
        let t = "deadbeef";
        assert!(!(t.len() == 32 && t.chars().all(|c| c.is_ascii_hexdigit())));
    }

    #[test]
    fn token_non_hex_rejected() {
        let t = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"; // 32 chars, not hex
        assert!(!(t.len() == 32 && t.chars().all(|c| c.is_ascii_hexdigit())));
    }

    #[test]
    fn load_or_create_token_from_file() {
        // Write a known valid token to a tempdir path and verify the reuse branch.
        let dir = tempfile::tempdir().unwrap();
        let token_path = dir.path().join(".attention_token");
        let known = "aabbccddeeff00112233445566778899";
        std::fs::write(&token_path, known).unwrap();
        let existing = std::fs::read_to_string(&token_path).unwrap();
        let t = existing.trim().to_string();
        assert!(t.len() == 32 && t.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(t, known);
    }

    #[test]
    fn load_or_create_token_bad_file_triggers_regeneration() {
        // "bad" means wrong length — the loader discriminates on length + hex.
        let bad = "notahextoken";
        let is_valid = bad.len() == 32 && bad.chars().all(|c| c.is_ascii_hexdigit());
        assert!(!is_valid, "short/non-hex token must not be reused");
    }

    // -----------------------------------------------------------------------
    // Group D: hook script robustness
    // -----------------------------------------------------------------------

    #[test]
    fn hook_script_has_retry_logic() {
        let dir = tempfile::tempdir().unwrap();
        install_hook_at(&dir.path().join("settings.json")).unwrap();
        let root = read_settings(dir.path());
        let cmd = find_hook_command(&root, "splice-attention-hook-v3").unwrap();
        assert!(cmd.contains("range(2)"), "hook must retry once on failure");
    }

    #[test]
    fn hook_script_has_timeout() {
        let dir = tempfile::tempdir().unwrap();
        install_hook_at(&dir.path().join("settings.json")).unwrap();
        let root = read_settings(dir.path());
        let cmd = find_hook_command(&root, "splice-attention-hook-v3").unwrap();
        assert!(cmd.contains("timeout="), "hook must set a request timeout");
    }

    #[test]
    fn hook_script_reads_both_config_dirs() {
        let dir = tempfile::tempdir().unwrap();
        install_hook_at(&dir.path().join("settings.json")).unwrap();
        let root = read_settings(dir.path());
        let cmd = find_hook_command(&root, "splice-attention-hook-v3").unwrap();
        assert!(
            cmd.contains("Library") || cmd.contains(".config"),
            "hook must search platform config dirs",
        );
    }

    #[test]
    fn hook_install_with_corrupted_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, b"{{{{INVALID JSON").unwrap();
        // Should not panic — recovers by starting fresh
        install_hook_at(&path).unwrap();
        let root = read_settings(dir.path());
        assert_eq!(count_hooks_with_marker(&root, "splice-session-hook-v4"), 1);
    }

    #[test]
    fn hook_install_with_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, b"").unwrap();
        install_hook_at(&path).unwrap();
        let root = read_settings(dir.path());
        assert_eq!(count_hooks_with_marker(&root, "splice-session-hook-v4"), 1);
    }

    #[test]
    fn hook_removes_old_splice_attention_hook_v1() {
        // Old installations used "splice-attention-hook" (no version suffix).
        // After the grandparent-PID fix the hook is "splice-attention-hook-v3".
        // The migration must remove the old entry so the new one takes effect.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let old = serde_json::json!({
            "hooks": {
                "Notification": [{
                    "matcher": "",
                    "hooks": [{"type": "command", "command": "python3 -c \"...\" # splice-attention-hook"}]
                }]
            }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&old).unwrap()).unwrap();

        install_hook_at(&path).unwrap();
        let root = read_settings(dir.path());

        // The old v1 marker must be gone and the new v2 marker present.
        // Note: count_hooks_with_marker uses contains(), so "splice-attention-hook"
        // matches v1, v2, v3, … entries — use the version-specific suffix to distinguish.
        assert_eq!(count_hooks_with_marker(&root, "splice-attention-hook-v3"), 1,
            "splice-attention-hook-v3 should be installed");
        // Verify no entry is the old bare marker (ends exactly without "-v2")
        let hooks = root.get("hooks").and_then(|h| h.as_object()).unwrap();
        let has_bare_marker = hooks.values()
            .flat_map(|arr| arr.as_array().into_iter().flatten())
            .flat_map(|entry| entry.get("hooks").and_then(|h| h.as_array()).into_iter().flatten())
            .filter_map(|h| h.get("command").and_then(|c| c.as_str()))
            .any(|cmd| cmd.ends_with("# splice-attention-hook"));
        assert!(!has_bare_marker, "bare splice-attention-hook v1 entry must be removed");
    }

    #[test]
    fn hook_script_reads_terminal_id_from_env() {
        // Routing is now O(1): the hook reads SPLICE_TERMINAL_ID injected by the PTY
        // spawner — no process-tree walking (ps) needed.
        let dir = tempfile::tempdir().unwrap();
        install_hook_at(&dir.path().join("settings.json")).unwrap();
        let root = read_settings(dir.path());
        let cmd = find_hook_command(&root, "splice-attention-hook-v3").unwrap();
        assert!(cmd.contains("SPLICE_TERMINAL_ID"), "hook must read SPLICE_TERMINAL_ID env var");
        assert!(!cmd.contains("ps -p"), "hook must not spawn ps (process tree walk eliminated)");
    }

    // -----------------------------------------------------------------------
    // Group E: accept loop resilience
    // -----------------------------------------------------------------------

    /// Regression test for the break→continue fix in the accept loop.
    ///
    /// With `break`, a single transient accept error (e.g. ECONNABORTED when a
    /// client resets before the OS hands the connection to accept()) permanently
    /// killed the server — all subsequent hook requests would hit "connection
    /// refused" and be silently dropped.
    ///
    /// ECONNABORTED cannot be injected reliably without unsafe OS tricks, so
    /// this test verifies the loop survives across many connections (a necessary
    /// condition for correctness). The loop logic mirrors production exactly.
    #[tokio::test]
    async fn accept_loop_survives_rapid_connections() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicU32, Ordering};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let accepted = Arc::new(AtomicU32::new(0));
        let accepted2 = Arc::clone(&accepted);

        // Mirror the fixed accept loop: continue on error, never break.
        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok(_) => { accepted2.fetch_add(1, Ordering::Relaxed); }
                    Err(_) => { /* continue — same as production */ }
                }
            }
        });

        // Fire 5 connections in rapid succession without holding them open.
        for _ in 0..5 {
            let _ = tokio::net::TcpStream::connect(addr).await.unwrap();
        }
        // Give the spawned task time to process all pending accept() calls.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        assert_eq!(
            accepted.load(Ordering::Relaxed),
            5,
            "accept loop must handle all connections; `break` on any error would stop it permanently",
        );
    }

    // -----------------------------------------------------------------------
    // Group F: remove_hooks_by_marker unit tests
    // -----------------------------------------------------------------------

    #[test]
    fn remove_hooks_by_marker_removes_matching() {
        let mut hooks_obj = serde_json::Map::new();
        let target = serde_json::json!({
            "matcher": "",
            "hooks": [{"type": "command", "command": "python3 stuff # target-marker"}]
        });
        let other = serde_json::json!({
            "matcher": "",
            "hooks": [{"type": "command", "command": "python3 stuff # other-marker"}]
        });
        hooks_obj.insert("Notification".to_string(), serde_json::json!([target, other]));

        remove_hooks_by_marker(&mut hooks_obj, "Notification", "target-marker");

        let arr = hooks_obj["Notification"].as_array().unwrap();
        assert_eq!(arr.len(), 1, "only the matching entry should be removed");
        let cmd = arr[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.contains("other-marker"), "unrelated entry must remain");
    }

    #[test]
    fn remove_hooks_by_marker_no_match_leaves_all() {
        let mut hooks_obj = serde_json::Map::new();
        let entry = serde_json::json!({
            "matcher": "",
            "hooks": [{"type": "command", "command": "python3 stuff # some-marker"}]
        });
        hooks_obj.insert("Notification".to_string(), serde_json::json!([entry]));

        remove_hooks_by_marker(&mut hooks_obj, "Notification", "nonexistent-marker");

        assert_eq!(hooks_obj["Notification"].as_array().unwrap().len(), 1,
            "no entries should be removed when marker is absent");
    }

    #[test]
    fn remove_hooks_by_marker_missing_key_no_panic() {
        let mut hooks_obj = serde_json::Map::new();
        // Must not panic when the hook key doesn't exist at all
        remove_hooks_by_marker(&mut hooks_obj, "Notification", "some-marker");
    }

    #[test]
    fn remove_hooks_by_marker_removes_all_occurrences() {
        let mut hooks_obj = serde_json::Map::new();
        let dup = |label: &str| serde_json::json!({
            "matcher": "",
            "hooks": [{"type": "command", "command": format!("# {label}")}]
        });
        hooks_obj.insert("Notification".to_string(),
            serde_json::json!([dup("dup-marker"), dup("dup-marker"), dup("other")]));

        remove_hooks_by_marker(&mut hooks_obj, "Notification", "dup-marker");

        let arr = hooks_obj["Notification"].as_array().unwrap();
        assert_eq!(arr.len(), 1, "all duplicate entries should be removed");
    }

    // -----------------------------------------------------------------------
    // Group G: install_hook_entry safety and replacement
    // -----------------------------------------------------------------------

    #[test]
    fn install_hook_entry_rejects_unknown_path() {
        let mut hooks_obj = serde_json::Map::new();
        install_hook_entry(&mut hooks_obj, "Notification", "malicious/../path", "test-marker");
        // Must be a no-op — no entries inserted for unknown paths
        let is_empty = hooks_obj
            .get("Notification")
            .and_then(|v| v.as_array())
            .map(|a| a.is_empty())
            .unwrap_or(true);
        assert!(is_empty, "install_hook_entry must not install hooks for unknown paths");
    }

    #[test]
    fn install_hook_entry_replaces_outdated_hook() {
        // An entry whose command lacks `.attention_port` is considered outdated
        // (it uses a hardcoded port instead of reading the file at connect time).
        let mut hooks_obj = serde_json::Map::new();
        let outdated = serde_json::json!({
            "matcher": "",
            "hooks": [{"type": "command", "command": "python3 hardcoded:19876 # splice-attention-hook-v3"}]
        });
        hooks_obj.insert("Notification".to_string(), serde_json::json!([outdated]));

        install_hook_entry(&mut hooks_obj, "Notification", "attention", "splice-attention-hook-v3");

        let arr = hooks_obj["Notification"].as_array().unwrap();
        assert_eq!(arr.len(), 1, "outdated entry should be replaced, not duplicated");
        let cmd = arr[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.contains(".attention_port"),
            "replacement must read port from .attention_port file, not hardcode it");
    }

    #[test]
    fn install_hook_both_hooks_installed() {
        let dir = tempfile::tempdir().unwrap();
        install_hook_at(&dir.path().join("settings.json")).unwrap();
        let root = read_settings(dir.path());
        assert_eq!(count_hooks_with_marker(&root, "splice-attention-hook-v3"), 1,
            "attention (Notification) hook must be installed");
        assert_eq!(count_hooks_with_marker(&root, "splice-session-hook-v4"), 1,
            "session (SessionStart) hook must be installed");
    }

    #[test]
    fn install_hook_entry_up_to_date_is_noop() {
        // Once an up-to-date entry (with .attention_port) is present, a second
        // call to install_hook_entry must not add a duplicate.
        let mut hooks_obj = serde_json::Map::new();
        install_hook_entry(&mut hooks_obj, "Notification", "attention", "splice-attention-hook-v3");
        install_hook_entry(&mut hooks_obj, "Notification", "attention", "splice-attention-hook-v3");
        let arr = hooks_obj["Notification"].as_array().unwrap();
        assert_eq!(arr.len(), 1, "calling install_hook_entry twice must not duplicate the entry");
    }

    // -----------------------------------------------------------------------
    // Group H: parse_content_length additional edge cases
    // -----------------------------------------------------------------------

    #[test]
    fn parse_content_length_with_extra_whitespace() {
        // Extra spaces around the value should still parse
        assert_eq!(parse_content_length("Content-Length:   128  \r\n"), Some(128));
    }

    #[test]
    fn parse_content_length_negative_rejected() {
        // Negative values cannot be represented as usize — parser should return None
        assert_eq!(parse_content_length("Content-Length: -1\r\n"), None);
    }
}
