//! Installs a Claude Code `Notification` hook on a *remote* host so a Claude
//! running there over SSH can raise a Splice attention notification.
//!
//! The local hook POSTs to Splice's attention server on `127.0.0.1` — unreachable
//! from a remote box. Instead, the remote hook emits an **OSC 7379** escape to the
//! controlling tty. That escape rides the SSH connection back as ordinary terminal
//! output, where Splice's emulator (`terminal::term::osc_dispatch`) parses it and
//! calls `attention::dispatch_attention` with the local terminal id. No ports,
//! tunnels, tokens, or env forwarding — it works over any SSH, including jump hosts.
//!
//! Install is best-effort and idempotent (marker-based), run over the workspace's
//! existing `openssh::Session`. We base64-encode both the hook command and the
//! installer script so nothing needs shell-quoting on the remote.

use base64::Engine;

pub(crate) const MARKER: &str = "splice-ssh-attention-v1";

/// The remote `Notification` hook command. Reads Claude's hook JSON on stdin,
/// classifies permission vs. idle from the message, and writes an OSC 7379 escape
/// (`ESC ] 7379 ; <type> ; <base64 message> BEL`) to `/dev/tty`. Uses `chr()` so
/// there are no backslashes to escape through shells and JSON.
pub(crate) const REMOTE_HOOK_COMMAND: &str = r#"python3 -c "import sys,json,base64;d=json.load(sys.stdin);m=str(d.get('message',''));t='permission' if 'permission' in m.lower() else 'idle';b=base64.b64encode(m.encode()).decode();f=open('/dev/tty','w');f.write(chr(27)+']7379;'+t+';'+b+chr(7));f.flush()" # splice-ssh-attention-v1"#;

/// Python program (run on the remote) that merges the hook command into
/// `~/.claude/settings.json` under `hooks.Notification`, idempotently.
fn installer_source() -> String {
    let hook_b64 = base64::engine::general_purpose::STANDARD.encode(REMOTE_HOOK_COMMAND);
    format!(
        r#"import json, os, os.path as op, base64
cmd = base64.b64decode("{hook_b64}").decode()
marker = "{marker}"
cdir = op.join(op.expanduser("~"), ".claude")
os.makedirs(cdir, exist_ok=True)
path = op.join(cdir, "settings.json")
try:
    data = json.load(open(path))
    if not isinstance(data, dict):
        data = {{}}
except Exception:
    data = {{}}
hooks = data.get("hooks")
if not isinstance(hooks, dict):
    hooks = {{}}
    data["hooks"] = hooks
arr = hooks.get("Notification")
if not isinstance(arr, list):
    arr = []
    hooks["Notification"] = arr
def has_marker(e):
    try:
        return any(marker in h.get("command", "") for h in e.get("hooks", []))
    except Exception:
        return False
arr[:] = [e for e in arr if not has_marker(e)]
arr.append({{"matcher": "", "hooks": [{{"type": "command", "command": cmd}}]}})
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(data, f, indent=2)
os.replace(tmp, path)
print("splice-ssh-attention installed")
"#,
        hook_b64 = hook_b64,
        marker = MARKER,
    )
}

/// The exact shell command run on the remote to install the hook. base64 output
/// is shell-safe inside single quotes; decode it remotely and pipe to python3.
/// Mirrors the printf | base64 --decode pattern used for SFTP writes.
fn remote_install_command() -> String {
    let src_b64 = base64::engine::general_purpose::STANDARD.encode(installer_source());
    format!("printf '%s' '{src_b64}' | base64 --decode | python3")
}

/// Install (or refresh) the remote attention hook over an existing SSH session.
/// Best-effort: returns Err if the remote lacks python3 or `~/.claude` isn't writable.
pub(crate) async fn install_on_session(session: &openssh::Session) -> Result<String, String> {
    let remote = remote_install_command();
    let out = session
        .command("sh")
        .args(["-c", remote.as_str()])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(format!(
            "remote installer failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Dump the byte-exact remote install command (what `install_on_session` sends)
    /// to a file, for driving a real over-SSH round-trip test. No-op unless the env
    /// var is set, so normal test runs are unaffected.
    #[test]
    fn dump_remote_install_command() {
        if let Ok(path) = std::env::var("SPLICE_DUMP_INSTALL_CMD") {
            std::fs::write(path, remote_install_command()).unwrap();
        }
    }

    /// Drive the *actual* generated installer through real python3 against a
    /// throwaway HOME, exactly as it would run on a remote. Verifies it writes a
    /// valid Notification hook and doesn't duplicate on reinstall (idempotent).
    #[test]
    fn installer_writes_idempotent_notification_hook() {
        let tmp = std::env::temp_dir().join(format!("splice-sshhook-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let run = || {
            std::process::Command::new("python3")
                .arg("-c")
                .arg(installer_source())
                .env("HOME", &tmp)
                .output()
                .expect("python3 must be available to run the installer")
        };

        let o1 = run();
        assert!(o1.status.success(), "installer failed: {}", String::from_utf8_lossy(&o1.stderr));

        let settings_path = tmp.join(".claude").join("settings.json");
        let raw = std::fs::read_to_string(&settings_path).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let arr = v["hooks"]["Notification"].as_array().unwrap();
        let marker_entries = || {
            arr.iter()
                .filter(|e| serde_json::to_string(e).unwrap().contains(MARKER))
                .count()
        };
        assert_eq!(marker_entries(), 1, "should install exactly one hook entry");
        assert!(raw.contains("7379"), "hook command must emit OSC 7379");

        // Reinstall: must not duplicate.
        run();
        let raw2 = std::fs::read_to_string(&settings_path).unwrap();
        let v2: serde_json::Value = serde_json::from_str(&raw2).unwrap();
        let count = v2["hooks"]["Notification"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| serde_json::to_string(e).unwrap().contains(MARKER))
            .count();
        assert_eq!(count, 1, "reinstall must be idempotent");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Preserve unrelated existing hooks and settings when merging.
    #[test]
    fn installer_preserves_existing_settings() {
        let tmp = std::env::temp_dir().join(format!("splice-sshhook-pre-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join(".claude")).unwrap();
        std::fs::write(
            tmp.join(".claude").join("settings.json"),
            r#"{"model":"opus","hooks":{"Notification":[{"matcher":"","hooks":[{"type":"command","command":"echo other"}]}]}}"#,
        )
        .unwrap();

        let out = std::process::Command::new("python3")
            .arg("-c")
            .arg(installer_source())
            .env("HOME", &tmp)
            .output()
            .expect("python3 available");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(tmp.join(".claude").join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(v["model"], "opus", "unrelated settings must be preserved");
        let arr = v["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(arr.len(), 2, "existing hook kept + ours added");
        assert!(arr.iter().any(|e| serde_json::to_string(e).unwrap().contains("echo other")));
        assert!(arr.iter().any(|e| serde_json::to_string(e).unwrap().contains(MARKER)));

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
