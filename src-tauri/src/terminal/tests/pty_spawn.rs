/// Integration tests for the PTY spawn layer (PtySession::spawn).
///
/// These tests sit one level above the emulator harness and exercise the
/// actual process-spawning code path using `portable_pty` directly — the
/// same crate used by `PtySession`. They verify that the `-l` (login) flag
/// is effective, which ensures login profile files are sourced and PATH is
/// complete when the app is launched as a bundled .app (not from a terminal).
///
/// Regression: without `-l`, `claude` (and other tools installed via
/// Homebrew/npm/nvm) would report "command not found" because their PATH
/// entries are only added by login-shell profile files (~/.zprofile,
/// ~/.bash_profile, ~/.profile).
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::Duration;

static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

/// RAII handle that deletes a directory on drop (even on test panic).
struct TempDir(std::path::PathBuf);

impl TempDir {
    fn create() -> Self {
        let n = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir()
            .join(format!("splice_pty_test_{}_{}", std::process::id(), n));
        std::fs::create_dir_all(&path).expect("create temp dir");
        TempDir(path)
    }

    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Build a `CommandBuilder` that mirrors `PtySession::spawn` exactly, but
/// adds `-c 'exit 0'` so the shell exits immediately rather than showing a
/// prompt.  The `login` parameter controls whether `-l` is included.
fn make_cmd(shell: &str, home: &std::path::Path, login: bool) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(shell);
    if login {
        cmd.arg("-l");
    }
    cmd.arg("-c");
    cmd.arg("exit 0");

    // Redirect all shell config-file lookups to our temp dir so the test is
    // hermetic with respect to the developer's own dotfiles.
    cmd.env("HOME", home);
    cmd.env("ZDOTDIR", home); // zsh uses this instead of HOME for its configs
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env_remove("CLAUDECODE");
    // Prevent bash from sourcing $BASH_ENV (only applies to non-login shells).
    cmd.env_remove("BASH_ENV");
    // Prevent POSIX sh from sourcing $ENV in interactive mode (unused here,
    // but belt-and-suspenders for hermeticity).
    cmd.env_remove("ENV");
    cmd
}

/// Run a `CommandBuilder` through a real PTY (same path as `PtySession`) and
/// collect all output until the child exits.  Returns `None` on timeout.
///
/// On macOS, when all slave fds are closed, `read()` on the master returns EIO
/// immediately without draining any buffered data.  To avoid losing output from
/// fast-exiting shells, we:
///   1. Start the reader thread before spawning the child (no data written yet).
///   2. Spawn the child.
///   3. Wait for the child to fully exit via `child.wait()`, THEN drop the slave.
///
/// This enforces the ordering: child writes → child exits → slave drops → EIO.
fn run_in_pty(cmd: CommandBuilder) -> Option<String> {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .expect("openpty");

    let mut reader = pair.master.try_clone_reader().expect("clone reader");
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut output = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => output.extend_from_slice(&buf[..n]),
            }
        }
        let _ = tx.send(output);
    });

    let mut child = pair.slave.spawn_command(cmd).expect("spawn");
    // Move the slave into a thread that waits for the child to fully exit
    // before dropping it.  Only then does the master see EIO, which lets the
    // reader thread above exit cleanly after draining all buffered data.
    let slave = pair.slave;
    std::thread::spawn(move || {
        let _ = child.wait();
        drop(slave);
    });

    rx.recv_timeout(Duration::from_secs(10))
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

// ── Tests ────────────────────────────────────────────────────────────────────

/// Sanity check: basic PTY I/O works at all.
#[test]
fn pty_basic_output_from_c_flag() {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .unwrap();

    let mut cmd = CommandBuilder::new("/bin/sh");
    cmd.arg("-c");
    cmd.arg("printf 'HELLO_DIRECT'; exit 0");

    let _child = pair.slave.spawn_command(cmd).unwrap();
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut output = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => output.extend_from_slice(&buf[..n]),
            }
        }
        let _ = tx.send(output);
    });

    let raw = rx.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
    let output = String::from_utf8_lossy(&raw);
    assert!(output.contains("HELLO_DIRECT"), "PTY basic output: {output:?}");
}

/// Positive: a shell spawned with `-l` (as `PtySession` now does) sources
/// login profile files, making PATH-dependent tools available.
#[test]
fn spawns_login_shell_that_sources_profile() {
    let tmp = TempDir::create();
    let sentinel = "SPLICE_LOGIN_PROFILE_OK";

    // Write a sentinel into every common login-profile location so the test
    // covers bash (~/.bash_profile), zsh (~/.zprofile), and POSIX sh (~/.profile).
    let content = format!("printf '{}\\n'\n", sentinel);
    std::fs::write(tmp.path().join(".bash_profile"), &content).unwrap();
    std::fs::write(tmp.path().join(".zprofile"), &content).unwrap();
    std::fs::write(tmp.path().join(".profile"), &content).unwrap();

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let cmd = make_cmd(&shell, tmp.path(), /* login = */ true);

    let output = run_in_pty(cmd).expect("PTY timed out");
    assert!(
        output.contains(sentinel),
        "login shell did not source profile files.\n\
         shell={shell}\noutput={output:?}",
    );
}

/// Negative control: without `-l`, profile files are NOT sourced.
/// This confirms that the positive test is actually detecting the flag and
/// that the original bug (missing `-l`) would have been caught.
#[test]
fn without_login_flag_profile_not_sourced() {
    let tmp = TempDir::create();
    let sentinel = "SPLICE_LOGIN_PROFILE_OK";

    let content = format!("printf '{}\\n'\n", sentinel);
    std::fs::write(tmp.path().join(".bash_profile"), &content).unwrap();
    std::fs::write(tmp.path().join(".zprofile"), &content).unwrap();
    std::fs::write(tmp.path().join(".profile"), &content).unwrap();

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let cmd = make_cmd(&shell, tmp.path(), /* login = */ false);

    let output = run_in_pty(cmd).expect("PTY timed out");
    assert!(
        !output.contains(sentinel),
        "non-login shell unexpectedly sourced a profile file.\n\
         shell={shell}\noutput={output:?}",
    );
}

// ─── terminate_child: closing a terminal must end and reap its shell ───────────

#[cfg(unix)]
fn pid_exists(pid: u32) -> bool {
    // kill(pid, 0) succeeds for a live process *and* for an unreaped zombie, so a
    // false here proves both termination and reaping.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

/// Spawn `script` under /bin/sh in a pty and block until it has printed READY, so
/// the test signals a shell that has finished its setup (e.g. installed a trap).
#[cfg(unix)]
fn spawn_long_runner(script: &str) -> (Box<dyn portable_pty::Child + Send + Sync>, u32, Box<dyn Read + Send>) {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .expect("openpty");
    let mut cmd = CommandBuilder::new("/bin/sh");
    cmd.args(["-c", &format!("{script}; echo READY; sleep 30")]);
    let child = pair.slave.spawn_command(cmd).expect("spawn");
    drop(pair.slave);
    let pid = child.process_id().expect("pid");
    // Mirror the live session: the reader thread holds a dup of the master, so the
    // pty never hangs up on its own when the session's handles are dropped.
    let mut reader = pair.master.try_clone_reader().expect("clone reader");
    let mut seen = Vec::new();
    let mut buf = [0u8; 256];
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !seen.windows(5).any(|w| w == b"READY") {
        assert!(std::time::Instant::now() < deadline, "shell never printed READY");
        let n = reader.read(&mut buf).expect("read pty");
        seen.extend_from_slice(&buf[..n]);
    }
    (child, pid, reader)
}

#[cfg(unix)]
fn wait_until_gone(pid: u32, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if !pid_exists(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    !pid_exists(pid)
}

#[test]
#[cfg(unix)]
fn terminate_child_hangs_up_and_reaps_a_cooperative_shell() {
    let (child, pid, _reader) = spawn_long_runner(":");
    assert!(pid_exists(pid));

    let started = std::time::Instant::now();
    crate::terminal::pty::terminate_child(child);

    assert!(wait_until_gone(pid, Duration::from_secs(3)), "shell {pid} still exists after SIGHUP");
    assert!(started.elapsed() < Duration::from_secs(1), "a cooperative shell must not wait for the SIGKILL grace period");
}

#[test]
#[cfg(unix)]
fn terminate_child_kills_a_process_that_ignores_hangup() {
    let (child, pid, _reader) = spawn_long_runner("trap '' HUP");
    assert!(pid_exists(pid));

    let started = std::time::Instant::now();
    crate::terminal::pty::terminate_child(child);

    // SIGHUP is ignored (and the ignore is inherited by `sleep`); the SIGKILL
    // fallback fires after the 2 s grace period.
    assert!(wait_until_gone(pid, Duration::from_secs(6)), "process {pid} survived SIGKILL fallback");
    assert!(started.elapsed() >= Duration::from_secs(2), "SIGHUP alone should not have ended a shell that ignores it");
}
