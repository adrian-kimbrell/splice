//! PTY session — spawns a shell and wires it to the emulator and emitter.
//!
//! `PtySession::spawn` creates three concurrent components:
//!   1. A PTY pair via `portable-pty` (wraps platform `openpty` / `posix_openpt`)
//!   2. A **reader thread** that loops `read(master_fd)` → `Emulator::advance` → bumps
//!      `version: AtomicU32` → wakes the emitter via `EmitterNotify` (Condvar)
//!   3. An **emitter thread** (see `emitter` module) that rate-limits and emits binary frames
//!
//! Security: shell must be in `commands::terminal::ALLOWED_SHELLS` before `PtySession::spawn`
//! is ever called — validation happens in `spawn_terminal`.
//!
//! Login shell: `-l` is appended unless `extra_args` are provided. `extra_args` is used by
//! SSH terminals, which pass explicit `ssh -t user@host` args instead of a login flag.
//!
//! `Drop` sets `running = false` and wakes the emitter so both threads exit cleanly
//! without requiring explicit kill/join from the caller.

use crate::terminal::emitter::{spawn_emitter, EmitterNotify};
use crate::terminal::term::Emulator;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub struct PtySession {
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub child_pid: Option<u32>,
    /// Wrapped in Arc<Mutex> so resize_terminal can clone it and release
    /// the AppState lock before issuing the PTY ioctl (may block).
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub emulator: Arc<RwLock<Emulator>>,
    pub version: Arc<AtomicU32>,
    running: Arc<AtomicBool>,
    pub scroll_offset: Arc<AtomicI32>,
    /// Last directory the shell reported via OSC 7 / OSC 9;9. Kept so the workspace
    /// can be persisted with each terminal's real directory even where the OS won't
    /// report a process's cwd (Windows) or the shell is remote (SSH).
    pub last_reported_cwd: Arc<Mutex<Option<String>>>,
    pub notify: Arc<EmitterNotify>,
    _reader_handle: JoinHandle<()>,
    _emitter_handle: JoinHandle<()>,
}

impl Drop for PtySession {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
        self.notify.notify(); // wake emitter so it can exit
    }
}

impl PtySession {
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        app: AppHandle,
        id: u32,
        shell: &str,
        cwd: &str,
        cols: u16,
        rows: u16,
        scrollback: usize,
        extra_args: &[String],
        attention_port: Option<u16>,
        attention_token: Option<String>,
    ) -> Result<Self, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let mut cmd = CommandBuilder::new(shell);
        if extra_args.is_empty() {
            // login shell: sources ~/.zprofile / ~/.profile so PATH is fully set up.
            // `-l` is a Unix shell flag — cmd.exe / PowerShell reject it and exit
            // immediately (the terminal would flash open and close on Windows).
            #[cfg(not(target_os = "windows"))]
            cmd.arg("-l");

            // Windows shells don't report their directory the way macOS zsh does, so
            // ask them to. This is what "Name Follows Folder" reads (OSC 9;9), and
            // without it the feature would silently do nothing on Windows.
            //
            // ponytail: wraps whatever prompt the profile already set rather than
            // replacing it. If a user's prompt is later rebuilt from scratch the
            // wrapper is lost — the fix then is PowerShell's own
            // Enable-PSShellIntegration, not more injection here.
            #[cfg(target_os = "windows")]
            {
                let lower = shell.to_ascii_lowercase();
                if lower.contains("powershell") || lower.contains("pwsh") {
                    cmd.arg("-NoExit");
                    cmd.arg("-Command");
                    cmd.arg(concat!(
                        "$__splice_prompt = $function:prompt; ",
                        "function global:prompt { ",
                        "Write-Host -NoNewline ([char]27 + ']9;9;' + $PWD.ProviderPath + [char]7); ",
                        "& $__splice_prompt }"
                    ));
                } else if lower.contains("cmd") {
                    // cmd.exe has no prompt hook, but PROMPT understands $e (ESC) and
                    // $P (current directory), which is all OSC 9;9 needs.
                    cmd.env("PROMPT", "$e]9;9;$P$e\\$P$G");
                }
            }
        } else {
            for arg in extra_args {
                cmd.arg(arg);
            }
        }
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // Don't inherit Claude Code's session marker — terminals spawned by Splice
        // are fresh shells and should be able to run `claude` freely.
        cmd.env_remove("CLAUDECODE");
        // Expose the terminal ID so Claude hook scripts can identify which Splice
        // terminal they're running in without process-tree walking.
        cmd.env("SPLICE_TERMINAL_ID", id.to_string());
        // Inject this process's attention server address and token so the hook
        // connects to the correct Splice instance even when multiple are running.
        if let Some(port) = attention_port {
            cmd.env("SPLICE_ATTENTION_PORT", port.to_string());
        }
        if let Some(token) = attention_token {
            cmd.env("SPLICE_ATTENTION_TOKEN", token);
        }

        let child = pair.slave
            .spawn_command(cmd)
            .map_err(|e| e.to_string())?;
        let child_pid = child.process_id();
        drop(child);

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = Arc::new(Mutex::new(
            pair.master.take_writer().map_err(|e| e.to_string())?,
        ));
        let master = Arc::new(Mutex::new(pair.master as Box<dyn MasterPty + Send>));

        let emulator = Arc::new(RwLock::new(Emulator::new(cols, rows, scrollback)));
        let version = Arc::new(AtomicU32::new(0));
        let running = Arc::new(AtomicBool::new(true));
        let scroll_offset = Arc::new(AtomicI32::new(0));
        let last_reported_cwd: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let notify = Arc::new(EmitterNotify::new());

        // Reader thread: read PTY bytes and feed to emulator
        let reader_emulator = Arc::clone(&emulator);
        let reader_version = Arc::clone(&version);
        let reader_running = Arc::clone(&running);
        let reader_writer = Arc::clone(&writer);
        let reader_notify = Arc::clone(&notify);
        let reader_scroll_offset = Arc::clone(&scroll_offset);
        let reader_reported_cwd = Arc::clone(&last_reported_cwd);
        let exit_event = format!("terminal:exit:{}", id);
        let title_event = format!("terminal:title:{}", id);
        let bell_event = format!("terminal:bell:{}", id);
        let clipboard_event = format!("terminal:clipboard:{}", id);
        let cwd_event = format!("terminal:cwd:{}", id);
        let cwd_pid = child_pid;
        let app_clone = app.clone();

        let reader_handle = thread::spawn(move || {
            let mut buf = [0u8; 4096];
            // Track the shell's cwd so we can tell the frontend when it changes
            // (for the "name follows folder" mode). Throttled to bound the syscall.
            let mut last_cwd: Option<String> = None;
            let mut last_cwd_check = Instant::now() - Duration::from_secs(1);
            loop {
                if !reader_running.load(Ordering::Relaxed) {
                    break;
                }
                match reader.read(&mut buf) {
                    Ok(0) => {
                        reader_running.store(false, Ordering::Relaxed);
                        let _ = app_clone.emit(&exit_event, 0);
                        reader_notify.notify();
                        break;
                    }
                    Ok(n) => {
                        // The VTE parser runs on arbitrary PTY bytes. A panic on some exotic
                        // sequence must NOT brick the pane: an uncaught panic here would drop
                        // the write guard poisoned, kill this thread, and leave the emitter
                        // skipping every frame forever (blank + unresponsive until re-spawn).
                        // Catch it, clear the poison, and drop just the offending chunk.
                        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            // Recover rather than break if a *prior* panic poisoned the lock.
                            let mut emu = match reader_emulator.write() {
                                Ok(g) => g,
                                Err(p) => {
                                    reader_emulator.clear_poison();
                                    p.into_inner()
                                }
                            };
                            let old_sb = if emu.grid.active_is_alt {
                                0
                            } else {
                                emu.grid.primary.scrollback.len()
                            };
                            emu.advance(&buf[..n]);
                            let new_sb = if emu.grid.active_is_alt {
                                0
                            } else {
                                emu.grid.primary.scrollback.len()
                            };
                            let reply: Vec<u8> = emu.pending_reply.drain(..).collect();
                            let title = emu.pending_title.take();
                            let bell = std::mem::replace(&mut emu.pending_bell, false);
                            let clipboard = emu.pending_clipboard.take();
                            let reported_cwd = emu.pending_cwd.take();
                            let sb_delta = new_sb.saturating_sub(old_sb) as i32;
                            (reply, title, bell, clipboard, reported_cwd, sb_delta)
                        }));
                        let (reply, title, bell, clipboard, reported_cwd, sb_delta) = match outcome {
                            Ok(t) => t,
                            Err(_) => {
                                reader_emulator.clear_poison();
                                tracing::error!(
                                    "terminal {}: parser panicked, dropped {} bytes of output",
                                    id, n
                                );
                                continue;
                            }
                        };

                        // Scroll stabilization: when scrollback grows and the user is
                        // viewing scrollback, advance the offset by the same delta so
                        // the display stays anchored to the same content.
                        if sb_delta > 0 && reader_scroll_offset.load(Ordering::Relaxed) > 0 {
                            reader_scroll_offset.fetch_add(sb_delta, Ordering::Relaxed);
                        }

                        // Process all independently (lock released above)
                        if !reply.is_empty() {
                            if let Ok(mut w) = reader_writer.lock() {
                                let _ = w.write_all(&reply);
                            }
                        }
                        if let Some(t) = title {
                            let _ = app_clone.emit(&title_event, t);
                        }
                        if bell {
                            let _ = app_clone.emit(&bell_event, ());
                        }
                        if let Some(text) = clipboard {
                            let _ = app_clone.emit(&clipboard_event, text);
                        }

                        // Tell the frontend when the shell's cwd changes, for "name
                        // follows folder". Two sources, preferring the shell's own word:
                        //
                        //  1. OSC 7 / OSC 9;9, if the shell reports it. Authoritative and
                        //     instant, works for any shell that reports — including over
                        //     SSH, and including PowerShell, which never updates its
                        //     process cwd on `cd` so polling can't see it move.
                        //  2. Polling the child's cwd, where the OS can tell us.
                        //
                        // The poll runs on small batches (a `cd`'s new prompt, keystroke
                        // echoes) so the name updates immediately, and is throttled on
                        // large batches so a flood of output doesn't spam the syscall.
                        // A shell-reported cwd is also the best answer for persistence,
                        // so keep the newest one where get_terminal_cwd can read it.
                        if let Some(c) = &reported_cwd {
                            if let Ok(mut slot) = reader_reported_cwd.lock() {
                                *slot = Some(c.clone());
                            }
                        }
                        let cwd_now = reported_cwd.or_else(|| {
                            cwd_pid.filter(|_| {
                                n <= 1024 || last_cwd_check.elapsed() >= Duration::from_millis(200)
                            })
                            .and_then(|pid| {
                                last_cwd_check = Instant::now();
                                crate::process_ext::process_cwd(pid)
                            })
                        });
                        if let Some(cwd) = cwd_now {
                            if last_cwd.as_deref() != Some(cwd.as_str()) {
                                last_cwd = Some(cwd.clone());
                                let _ = app_clone.emit(&cwd_event, cwd);
                            }
                        }

                        reader_version.fetch_add(1, Ordering::Relaxed);
                        reader_notify.notify();
                    }
                    Err(_) => {
                        reader_running.store(false, Ordering::Relaxed);
                        let _ = app_clone.emit(&exit_event, 1);
                        reader_notify.notify();
                        break;
                    }
                }
            }
        });

        // Emitter thread: serialize grid state and emit to frontend
        let emitter_handle = spawn_emitter(
            app,
            id,
            Arc::clone(&emulator),
            Arc::clone(&version),
            Arc::clone(&running),
            Arc::clone(&scroll_offset),
            Arc::clone(&notify),
        );

        Ok(Self {
            writer,
            child_pid,
            master,
            emulator,
            version,
            running,
            scroll_offset,
            last_reported_cwd,
            notify,
            _reader_handle: reader_handle,
            _emitter_handle: emitter_handle,
        })
    }

    pub fn scroll(&self, delta: i32) {
        // TOCTOU note: scroll_offset may transiently exceed the current scrollback length
        // if the PTY writes new data between here and the next serialize_grid call.
        // serialize_grid re-clamps the offset before use, so visual output is always correct.
        let max = {
            let emu = match self.emulator.read() {
                Ok(emu) => emu,
                Err(_) => return, // scroll is non-critical
            };
            // Scrollback already composited into the view by the bottom-pinning
            // shift isn't scrollable-to — clamping past it would add dead wheel
            // turns at the top of history.
            (emu.grid.active().scrollback.len() - crate::terminal::emitter::view_shift(&emu.grid))
                as i32
        };
        let old = self.scroll_offset.load(Ordering::Relaxed);
        let new_val = (old + delta).clamp(0, max);
        self.scroll_offset.store(new_val, Ordering::Relaxed);
        self.version.fetch_add(1, Ordering::Relaxed);
        self.notify.notify();
    }

    pub fn set_scroll_offset(&self, offset: i32) {
        let max = {
            let emu = match self.emulator.read() {
                Ok(emu) => emu,
                Err(_) => return,
            };
            (emu.grid.active().scrollback.len() - crate::terminal::emitter::view_shift(&emu.grid))
                as i32
        };
        self.scroll_offset.store(offset.clamp(0, max), Ordering::Relaxed);
        self.version.fetch_add(1, Ordering::Relaxed);
        self.notify.notify();
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        {
            let mut emu = self.emulator.write().map_err(|e| e.to_string())?;
            emu.resize(cols, rows);
        }
        self.master
            .lock().map_err(|e| e.to_string())?
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        self.version.fetch_add(1, Ordering::Relaxed);
        self.notify.notify();
        Ok(())
    }
}
