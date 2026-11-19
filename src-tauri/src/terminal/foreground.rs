//! Which program holds a terminal's foreground, and whether it is a coding agent.
//!
//! The Agents panel must list an agent the moment it starts, before any hook has
//! reported a session (Codex reports nothing until its first turn ends, or until
//! its hooks are trusted). So the agent is recognised from the foreground
//! process itself: its executable path and first arguments.

use std::collections::HashMap;
use std::sync::Mutex;

/// `"claude"` or `"codex"` when the executable path or one of the first arguments
/// names that CLI. Covers native binaries (`…/bin/codex`, `…/claude/versions/2.1.0`)
/// and Node installs (`node …/@anthropic-ai/claude-code/cli.js`).
pub fn classify(exe: &str, args: &[String]) -> Option<&'static str> {
    // The program itself (exec path, argv[0]) may match by name; later arguments
    // only by an install path, so `vim claude` is not an agent.
    std::iter::once(exe).chain(args.iter().take(3).map(String::as_str)).enumerate().find_map(|(i, s)| {
        let base = if i <= 1 { s.rsplit('/').next().unwrap_or(s) } else { "" };
        if base == "codex" || s.contains("/@openai/codex") {
            Some("codex")
        } else if base == "claude" || s.contains("/claude/versions/") || s.contains("/claude-code/") {
            Some("claude")
        } else {
            None
        }
    })
}

/// Split a `KERN_PROCARGS2` buffer: `argc`, the exec path, NUL padding, then argv.
pub fn parse_procargs2(buf: &[u8]) -> Option<(String, Vec<String>)> {
    let argc = i32::from_ne_bytes(buf.get(..4)?.try_into().ok()?).max(0) as usize;
    let rest = &buf[4..];
    let exe_end = rest.iter().position(|&b| b == 0)?;
    let exe = String::from_utf8_lossy(&rest[..exe_end]).into_owned();
    let args_start = exe_end + rest[exe_end..].iter().position(|&b| b != 0).unwrap_or(rest.len() - exe_end);
    let args = rest[args_start..]
        .split(|&b| b == 0)
        .take(argc.min(4))
        .map(|a| String::from_utf8_lossy(a).into_owned())
        .collect();
    Some((exe, args))
}

#[cfg(target_os = "macos")]
fn exe_and_args(pid: i32) -> Option<(String, Vec<String>)> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size: libc::size_t = 0;
    // SAFETY: a size query, then a read into a buffer of the size the kernel reported.
    unsafe {
        if libc::sysctl(mib.as_mut_ptr(), 3, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0) != 0 {
            return None;
        }
        let mut buf = vec![0u8; size];
        if libc::sysctl(mib.as_mut_ptr(), 3, buf.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) != 0 {
            return None;
        }
        buf.truncate(size);
        parse_procargs2(&buf)
    }
}

#[cfg(target_os = "linux")]
fn exe_and_args(pid: i32) -> Option<(String, Vec<String>)> {
    let exe = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?.to_string_lossy().into_owned();
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
    let args = raw.split(|&b| b == 0).take(4).map(|a| String::from_utf8_lossy(a).into_owned()).collect();
    Some((exe, args))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn exe_and_args(_pid: i32) -> Option<(String, Vec<String>)> {
    None
}

/// The agent running as process `pid`, if any. Remembered per pid, so a terminal
/// polled every couple of seconds costs one lookup for the life of its program.
pub fn agent_of(pid: i32) -> Option<&'static str> {
    static SEEN: Mutex<Option<HashMap<i32, Option<&'static str>>>> = Mutex::new(None);
    let mut guard = SEEN.lock().ok()?;
    let seen = guard.get_or_insert_with(HashMap::new);
    if let Some(known) = seen.get(&pid) {
        return *known;
    }
    if seen.len() > 512 {
        seen.clear(); // pids are reused eventually; never let the table grow without bound
    }
    let agent = exe_and_args(pid).and_then(|(exe, args)| classify(&exe, &args));
    seen.insert(pid, agent);
    agent
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn recognises_native_and_node_installs_of_both_agents() {
        let codex = "/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex";
        assert_eq!(classify(codex, &args(&[codex])), Some("codex"));
        assert_eq!(classify("/opt/homebrew/bin/node", &args(&["node", "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js"])), Some("codex"));
        assert_eq!(classify("/Users/a/.local/share/claude/versions/2.1.0", &args(&["claude"])), Some("claude"));
        assert_eq!(classify("/Users/a/.local/bin/claude", &args(&["claude", "--resume", "x"])), Some("claude"));
        assert_eq!(classify("/usr/local/bin/node", &args(&["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"])), Some("claude"));
    }

    #[test]
    fn other_programs_are_not_agents_even_when_an_agent_is_only_an_argument_far_along() {
        assert_eq!(classify("/usr/bin/vim", &args(&["vim", "notes.md"])), None);
        assert_eq!(classify("/usr/bin/vim", &args(&["vim", "claude"])), None);
        assert_eq!(classify("/bin/cat", &args(&["cat", "codex"])), None);
        assert_eq!(classify("/bin/sleep", &args(&["sleep", "300"])), None);
        assert_eq!(classify("/usr/bin/grep", &args(&["grep", "-r", "-n", "claude"])), None);
        assert_eq!(classify("/usr/bin/man", &args(&["man", "codexrc"])), None);
    }

    #[test]
    fn procargs2_is_split_into_exec_path_and_argv() {
        let mut buf = 2i32.to_ne_bytes().to_vec();
        buf.extend_from_slice(b"/bin/codex\0\0\0\0codex\0resume\0HOME=/x\0");
        let (exe, argv) = parse_procargs2(&buf).unwrap();
        assert_eq!(exe, "/bin/codex");
        assert_eq!(argv, args(&["codex", "resume"]));
        assert_eq!(parse_procargs2(&[1, 0]), None);
    }
}
