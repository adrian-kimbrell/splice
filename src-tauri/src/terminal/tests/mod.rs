use crate::terminal::color::Rgb;
use crate::terminal::term::Emulator;

pub mod charset;
pub mod cursor;
pub mod edge_cases;
pub mod emitter_integration;
pub mod erase;
pub mod fuzz;
pub mod modes;
pub mod osc;
pub mod real_apps;
pub mod replies;
pub mod resize;
pub mod scroll_region;
pub mod scrollback;
pub mod sgr;
pub mod split_sequence;
pub mod tabs;

// ── TerminalHarness ───────────────────────────────────────────────────────────

#[allow(dead_code)]
pub struct TerminalHarness {
    pub emu: Emulator,
}

#[allow(dead_code)]
impl TerminalHarness {
    /// Create a harness with 1 000-line scrollback.
    pub fn new(cols: u16, rows: u16) -> Self {
        Self { emu: Emulator::new(cols, rows, 1000) }
    }

    /// Create a harness with a custom scrollback limit.
    pub fn with_scrollback(cols: u16, rows: u16, sb: usize) -> Self {
        Self { emu: Emulator::new(cols, rows, sb) }
    }

    // ── Feed helpers ──────────────────────────────────────────────────────────

    pub fn feed(&mut self, bytes: &[u8]) -> &mut Self {
        self.emu.advance(bytes);
        self
    }

    pub fn feed_str(&mut self, s: &str) -> &mut Self {
        self.emu.advance(s.as_bytes());
        self
    }

    /// Feed `ESC [ {s}` (CSI sequence).
    pub fn csi(&mut self, s: &str) -> &mut Self {
        self.feed_str(&format!("\x1b[{s}"));
        self
    }

    /// Feed `ESC ] {s} BEL` (OSC sequence).
    pub fn osc(&mut self, s: &str) -> &mut Self {
        self.feed_str(&format!("\x1b]{s}\x07"));
        self
    }

    /// Feed `ESC {s}` (escape sequence).
    pub fn esc(&mut self, s: &str) -> &mut Self {
        self.feed_str(&format!("\x1b{s}"));
        self
    }

    // ── Cell accessors (0-based row/col) ──────────────────────────────────────

    pub fn char_at(&self, row: usize, col: usize) -> char {
        self.emu.grid.active().lines[row].cells[col].ch
    }

    pub fn fg_at(&self, row: usize, col: usize) -> Rgb {
        self.emu.grid.active().lines[row].cells[col].fg
    }

    pub fn bg_at(&self, row: usize, col: usize) -> Rgb {
        self.emu.grid.active().lines[row].cells[col].bg
    }

    pub fn flags_at(&self, row: usize, col: usize) -> u8 {
        self.emu.grid.active().lines[row].cells[col].flags
    }

    pub fn width_at(&self, row: usize, col: usize) -> u8 {
        self.emu.grid.active().lines[row].cells[col].width
    }

    // ── Row/screen helpers ────────────────────────────────────────────────────

    /// Collect non-placeholder cells of `row` into a string (nulls → space),
    /// then trim trailing whitespace.
    pub fn row_text(&self, row: usize) -> String {
        let buf = self.emu.grid.active();
        let s: String = buf.lines[row]
            .cells
            .iter()
            .filter(|c| c.width != 0)
            .map(|c| if c.ch == '\0' { ' ' } else { c.ch })
            .collect();
        s.trim_end().to_string()
    }

    /// All visible rows as trimmed strings.
    pub fn screen_text(&self) -> Vec<String> {
        let rows = self.emu.grid.rows as usize;
        (0..rows).map(|r| self.row_text(r)).collect()
    }

    // ── Cursor ────────────────────────────────────────────────────────────────

    /// Returns `(col, row)` — both 0-based.
    pub fn cursor(&self) -> (u16, u16) {
        (self.emu.grid.cursor_col(), self.emu.grid.cursor_row())
    }

    pub fn cursor_visible(&self) -> bool {
        self.emu.grid.cursor_visible
    }

    // ── Scrollback (primary buffer only) ─────────────────────────────────────

    pub fn scrollback_len(&self) -> usize {
        self.emu.grid.primary.scrollback.len()
    }

    /// `idx == 0` is the oldest line.
    pub fn scrollback_text(&self, idx: usize) -> String {
        let row = &self.emu.grid.primary.scrollback[idx];
        let s: String = row
            .cells
            .iter()
            .filter(|c| c.width != 0)
            .map(|c| if c.ch == '\0' { ' ' } else { c.ch })
            .collect();
        s.trim_end().to_string()
    }

    // ── Mode flags ────────────────────────────────────────────────────────────

    pub fn mouse_mode(&self) -> u8 {
        self.emu.grid.mouse_mode
    }

    pub fn mouse_sgr(&self) -> bool {
        self.emu.grid.mouse_sgr
    }

    pub fn focus_events(&self) -> bool {
        self.emu.grid.focus_events
    }

    pub fn bracketed_paste(&self) -> bool {
        self.emu.grid.bracketed_paste
    }

    pub fn app_cursor_keys(&self) -> bool {
        self.emu.grid.app_cursor_keys
    }

    pub fn is_alt_screen(&self) -> bool {
        self.emu.grid.active_is_alt
    }

    pub fn auto_wrap(&self) -> bool {
        self.emu.grid.auto_wrap
    }

    // ── Side-effects ──────────────────────────────────────────────────────────

    pub fn pending_title(&self) -> Option<&str> {
        self.emu.pending_title.as_deref()
    }

    pub fn pending_bell(&self) -> bool {
        self.emu.pending_bell
    }

    pub fn take_reply(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.emu.pending_reply)
    }

    pub fn take_clipboard(&mut self) -> Option<String> {
        self.emu.pending_clipboard.take()
    }
}
