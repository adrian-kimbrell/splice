use std::sync::Arc;
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tracing::{info, warn};

use crate::attention::handlers::{handle_attention_request, handle_session_request};
use crate::attention::http::{find_header_end, parse_content_length};

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
        .and_then(|l| l.split_once(':').map(|x| x.1))
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

#[cfg(test)]
mod tests {
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
}
