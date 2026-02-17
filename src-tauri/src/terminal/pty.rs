use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

const MAX_SCROLLBACK: usize = 512 * 1024; // 512 KB

pub struct PtySession {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    scrollback: Arc<Mutex<VecDeque<u8>>>,
    _reader_handle: thread::JoinHandle<()>,
}

impl PtySession {
    pub fn spawn(
        app: AppHandle,
        id: u32,
        shell: &str,
        cwd: &str,
        cols: u16,
        rows: u16,
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
        cmd.cwd(cwd);

        pair.slave
            .spawn_command(cmd)
            .map_err(|e| e.to_string())?;

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = Arc::new(Mutex::new(
            pair.master.take_writer().map_err(|e| e.to_string())?,
        ));

        let scrollback: Arc<Mutex<VecDeque<u8>>> =
            Arc::new(Mutex::new(VecDeque::with_capacity(MAX_SCROLLBACK)));
        let scrollback_clone = Arc::clone(&scrollback);

        let output_event = format!("terminal:output:{}", id);
        let exit_event = format!("terminal:exit:{}", id);

        let reader_handle = thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        let _ = app.emit(&exit_event, 0);
                        break;
                    }
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        // Append to scrollback buffer before emitting
                        if let Ok(mut sb) = scrollback_clone.lock() {
                            sb.extend(&data);
                            let overflow = sb.len().saturating_sub(MAX_SCROLLBACK);
                            if overflow > 0 {
                                sb.drain(..overflow);
                            }
                        }
                        let _ = app.emit(&output_event, data);
                    }
                    Err(_) => {
                        let _ = app.emit(&exit_event, 1);
                        break;
                    }
                }
            }
        });

        Ok(Self {
            writer,
            master: pair.master,
            scrollback,
            _reader_handle: reader_handle,
        })
    }

    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        self.writer
            .lock()
            .map_err(|e| e.to_string())?
            .write_all(data)
            .map_err(|e| e.to_string())
    }

    pub fn get_scrollback(&self) -> Result<Vec<u8>, String> {
        let sb = self.scrollback.lock().map_err(|e| e.to_string())?;
        Ok(sb.iter().copied().collect())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }
}
