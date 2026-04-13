//! Terminal grid data structures.
//!
//! `Cell` (12 bytes when serialized): character codepoint, fg/bg RGB, attribute flags, width.
//! `Row`: a `Vec<Cell>` for one terminal line.
//! `ScreenBuffer`: full mutable state for one screen — live lines, scrollback `VecDeque`,
//!   cursor position, pen (current SGR attributes), scroll region, and the `cleared` flag.
//! `Grid`: wraps primary + alt `ScreenBuffer` and all terminal mode flags (mouse mode,
//!   cursor style, bracketed paste, app_cursor_keys, etc.).
//!
//! Key invariants:
//! - Scrollback is a `VecDeque` capped at `max_scrollback`; oldest rows are popped from front.
//! - `cleared` is set by ED 2 / ED 3 (erase screen) and reset when content scrolls up.
//!   The emitter checks this flag to skip view-shift compositing — without it, old scrollback
//!   rows would bleed into a freshly cleared screen (e.g. after `clear` or `printf '\033[2J'`).
//! - Wide characters: left-half cell has `width=2`, right-half placeholder has `width=0`.
//!   The serializer faithfully encodes both; the renderer skips placeholder cells.

use std::collections::VecDeque;
use crate::terminal::color::{Rgb, DEFAULT_BG, DEFAULT_FG};

pub mod flags {
    pub const BOLD: u8 = 0x01;
    pub const ITALIC: u8 = 0x02;
    pub const UNDERLINE: u8 = 0x04;
    pub const DIM: u8 = 0x08;
    pub const INVERSE: u8 = 0x10;
    pub const STRIKETHROUGH: u8 = 0x20;
    pub const BLINK: u8 = 0x40;
    pub const HIDDEN: u8 = 0x80;
}

#[derive(Clone, Copy)]
pub struct Cell {
    pub ch: char,
    pub fg: Rgb,
    pub bg: Rgb,
    pub flags: u8,
    /// 1 = normal width, 2 = wide char (left half), 0 = wide char (right-half placeholder)
    pub width: u8,
}

impl Default for Cell {
    fn default() -> Self {
        Self {
            ch: ' ',
            fg: DEFAULT_FG,
            bg: DEFAULT_BG,
            flags: 0,
            width: 1,
        }
    }
}

#[derive(Clone)]
pub struct Row {
    pub cells: Vec<Cell>,
}

impl Row {
    pub fn new(cols: usize) -> Self {
        Self {
            cells: vec![Cell::default(); cols],
        }
    }
}

#[derive(Clone, Copy)]
pub struct Pen {
    pub fg: Rgb,
    pub bg: Rgb,
    pub flags: u8,
}

impl Default for Pen {
    fn default() -> Self {
        Self {
            fg: DEFAULT_FG,
            bg: DEFAULT_BG,
            flags: 0,
        }
    }
}

pub struct ScreenBuffer {
    pub cols: u16,
    pub lines: Vec<Row>,
    pub cursor_col: u16,
    pub cursor_row: u16,
    pub pen: Pen,
    pub scroll_top: u16,
    pub scroll_bottom: u16,
    pub scrollback: VecDeque<Row>,
    pub max_scrollback: usize,
    /// Set by ED 2/3 (clear screen). Cleared when content scrolls up
    /// (screen has been filled since the clear). Used by emitter to
    /// skip view-shift compositing after an explicit clear.
    pub cleared: bool,
    /// DEC charset state: 0=ASCII, 1=DEC special graphics
    pub charset_g0: u8,
    pub charset_g1: u8,
    /// Active charset slot: 0=G0, 1=G1
    pub active_charset: u8,
    saved_cursor_col: u16,
    saved_cursor_row: u16,
    saved_pen: Pen,
}

impl ScreenBuffer {
    pub fn new(cols: u16, rows: u16, max_scrollback: usize) -> Self {
        let lines = (0..rows).map(|_| Row::new(cols as usize)).collect();
        Self {
            cols,
            lines,
            cursor_col: 0,
            cursor_row: 0,
            pen: Pen::default(),
            scroll_top: 0,
            scroll_bottom: rows.saturating_sub(1),
            scrollback: VecDeque::new(),
            max_scrollback,
            cleared: false,
            charset_g0: 0,
            charset_g1: 0,
            active_charset: 0,
            saved_cursor_col: 0,
            saved_cursor_row: 0,
            saved_pen: Pen::default(),
        }
    }

    pub fn blank_row(&self) -> Row {
        Row::new(self.cols as usize)
    }

    pub fn scroll_up_in_region(&mut self) {
        let top = self.scroll_top as usize;
        let bottom = self.scroll_bottom as usize;
        if top < self.lines.len() && bottom < self.lines.len() && top <= bottom {
            // If full-screen scroll region, push evicted line to scrollback
            if top == 0 && self.max_scrollback > 0 {
                let evicted = self.lines[top].clone();
                self.scrollback.push_back(evicted);
                if self.scrollback.len() > self.max_scrollback {
                    self.scrollback.pop_front();
                }
            }
            let blank = self.blank_row();
            self.lines[top..=bottom].rotate_left(1);
            self.lines[bottom] = blank;
            // Content is actively scrolling — screen has been filled since any clear
            self.cleared = false;
        }
    }

    pub fn scroll_down_in_region(&mut self) {
        let top = self.scroll_top as usize;
        let bottom = self.scroll_bottom as usize;
        if top < self.lines.len() && bottom < self.lines.len() && top <= bottom {
            let blank = self.blank_row();
            self.lines[top..=bottom].rotate_right(1);
            self.lines[top] = blank;
        }
    }

    pub fn insert_lines(&mut self, n: u16, cursor_row: u16) {
        let row = cursor_row as usize;
        let bottom = self.scroll_bottom as usize;
        let top = self.scroll_top as usize;
        if row < top || row > bottom {
            return;
        }
        let count = (n as usize).min(bottom - row + 1);
        if count == 0 {
            return;
        }
        self.lines[row..=bottom].rotate_right(count);
        for i in row..(row + count).min(bottom + 1) {
            self.lines[i] = self.blank_row();
        }
    }

    pub fn delete_lines(&mut self, n: u16, cursor_row: u16) {
        let row = cursor_row as usize;
        let bottom = self.scroll_bottom as usize;
        let top = self.scroll_top as usize;
        if row < top || row > bottom {
            return;
        }
        let count = (n as usize).min(bottom - row + 1);
        if count == 0 {
            return;
        }
        self.lines[row..=bottom].rotate_left(count);
        for i in (bottom + 1 - count)..=bottom {
            self.lines[i] = self.blank_row();
        }
    }

    pub fn save_cursor(&mut self) {
        self.saved_cursor_col = self.cursor_col;
        self.saved_cursor_row = self.cursor_row;
        self.saved_pen = self.pen;
    }

    pub fn restore_cursor(&mut self) {
        self.cursor_col = self.saved_cursor_col;
        self.cursor_row = self.saved_cursor_row;
        self.pen = self.saved_pen;
    }
}

fn default_tab_stops(cols: u16) -> Vec<bool> {
    // Standard VT tab stops at columns 8, 16, 24, … (1-based: cols 8, 16, …)
    // Column 0 is never a tab stop — tab() starts searching from cursor+1.
    (0..cols).map(|c| c > 0 && c % 8 == 0).collect()
}

pub struct Grid {
    pub cols: u16,
    pub rows: u16,
    pub primary: ScreenBuffer,
    pub alt: ScreenBuffer,
    pub active_is_alt: bool,
    pub cursor_visible: bool,
    pub cursor_style: u8,
    pub auto_wrap: bool,
    pub bracketed_paste: bool,
    pub app_cursor_keys: bool,
    pub app_keypad: bool,
    pub tab_stops: Vec<bool>,
    pub last_char: char,
    /// Mouse protocol: 0=off, 1=X10(1000), 2=button-tracking(1002), 3=any-event(1003)
    pub mouse_mode: u8,
    /// SGR extended mouse encoding (1006)
    pub mouse_sgr: bool,
    /// Focus events mode (1004): sends CSI I on focus, CSI O on blur
    pub focus_events: bool,
}

impl Grid {
    pub fn new(cols: u16, rows: u16, scrollback: usize) -> Self {
        Self {
            cols,
            rows,
            primary: ScreenBuffer::new(cols, rows, scrollback),
            alt: ScreenBuffer::new(cols, rows, 0),
            active_is_alt: false,
            cursor_visible: true,
            cursor_style: 0,
            auto_wrap: true,
            bracketed_paste: false,
            app_cursor_keys: false,
            app_keypad: false,
            tab_stops: default_tab_stops(cols),
            last_char: ' ',
            mouse_mode: 0,
            mouse_sgr: false,
            focus_events: false,
        }
    }

    pub fn active(&self) -> &ScreenBuffer {
        if self.active_is_alt {
            &self.alt
        } else {
            &self.primary
        }
    }

    pub fn active_mut(&mut self) -> &mut ScreenBuffer {
        if self.active_is_alt {
            &mut self.alt
        } else {
            &mut self.primary
        }
    }

    // Convenience accessors used by term.rs
    pub fn cursor_col(&self) -> u16 {
        self.active().cursor_col
    }

    pub fn cursor_row(&self) -> u16 {
        self.active().cursor_row
    }


    pub fn write_char(&mut self, c: char) {
        use unicode_width::UnicodeWidthChar;
        self.last_char = c;
        let char_width = UnicodeWidthChar::width(c).unwrap_or(1) as u16;

        // Combining/zero-width: attach to previous cell, don't advance cursor
        if char_width == 0 {
            return;
        }

        let cols = self.cols;
        let auto_wrap = self.auto_wrap;
        let buf = self.active_mut();

        // Wrap if character won't fit in remaining columns
        if buf.cursor_col + char_width > cols {
            if auto_wrap {
                buf.cursor_col = 0;
                if buf.cursor_row == buf.scroll_bottom {
                    buf.scroll_up_in_region();
                } else if buf.cursor_row < buf.scroll_bottom {
                    buf.cursor_row += 1;
                }
                // else: cursor is below the scroll region — leave it as-is
            } else {
                buf.cursor_col = cols.saturating_sub(char_width);
            }
        }

        let col = buf.cursor_col as usize;
        let row = buf.cursor_row as usize;
        if row < buf.lines.len() {
            // Write primary cell
            if col < buf.lines[row].cells.len() {
                buf.lines[row].cells[col] = Cell {
                    ch: c,
                    fg: buf.pen.fg,
                    bg: buf.pen.bg,
                    flags: buf.pen.flags,
                    width: char_width as u8,
                };
            }
            // Write placeholder for right half of wide char
            if char_width == 2 && col + 1 < buf.lines[row].cells.len() {
                buf.lines[row].cells[col + 1] = Cell {
                    ch: ' ',
                    fg: buf.pen.fg,
                    bg: buf.pen.bg,
                    flags: 0,
                    width: 0,
                };
            }
        }
        buf.cursor_col += char_width;
    }

    pub fn linefeed(&mut self) {
        let buf = self.active_mut();
        if buf.cursor_row == buf.scroll_bottom {
            buf.scroll_up_in_region();
        } else if buf.cursor_row + 1 < buf.lines.len() as u16 {
            buf.cursor_row += 1;
        }
    }

    pub fn carriage_return(&mut self) {
        self.active_mut().cursor_col = 0;
    }

    pub fn backspace(&mut self) {
        let buf = self.active_mut();
        if buf.cursor_col > 0 {
            buf.cursor_col -= 1;
        }
    }

    pub fn tab(&mut self) {
        let cols = self.cols;
        let start = self.active_mut().cursor_col as usize + 1;
        // active_mut borrow ends after extracting start (NLL)
        let next = (start..cols as usize)
            .find(|&c| self.tab_stops.get(c).copied().unwrap_or(false));
        self.active_mut().cursor_col = next.unwrap_or(cols.saturating_sub(1) as usize) as u16;
    }

    pub fn backtab(&mut self, n: u16) {
        let buf = self.active_mut();
        let mut col = buf.cursor_col as usize;
        for _ in 0..n {
            if col == 0 {
                break;
            }
            col -= 1;
            while col > 0 && !self.tab_stops.get(col).copied().unwrap_or(false) {
                col -= 1;
            }
        }
        self.active_mut().cursor_col = col as u16;
    }

    pub fn set_tab_stop(&mut self) {
        let col = self.active().cursor_col as usize;
        if col < self.tab_stops.len() {
            self.tab_stops[col] = true;
        }
    }

    pub fn clear_tab_stop(&mut self, mode: u16) {
        match mode {
            0 => {
                let col = self.active().cursor_col as usize;
                if col < self.tab_stops.len() {
                    self.tab_stops[col] = false;
                }
            }
            3 => {
                for stop in &mut self.tab_stops {
                    *stop = false;
                }
            }
            _ => {}
        }
    }

    pub fn cursor_up(&mut self, n: u16) {
        let buf = self.active_mut();
        let min_row = if buf.cursor_row >= buf.scroll_top && buf.cursor_row <= buf.scroll_bottom {
            buf.scroll_top
        } else {
            0
        };
        buf.cursor_row = buf.cursor_row.saturating_sub(n).max(min_row);
    }

    pub fn cursor_down(&mut self, n: u16) {
        let buf = self.active_mut();
        let max_row = if buf.cursor_row >= buf.scroll_top && buf.cursor_row <= buf.scroll_bottom {
            buf.scroll_bottom
        } else {
            (buf.lines.len() as u16).saturating_sub(1)
        };
        buf.cursor_row = buf.cursor_row.saturating_add(n).min(max_row);
    }

    pub fn cursor_forward(&mut self, n: u16) {
        let cols = self.cols;
        let buf = self.active_mut();
        buf.cursor_col = buf.cursor_col.saturating_add(n).min(cols.saturating_sub(1));
    }

    pub fn cursor_back(&mut self, n: u16) {
        let buf = self.active_mut();
        buf.cursor_col = buf.cursor_col.saturating_sub(n);
    }

    pub fn set_cursor_pos(&mut self, row: u16, col: u16) {
        let rows = self.rows;
        let cols = self.cols;
        let buf = self.active_mut();
        buf.cursor_row = row.min(rows.saturating_sub(1));
        buf.cursor_col = col.min(cols.saturating_sub(1));
    }

    pub fn erase_in_display(&mut self, mode: u16) {
        let buf = self.active_mut();
        let (row, col) = (buf.cursor_row as usize, buf.cursor_col as usize);
        // BCE: erased cells inherit the current pen background colour.
        let blank = Cell { ch: ' ', fg: DEFAULT_FG, bg: buf.pen.bg, flags: 0, width: 1 };
        match mode {
            0 => {
                if row < buf.lines.len() {
                    for c in col..buf.lines[row].cells.len() {
                        buf.lines[row].cells[c] = blank;
                    }
                }
                for r in (row + 1)..buf.lines.len() {
                    for cell in &mut buf.lines[r].cells {
                        *cell = blank;
                    }
                }
            }
            1 => {
                for r in 0..row {
                    for cell in &mut buf.lines[r].cells {
                        *cell = blank;
                    }
                }
                if row < buf.lines.len() {
                    for c in 0..=col.min(buf.lines[row].cells.len().saturating_sub(1)) {
                        buf.lines[row].cells[c] = blank;
                    }
                }
            }
            2 => {
                for r in 0..buf.lines.len() {
                    for cell in &mut buf.lines[r].cells {
                        *cell = blank;
                    }
                }
                buf.cleared = true;
            }
            3 => {
                for r in 0..buf.lines.len() {
                    for cell in &mut buf.lines[r].cells {
                        *cell = blank;
                    }
                }
                buf.scrollback.clear();
                buf.cleared = true;
            }
            _ => {}
        }
    }

    pub fn erase_in_line(&mut self, mode: u16) {
        let buf = self.active_mut();
        let row = buf.cursor_row as usize;
        let col = buf.cursor_col as usize;
        if row >= buf.lines.len() {
            return;
        }
        let blank = Cell { ch: ' ', fg: DEFAULT_FG, bg: buf.pen.bg, flags: 0, width: 1 };
        match mode {
            0 => {
                for c in col..buf.lines[row].cells.len() {
                    buf.lines[row].cells[c] = blank;
                }
            }
            1 => {
                for c in 0..=col.min(buf.lines[row].cells.len().saturating_sub(1)) {
                    buf.lines[row].cells[c] = blank;
                }
            }
            2 => {
                for cell in &mut buf.lines[row].cells {
                    *cell = blank;
                }
            }
            _ => {}
        }
    }

    pub fn erase_chars(&mut self, n: u16) {
        let buf = self.active_mut();
        let row = buf.cursor_row as usize;
        let col = buf.cursor_col as usize;
        let blank = Cell { ch: ' ', fg: DEFAULT_FG, bg: buf.pen.bg, flags: 0, width: 1 };
        if row < buf.lines.len() {
            let end = (col + n as usize).min(buf.lines[row].cells.len());
            for c in col..end {
                buf.lines[row].cells[c] = blank;
            }
        }
    }

    pub fn insert_blank_chars(&mut self, n: u16) {
        let cols = self.cols as usize;
        let buf = self.active_mut();
        let row = buf.cursor_row as usize;
        let col = buf.cursor_col as usize;
        if row >= buf.lines.len() {
            return;
        }
        let blank = Cell { ch: ' ', fg: DEFAULT_FG, bg: buf.pen.bg, flags: 0, width: 1 };
        let n = (n as usize).min(cols.saturating_sub(col));
        let line = &mut buf.lines[row].cells;
        for i in (col + n..cols).rev() {
            line[i] = line[i - n];
        }
        for i in col..(col + n).min(cols) {
            line[i] = blank;
        }
    }

    pub fn delete_chars(&mut self, n: u16) {
        let cols = self.cols as usize;
        let buf = self.active_mut();
        let row = buf.cursor_row as usize;
        let col = buf.cursor_col as usize;
        if row >= buf.lines.len() {
            return;
        }
        let blank = Cell { ch: ' ', fg: DEFAULT_FG, bg: buf.pen.bg, flags: 0, width: 1 };
        let n = (n as usize).min(cols.saturating_sub(col));
        let line = &mut buf.lines[row].cells;
        for i in col..(cols - n) {
            line[i] = line[i + n];
        }
        for i in (cols - n)..cols {
            line[i] = blank;
        }
    }

    pub fn resize(&mut self, new_cols: u16, new_rows: u16) {
        Self::resize_screen_buffer(&mut self.primary, new_cols, new_rows);
        Self::resize_screen_buffer(&mut self.alt, new_cols, new_rows);
        self.cols = new_cols;
        self.rows = new_rows;
        self.tab_stops = default_tab_stops(new_cols);
    }

    fn resize_screen_buffer(buf: &mut ScreenBuffer, new_cols: u16, new_rows: u16) {
        let old_rows = buf.lines.len() as u16;

        if new_cols != buf.cols {
            for row in &mut buf.lines {
                row.cells.resize(new_cols as usize, Cell::default());
            }
            buf.cols = new_cols;
        }

        if new_rows > old_rows {
            // Standard behavior: add blank rows at bottom.
            // Shell handles prompt redraw via SIGWINCH.
            for _ in 0..(new_rows - old_rows) {
                buf.lines.push(Row::new(new_cols as usize));
            }
        } else if new_rows < old_rows {
            let cursor_overflow =
                (buf.cursor_row as usize + 1).saturating_sub(new_rows as usize);
            // Clamp so drain never exceeds the Vec length (panic guard for resize to 1 row)
            let cursor_overflow = cursor_overflow.min(buf.lines.len());
            if cursor_overflow > 0 {
                // Push evicted top lines to scrollback before removing
                if buf.max_scrollback > 0 {
                    for row in buf.lines.drain(0..cursor_overflow) {
                        buf.scrollback.push_back(row);
                        if buf.scrollback.len() > buf.max_scrollback {
                            buf.scrollback.pop_front();
                        }
                    }
                } else {
                    buf.lines.drain(0..cursor_overflow);
                }
                buf.cursor_row -= cursor_overflow as u16;
            }
            buf.lines.truncate(new_rows as usize);
        }

        buf.cursor_col = buf.cursor_col.min(new_cols.saturating_sub(1));
        buf.cursor_row = buf.cursor_row.min(new_rows.saturating_sub(1));
        buf.scroll_top = 0;
        buf.scroll_bottom = new_rows.saturating_sub(1);
    }

    pub fn save_cursor(&mut self) {
        self.active_mut().save_cursor();
    }

    pub fn restore_cursor(&mut self) {
        self.active_mut().restore_cursor();
    }

    // --- Alt screen ---

    pub fn enter_alt_screen(&mut self) {
        if self.active_is_alt {
            return;
        }
        self.primary.save_cursor();
        self.active_is_alt = true;
        // Clear alt screen
        for r in 0..self.alt.lines.len() {
            for cell in &mut self.alt.lines[r].cells {
                *cell = Cell::default();
            }
        }
        self.alt.cursor_col = 0;
        self.alt.cursor_row = 0;
        self.alt.pen = Pen::default();
        self.alt.scroll_top = 0;
        self.alt.scroll_bottom = self.rows.saturating_sub(1);
    }

    pub fn leave_alt_screen(&mut self) {
        if !self.active_is_alt {
            return;
        }
        self.active_is_alt = false;
        self.primary.restore_cursor();
    }

    // --- Scroll regions ---

    pub fn set_scroll_region(&mut self, top: u16, bottom: u16) {
        let max = self.rows.saturating_sub(1);
        let buf = self.active_mut();
        buf.scroll_top = top.min(max);
        buf.scroll_bottom = bottom.min(max);
        if buf.scroll_top > buf.scroll_bottom {
            buf.scroll_top = 0;
            buf.scroll_bottom = max;
        }
        // Move cursor to home
        buf.cursor_col = 0;
        buf.cursor_row = 0;
    }

    pub fn scroll_up_in_region(&mut self) {
        self.active_mut().scroll_up_in_region();
    }

    pub fn scroll_down_in_region(&mut self) {
        self.active_mut().scroll_down_in_region();
    }

    pub fn insert_lines(&mut self, n: u16) {
        let cursor_row = self.active().cursor_row;
        self.active_mut().insert_lines(n, cursor_row);
    }

    pub fn delete_lines(&mut self, n: u16) {
        let cursor_row = self.active().cursor_row;
        self.active_mut().delete_lines(n, cursor_row);
    }

    pub fn reverse_index(&mut self) {
        let buf = self.active_mut();
        if buf.cursor_row == buf.scroll_top {
            buf.scroll_down_in_region();
        } else if buf.cursor_row > 0 {
            buf.cursor_row -= 1;
        }
    }

    /// IND — Index: move cursor down one line, scrolling if at bottom of scroll region.
    pub fn index(&mut self) {
        self.linefeed();
    }

    /// DECALN — fill screen with 'E' for alignment test.
    pub fn alignment_test(&mut self) {
        let buf = self.active_mut();
        for row in &mut buf.lines {
            for cell in &mut row.cells {
                cell.ch = 'E';
                cell.fg = crate::terminal::color::DEFAULT_FG;
                cell.bg = crate::terminal::color::DEFAULT_BG;
                cell.flags = 0;
                cell.width = 1;
            }
        }
    }

    /// Enter alt screen without save/restore cursor (CSI ? 47 h / 1047 h).
    pub fn enter_alt_screen_simple(&mut self) {
        if self.active_is_alt {
            return;
        }
        self.active_is_alt = true;
        for r in 0..self.alt.lines.len() {
            for cell in &mut self.alt.lines[r].cells {
                *cell = Cell::default();
            }
        }
        self.alt.cursor_col = 0;
        self.alt.cursor_row = 0;
        self.alt.pen = Pen::default();
        self.alt.scroll_top = 0;
        self.alt.scroll_bottom = self.rows.saturating_sub(1);
    }

    /// Leave alt screen without restore cursor (CSI ? 47 l / 1047 l).
    pub fn leave_alt_screen_simple(&mut self) {
        if !self.active_is_alt {
            return;
        }
        self.active_is_alt = false;
    }

    pub fn full_reset(&mut self) {
        let cols = self.cols;
        let rows = self.rows;
        let scrollback = self.primary.max_scrollback;
        *self = Grid::new(cols, rows, scrollback);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::color::{Rgb, DEFAULT_FG};

    fn make_buf(cols: u16, rows: u16) -> ScreenBuffer {
        ScreenBuffer::new(cols, rows, 1000)
    }

    // --- scroll_up_in_region ---

    #[test]
    fn scroll_up_shifts_rows() {
        let mut buf = make_buf(4, 3);
        buf.lines[0].cells[0].ch = 'A';
        buf.lines[1].cells[0].ch = 'B';
        buf.lines[2].cells[0].ch = 'C';

        buf.scroll_up_in_region();

        assert_eq!(buf.lines[0].cells[0].ch, 'B');
        assert_eq!(buf.lines[1].cells[0].ch, 'C');
        assert_eq!(buf.lines[2].cells[0].ch, ' ');
    }

    #[test]
    fn scroll_up_full_screen_pushes_to_scrollback() {
        let mut buf = make_buf(4, 3);
        buf.lines[0].cells[0].ch = 'X';

        buf.scroll_up_in_region();

        assert_eq!(buf.scrollback.len(), 1);
        assert_eq!(buf.scrollback[0].cells[0].ch, 'X');
    }

    #[test]
    fn scrollback_capped_at_max_scrollback() {
        let mut buf = ScreenBuffer::new(4, 2, 3);
        for i in 0..5u8 {
            buf.lines[0].cells[0].ch = (b'A' + i) as char;
            buf.scroll_up_in_region();
        }
        assert!(buf.scrollback.len() <= 3);
    }

    #[test]
    fn scroll_up_partial_region_does_not_push_scrollback() {
        let mut buf = make_buf(4, 4);
        buf.scroll_top = 1;
        buf.scroll_bottom = 3;
        buf.lines[1].cells[0].ch = 'P';
        buf.lines[2].cells[0].ch = 'Q';

        buf.scroll_up_in_region();

        // Partial region (scroll_top > 0): evicted row is NOT pushed to scrollback
        assert_eq!(buf.scrollback.len(), 0);
        // Region shifts up: P (top of region) is discarded, Q moves to row 1
        assert_eq!(buf.lines[1].cells[0].ch, 'Q');
        // New blank row at bottom of region
        assert_eq!(buf.lines[3].cells[0].ch, ' ');
        // Row 0 (outside region) unchanged
        assert_eq!(buf.lines[0].cells[0].ch, ' ');
    }

    #[test]
    fn scroll_up_clears_cleared_flag() {
        let mut buf = make_buf(4, 3);
        buf.cleared = true;

        buf.scroll_up_in_region();

        assert!(!buf.cleared);
    }

    // --- scroll_down_in_region ---

    #[test]
    fn scroll_down_shifts_rows_and_blanks_top() {
        let mut buf = make_buf(4, 3);
        buf.lines[0].cells[0].ch = 'A';
        buf.lines[1].cells[0].ch = 'B';
        buf.lines[2].cells[0].ch = 'C';

        buf.scroll_down_in_region();

        assert_eq!(buf.lines[0].cells[0].ch, ' ');
        assert_eq!(buf.lines[1].cells[0].ch, 'A');
        assert_eq!(buf.lines[2].cells[0].ch, 'B');
        // C is evicted (lost)
    }

    #[test]
    fn scroll_down_does_not_push_to_scrollback() {
        let mut buf = make_buf(4, 3);
        buf.lines[2].cells[0].ch = 'Z';

        buf.scroll_down_in_region();

        assert_eq!(buf.scrollback.len(), 0);
    }

    // --- insert_lines / delete_lines ---

    #[test]
    fn insert_lines_shifts_existing_content_down() {
        let mut buf = make_buf(4, 5);
        for (i, ch) in [b'A', b'B', b'C', b'D', b'E'].iter().enumerate() {
            buf.lines[i].cells[0].ch = *ch as char;
        }
        buf.scroll_top = 0;
        buf.scroll_bottom = 4;

        buf.insert_lines(2, 1);

        assert_eq!(buf.lines[0].cells[0].ch, 'A'); // unchanged
        assert_eq!(buf.lines[1].cells[0].ch, ' '); // blank
        assert_eq!(buf.lines[2].cells[0].ch, ' '); // blank
        assert_eq!(buf.lines[3].cells[0].ch, 'B'); // old row 1
        assert_eq!(buf.lines[4].cells[0].ch, 'C'); // old row 2
    }

    #[test]
    fn delete_lines_shifts_content_up() {
        let mut buf = make_buf(4, 5);
        for (i, ch) in [b'A', b'B', b'C', b'D', b'E'].iter().enumerate() {
            buf.lines[i].cells[0].ch = *ch as char;
        }
        buf.scroll_top = 0;
        buf.scroll_bottom = 4;

        buf.delete_lines(1, 1);

        assert_eq!(buf.lines[0].cells[0].ch, 'A'); // unchanged
        assert_eq!(buf.lines[1].cells[0].ch, 'C'); // old row 2
        assert_eq!(buf.lines[4].cells[0].ch, ' '); // last row blanked
    }

    #[test]
    fn insert_lines_outside_scroll_region_is_noop() {
        let mut buf = make_buf(4, 5);
        for (i, ch) in [b'A', b'B', b'C', b'D', b'E'].iter().enumerate() {
            buf.lines[i].cells[0].ch = *ch as char;
        }
        buf.scroll_top = 2;
        buf.scroll_bottom = 4;

        buf.insert_lines(1, 0); // cursor_row=0 < scroll_top=2

        // Content unchanged
        assert_eq!(buf.lines[0].cells[0].ch, 'A');
        assert_eq!(buf.lines[1].cells[0].ch, 'B');
    }

    // --- save_cursor / restore_cursor ---

    #[test]
    fn save_restore_cursor_preserves_position_and_pen() {
        let mut buf = make_buf(10, 10);
        buf.cursor_col = 3;
        buf.cursor_row = 7;
        buf.pen.fg = Rgb { r: 255, g: 0, b: 0 };
        buf.pen.flags = flags::BOLD;

        buf.save_cursor();

        // Mutate
        buf.cursor_col = 0;
        buf.cursor_row = 0;
        buf.pen.fg = DEFAULT_FG;
        buf.pen.flags = 0;

        buf.restore_cursor();

        assert_eq!(buf.cursor_col, 3);
        assert_eq!(buf.cursor_row, 7);
        assert_eq!(buf.pen.fg, Rgb { r: 255, g: 0, b: 0 });
        assert_eq!(buf.pen.flags, flags::BOLD);
    }

    // --- wide character write ---

    #[test]
    fn wide_char_writes_left_and_placeholder() {
        let mut grid = Grid::new(10, 5, 0);
        grid.write_char('あ'); // CJK, width=2
        assert_eq!(grid.primary.lines[0].cells[0].ch, 'あ');
        assert_eq!(grid.primary.lines[0].cells[0].width, 2);
        assert_eq!(grid.primary.lines[0].cells[1].ch, ' ');
        assert_eq!(grid.primary.lines[0].cells[1].width, 0);
        assert_eq!(grid.primary.cursor_col, 2);
    }

    #[test]
    fn wide_char_wraps_when_one_col_remaining() {
        let mut grid = Grid::new(5, 5, 0);
        // Move cursor to col 4 (last column)
        grid.primary.cursor_col = 4;
        grid.write_char('あ'); // width=2, doesn't fit → wraps
        assert_eq!(grid.primary.cursor_col, 2); // written at col 0 of next row
        assert_eq!(grid.primary.cursor_row, 1);
        assert_eq!(grid.primary.lines[1].cells[0].ch, 'あ');
    }
}
