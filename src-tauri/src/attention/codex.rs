//! OpenAI Codex integration: the same attention / session / status bridge the
//! Claude hooks provide, wired through Codex's two extension points.
//!
//! - `notify` in `~/.codex/config.toml` runs a program after every turn with the
//!   event JSON as an argument (`agent-turn-complete`, with `thread-id` and
//!   `last-assistant-message`). It needs no trust step, so "done, waiting for you"
//!   and session tracking (for `codex resume` on restore) work out of the box.
//! - Hooks in `~/.codex/hooks.json` (`SessionStart`, `PermissionRequest`, `Stop`)
//!   add permission prompts and the model name. Codex only runs hooks the user has
//!   trusted once via `/hooks` in its TUI; until then they are simply skipped.
//!
//! Both point at one Python helper written under `~/.codex/splice-hooks/`. Codex
//! passes the terminal's environment through, so the helper finds this instance via
//! `SPLICE_TERMINAL_ID` / `SPLICE_ATTENTION_PORT` / `SPLICE_ATTENTION_TOKEN`
//! exactly like the Claude hook. Nothing is installed when `~/.codex` does not
//! exist (the user does not use Codex) or when the config dir is sandboxed.

use tracing::{info, warn};

/// Marker every Splice-managed Codex entry contains, used to find and replace them.
pub(crate) const SCRIPT_NAME: &str = "splice_codex_hook.py";

const CODEX_HOOK_SCRIPT: &str = r#"#!/usr/bin/env python3
# Splice <-> OpenAI Codex bridge. Auto-generated; do not edit (overwritten on launch).
# Invoked two ways:
#   notify  - config.toml `notify`: the event JSON is the last argv entry
#   hook    - hooks.json command hooks: the event JSON arrives on stdin
# Prints nothing and exits 0, so Codex never waits on or reacts to it.
import sys, json, os, os.path as op, urllib.request

def read_cfg(name):
    for cd in [op.join(op.expanduser('~'), 'Library', 'Application Support', 'Splice'),
               op.join(op.expanduser('~'), '.config', 'Splice')]:
        try:
            return open(op.join(cd, name)).read().strip()
        except Exception:
            pass
    return ''

def main():
    try:
        tid = int(os.environ.get('SPLICE_TERMINAL_ID', '0') or 0)
    except Exception:
        tid = 0
    if tid <= 0:
        return  # not inside a Splice terminal
    token = os.environ.get('SPLICE_ATTENTION_TOKEN', '') or read_cfg('.attention_token')
    port = os.environ.get('SPLICE_ATTENTION_PORT', '') or read_cfg('.attention_port')
    if not port:
        return

    def post(path, payload):
        payload['terminal_id'] = tid
        payload['agent'] = 'codex'
        for attempt in range(2):
            try:
                req = urllib.request.Request(
                    'http://127.0.0.1:%s/%s' % (port, path),
                    json.dumps(payload).encode(),
                    {'Content-Type': 'application/json', 'X-Splice-Token': token})
                urllib.request.urlopen(req, timeout=0.5).read()
                return
            except Exception:
                if attempt == 0:
                    import time; time.sleep(0.3)

    # notify: `codex` appends the event JSON as the final argument.
    if len(sys.argv) > 1 and sys.argv[-1].lstrip().startswith('{'):
        try:
            ev = json.loads(sys.argv[-1])
        except Exception:
            return
        if ev.get('type') == 'agent-turn-complete':
            sid = ev.get('thread-id')
            if sid:
                post('session', {'session_id': sid, 'claude_pid': os.getppid()})
            post('attention', {'notification_type': 'idle_prompt',
                               'message': (ev.get('last-assistant-message') or '')[:200]})
        return

    # hook: event JSON on stdin.
    try:
        ev = json.load(sys.stdin)
    except Exception:
        return
    name = ev.get('hook_event_name')
    sid = ev.get('session_id')
    model = ev.get('model')
    if model:
        post('status', {'model': {'display_name': model}})
    if name == 'SessionStart' and sid:
        post('session', {'session_id': sid, 'claude_pid': os.getppid()})
    elif name == 'PermissionRequest':
        ti = ev.get('tool_input') or {}
        msg = ti.get('description') or ti.get('command') or ev.get('tool_name') or 'approval needed'
        if isinstance(msg, list):
            msg = ' '.join(str(m) for m in msg)
        post('attention', {'notification_type': 'permission_prompt', 'message': str(msg)[:200]})

try:
    main()
except Exception:
    pass
"#;

/// Install the Codex bridge for the real `~/.codex`. A sandboxed instance (E2E
/// harness) never touches the user's files; a machine without `~/.codex` is left
/// alone so Splice does not create Codex config for a tool the user does not have.
pub fn install_codex_integration() -> Result<(), String> {
    if crate::state::config_dir_is_sandboxed() {
        info!("SPLICE_CONFIG_DIR is set; skipping Codex integration install");
        return Ok(());
    }
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let codex_home = home.join(".codex");
    if !codex_home.is_dir() {
        return Ok(());
    }
    install_codex_at(&codex_home).map(|_| ())
}

/// Install into an arbitrary Codex home (tests use a temp dir). Returns true when
/// any file was written.
pub fn install_codex_at(codex_home: &std::path::Path) -> Result<bool, String> {
    let script_path = write_script(codex_home)?;
    let notify_changed = install_notify(&codex_home.join("config.toml"), &script_path)?;
    let hooks_changed = install_hooks(&codex_home.join("hooks.json"), &script_path)?;
    if notify_changed || hooks_changed {
        info!("Splice Codex integration configured in ~/.codex");
    }
    Ok(notify_changed || hooks_changed)
}

fn atomic_write(path: &std::path::Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Write the helper next to the Codex config; only touched when its content changed.
fn write_script(codex_home: &std::path::Path) -> Result<String, String> {
    let dir = codex_home.join("splice-hooks");
    let script = dir.join(SCRIPT_NAME);
    let current = std::fs::read(&script).ok();
    if current.as_deref() != Some(CODEX_HOOK_SCRIPT.as_bytes()) {
        atomic_write(&script, CODEX_HOOK_SCRIPT)?;
    }
    Ok(script.to_string_lossy().into_owned())
}

/// The `notify` line. Codex runs this argv directly (no shell), so the python3 guard
/// (Xcode's stub would open an install dialog on every turn) lives in a `sh -c`
/// wrapper: `$0` is the script path and `$1` the event JSON Codex appends.
pub(crate) fn notify_line(script_path: &str) -> String {
    format!(
        "notify = [\"/bin/sh\", \"-c\", \"if [ -n \\\"$SPLICE_TERMINAL_ID\\\" ] && command -v python3 >/dev/null 2>&1; then exec python3 \\\"$0\\\" \\\"$1\\\"; fi\", \"{script_path}\"]"
    )
}

/// Add or refresh the top-level `notify` key in `config.toml`. A `notify` the user
/// set themselves is left untouched; an unparsable file is never rewritten.
pub(crate) fn install_notify(config_path: &std::path::Path, script_path: &str) -> Result<bool, String> {
    let original = if config_path.exists() {
        std::fs::read_to_string(config_path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    let wanted = notify_line(script_path);

    // TOML: top-level keys must precede the first `[table]` header.
    let lines: Vec<&str> = original.lines().collect();
    let first_table = lines.iter().position(|l| l.trim_start().starts_with('['));
    let top_level = &lines[..first_table.unwrap_or(lines.len())];
    let existing = top_level.iter().position(|l| {
        let t = l.trim_start();
        t.starts_with("notify") && t[6..].trim_start().starts_with('=')
    });

    let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    match existing {
        Some(i) if lines[i].contains(SCRIPT_NAME) => {
            if lines[i].trim() == wanted {
                return Ok(false);
            }
            out[i] = wanted;
        }
        Some(_) => {
            info!("Leaving the user's own Codex `notify` setting untouched");
            return Ok(false);
        }
        None => {
            let at = first_table.unwrap_or(out.len());
            out.insert(at, wanted);
            if first_table.is_some() {
                out.insert(at + 1, String::new()); // keep a blank line before the table
            }
        }
    }
    let mut text = out.join("\n");
    if !text.ends_with('\n') {
        text.push('\n');
    }
    atomic_write(config_path, &text)?;
    Ok(true)
}

/// Hook command with the same guard as the Claude hooks: outside Splice, or on a
/// Mac whose python3 is the Xcode stub, do nothing.
fn hook_command(script_path: &str) -> String {
    format!(
        "if [ -n \"$SPLICE_TERMINAL_ID\" ] && command -v python3 >/dev/null 2>&1; then python3 \"{script_path}\"; fi"
    )
}

const HOOK_EVENTS: [&str; 3] = ["SessionStart", "PermissionRequest", "Stop"];

/// Merge Splice's entries into `hooks.json` (`{"hooks": {Event: [{matcher, hooks}]}}`),
/// replacing older Splice entries and leaving the user's own hooks alone.
pub(crate) fn install_hooks(hooks_path: &std::path::Path, script_path: &str) -> Result<bool, String> {
    let original: Option<serde_json::Value> = if hooks_path.exists() {
        let content = std::fs::read_to_string(hooks_path).map_err(|e| e.to_string())?;
        if content.trim().is_empty() {
            None
        } else {
            match serde_json::from_str::<serde_json::Value>(&content) {
                Ok(v) => Some(v),
                Err(e) => {
                    warn!(path = %hooks_path.display(), error = %e, "hooks.json failed to parse; leaving it untouched");
                    return Err(format!(
                        "{} is not valid JSON ({}); Splice Codex hooks were not installed",
                        hooks_path.display(),
                        e
                    ));
                }
            }
        }
    } else {
        None
    };
    let mut root = original.clone().unwrap_or_else(|| serde_json::json!({}));
    if !root.is_object() {
        root = serde_json::json!({});
    }
    let hooks = root
        .as_object_mut()
        .expect("object after guard")
        .entry("hooks")
        .or_insert(serde_json::json!({}));
    if !hooks.is_object() {
        *hooks = serde_json::json!({});
    }
    let hooks_obj = hooks.as_object_mut().expect("object after guard");

    let command = hook_command(script_path);
    for event in HOOK_EVENTS {
        super::hook::remove_hooks_by_marker(hooks_obj, event, SCRIPT_NAME);
        let arr = hooks_obj.entry(event).or_insert(serde_json::json!([]));
        if !arr.is_array() {
            *arr = serde_json::json!([]);
        }
        // Permission requests are reported synchronously so the badge is up before
        // Codex's own prompt; the other two never block a turn.
        let sync = event == "PermissionRequest";
        arr.as_array_mut().expect("array after guard").push(serde_json::json!({
            "matcher": "",
            "hooks": [{
                "type": "command",
                "command": command,
                "timeout": 5,
                "async": !sync,
                "statusMessage": "Notifying Splice",
            }]
        }));
    }

    if original.as_ref() == Some(&root) {
        return Ok(false);
    }
    let text = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    atomic_write(hooks_path, &(text + "\n"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("splice-codex-{}-{}", std::process::id(), rand_suffix()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn rand_suffix() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    }

    #[test]
    fn script_posts_to_all_three_endpoints_as_codex() {
        for needle in ["'session'", "'attention'", "'status'", "payload['agent'] = 'codex'", "SPLICE_TERMINAL_ID", "X-Splice-Token", "thread-id", "PermissionRequest", "idle_prompt", "permission_prompt"] {
            assert!(CODEX_HOOK_SCRIPT.contains(needle), "script lacks {needle}");
        }
    }

    #[test]
    fn notify_is_inserted_before_the_first_table_and_is_idempotent() {
        let d = tmp();
        let cfg = d.join("config.toml");
        std::fs::write(&cfg, "model = \"gpt-6\"\n\n[mcp_servers.x]\ncommand = \"y\"\n").unwrap();
        assert!(install_notify(&cfg, "/p/splice_codex_hook.py").unwrap());
        let text = std::fs::read_to_string(&cfg).unwrap();
        let notify_at = text.find("notify = [").unwrap();
        let table_at = text.find("[mcp_servers.x]").unwrap();
        assert!(notify_at < table_at, "notify must be top-level:\n{text}");
        assert!(text.contains("command = \"y\""), "user table kept");
        assert!(!install_notify(&cfg, "/p/splice_codex_hook.py").unwrap(), "second install rewrites nothing");
        assert_eq!(text, std::fs::read_to_string(&cfg).unwrap());
    }

    #[test]
    fn notify_is_created_when_config_is_missing_and_refreshed_when_stale() {
        let d = tmp();
        let cfg = d.join("config.toml");
        assert!(install_notify(&cfg, "/p/splice_codex_hook.py").unwrap());
        assert!(std::fs::read_to_string(&cfg).unwrap().starts_with("notify = ["));
        // A path change (older install location) is replaced.
        assert!(install_notify(&cfg, "/q/splice_codex_hook.py").unwrap());
        let text = std::fs::read_to_string(&cfg).unwrap();
        assert!(text.contains("/q/splice_codex_hook.py") && !text.contains("/p/"));
        assert_eq!(text.matches("notify = [").count(), 1);
    }

    #[test]
    fn a_users_own_notify_is_left_alone() {
        let d = tmp();
        let cfg = d.join("config.toml");
        let original = "notify = [\"say\", \"done\"]\nmodel = \"x\"\n";
        std::fs::write(&cfg, original).unwrap();
        assert!(!install_notify(&cfg, "/p/splice_codex_hook.py").unwrap());
        assert_eq!(std::fs::read_to_string(&cfg).unwrap(), original);
    }

    #[test]
    fn hooks_are_merged_with_the_users_entries_and_idempotent() {
        let d = tmp();
        let hooks = d.join("hooks.json");
        std::fs::write(&hooks, r#"{"hooks":{"Stop":[{"matcher":"","hooks":[{"type":"command","command":"say done"}]}]}}"#).unwrap();
        assert!(install_hooks(&hooks, "/p/splice_codex_hook.py").unwrap());
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&hooks).unwrap()).unwrap();
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2, "user hook kept, ours added");
        assert_eq!(stop[0]["hooks"][0]["command"], "say done");
        assert!(stop[1]["hooks"][0]["command"].as_str().unwrap().contains(SCRIPT_NAME));
        assert_eq!(v["hooks"]["PermissionRequest"][0]["hooks"][0]["async"], false);
        assert_eq!(v["hooks"]["SessionStart"][0]["hooks"][0]["async"], true);
        assert!(!install_hooks(&hooks, "/p/splice_codex_hook.py").unwrap());
        // A re-install with a new script path replaces ours without duplicating.
        assert!(install_hooks(&hooks, "/q/splice_codex_hook.py").unwrap());
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&hooks).unwrap()).unwrap();
        assert_eq!(v["hooks"]["Stop"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn corrupted_hooks_json_is_never_overwritten() {
        let d = tmp();
        let hooks = d.join("hooks.json");
        std::fs::write(&hooks, "{ not json").unwrap();
        assert!(install_hooks(&hooks, "/p/splice_codex_hook.py").is_err());
        assert_eq!(std::fs::read_to_string(&hooks).unwrap(), "{ not json");
    }

    #[test]
    fn install_at_writes_script_config_and_hooks_once() {
        let d = tmp();
        assert!(install_codex_at(&d).unwrap());
        assert!(d.join("splice-hooks").join(SCRIPT_NAME).exists());
        assert!(d.join("config.toml").exists());
        assert!(d.join("hooks.json").exists());
        assert!(!install_codex_at(&d).unwrap());
    }
}
