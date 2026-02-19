use base64::Engine;
use crate::terminal::grid::{Cell, Grid};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::terminal::term::Emulator;

/// Shared notifier to wake the emitter thread immediately on version bumps.
pub struct EmitterNotify {
    mutex: Mutex<()>,
    condvar: Condvar,
}

impl EmitterNotify {
    pub fn new() -> Self {
        Self {
            mutex: Mutex::new(()),
            condvar: Condvar::new(),
        }
    }

    pub fn notify(&self) {
        let _lock = self.mutex.lock().unwrap();
        self.condvar.notify_one();
    }

    fn wait_timeout(&self, timeout: Duration) {
        let lock = self.mutex.lock().unwrap();
        let _ = self.condvar.wait_timeout(lock, timeout).unwrap();
    }
}

fn is_row_blank(row: &crate::terminal::grid::Row) -> bool {
    row.cells.iter().all(|c| c.ch == ' ' || c.ch == '\0')
}

pub fn serialize_grid(grid: &Grid, scroll_offset: i32) -> Vec<u8> {
    let cols = grid.cols;
    let rows = grid.rows;
    let buf_ref = grid.active();
    let header_size = 12;
    let cell_size = 12;
    let total = header_size + (cols as usize * rows as usize * cell_size);
    let mut buf = Vec::with_capacity(total);

    // Clamp scroll offset to actual scrollback length
    let max_offset = buf_ref.scrollback.len() as i32;
    let offset = scroll_offset.min(max_offset).max(0) as usize;
    let is_scrolled = offset > 0;

    let live_lines = &buf_ref.lines;
    let scrollback_len = buf_ref.scrollback.len();

    // Display-level view shift: when NOT scrolled and there are trailing blank
    // rows below the cursor, fill them with scrollback content to keep the
    // prompt visually pinned to the bottom. This doesn't touch the grid — it's
    // purely a compositing optimization.
    //
    // Skipped when: scrolled, alt screen, no scrollback, or screen was
    // explicitly cleared (buf.cleared flag — set by ED 2/3, cleared when
    // content scrolls up again).
    let view_shift = if !is_scrolled && !grid.active_is_alt && scrollback_len > 0 && !buf_ref.cleared {
        let cursor_row = buf_ref.cursor_row as usize;
        let mut trailing_blanks = 0usize;
        for r in (cursor_row + 1..live_lines.len()).rev() {
            if is_row_blank(&live_lines[r]) {
                trailing_blanks += 1;
            } else {
                break;
            }
        }
        if trailing_blanks > 0 {
            trailing_blanks.min(scrollback_len)
        } else {
            0
        }
    } else {
        0
    };

    // With view_shift, the display shows:
    //   scrollback[scrollback_len - view_shift ..] (view_shift rows from scrollback)
    //   grid[0 .. rows - view_shift]              (grid content, truncated from bottom)
    // Cursor row shifts down by view_shift in the display.

    let display_cursor_row = buf_ref.cursor_row + view_shift as u16;

    // Header (12 bytes)
    buf.extend_from_slice(&cols.to_le_bytes());
    buf.extend_from_slice(&rows.to_le_bytes());

    if is_scrolled {
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.push(0); // cursor not visible
    } else {
        buf.extend_from_slice(&buf_ref.cursor_col.to_le_bytes());
        buf.extend_from_slice(&display_cursor_row.to_le_bytes());
        buf.push(if grid.cursor_visible { 1 } else { 0 });
    }
    buf.push(grid.cursor_style);
    let mode_flags = (if grid.bracketed_paste { 1u8 } else { 0 })
        | (if grid.app_cursor_keys { 2u8 } else { 0 })
        | (if grid.app_keypad { 4u8 } else { 0 });
    buf.push(mode_flags);
    buf.push(if is_scrolled { 1 } else { 0 });

    // Cells (12 bytes each)
    let default_cell = Cell::default();
    let blank_row = crate::terminal::grid::Row::new(cols as usize);

    for display_row in 0..rows as usize {
        let row = if is_scrolled {
            // Explicit scrollback viewing
            let history_row = scrollback_len as i64 - offset as i64 + display_row as i64;
            if history_row >= 0 && (history_row as usize) < scrollback_len {
                &buf_ref.scrollback[history_row as usize]
            } else {
                let live_idx = (history_row as usize).saturating_sub(scrollback_len);
                if live_idx < live_lines.len() {
                    &live_lines[live_idx]
                } else {
                    &blank_row
                }
            }
        } else if display_row < view_shift {
            // View-shifted: fill top rows from scrollback
            let sb_idx = scrollback_len - view_shift + display_row;
            &buf_ref.scrollback[sb_idx]
        } else {
            // Normal grid row (shifted by view_shift)
            let grid_row = display_row - view_shift;
            if grid_row < live_lines.len() {
                &live_lines[grid_row]
            } else {
                &blank_row
            }
        };

        for col_idx in 0..cols as usize {
            let cell = if col_idx < row.cells.len() {
                &row.cells[col_idx]
            } else {
                &default_cell
            };
            let cp = cell.ch as u32;
            buf.extend_from_slice(&cp.to_le_bytes());
            buf.push(cell.fg.r);
            buf.push(cell.fg.g);
            buf.push(cell.fg.b);
            buf.push(cell.bg.r);
            buf.push(cell.bg.g);
            buf.push(cell.bg.b);
            buf.push(cell.flags);
            buf.push(0);
        }
    }

    buf
}

pub fn spawn_emitter(
    app: AppHandle,
    id: u32,
    emulator: Arc<RwLock<Emulator>>,
    version: Arc<AtomicU32>,
    running: Arc<AtomicBool>,
    scroll_offset: Arc<AtomicI32>,
    notify: Arc<EmitterNotify>,
) -> JoinHandle<()> {
    let event_name = format!("terminal:grid:{}", id);
    let min_frame = Duration::from_millis(8); // ~120fps cap

    thread::spawn(move || {
        let mut last_version = 0u32;
        let mut last_emit = Instant::now();
        loop {
            if !running.load(Ordering::Relaxed) {
                break;
            }

            // Wait for notification or timeout (for idle refresh like cursor blink)
            let since_last = last_emit.elapsed();
            let wait = if since_last < min_frame {
                min_frame - since_last
            } else {
                Duration::from_millis(100) // idle timeout
            };
            notify.wait_timeout(wait);

            let current = version.load(Ordering::Relaxed);
            if current != last_version {
                // Rate-limit: ensure minimum frame interval
                if last_emit.elapsed() < min_frame {
                    continue;
                }
                last_version = current;
                let offset = scroll_offset.load(Ordering::Relaxed);
                let b64 = {
                    let emu = emulator.read().unwrap();
                    let data = serialize_grid(&emu.grid, offset);
                    base64::engine::general_purpose::STANDARD.encode(&data)
                };
                let _ = app.emit(&event_name, b64);
                last_emit = Instant::now();
            }
        }
    })
}
