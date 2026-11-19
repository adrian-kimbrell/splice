//! Outbound webhooks: named HTTPS endpoints Splice can POST a message to, such as
//! a Grok Bot routine with a webhook trigger. Stored in `webhooks.json` (owner-only)
//! in the Splice config dir, because each entry carries a secret.
//!
//! Requests are made by `curl`, which ships with macOS and every mainstream Linux:
//! no TLS stack is linked into Splice for a feature most launches never use. The
//! secret travels in a config stream on curl's stdin, never in argv, so it is not
//! visible in the process list.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const MAX_WEBHOOKS: usize = 20;
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const SEND_TIMEOUT_SECS: u32 = 20;

/// Which header carries the secret. Grok Bot guides disagree, so it is a choice.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum AuthStyle {
    /// `Authorization: Bearer <key>`
    #[default]
    Bearer,
    /// `X-Webhook-Secret: <key>`
    XWebhookSecret,
    /// No auth header (the URL itself is the secret).
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Webhook {
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub auth: AuthStyle,
}

/// What the UI and agents see: never the key.
#[derive(Debug, Clone, Serialize)]
pub struct WebhookSummary {
    pub name: String,
    /// Scheme and host only, so a secret embedded in the path stays private.
    pub host: String,
    pub auth: AuthStyle,
    pub has_key: bool,
}

#[derive(Default)]
pub struct Webhooks {
    pub hooks: Vec<Webhook>,
    path: Option<PathBuf>,
}

/// `https://host` of a URL, or the whole thing if it has no path.
pub fn origin_of(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else { return String::new() };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    // Drop userinfo if someone pasted credentials into the URL.
    let host = host.rsplit('@').next().unwrap_or(host);
    format!("{scheme}://{host}")
}

/// Only HTTPS leaves the machine. Plain HTTP is accepted for loopback so the
/// feature can be exercised against a local receiver.
pub fn validate_url(url: &str) -> Result<(), String> {
    if url.len() > 2048 || url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("the URL contains whitespace or is too long".into());
    }
    if let Some(rest) = url.strip_prefix("https://") {
        return if rest.is_empty() || rest.starts_with('/') { Err("the URL has no host".into()) } else { Ok(()) };
    }
    if let Some(rest) = url.strip_prefix("http://") {
        let host = rest.split(['/', '?', '#']).next().unwrap_or("");
        let host_only = host.rsplit('@').next().unwrap_or(host);
        let name = host_only.rsplit_once(':').map(|(h, _)| h).unwrap_or(host_only);
        if matches!(name, "127.0.0.1" | "localhost" | "[::1]") {
            return Ok(());
        }
        return Err("plain http is only allowed for 127.0.0.1 / localhost; use https".into());
    }
    Err("the URL must start with https://".into())
}

fn validate_name(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.len() <= 40
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ' ' | '.'));
    if ok { Ok(()) } else { Err("name must be 1-40 characters: letters, digits, space, - _ .".into()) }
}

impl Webhooks {
    pub fn load(path: &Path) -> Self {
        let hooks = std::fs::read_to_string(path)
            .ok()
            .and_then(|d| serde_json::from_str::<Vec<Webhook>>(&d).ok())
            .unwrap_or_default();
        Self { hooks, path: Some(path.to_path_buf()) }
    }

    fn save(&self) -> Result<(), String> {
        let Some(path) = &self.path else { return Ok(()) };
        let data = serde_json::to_string_pretty(&self.hooks).map_err(|e| e.to_string())?;
        super::write_private(path, data.as_bytes())
    }

    pub fn summaries(&self) -> Vec<WebhookSummary> {
        self.hooks
            .iter()
            .map(|h| WebhookSummary { name: h.name.clone(), host: origin_of(&h.url), auth: h.auth, has_key: !h.key.is_empty() })
            .collect()
    }

    pub fn find(&self, name: &str) -> Option<&Webhook> {
        self.hooks.iter().find(|h| h.name.eq_ignore_ascii_case(name.trim()))
    }

    /// Add or replace by name. An empty `key` on a replace keeps the stored one,
    /// so the UI can edit a URL without ever being shown the secret.
    pub fn upsert(&mut self, mut hook: Webhook) -> Result<(), String> {
        hook.name = hook.name.trim().to_string();
        hook.url = hook.url.trim().to_string();
        hook.key = hook.key.trim().to_string();
        validate_name(&hook.name)?;
        validate_url(&hook.url)?;
        if hook.key.len() > 512 || hook.key.chars().any(|c| c.is_control()) {
            return Err("the key contains control characters or is too long".into());
        }
        if let Some(existing) = self.hooks.iter_mut().find(|h| h.name.eq_ignore_ascii_case(&hook.name)) {
            if hook.key.is_empty() {
                hook.key = existing.key.clone();
            }
            *existing = hook;
        } else {
            if self.hooks.len() >= MAX_WEBHOOKS {
                return Err(format!("at most {MAX_WEBHOOKS} webhooks"));
            }
            self.hooks.push(hook);
        }
        self.save()
    }

    pub fn delete(&mut self, name: &str) -> Result<bool, String> {
        let before = self.hooks.len();
        self.hooks.retain(|h| !h.name.eq_ignore_ascii_case(name.trim()));
        let removed = before != self.hooks.len();
        if removed {
            self.save()?;
        }
        Ok(removed)
    }
}

/// Quote a value for a curl config file: backslash, quote and the control
/// characters curl gives a meaning to are escaped; everything else is literal.
fn curl_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The JSON body sent to the endpoint.
pub fn payload(message: &str, workspace: Option<&str>) -> String {
    serde_json::json!({
        "text": message,
        "source": "splice",
        "workspace": workspace,
    })
    .to_string()
}

/// The curl config for one send. Separate from `send` so it can be tested.
pub fn curl_config(hook: &Webhook, body: &str) -> String {
    let mut cfg = String::new();
    cfg.push_str(&format!("url = {}\n", curl_quote(&hook.url)));
    cfg.push_str("request = \"POST\"\n");
    cfg.push_str("header = \"Content-Type: application/json\"\n");
    cfg.push_str("header = \"User-Agent: Splice\"\n");
    if !hook.key.is_empty() {
        match hook.auth {
            AuthStyle::Bearer => cfg.push_str(&format!("header = {}\n", curl_quote(&format!("Authorization: Bearer {}", hook.key)))),
            AuthStyle::XWebhookSecret => cfg.push_str(&format!("header = {}\n", curl_quote(&format!("X-Webhook-Secret: {}", hook.key)))),
            AuthStyle::None => {}
        }
    }
    cfg.push_str(&format!("data-binary = {}\n", curl_quote(body)));
    cfg
}

#[derive(Debug, Clone, Serialize)]
pub struct SendOutcome {
    pub status: u16,
    /// First part of the response body, for the user to read.
    pub body: String,
}

/// POST `message` to `hook`. Blocking: call from a blocking thread.
pub fn send(hook: &Webhook, message: &str, workspace: Option<&str>) -> Result<SendOutcome, String> {
    if message.trim().is_empty() {
        return Err("message is empty".into());
    }
    if message.len() > MAX_MESSAGE_BYTES {
        return Err(format!("message is too large ({} bytes; the limit is {})", message.len(), MAX_MESSAGE_BYTES));
    }
    validate_url(&hook.url)?;
    let cfg = curl_config(hook, &payload(message, workspace));

    let mut child = Command::new("curl")
        .args([
            "--silent", "--show-error",
            "--max-time", &SEND_TIMEOUT_SECS.to_string(),
            "--proto", "=https,http",
            "--max-redirs", "0",
            "--write-out", "\n%{http_code}",
            "--config", "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run curl: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(cfg.as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("request failed: {}", err.trim().trim_start_matches("curl: ")));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let (body, code) = text.rsplit_once('\n').unwrap_or(("", text.as_ref()));
    let status: u16 = code.trim().parse().map_err(|_| "could not read the HTTP status".to_string())?;
    let body = super::inbox::truncate_bytes(body.trim(), 600).to_string();
    if (200..300).contains(&status) {
        Ok(SendOutcome { status, body })
    } else {
        Err(format!("the endpoint answered HTTP {status}{}", if body.is_empty() { String::new() } else { format!(": {body}") }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hook(url: &str) -> Webhook {
        Webhook { name: "grok".into(), url: url.into(), key: "s3cret".into(), auth: AuthStyle::Bearer }
    }

    #[test]
    fn only_https_or_loopback_http_urls_are_accepted() {
        assert!(validate_url("https://api.example.com/hook/abc").is_ok());
        assert!(validate_url("http://127.0.0.1:9000/x").is_ok());
        assert!(validate_url("http://localhost/x").is_ok());
        assert!(validate_url("http://example.com/x").is_err());
        assert!(validate_url("http://127.0.0.1.evil.com/x").is_err());
        assert!(validate_url("file:///etc/passwd").is_err());
        assert!(validate_url("https://").is_err());
        assert!(validate_url("https://a b").is_err());
        assert!(validate_url("https://a\n-o /tmp/x").is_err());
    }

    #[test]
    fn summaries_never_contain_the_key_or_the_path() {
        let mut w = Webhooks::default();
        w.upsert(hook("https://hooks.example.com/routine/SECRETPATH")).unwrap();
        let json = serde_json::to_string(&w.summaries()).unwrap();
        assert!(!json.contains("s3cret") && !json.contains("SECRETPATH"), "{json}");
        assert!(json.contains("https://hooks.example.com"));
        assert!(json.contains("\"has_key\":true"));
    }

    #[test]
    fn upsert_replaces_by_name_and_keeps_the_key_when_none_is_given() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("webhooks.json");
        let mut w = Webhooks::load(&p);
        w.upsert(hook("https://a.example.com/1")).unwrap();
        w.upsert(Webhook { name: "GROK".into(), url: "https://b.example.com/2".into(), key: String::new(), auth: AuthStyle::XWebhookSecret }).unwrap();
        let again = Webhooks::load(&p);
        assert_eq!(again.hooks.len(), 1);
        assert_eq!(again.hooks[0].url, "https://b.example.com/2");
        assert_eq!(again.hooks[0].key, "s3cret");
        assert_eq!(again.hooks[0].auth, AuthStyle::XWebhookSecret);
        assert!(again.find("grok").is_some());
    }

    #[test]
    fn bad_names_and_keys_are_rejected() {
        let mut w = Webhooks::default();
        assert!(w.upsert(Webhook { name: "a/b".into(), ..hook("https://x.example.com") }).is_err());
        assert!(w.upsert(Webhook { key: "a\nb".into(), ..hook("https://x.example.com") }).is_err());
        assert!(w.hooks.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("webhooks.json");
        let mut w = Webhooks::load(&p);
        w.upsert(hook("https://a.example.com/1")).unwrap();
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn curl_config_quotes_the_body_and_picks_the_auth_header() {
        let cfg = curl_config(&hook("https://a.example.com/1"), "{\"text\":\"line1\\nq\\\"x\"}");
        assert!(cfg.contains("header = \"Authorization: Bearer s3cret\""));
        assert!(cfg.contains(r#"data-binary = "{\"text\":\"line1\\nq\\\"x\"}""#), "{cfg}");
        let cfg = curl_config(&Webhook { auth: AuthStyle::XWebhookSecret, ..hook("https://a.example.com/1") }, "{}");
        assert!(cfg.contains("header = \"X-Webhook-Secret: s3cret\"") && !cfg.contains("Authorization"));
        let cfg = curl_config(&Webhook { auth: AuthStyle::None, ..hook("https://a.example.com/1") }, "{}");
        assert!(!cfg.contains("s3cret"));
    }

    /// End to end against a loopback receiver: the body and the secret header arrive.
    #[test]
    fn send_posts_json_with_the_secret_header() {
        use std::io::{Read, Write};
        if Command::new("curl").arg("--version").output().is_err() {
            return; // no curl on this machine
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = Vec::new();
            let mut tmp = [0u8; 4096];
            loop {
                let n = s.read(&mut tmp).unwrap();
                buf.extend_from_slice(&tmp[..n]);
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some(pos) = text.find("\r\n\r\n") {
                    let len: usize = text.lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap()))
                        .unwrap_or(0);
                    if buf.len() >= pos + 4 + len { break; }
                }
                if n == 0 { break; }
            }
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\naccepted").unwrap();
            String::from_utf8_lossy(&buf).to_string()
        });
        let h = hook(&format!("http://127.0.0.1:{port}/routine"));
        let out = send(&h, "research \"this\"\nplease", Some("proj")).unwrap();
        assert_eq!(out.status, 200);
        assert_eq!(out.body, "accepted");
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /routine "), "{request}");
        assert!(request.contains("Authorization: Bearer s3cret"));
        let body = request.split("\r\n\r\n").nth(1).unwrap();
        let v: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(v["text"], "research \"this\"\nplease");
        assert_eq!(v["source"], "splice");
        assert_eq!(v["workspace"], "proj");
    }
}
