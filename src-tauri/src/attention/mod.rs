use std::collections::HashMap;
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

static PS_SEMAPHORE: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
fn ps_semaphore() -> &'static tokio::sync::Semaphore {
    PS_SEMAPHORE.get_or_init(|| tokio::sync::Semaphore::new(1))
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
                                warn!("Attention server accept error: {}", e);
                                break;
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
    let claude_pid = match json.get("claude_pid").and_then(|v| v.as_u64()) {
        Some(p) => p as u32,
        None => {
            warn!("attention request missing claude_pid");
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

    if let Some(terminal_id) = find_terminal_by_ancestor_pid(app, claude_pid).await {
        let event = AttentionEvent {
            terminal_id,
            notification_type,
            message,
        };
        if let Err(e) = app.emit("attention:notify", &event) {
            warn!("Failed to emit attention:notify: {}", e);
        } else {
            info!(terminal_id, "Emitted attention:notify");
        }
    } else {
        warn!(claude_pid, "Could not find terminal for Claude PID");
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

    let claude_pid = match json.get("claude_pid").and_then(|v| v.as_u64()) {
        Some(p) => p as u32,
        None => {
            warn!("session request missing claude_pid");
            return;
        }
    };

    match find_terminal_by_ancestor_pid(app, claude_pid).await {
        Some(terminal_id) => {
            let state = app.state::<Mutex<AppState>>();
            if let Ok(mut locked) = state.lock() {
                locked
                    .terminal_claude_sessions
                    .insert(terminal_id, (session_id.clone(), claude_pid));
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
        None => warn!(claude_pid, "Could not find terminal for Claude session"),
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

async fn find_terminal_by_ancestor_pid(app: &AppHandle, claude_pid: u32) -> Option<u32> {
    // Fast path: check the pid→terminal cache first
    {
        let state = app.state::<Mutex<AppState>>();
        if let Ok(mut locked) = state.lock() {
            if let Some(&tid) = locked.pid_to_terminal_cache.get(&claude_pid) {
                if locked.terminals.contains_key(&tid) {
                    return Some(tid);
                }
                // Stale entry (terminal exited) — evict and fall through to ps lookup
                locked.pid_to_terminal_cache.remove(&claude_pid);
            }
        };
    }

    // Acquire permit — limits concurrent ps invocations to 1
    let _permit = ps_semaphore().acquire().await.ok()?;

    // Re-check cache: may have been populated while we waited for the permit
    {
        let state = app.state::<Mutex<AppState>>();
        if let Ok(mut locked) = state.lock() {
            if let Some(&tid) = locked.pid_to_terminal_cache.get(&claude_pid) {
                if locked.terminals.contains_key(&tid) {
                    return Some(tid);
                }
                // Stale entry — evict and continue to ps lookup
                locked.pid_to_terminal_cache.remove(&claude_pid);
            }
        };
    }

    // Cache still cold — build pid→ppid map from `ps`
    let output = tokio::process::Command::new("ps")
        .args(["-ax", "-o", "pid=,ppid="])
        .output()
        .await
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let pid_map: HashMap<u32, u32> = stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid: u32 = parts.next()?.parse().ok()?;
            let ppid: u32 = parts.next()?.parse().ok()?;
            Some((pid, ppid))
        })
        .collect();

    // Collect child_pids from known terminals
    let terminal_pids: HashMap<u32, u32> = {
        let state = app.state::<Mutex<AppState>>();
        let locked = state.lock().ok()?;
        locked
            .terminals
            .iter()
            .filter_map(|(&tid, session)| session.child_pid.map(|pid| (pid, tid)))
            .collect()
    };

    // Walk up the process tree from claude_pid
    let mut current = claude_pid;
    let mut result = None;
    for _ in 0..20 {
        if let Some(&terminal_id) = terminal_pids.get(&current) {
            result = Some(terminal_id);
            break;
        }
        match pid_map.get(&current) {
            Some(&ppid) if ppid != 0 && ppid != current => current = ppid,
            _ => break,
        }
    }

    // Store result in cache and evict dead PIDs while we hold the lock
    {
        let state = app.state::<Mutex<AppState>>();
        if let Ok(mut locked) = state.lock() {
            if let Some(terminal_id) = result {
                locked.pid_to_terminal_cache.insert(claude_pid, terminal_id);
            }
            // Evict cached PIDs that no longer exist in the process table
            locked.pid_to_terminal_cache.retain(|pid, _| pid_map.contains_key(pid));
        };
    }

    result
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
    let command = format!(
        "python3 -c \"import sys,json,urllib.request,os,os.path as op\n\
         d=json.load(sys.stdin)\n\
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

    // Create parent dir if needed
    if let Some(parent) = settings_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Read existing JSON or start with {}
    let mut root: serde_json::Value = if settings_path.exists() {
        let content = std::fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
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

    // Clean up old "malloc-*-hook" entries from before the rename
    remove_hooks_by_marker(hooks_obj, "Notification", "malloc-attention-hook");
    remove_hooks_by_marker(hooks_obj, "SessionStart", "malloc-session-hook");
    remove_hooks_by_marker(hooks_obj, "SessionStart", "splice-session-hook");

    install_hook_entry(hooks_obj, "Notification", "attention", "splice-attention-hook");
    install_hook_entry(hooks_obj, "SessionStart", "session", "splice-session-hook-v2");
    info!("Splice hooks configured in ~/.claude/settings.json");

    let updated = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    // Atomic write: write to a temp file then rename to avoid racing with Claude itself
    let tmp = settings_path.with_extension("json.tmp");
    std::fs::write(&tmp, updated).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &settings_path).map_err(|e| e.to_string())?;

    Ok(())
}
