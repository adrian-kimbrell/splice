//! Suppress the console window Windows pops for every child process.
//!
//! On Windows, spawning a console executable (git, npm, a language server) from a
//! GUI app flashes a visible console window unless the `CREATE_NO_WINDOW` creation
//! flag is set. Splice polls `git` on an interval, so without this a console window
//! blinks open/closed constantly. No-op on Unix.

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
