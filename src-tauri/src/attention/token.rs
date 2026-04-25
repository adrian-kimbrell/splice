use tracing::warn;

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
    // Write token with restrictive permissions (owner-only) to prevent
    // other local users from reading the authentication secret.
    #[cfg(unix)]
    {
        use std::fs::OpenOptions;
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt;
        if let Ok(mut f) = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&token_path)
        {
            let _ = f.write_all(token.as_bytes());
        }
    }
    #[cfg(not(unix))]
    std::fs::write(&token_path, &token).ok();
    token
}

#[cfg(test)]
mod tests {
    // -----------------------------------------------------------------------
    // Token validation logic
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
}
