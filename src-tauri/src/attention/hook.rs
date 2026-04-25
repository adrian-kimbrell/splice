//! Manages Claude Code hook script installation in `~/.claude/settings.json`.
//!
//! Splice registers two hooks: `Notification` (attention alerts) and
//! `SessionStart` (session tracking). Each hook is an inline Python one-liner
//! that POSTs JSON to the local attention server via `urllib.request`.
//!
//! Hook entries are identified by a trailing marker comment (e.g.
//! `splice-attention-hook-v4`). On install, old markers from previous versions
//! (`malloc-*`, `splice-*-v1` through `v3`) are removed before writing the
//! current version. Idempotent: re-running install with an up-to-date hook
//! already present is a no-op.
//!
//! The hook script prefers per-instance env vars (`SPLICE_ATTENTION_PORT`,
//! `SPLICE_ATTENTION_TOKEN`) injected by the PTY spawner, falling back to
//! shared config files for out-of-terminal usage. Writes use atomic
//! rename (`settings.json.tmp` -> `settings.json`) to avoid racing with Claude.

use tracing::{info, warn};

/// Remove all hook entries under `hooks_obj[hook_key]` whose command contains `marker`.
pub(crate) fn remove_hooks_by_marker(
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
pub(crate) fn install_hook_entry(
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
        // Already installed — check if up-to-date (uses per-instance SPLICE_ATTENTION_PORT env var)
        if entry_command_contains(&arr[idx], "SPLICE_ATTENTION_PORT") {
            return;
        }
        // Outdated: remove so we can reinstall below
        arr.remove(idx);
        info!(hook_key, "Replacing outdated Splice hook");
    }

    // The hook prefers SPLICE_ATTENTION_PORT / SPLICE_ATTENTION_TOKEN injected by Splice
    // when spawning the PTY — this guarantees each terminal connects to its own Splice
    // instance even when multiple instances are running simultaneously.
    //
    // If the env vars are absent (e.g. hook runs outside a Splice terminal), it falls back
    // to reading the shared config files (.attention_port / .attention_token) so the hook
    // still works in that edge case.
    //
    // terminal_id is read from SPLICE_TERMINAL_ID (also injected by the PTY spawner).
    // claude_pid (os.getppid()) is sent for informational/session-persistence purposes only.
    let command = format!(
        "python3 -c \"import sys,json,urllib.request,os,os.path as op\n\
         d=json.load(sys.stdin)\n\
         d['terminal_id']=int(os.environ.get('SPLICE_TERMINAL_ID','0'))\n\
         d['claude_pid']=os.getppid()\n\
         t=os.environ.get('SPLICE_ATTENTION_TOKEN','')\n\
         port=os.environ.get('SPLICE_ATTENTION_PORT','')\n\
         if not t or not port:\n\
         \tdef rf(p):\n\
         \t\ttry: return open(p).read().strip()\n\
         \t\texcept: return ''\n\
         \tfor cd in [op.join(op.expanduser('~'),'Library','Application Support','Splice'),op.join(op.expanduser('~'),'.config','Splice')]:\n\
         \t\tt=t or rf(op.join(cd,'.attention_token'))\n\
         \t\tport=port or rf(op.join(cd,'.attention_port'))\n\
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
    install_hook_at(&settings_path)
}

/// Install Splice hooks into the Claude settings file at `settings_path`.
/// Extracted to allow testing with a temp-dir path without touching `~/.claude/settings.json`.
pub fn install_hook_at(settings_path: &std::path::Path) -> Result<(), String> {
    // Create parent dir if needed
    if let Some(parent) = settings_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Read existing JSON or start with {}
    let mut root: serde_json::Value = if settings_path.exists() {
        let content = std::fs::read_to_string(settings_path).map_err(|e| e.to_string())?;
        match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(e) => {
                warn!(
                    path = %settings_path.display(),
                    error = %e,
                    "settings.json failed to parse; hooks will be reset to defaults"
                );
                serde_json::Value::Object(Default::default())
            }
        }
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
    let hooks_obj = hooks
        .as_object_mut()
        .ok_or("hooks field is not an object after reset")?;

    // Remove hooks from all previous versions.
    // "splice-attention-hook" is a prefix of all versioned attention markers (v2, v3, …),
    // so this single remove call clears every generation of the attention hook.
    // Same logic applies to "splice-session-hook".
    remove_hooks_by_marker(hooks_obj, "Notification", "malloc-attention-hook");
    remove_hooks_by_marker(hooks_obj, "Notification", "splice-attention-hook");
    remove_hooks_by_marker(hooks_obj, "SessionStart", "malloc-session-hook");
    remove_hooks_by_marker(hooks_obj, "SessionStart", "splice-session-hook");

    install_hook_entry(hooks_obj, "Notification", "attention", "splice-attention-hook-v4");
    install_hook_entry(hooks_obj, "SessionStart", "session", "splice-session-hook-v4");
    info!("Splice hooks configured in ~/.claude/settings.json");

    let updated = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    // Atomic write: write to a temp file then rename to avoid racing with Claude itself
    let tmp = settings_path.with_extension("json.tmp");
    std::fs::write(&tmp, updated).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, settings_path).map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Read settings.json from a temp dir, return the parsed JSON value.
    fn read_settings(dir: &std::path::Path) -> serde_json::Value {
        let path = dir.join("settings.json");
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    }

    /// Count how many hook entries across all hook keys contain `marker` in their command.
    fn count_hooks_with_marker(root: &serde_json::Value, marker: &str) -> usize {
        let Some(hooks) = root.get("hooks").and_then(|h| h.as_object()) else {
            return 0;
        };
        hooks.values().flat_map(|arr| arr.as_array().into_iter().flatten()).filter(|entry| {
            entry.get("hooks").and_then(|h| h.as_array()).map(|hh| {
                hh.iter().any(|h| {
                    h.get("command").and_then(|c| c.as_str())
                        .map(|s| s.contains(marker)).unwrap_or(false)
                })
            }).unwrap_or(false)
        }).count()
    }

    /// Return the command string for the first hook entry containing `marker`, if any.
    fn find_hook_command(root: &serde_json::Value, marker: &str) -> Option<String> {
        let hooks = root.get("hooks")?.as_object()?;
        for arr in hooks.values() {
            for entry in arr.as_array()?.iter() {
                for h in entry.get("hooks")?.as_array()?.iter() {
                    if let Some(cmd) = h.get("command").and_then(|c| c.as_str()) {
                        if cmd.contains(marker) {
                            return Some(cmd.to_string());
                        }
                    }
                }
            }
        }
        None
    }

    #[test]
    fn hook_script_contains_session_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        install_hook_at(&dir.path().join("settings.json")).unwrap();
        let root = read_settings(dir.path());
        let cmd = find_hook_command(&root, "splice-session-hook-v4").unwrap();
        assert!(cmd.contains("/session"), "hook command should contain /session endpoint");
    }

    #[test]
    fn hook_script_contains_token_header() {
        let dir = tempfile::tempdir().unwrap();
        install_hook_at(&dir.path().join("settings.json")).unwrap();
        let root = read_settings(dir.path());
        let cmd = find_hook_command(&root, "splice-session-hook-v4").unwrap();
        assert!(cmd.contains("X-Splice-Token"), "hook command should include X-Splice-Token header");
    }

    #[test]
    fn hook_script_reads_claude_pid() {
        let dir = tempfile::tempdir().unwrap();
        install_hook_at(&dir.path().join("settings.json")).unwrap();
        let root = read_settings(dir.path());
        let cmd = find_hook_command(&root, "splice-session-hook-v4").unwrap();
        // os.getppid() is still sent as claude_pid for informational / session-persistence use.
        assert!(cmd.contains("os.getppid()"), "hook command should call os.getppid()");
    }

    #[test]
    fn hook_installation_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        install_hook_at(&path).unwrap();
        install_hook_at(&path).unwrap();
        let root = read_settings(dir.path());
        let count = count_hooks_with_marker(&root, "splice-session-hook-v4");
        assert_eq!(count, 1, "session hook should appear exactly once after two installs");
    }

    #[test]
    fn hook_removes_old_malloc_marker() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");

        // Write a settings file with an old malloc-attention-hook entry
        let old = serde_json::json!({
            "hooks": {
                "Notification": [{
                    "matcher": "",
                    "hooks": [{"type": "command", "command": "python3 -c \"...\" # malloc-attention-hook"}]
                }]
            }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&old).unwrap()).unwrap();

        install_hook_at(&path).unwrap();
        let root = read_settings(dir.path());

        assert_eq!(count_hooks_with_marker(&root, "malloc-attention-hook"), 0,
            "old malloc-attention-hook marker should be gone after install");
        assert_eq!(count_hooks_with_marker(&root, "splice-attention-hook-v4"), 1,
            "splice-attention-hook-v4 should be present after install");
    }

    #[test]
    fn hook_removes_old_malloc_session_marker() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");

        let old = serde_json::json!({
            "hooks": {
                "SessionStart": [{
                    "matcher": "",
                    "hooks": [{"type": "command", "command": "python3 -c \"...\" # malloc-session-hook"}]
                }]
            }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&old).unwrap()).unwrap();

        install_hook_at(&path).unwrap();
        let root = read_settings(dir.path());

        assert_eq!(count_hooks_with_marker(&root, "malloc-session-hook"), 0,
            "old malloc-session-hook marker should be gone");
        assert_eq!(count_hooks_with_marker(&root, "splice-session-hook-v4"), 1,
            "splice-session-hook-v4 should be present");
    }

    // -----------------------------------------------------------------------
    // Group D: hook script robustness
    // -----------------------------------------------------------------------

    #[test]
    fn hook_script_has_retry_logic() {
        let dir = tempfile::tempdir().unwrap();
        install_hook_at(&dir.path().join("settings.json")).unwrap();
        let root = read_settings(dir.path());
        let cmd = find_hook_command(&root, "splice-attention-hook-v4").unwrap();
        assert!(cmd.contains("range(2)"), "hook must retry once on failure");
    }

    #[test]
    fn hook_script_has_timeout() {
        let dir = tempfile::tempdir().unwrap();
        install_hook_at(&dir.path().join("settings.json")).unwrap();
        let root = read_settings(dir.path());
        let cmd = find_hook_command(&root, "splice-attention-hook-v4").unwrap();
        assert!(cmd.contains("timeout="), "hook must set a request timeout");
    }

    #[test]
    fn hook_script_reads_both_config_dirs() {
        let dir = tempfile::tempdir().unwrap();
        install_hook_at(&dir.path().join("settings.json")).unwrap();
        let root = read_settings(dir.path());
        let cmd = find_hook_command(&root, "splice-attention-hook-v4").unwrap();
        assert!(
            cmd.contains("Library") || cmd.contains(".config"),
            "hook must search platform config dirs",
        );
    }

    #[test]
    fn hook_install_with_corrupted_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, b"{{{{INVALID JSON").unwrap();
        // Should not panic — recovers by starting fresh
        install_hook_at(&path).unwrap();
        let root = read_settings(dir.path());
        assert_eq!(count_hooks_with_marker(&root, "splice-session-hook-v4"), 1);
    }

    #[test]
    fn hook_install_with_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, b"").unwrap();
        install_hook_at(&path).unwrap();
        let root = read_settings(dir.path());
        assert_eq!(count_hooks_with_marker(&root, "splice-session-hook-v4"), 1);
    }

    #[test]
    fn hook_removes_old_splice_attention_hook_v1() {
        // Old installations used "splice-attention-hook" (no version suffix).
        // After the grandparent-PID fix the hook is "splice-attention-hook-v4".
        // The migration must remove the old entry so the new one takes effect.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let old = serde_json::json!({
            "hooks": {
                "Notification": [{
                    "matcher": "",
                    "hooks": [{"type": "command", "command": "python3 -c \"...\" # splice-attention-hook"}]
                }]
            }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&old).unwrap()).unwrap();

        install_hook_at(&path).unwrap();
        let root = read_settings(dir.path());

        // The old v1 marker must be gone and the new v2 marker present.
        // Note: count_hooks_with_marker uses contains(), so "splice-attention-hook"
        // matches v1, v2, v3, … entries — use the version-specific suffix to distinguish.
        assert_eq!(count_hooks_with_marker(&root, "splice-attention-hook-v4"), 1,
            "splice-attention-hook-v4 should be installed");
        // Verify no entry is the old bare marker (ends exactly without "-v2")
        let hooks = root.get("hooks").and_then(|h| h.as_object()).unwrap();
        let has_bare_marker = hooks.values()
            .flat_map(|arr| arr.as_array().into_iter().flatten())
            .flat_map(|entry| entry.get("hooks").and_then(|h| h.as_array()).into_iter().flatten())
            .filter_map(|h| h.get("command").and_then(|c| c.as_str()))
            .any(|cmd| cmd.ends_with("# splice-attention-hook"));
        assert!(!has_bare_marker, "bare splice-attention-hook v1 entry must be removed");
    }

    #[test]
    fn hook_script_reads_terminal_id_from_env() {
        // Routing is now O(1): the hook reads SPLICE_TERMINAL_ID injected by the PTY
        // spawner — no process-tree walking (ps) needed.
        let dir = tempfile::tempdir().unwrap();
        install_hook_at(&dir.path().join("settings.json")).unwrap();
        let root = read_settings(dir.path());
        let cmd = find_hook_command(&root, "splice-attention-hook-v4").unwrap();
        assert!(cmd.contains("SPLICE_TERMINAL_ID"), "hook must read SPLICE_TERMINAL_ID env var");
        assert!(!cmd.contains("ps -p"), "hook must not spawn ps (process tree walk eliminated)");
    }

    #[test]
    fn hook_script_prefers_env_vars_for_port_and_token() {
        // Per-instance isolation: the hook must read SPLICE_ATTENTION_PORT and
        // SPLICE_ATTENTION_TOKEN from the environment first so each terminal
        // connects to its own Splice instance rather than the shared config files.
        let dir = tempfile::tempdir().unwrap();
        install_hook_at(&dir.path().join("settings.json")).unwrap();
        let root = read_settings(dir.path());
        let cmd = find_hook_command(&root, "splice-attention-hook-v4").unwrap();
        assert!(cmd.contains("SPLICE_ATTENTION_PORT"), "hook must read SPLICE_ATTENTION_PORT env var");
        assert!(cmd.contains("SPLICE_ATTENTION_TOKEN"), "hook must read SPLICE_ATTENTION_TOKEN env var");
        // File fallback must still be present for the edge case where the env vars are absent.
        assert!(cmd.contains(".attention_port"), "hook must fall back to .attention_port file");
        assert!(cmd.contains(".attention_token"), "hook must fall back to .attention_token file");
    }

    // -----------------------------------------------------------------------
    // Group F: remove_hooks_by_marker unit tests
    // -----------------------------------------------------------------------

    #[test]
    fn remove_hooks_by_marker_removes_matching() {
        let mut hooks_obj = serde_json::Map::new();
        let target = serde_json::json!({
            "matcher": "",
            "hooks": [{"type": "command", "command": "python3 stuff # target-marker"}]
        });
        let other = serde_json::json!({
            "matcher": "",
            "hooks": [{"type": "command", "command": "python3 stuff # other-marker"}]
        });
        hooks_obj.insert("Notification".to_string(), serde_json::json!([target, other]));

        remove_hooks_by_marker(&mut hooks_obj, "Notification", "target-marker");

        let arr = hooks_obj["Notification"].as_array().unwrap();
        assert_eq!(arr.len(), 1, "only the matching entry should be removed");
        let cmd = arr[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.contains("other-marker"), "unrelated entry must remain");
    }

    #[test]
    fn remove_hooks_by_marker_no_match_leaves_all() {
        let mut hooks_obj = serde_json::Map::new();
        let entry = serde_json::json!({
            "matcher": "",
            "hooks": [{"type": "command", "command": "python3 stuff # some-marker"}]
        });
        hooks_obj.insert("Notification".to_string(), serde_json::json!([entry]));

        remove_hooks_by_marker(&mut hooks_obj, "Notification", "nonexistent-marker");

        assert_eq!(hooks_obj["Notification"].as_array().unwrap().len(), 1,
            "no entries should be removed when marker is absent");
    }

    #[test]
    fn remove_hooks_by_marker_missing_key_no_panic() {
        let mut hooks_obj = serde_json::Map::new();
        // Must not panic when the hook key doesn't exist at all
        remove_hooks_by_marker(&mut hooks_obj, "Notification", "some-marker");
    }

    #[test]
    fn remove_hooks_by_marker_removes_all_occurrences() {
        let mut hooks_obj = serde_json::Map::new();
        let dup = |label: &str| serde_json::json!({
            "matcher": "",
            "hooks": [{"type": "command", "command": format!("# {label}")}]
        });
        hooks_obj.insert("Notification".to_string(),
            serde_json::json!([dup("dup-marker"), dup("dup-marker"), dup("other")]));

        remove_hooks_by_marker(&mut hooks_obj, "Notification", "dup-marker");

        let arr = hooks_obj["Notification"].as_array().unwrap();
        assert_eq!(arr.len(), 1, "all duplicate entries should be removed");
    }

    // -----------------------------------------------------------------------
    // Group G: install_hook_entry safety and replacement
    // -----------------------------------------------------------------------

    #[test]
    fn install_hook_entry_rejects_unknown_path() {
        let mut hooks_obj = serde_json::Map::new();
        install_hook_entry(&mut hooks_obj, "Notification", "malicious/../path", "test-marker");
        // Must be a no-op — no entries inserted for unknown paths
        let is_empty = hooks_obj
            .get("Notification")
            .and_then(|v| v.as_array())
            .map(|a| a.is_empty())
            .unwrap_or(true);
        assert!(is_empty, "install_hook_entry must not install hooks for unknown paths");
    }

    #[test]
    fn install_hook_entry_replaces_outdated_hook() {
        // An entry whose command lacks `SPLICE_ATTENTION_PORT` is considered outdated
        // (it doesn't read the per-instance port/token from the injected env vars).
        let mut hooks_obj = serde_json::Map::new();
        let outdated = serde_json::json!({
            "matcher": "",
            "hooks": [{"type": "command", "command": "python3 hardcoded:19876 # splice-attention-hook-v4"}]
        });
        hooks_obj.insert("Notification".to_string(), serde_json::json!([outdated]));

        install_hook_entry(&mut hooks_obj, "Notification", "attention", "splice-attention-hook-v4");

        let arr = hooks_obj["Notification"].as_array().unwrap();
        assert_eq!(arr.len(), 1, "outdated entry should be replaced, not duplicated");
        let cmd = arr[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.contains("SPLICE_ATTENTION_PORT"),
            "replacement must read port from SPLICE_ATTENTION_PORT env var");
    }

    #[test]
    fn install_hook_both_hooks_installed() {
        let dir = tempfile::tempdir().unwrap();
        install_hook_at(&dir.path().join("settings.json")).unwrap();
        let root = read_settings(dir.path());
        assert_eq!(count_hooks_with_marker(&root, "splice-attention-hook-v4"), 1,
            "attention (Notification) hook must be installed");
        assert_eq!(count_hooks_with_marker(&root, "splice-session-hook-v4"), 1,
            "session (SessionStart) hook must be installed");
    }

    #[test]
    fn install_hook_entry_up_to_date_is_noop() {
        // Once an up-to-date entry (with SPLICE_ATTENTION_PORT) is present, a second
        // call to install_hook_entry must not add a duplicate.
        let mut hooks_obj = serde_json::Map::new();
        install_hook_entry(&mut hooks_obj, "Notification", "attention", "splice-attention-hook-v4");
        install_hook_entry(&mut hooks_obj, "Notification", "attention", "splice-attention-hook-v4");
        let arr = hooks_obj["Notification"].as_array().unwrap();
        assert_eq!(arr.len(), 1, "calling install_hook_entry twice must not duplicate the entry");
    }
}
