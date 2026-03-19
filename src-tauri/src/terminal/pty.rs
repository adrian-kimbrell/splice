use crate::terminal::emitter::{spawn_emitter, EmitterNotify};
use crate::terminal::term::Emulator;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::{self, JoinHandle};
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
    pub fn spawn(
        app: AppHandle,
        id: u32,
        shell: &str,
        cwd: &str,
        cols: u16,
        rows: u16,
        scrollback: usize,
        extra_args: &[String],
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
            cmd.arg("-l"); // login shell: sources ~/.zprofile / ~/.profile so PATH is fully set up
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
        let notify = Arc::new(EmitterNotify::new());

        // Reader thread: read PTY bytes and feed to emulator
        let reader_emulator = Arc::clone(&emulator);
        let reader_version = Arc::clone(&version);
        let reader_running = Arc::clone(&running);
        let reader_writer = Arc::clone(&writer);
        let reader_notify = Arc::clone(&notify);
        let reader_scroll_offset = Arc::clone(&scroll_offset);
        let exit_event = format!("terminal:exit:{}", id);
        let title_event = format!("terminal:title:{}", id);
        let bell_event = format!("terminal:bell:{}", id);
        let clipboard_event = format!("terminal:clipboard:{}", id);
        let app_clone = app.clone();

        let reader_handle = thread::spawn(move || {
            let mut buf = [0u8; 4096];
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
                        // Acquire emulator lock, advance parser, collect pending state,
                        // then release lock before any I/O or Tauri events.
                        let (reply, title, bell, clipboard, sb_delta) =
                            match reader_emulator.write() {
                                Err(_) => {
                                    reader_running.store(false, Ordering::Relaxed);
                                    let _ = app_clone.emit(&exit_event, 1);
                                    reader_notify.notify();
                                    break;
                                }
                                Ok(mut emu) => {
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
                                    let sb_delta = new_sb.saturating_sub(old_sb) as i32;
                                    (reply, title, bell, clipboard, sb_delta)
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
            emu.grid.active().scrollback.len() as i32
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
            emu.grid.active().scrollback.len() as i32
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
