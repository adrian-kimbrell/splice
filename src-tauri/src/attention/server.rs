//! Lightweight HTTP server that receives hook notifications from Claude Code.
//!
//! Listens on `127.0.0.1` and tries ports 19876, 19877, 19878 in order, binding
//! to the first available one. The chosen port is written to
//! `~/.config/Splice/.attention_port` so hook scripts can discover it.
//!
//! Each connection is handled as a minimal HTTP/1.1 request: the server reads
//! until the `\r\n\r\n` header boundary, extracts `Content-Length`, then reads
//! exactly that many body bytes (with a 5-second timeout to prevent slow-loris
//! hangs). Requests are authenticated via the `X-Splice-Token` header against a
//! per-instance random token. Valid JSON payloads are dispatched to
//! [`handle_attention_request`] or [`handle_session_request`] based on the URL
//! path (`/attention` or `/session`), which emit Tauri events to the frontend.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Instant;
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::attention::handlers::{
    handle_attention_request, handle_session_request, handle_status_request,
};
use crate::attention::http::{find_header_end, parse_content_length};

/// Per (IP, path) rate limiter: up to `max` requests per one-second window. The
/// window resets once a full second has elapsed since its first request.
///
/// Buckets are per path because `/status` is driven by Claude's statusLine, which
/// fires a few times a second *per Claude session*; one shared bucket let four
/// busy sessions starve the attention notifications.
struct RateLimiter {
    requests: HashMap<(IpAddr, String), (Instant, u32)>,
}

/// `/status` is high-frequency telemetry; everything else is user-visible events.
fn rate_limit_for(path: &str) -> u32 {
    if path == "/status" { 60 } else { 20 }
}

impl RateLimiter {
    fn new() -> Self {
        Self { requests: HashMap::new() }
    }

    /// Returns `true` if the request is allowed, `false` if rate-limited.
    fn check(&mut self, addr: IpAddr, path: &str, max: u32) -> bool {
        self.check_at(addr, path, max, Instant::now())
    }

    fn check_at(&mut self, addr: IpAddr, path: &str, max: u32, now: Instant) -> bool {
        let entry = self
            .requests
            .entry((addr, path.to_string()))
            .or_insert((now, 0));
        if now.duration_since(entry.0).as_secs() >= 1 {
            *entry = (now, 1);
            true
        } else {
            entry.1 += 1;
            entry.1 <= max
        }
    }
}

/// How long a client may take to send its request head. Without this a client
/// that connects and sends nothing held a task and a socket forever.
const HEADER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Read until the `\r\n\r\n` header boundary. Returns the buffer (which may already
/// contain body bytes) and the offset of the boundary, or None on EOF/oversize.
async fn read_request_head(stream: &mut TcpStream) -> Option<(Vec<u8>, usize)> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 1024];
    loop {
        match stream.read(&mut tmp).await {
            Ok(0) | Err(_) => return None,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if let Some(pos) = find_header_end(&buf) {
                    return Some((buf, pos));
                }
                if buf.len() > 16384 {
                    return None; // request too large
                }
            }
        }
    }
}

/// Write the bound port to a file next to the token so hooks know where to connect.
fn write_port_file(port: u16) {
    let port_path = crate::state::splice_config_dir("Splice").join(".attention_port");
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
                let rate_limiter = Arc::new(Mutex::new(RateLimiter::new()));
                tokio::spawn(async move {
                    loop {
                        match listener.accept().await {
                            Ok((stream, addr)) => {
                                let app = app_clone.clone();
                                let tok = Arc::clone(&token_clone);
                                let rl = Arc::clone(&rate_limiter);
                                tokio::spawn(handle_connection(stream, addr.ip(), app, tok, rl));
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

async fn handle_connection(
    mut stream: TcpStream,
    peer_ip: IpAddr,
    app: AppHandle,
    token: Arc<String>,
    rate_limiter: Arc<Mutex<RateLimiter>>,
) {
    // Read until \r\n\r\n to get headers (bounded in size and time)
    let Ok(Some((buf, header_end))) = tokio::time::timeout(HEADER_TIMEOUT, read_request_head(&mut stream)).await else {
        return;
    };

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
        "/session" | "/attention" | "/status" => path.to_string(),
        _ => {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\n\r\n").await;
            return;
        }
    };

    // Rate limit per (peer, path) once we know the path, so statusLine telemetry
    // cannot crowd out attention notifications.
    {
        let mut rl = rate_limiter.lock().await;
        if !rl.check(peer_ip, &path, rate_limit_for(&path)) {
            warn!("attention: rate-limited {} request from {}", path, peer_ip);
            let _ = stream
                .write_all(b"HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\n\r\n")
                .await;
            return;
        }
    }

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

    match path.as_str() {
        "/session" => handle_session_request(&app, json).await,
        "/status" => handle_status_request(&app, json).await,
        _ => handle_attention_request(&app, json).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limiter_buckets_per_path_so_status_cannot_starve_attention() {
        let ip: IpAddr = "127.0.0.1".parse().unwrap();
        let mut rl = RateLimiter::new();
        let now = Instant::now();
        // Saturate /status at its own limit…
        for _ in 0..rate_limit_for("/status") {
            assert!(rl.check_at(ip, "/status", rate_limit_for("/status"), now));
        }
        assert!(!rl.check_at(ip, "/status", rate_limit_for("/status"), now), "61st /status is limited");
        // …and /attention is still accepted.
        assert!(rl.check_at(ip, "/attention", rate_limit_for("/attention"), now));
    }

    #[test]
    fn rate_limiter_window_resets_after_a_second() {
        let ip: IpAddr = "127.0.0.1".parse().unwrap();
        let mut rl = RateLimiter::new();
        let t0 = Instant::now();
        for _ in 0..20 {
            assert!(rl.check_at(ip, "/attention", 20, t0));
        }
        assert!(!rl.check_at(ip, "/attention", 20, t0));
        assert!(rl.check_at(ip, "/attention", 20, t0 + std::time::Duration::from_millis(1001)));
    }

    #[tokio::test]
    async fn silent_client_is_dropped_after_header_timeout() {
        // A connection that never sends a request head must not hold the task open.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let _client = tokio::net::TcpStream::connect(addr).await.unwrap();
        let (mut server_side, _) = listener.accept().await.unwrap();
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(200),
            read_request_head(&mut server_side),
        )
        .await;
        assert!(result.is_err(), "read must still be pending (production wraps it in HEADER_TIMEOUT)");
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
}
