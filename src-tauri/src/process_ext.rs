//! Cross-platform child-process helpers: console suppression, cwd, liveness.
//!
//! On Windows, spawning a console executable (git, npm, a language server) from a
//! GUI app flashes a visible console window unless the `CREATE_NO_WINDOW` creation
//! flag is set. Splice polls `git` on an interval, so without this a console window
//! blinks open/closed constantly. No-op on Unix.
//!
//! {@link process_cwd} and {@link is_process_alive} answer two questions about a PTY's
//! child that every platform asks but each answers differently: where is this shell,
//! and is this Claude session still running.

/// `CREATE_NO_WINDOW` — https://learn.microsoft.com/windows/win32/procthread/process-creation-flags
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub trait NoWindow {
    /// Run the child process without a visible console window (Windows only).
    fn no_window(&mut self) -> &mut Self;
}

#[cfg(target_os = "windows")]
impl NoWindow for std::process::Command {
    fn no_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(CREATE_NO_WINDOW)
    }
}

#[cfg(target_os = "windows")]
impl NoWindow for tokio::process::Command {
    fn no_window(&mut self) -> &mut Self {
        self.creation_flags(CREATE_NO_WINDOW)
    }
}

#[cfg(not(target_os = "windows"))]
impl NoWindow for std::process::Command {
    fn no_window(&mut self) -> &mut Self {
        self
    }
}

#[cfg(not(target_os = "windows"))]
impl NoWindow for tokio::process::Command {
    fn no_window(&mut self) -> &mut Self {
        self
    }
}

// ─── Process working directory ────────────────────────────────────────────────

/// The current working directory of a running process, if the OS will tell us.
///
/// Used to persist a terminal's directory across restart, and as the fallback for
/// "Name Follows Folder" when the shell doesn't report its own cwd via OSC 7.
///
/// macOS: `proc_pidinfo(PROC_PIDVNODEPATHINFO)` fills a `struct proc_vnodepathinfo`
/// (2352 bytes). Its first member, `pvi_cdir.vip_path`, is the cwd C-string; the
/// `vnode_info` preceding it is 152 bytes, so the path starts at byte offset 152.
#[cfg(target_os = "macos")]
pub fn process_cwd(pid: u32) -> Option<String> {
    use std::os::raw::{c_int, c_void};
    const PROC_PIDVNODEPATHINFO: c_int = 9;
    const BUF_SIZE: usize = 2352;
    const VIP_PATH_OFFSET: usize = 152;
    extern "C" {
        fn proc_pidinfo(
            pid: c_int,
            flavor: c_int,
            arg: u64,
            buffer: *mut c_void,
            buffersize: c_int,
        ) -> c_int;
    }
    let mut buf = [0u8; BUF_SIZE];
    let ret = unsafe {
        proc_pidinfo(
            pid as c_int,
            PROC_PIDVNODEPATHINFO,
            0,
            buf.as_mut_ptr() as *mut c_void,
            BUF_SIZE as c_int,
        )
    };
    if ret <= 0 {
        return None;
    }
    let path = &buf[VIP_PATH_OFFSET..];
    let end = path.iter().position(|&b| b == 0).unwrap_or(0);
    if end == 0 {
        return None;
    }
    std::str::from_utf8(&path[..end]).ok().map(str::to_string)
}

#[cfg(target_os = "linux")]
pub fn process_cwd(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{}/cwd", pid))
        .ok()
        .and_then(|p| p.to_str().map(str::to_string))
}

/// Windows has no supported API for another process's cwd — it lives in that
/// process's PEB and reading it means `ReadProcessMemory` against undocumented
/// offsets. It would also answer the wrong question for the default shell:
/// PowerShell's `Set-Location` deliberately does not call `SetCurrentDirectory`,
/// because a PowerShell location can be a registry or certificate path, so the
/// process cwd stays wherever the shell started.
///
/// The shell's own OSC 7 / OSC 9;9 report is used instead (see `terminal::term`),
/// which is both authoritative and what PowerShell's shell integration emits.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn process_cwd(_pid: u32) -> Option<String> {
    None
}

// ─── Process liveness ─────────────────────────────────────────────────────────

/// Whether a process is still running.
///
/// Used to decide if a persisted Claude session can be resumed — a wrong `true`
/// means offering to resume a session that is gone.
///
/// POSIX `kill(pid, 0)` is a read-only existence check; it never delivers a signal.
/// EPERM means the process exists but belongs to someone else, which still counts.
#[cfg(unix)]
pub fn is_process_alive(pid: u32) -> bool {
    let ret = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if ret == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0) == libc::EPERM
}

/// Windows: open the process and ask whether it still has an exit code pending.
///
/// `PROCESS_QUERY_LIMITED_INFORMATION` is the least-privileged right that permits
/// `GetExitCodeProcess`, so this works across integrity levels. `STILL_ACTIVE` is
/// the sentinel for "hasn't exited".
///
/// These come from `windows-sys` rather than a hand-written `extern "system"` block:
/// a bare extern names no DLL, and the resulting binary failed to load at all with
/// STATUS_ENTRYPOINT_NOT_FOUND. Microsoft's bindings pin each symbol to kernel32.
#[cfg(windows)]
pub fn is_process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    // SAFETY: OpenProcess returns null on failure; the handle is closed on every
    // path, and GetExitCodeProcess only writes to the u32 we hand it.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            // Either the process is gone or it's protected. A dead PID is far more
            // likely for a shell we spawned, and claiming "alive" would resurrect a
            // stale Claude session.
            return false;
        }
        let mut code: u32 = 0;
        let ok = windows_sys::Win32::System::Threading::GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok != 0 && code == STILL_ACTIVE as u32
    }
}

/// Fallback for any other target: assume alive rather than silently disabling
/// Claude session resume.
#[cfg(not(any(unix, windows)))]
pub fn is_process_alive(_pid: u32) -> bool {
    true
}
