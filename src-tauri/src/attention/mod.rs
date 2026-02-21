use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tracing::{info, warn};

use crate::state::AppState;

#[derive(serde::Serialize, Clone)]
struct AttentionEvent {
    terminal_id: u32,
    notification_type: String,
    message: String,
}

pub async fn start_server(app: AppHandle) -> u16 {
    for port in [9876u16, 9877, 9878] {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => {
                info!(port, "Attention server listening");
                let app_clone = app.clone();
                tokio::spawn(async move {
                    loop {
                        match listener.accept().await {
                            Ok((stream, _)) => {
                                let app = app_clone.clone();
                                tokio::spawn(handle_connection(stream, app));
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
    warn!("Could not bind attention server on ports 9876-9878");
    0
}

async fn handle_connection(mut stream: TcpStream, app: AppHandle) {
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

    // Parse Content-Length
    let header_str = match std::str::from_utf8(&buf[..header_end]) {
        Ok(s) => s,
        Err(_) => return,
    };

    let content_length = parse_content_length(header_str).unwrap_or(0);
    if content_length == 0 || content_length > 65536 {
        let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
        return;
    }

    // We already have some body bytes after the header
    let body_start = header_end + 4; // skip \r\n\r\n
    let already_read = buf.len().saturating_sub(body_start);
    let mut body = buf[body_start..].to_vec();

    // Read remaining body bytes
    let remaining = content_length.saturating_sub(already_read);
    if remaining > 0 {
        let mut rest = vec![0u8; remaining];
        if stream.read_exact(&mut rest).await.is_err() {
            return;
        }
        body.extend_from_slice(&rest);
    }

    // Parse JSON body
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(&body) else {
        let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
        return;
    };

    let claude_pid = match json.get("claude_pid").and_then(|v| v.as_u64()) {
        Some(p) => p as u32,
        None => {
            let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
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

    // Respond immediately so Claude isn't blocked
    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").await;

    // Find which terminal this Claude belongs to
    if let Some(terminal_id) = find_terminal_by_ancestor_pid(&app, claude_pid).await {
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
    // Build pid→ppid map from `ps`
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
    for _ in 0..20 {
        if let Some(&terminal_id) = terminal_pids.get(&current) {
            return Some(terminal_id);
        }
        match pid_map.get(&current) {
            Some(&ppid) if ppid != 0 && ppid != current => current = ppid,
            _ => break,
        }
    }

    None
}

pub fn install_hook(port: u16) -> Result<(), String> {
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

    // Navigate/create hooks.Notification array
    let hooks_obj = root
        .as_object_mut()
        .ok_or("settings.json root is not an object")?
        .entry("hooks")
        .or_insert(serde_json::json!({}))
        .as_object_mut()
        .ok_or("hooks is not an object")?
        .entry("Notification")
        .or_insert(serde_json::json!([]))
        .as_array_mut()
        .ok_or("hooks.Notification is not an array")?;

    // Idempotency check: look for our hook marker
    let marker = "splice-attention-hook";
    let already_installed = hooks_obj.iter().any(|entry| {
        entry
            .get("hooks")
            .and_then(|h| h.as_array())
            .map(|arr| {
                arr.iter().any(|hook| {
                    hook.get("command")
                        .and_then(|c| c.as_str())
                        .map(|s| s.contains(marker))
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false)
    });

    if already_installed {
        return Ok(());
    }

    let command = format!(
        "python3 -c \"import sys,json,urllib.request,os; d=json.load(sys.stdin); d['claude_pid']=os.getppid(); urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:{port}/attention',json.dumps(d).encode(),{{'Content-Type':'application/json'}}),timeout=2)\" # {marker}"
    );

    let hook_entry = serde_json::json!({
        "matcher": "",
        "hooks": [{
            "type": "command",
            "command": command
        }]
    });

    hooks_obj.push(hook_entry);

    let updated = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&settings_path, updated).map_err(|e| e.to_string())?;

    info!(port, "Installed Splice attention hook in ~/.claude/settings.json");
    Ok(())
}
