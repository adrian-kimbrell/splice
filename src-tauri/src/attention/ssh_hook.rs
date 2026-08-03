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

/// Install (or refresh) the remote attention hook over an existing SSH session.
/// Best-effort: returns Err if the remote lacks python3 or `~/.claude` isn't writable.
pub(crate) async fn install_on_session(session: &openssh::Session) -> Result<String, String> {
    let src_b64 = base64::engine::general_purpose::STANDARD.encode(installer_source());
    // base64 output is shell-safe inside single quotes; decode it remotely and pipe
    // to python3. Mirrors the printf | base64 --decode pattern used for SFTP writes.
    let remote = format!("printf '%s' '{src_b64}' | base64 --decode | python3");
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
