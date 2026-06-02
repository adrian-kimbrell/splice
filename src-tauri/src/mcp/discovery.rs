//! Persists the chosen port + bearer token to a discovery file so external MCP clients
//! (Claude Code, Cursor, custom scripts) can locate the running Splice instance.
//!
//! Written at `~/.config/Splice/mcp.json`:
//! ```json
//! { "url": "http://127.0.0.1:19880/mcp", "token": "<hex>", "port": 19880 }
//! ```
//!
//! Token entropy comes from `/dev/urandom` on Unix (same approach as
//! `attention::token`), with a time+pid fallback on non-Unix targets.

use std::path::PathBuf;

fn discovery_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Splice")
        .join("mcp.json")
}

fn token_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Splice")
        .join(".mcp_token")
}

pub fn write(port: u16, token: &str) {
    let path = discovery_path();
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).ok(); }
    let payload = serde_json::json!({
        "url": format!("http://127.0.0.1:{}/mcp", port),
        "token": token,
        "port": port,
    });
    std::fs::write(&path, payload.to_string()).ok();
    tracing::info!(path = %path.display(), port, "Wrote MCP discovery file");
}

/// Loads or generates a stable 128-bit hex token persisted under `~/.config/Splice/`.
/// Mirrors `crate::attention::token::load_or_create_token` so we don't pull `rand`.
pub fn load_or_create_token() -> String {
    let path = token_path();
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let t = existing.trim().to_string();
        if t.len() == 32 && t.chars().all(|c| c.is_ascii_hexdigit()) {
            return t;
        }
    }
    let mut bytes = [0u8; 16];
    #[cfg(unix)]
    {
        use std::io::Read;
        if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
            if f.read_exact(&mut bytes).is_err() {
                let nanos = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .subsec_nanos();
                let t = nanos.to_le_bytes();
                for (b, &n) in bytes.iter_mut().zip(t.iter().cycle()) { *b ^= n; }
            }
        }
    }
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
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).ok(); }
    #[cfg(unix)]
    {
        use std::fs::OpenOptions;
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt;
        if let Ok(mut f) = OpenOptions::new()
            .write(true).create(true).truncate(true).mode(0o600).open(&path)
        {
            let _ = f.write_all(token.as_bytes());
        }
    }
    #[cfg(not(unix))]
    std::fs::write(&path, &token).ok();
    token
}
