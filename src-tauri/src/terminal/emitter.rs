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
        if let Ok(_lock) = self.mutex.lock() {
            self.condvar.notify_one();
        }
    }

    fn wait_timeout(&self, timeout: Duration) {
        if let Ok(lock) = self.mutex.lock() {
            let _ = self.condvar.wait_timeout(lock, timeout);
        } else {
            thread::sleep(timeout);
        }
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

    // Cap at rows-1 to prevent u16 overflow when view_shift is large
    let display_cursor_row = (buf_ref.cursor_row as u32 + view_shift as u32)
        .min((rows - 1) as u32) as u16;

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
            } else if history_row >= 0 {
                // Past end of scrollback — map into live screen rows
                let live_idx = (history_row as usize).saturating_sub(scrollback_len);
                if live_idx < live_lines.len() {
                    &live_lines[live_idx]
                } else {
                    &blank_row
                }
            } else {
                // history_row < 0: display row is before the start of scrollback
                &blank_row
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::color::Rgb;
    use crate::terminal::grid::{flags, Grid, Row};

    fn make_grid(cols: u16, rows: u16) -> Grid {
        Grid::new(cols, rows, 1000)
    }

    // --- Header fields ---

    #[test]
    fn buffer_length_is_header_plus_cells() {
        let grid = make_grid(10, 5);
        let data = serialize_grid(&grid, 0);
        assert_eq!(data.len(), 12 + 10 * 5 * 12);
    }

    #[test]
    fn header_encodes_cols_and_rows() {
        let grid = make_grid(80, 24);
        let data = serialize_grid(&grid, 0);
        assert_eq!(u16::from_le_bytes([data[0], data[1]]), 80);
        assert_eq!(u16::from_le_bytes([data[2], data[3]]), 24);
    }

    #[test]
    fn header_encodes_cursor_position() {
        let mut grid = make_grid(10, 5);
        grid.primary.cursor_col = 3;
        grid.primary.cursor_row = 2;
        let data = serialize_grid(&grid, 0);
        assert_eq!(u16::from_le_bytes([data[4], data[5]]), 3);
        assert_eq!(u16::from_le_bytes([data[6], data[7]]), 2);
    }

    #[test]
    fn cursor_visible_byte_is_one_when_visible() {
        let mut grid = make_grid(10, 5);
        grid.cursor_visible = true;
        let data = serialize_grid(&grid, 0);
        assert_eq!(data[8], 1);
    }

    #[test]
    fn cursor_visible_byte_is_zero_when_hidden() {
        let mut grid = make_grid(10, 5);
        grid.cursor_visible = false;
        let data = serialize_grid(&grid, 0);
        assert_eq!(data[8], 0);
    }

    #[test]
    fn scroll_indicator_zero_when_not_scrolled() {
        let grid = make_grid(10, 5);
        let data = serialize_grid(&grid, 0);
        assert_eq!(data[11], 0);
    }

    // --- Scrolled state ---

    #[test]
    fn scrolled_state_hides_cursor_and_sets_flag() {
        let mut grid = make_grid(10, 5);
        // Push a row to scrollback so offset=1 is valid
        grid.primary.lines[0].cells[0].ch = 'X';
        grid.primary.scroll_up_in_region();

        let data = serialize_grid(&grid, 1);

        assert_eq!(u16::from_le_bytes([data[4], data[5]]), 0); // cursor_col
        assert_eq!(u16::from_le_bytes([data[6], data[7]]), 0); // cursor_row
        assert_eq!(data[8], 0);  // cursor not visible
        assert_eq!(data[11], 1); // scroll flag set
    }

    // --- Cell layout ---

    #[test]
    fn cell_codepoint_and_color_bytes() {
        let mut grid = make_grid(4, 2);
        grid.primary.lines[0].cells[0].ch = 'Z';
        grid.primary.lines[0].cells[0].fg = Rgb { r: 10, g: 20, b: 30 };
        grid.primary.lines[0].cells[0].bg = Rgb { r: 40, g: 50, b: 60 };
        grid.primary.lines[0].cells[0].flags = flags::BOLD;

        let data = serialize_grid(&grid, 0);
        let c = 12; // first cell starts at byte 12

        let cp = u32::from_le_bytes([data[c], data[c + 1], data[c + 2], data[c + 3]]);
        assert_eq!(cp, 'Z' as u32);
        assert_eq!(data[c + 4], 10); // fg.r
        assert_eq!(data[c + 5], 20); // fg.g
        assert_eq!(data[c + 6], 30); // fg.b
        assert_eq!(data[c + 7], 40); // bg.r
        assert_eq!(data[c + 8], 50); // bg.g
        assert_eq!(data[c + 9], 60); // bg.b
        assert_eq!(data[c + 10], flags::BOLD); // flags
        assert_eq!(data[c + 11], 0); // reserved
    }

    // --- View shift ---

    #[test]
    fn view_shift_fills_top_rows_from_scrollback() {
        let mut grid = make_grid(4, 4);
        grid.primary.lines[0].cells[0].ch = 'A';
        grid.primary.lines[1].cells[0].ch = 'B';
        // Add one scrollback row manually
        let mut sb_row = Row::new(4);
        sb_row.cells[0].ch = 'S';
        grid.primary.scrollback.push_back(sb_row);
        // Cursor at row 1; rows 2-3 are blank → trailing_blanks=2, view_shift=min(2,1)=1
        grid.primary.cursor_row = 1;
        grid.primary.cleared = false;

        let data = serialize_grid(&grid, 0);

        // Display row 0 should be from scrollback ('S')
        let cp = u32::from_le_bytes([data[12], data[13], data[14], data[15]]);
        assert_eq!(cp, 'S' as u32);
        // Display row 1 should be grid row 0 ('A')
        let row1_start = 12 + 4 * 12; // 4 cols × 12 bytes/cell
        let cp2 = u32::from_le_bytes([
            data[row1_start],
            data[row1_start + 1],
            data[row1_start + 2],
            data[row1_start + 3],
        ]);
        assert_eq!(cp2, 'A' as u32);
    }

    #[test]
    fn view_shift_skipped_when_cleared_flag_set() {
        let mut grid = make_grid(4, 4);
        grid.primary.lines[0].cells[0].ch = 'A';
        let mut sb_row = Row::new(4);
        sb_row.cells[0].ch = 'S';
        grid.primary.scrollback.push_back(sb_row);
        grid.primary.cursor_row = 0;
        grid.primary.cleared = true; // skip view shift

        let data = serialize_grid(&grid, 0);

        // Display row 0 should be grid row 0 ('A'), not scrollback
        let cp = u32::from_le_bytes([data[12], data[13], data[14], data[15]]);
        assert_eq!(cp, 'A' as u32);
    }
}

const MIN_FRAME_MS: u64 = 8;      // ~120 fps cap
const IDLE_TIMEOUT_MS: u64 = 100;

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
    let min_frame = Duration::from_millis(MIN_FRAME_MS);

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
                Duration::from_millis(IDLE_TIMEOUT_MS)
            };
            notify.wait_timeout(wait);

            let current = version.load(Ordering::Relaxed);
            if current != last_version {
                // Rate-limit: ensure minimum frame interval.
                // Wait only the remaining budget (not the full IDLE_TIMEOUT_MS).
                // Do not `continue` after the sleep — fall through to emit so we avoid
                // a redundant Condvar acquire at the top of the loop.
                if last_emit.elapsed() < min_frame {
                    let remaining = min_frame.saturating_sub(last_emit.elapsed());
                    notify.wait_timeout(remaining);
                }
                last_version = current;
                let offset = scroll_offset.load(Ordering::Relaxed);
                let b64 = match emulator.read() {
                    Ok(emu) => {
                        let data = serialize_grid(&emu.grid, offset);
                        base64::engine::general_purpose::STANDARD.encode(&data)
                    }
                    Err(_) => continue, // skip frame on poisoned lock
                };
                let _ = app.emit(&event_name, b64);
                last_emit = Instant::now();
            }
        }
    })
}
