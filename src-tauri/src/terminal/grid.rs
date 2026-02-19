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
}

impl Default for Cell {
    fn default() -> Self {
        Self {
            ch: ' ',
            fg: DEFAULT_FG,
            bg: DEFAULT_BG,
            flags: 0,
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
    (0..cols).map(|c| c % 8 == 0).collect()
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
}

impl Grid {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            cols,
            rows,
            primary: ScreenBuffer::new(cols, rows, 10000),
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
        self.last_char = c;
        let cols = self.cols;
        let auto_wrap = self.auto_wrap;
        let buf = self.active_mut();
        if buf.cursor_col >= cols {
            if auto_wrap {
                buf.cursor_col = 0;
                // inline linefeed logic to avoid borrow issues
                if buf.cursor_row >= buf.scroll_bottom {
                    if buf.cursor_row == buf.scroll_bottom {
                        buf.scroll_up_in_region();
                    }
                    // cursor stays at scroll_bottom
                } else {
                    buf.cursor_row += 1;
                }
            } else {
                buf.cursor_col = cols.saturating_sub(1);
            }
        }
        let col = buf.cursor_col as usize;
        let row = buf.cursor_row as usize;
        if row < buf.lines.len() && col < buf.lines[row].cells.len() {
            buf.lines[row].cells[col] = Cell {
                ch: c,
                fg: buf.pen.fg,
                bg: buf.pen.bg,
                flags: buf.pen.flags,
            };
        }
        buf.cursor_col += 1;
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
        let buf = self.active_mut();
        let start = buf.cursor_col as usize + 1;
        for c in start..cols as usize {
            if self.tab_stops.get(c).copied().unwrap_or(false) {
                self.active_mut().cursor_col = c as u16;
                return;
            }
        }
        self.active_mut().cursor_col = cols.saturating_sub(1);
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
        buf.cursor_row = (buf.cursor_row + n).min(max_row);
    }

    pub fn cursor_forward(&mut self, n: u16) {
        let cols = self.cols;
        let buf = self.active_mut();
        buf.cursor_col = (buf.cursor_col + n).min(cols.saturating_sub(1));
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
        match mode {
            0 => {
                if row < buf.lines.len() {
                    for c in col..buf.lines[row].cells.len() {
                        buf.lines[row].cells[c] = Cell::default();
                    }
                }
                for r in (row + 1)..buf.lines.len() {
                    for cell in &mut buf.lines[r].cells {
                        *cell = Cell::default();
                    }
                }
            }
            1 => {
                for r in 0..row {
                    for cell in &mut buf.lines[r].cells {
                        *cell = Cell::default();
                    }
                }
                if row < buf.lines.len() {
                    for c in 0..=col.min(buf.lines[row].cells.len().saturating_sub(1)) {
                        buf.lines[row].cells[c] = Cell::default();
                    }
                }
            }
            2 => {
                for r in 0..buf.lines.len() {
                    for cell in &mut buf.lines[r].cells {
                        *cell = Cell::default();
                    }
                }
                buf.cleared = true;
            }
            3 => {
                for r in 0..buf.lines.len() {
                    for cell in &mut buf.lines[r].cells {
                        *cell = Cell::default();
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
        match mode {
            0 => {
                for c in col..buf.lines[row].cells.len() {
                    buf.lines[row].cells[c] = Cell::default();
                }
            }
            1 => {
                for c in 0..=col.min(buf.lines[row].cells.len().saturating_sub(1)) {
                    buf.lines[row].cells[c] = Cell::default();
                }
            }
            2 => {
                for cell in &mut buf.lines[row].cells {
                    *cell = Cell::default();
                }
            }
            _ => {}
        }
    }

    pub fn erase_chars(&mut self, n: u16) {
        let buf = self.active_mut();
        let row = buf.cursor_row as usize;
        let col = buf.cursor_col as usize;
        if row < buf.lines.len() {
            let end = (col + n as usize).min(buf.lines[row].cells.len());
            for c in col..end {
                buf.lines[row].cells[c] = Cell::default();
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
        let n = (n as usize).min(cols.saturating_sub(col));
        let line = &mut buf.lines[row].cells;
        for i in (col + n..cols).rev() {
            line[i] = line[i - n];
        }
        for i in col..(col + n).min(cols) {
            line[i] = Cell::default();
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
        let n = (n as usize).min(cols.saturating_sub(col));
        let line = &mut buf.lines[row].cells;
        for i in col..(cols - n) {
            line[i] = line[i + n];
        }
        for i in (cols - n)..cols {
            line[i] = Cell::default();
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
        *self = Grid::new(cols, rows);
    }
}
