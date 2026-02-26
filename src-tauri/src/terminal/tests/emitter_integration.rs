use super::TerminalHarness;
use crate::terminal::color::Rgb;
use crate::terminal::emitter::serialize_grid;
use crate::terminal::grid::flags;

// ── Helpers ───────────────────────────────────────────────────────────────────

fn header_cursor_col(data: &[u8]) -> u16 {
    u16::from_le_bytes([data[4], data[5]])
}
fn header_cursor_row(data: &[u8]) -> u16 {
    u16::from_le_bytes([data[6], data[7]])
}
fn header_cursor_visible(data: &[u8]) -> u8 {
    data[8]
}
fn header_cursor_style(data: &[u8]) -> u8 {
    data[9]
}
fn header_mode_flags(data: &[u8]) -> u8 {
    data[10]
}
fn header_is_scrolled(data: &[u8]) -> u8 {
    data[11]
}
fn header_scrollback_len(data: &[u8]) -> u32 {
    u32::from_le_bytes([data[16], data[17], data[18], data[19]])
}

/// Return (codepoint, fg, bg, flags, width) for a cell at 0-based row/col.
fn cell_at(data: &[u8], cols: u16, row: usize, col: usize) -> (char, Rgb, Rgb, u8, u8) {
    let offset = 20 + (row * cols as usize + col) * 12;
    let cp = u32::from_le_bytes([
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
    ]);
    let fg = Rgb {
        r: data[offset + 4],
        g: data[offset + 5],
        b: data[offset + 6],
    };
    let bg = Rgb {
        r: data[offset + 7],
        g: data[offset + 8],
        b: data[offset + 9],
    };
    let cell_flags = data[offset + 10];
    let width = data[offset + 11];
    (char::from_u32(cp).unwrap_or(' '), fg, bg, cell_flags, width)
}

// ── Frame layout ──────────────────────────────────────────────────────────────

#[test]
fn frame_size_is_header_plus_cells() {
    let h = TerminalHarness::new(80, 24);
    let data = serialize_grid(&h.emu.grid, 0);
    assert_eq!(data.len(), 20 + 80 * 24 * 12);
}

#[test]
fn frame_cols_rows_in_header() {
    let h = TerminalHarness::new(40, 12);
    let data = serialize_grid(&h.emu.grid, 0);
    assert_eq!(u16::from_le_bytes([data[0], data[1]]), 40);
    assert_eq!(u16::from_le_bytes([data[2], data[3]]), 12);
}

// ── Cursor position ───────────────────────────────────────────────────────────

#[test]
fn frame_cursor_position_after_cup() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[10;20H"); // row=10, col=20 (1-based) → 0-based: row=9, col=19
    let data = serialize_grid(&h.emu.grid, 0);
    assert_eq!(header_cursor_col(&data), 19);
    assert_eq!(header_cursor_row(&data), 9);
    assert_eq!(header_cursor_visible(&data), 1);
}

#[test]
fn frame_cursor_hidden_after_hide_sequence() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[?25l");
    let data = serialize_grid(&h.emu.grid, 0);
    assert_eq!(header_cursor_visible(&data), 0);
}

#[test]
fn frame_cursor_style_reflected() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[4 q"); // underline cursor
    let data = serialize_grid(&h.emu.grid, 0);
    assert_eq!(header_cursor_style(&data), 4);
}

// ── Mode flags ────────────────────────────────────────────────────────────────

#[test]
fn frame_mode_flags_bracketed_paste() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[?2004h");
    let data = serialize_grid(&h.emu.grid, 0);
    assert_ne!(header_mode_flags(&data) & 0x01, 0, "bracketed_paste bit 0");
}

#[test]
fn frame_mode_flags_app_cursor_keys() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[?1h");
    let data = serialize_grid(&h.emu.grid, 0);
    assert_ne!(header_mode_flags(&data) & 0x02, 0, "app_cursor_keys bit 1");
}

#[test]
fn frame_mode_flags_app_keypad() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b="); // DECKPAM
    let data = serialize_grid(&h.emu.grid, 0);
    assert_ne!(header_mode_flags(&data) & 0x04, 0, "app_keypad bit 2");
}

#[test]
fn frame_mode_flags_mouse_mode_in_bits_3_4() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[?1003h"); // any-event = mode 3
    let data = serialize_grid(&h.emu.grid, 0);
    assert_eq!((header_mode_flags(&data) >> 3) & 0x3, 3);
}

#[test]
fn frame_mode_flags_mouse_sgr() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[?1006h");
    let data = serialize_grid(&h.emu.grid, 0);
    assert_ne!(header_mode_flags(&data) & 0x20, 0);
}

#[test]
fn frame_mode_flags_focus_events() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[?1004h");
    let data = serialize_grid(&h.emu.grid, 0);
    assert_ne!(header_mode_flags(&data) & 0x40, 0);
}

// ── Cell data ─────────────────────────────────────────────────────────────────

#[test]
fn frame_cell_codepoints_match_written_text() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("Hello");
    let data = serialize_grid(&h.emu.grid, 0);
    for (col, ch) in "Hello".chars().enumerate() {
        let (got, _, _, _, _) = cell_at(&data, 20, 0, col);
        assert_eq!(got, ch, "col {col}");
    }
}

#[test]
fn frame_cell_truecolor_fg_bg() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("\x1b[38;2;200;100;50m");
    h.feed_str("\x1b[48;2;10;20;30m");
    h.feed_str("X");
    let data = serialize_grid(&h.emu.grid, 0);
    let (_, fg, bg, _, _) = cell_at(&data, 20, 0, 0);
    assert_eq!(fg, Rgb { r: 200, g: 100, b: 50 });
    assert_eq!(bg, Rgb { r: 10, g: 20, b: 30 });
}

#[test]
fn frame_cell_bold_flag() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("\x1b[1m");
    h.feed_str("B");
    let data = serialize_grid(&h.emu.grid, 0);
    let (_, _, _, cell_flags, _) = cell_at(&data, 20, 0, 0);
    assert_ne!(cell_flags & flags::BOLD, 0);
}

#[test]
fn frame_cell_italic_flag() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("\x1b[3m");
    h.feed_str("I");
    let data = serialize_grid(&h.emu.grid, 0);
    let (_, _, _, cell_flags, _) = cell_at(&data, 20, 0, 0);
    assert_ne!(cell_flags & flags::ITALIC, 0);
}

#[test]
fn frame_cell_underline_flag() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("\x1b[4m");
    h.feed_str("U");
    let data = serialize_grid(&h.emu.grid, 0);
    let (_, _, _, cell_flags, _) = cell_at(&data, 20, 0, 0);
    assert_ne!(cell_flags & flags::UNDERLINE, 0);
}

#[test]
fn frame_cell_wide_char_width_bytes() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("あ"); // width=2
    let data = serialize_grid(&h.emu.grid, 0);
    let (ch, _, _, _, w0) = cell_at(&data, 20, 0, 0);
    let (_, _, _, _, w1) = cell_at(&data, 20, 0, 1);
    assert_eq!(ch, 'あ');
    assert_eq!(w0, 2); // wide left
    assert_eq!(w1, 0); // wide right placeholder
}

// ── Scrollback in frame ───────────────────────────────────────────────────────

#[test]
fn frame_scrollback_len_grows_with_pushed_rows() {
    let mut h = TerminalHarness::new(10, 2);
    // 3 LFs on a 2-row terminal push rows to scrollback
    h.feed_str("line1\r\nline2\r\nline3\r\n");
    let data = serialize_grid(&h.emu.grid, 0);
    let sb_len = header_scrollback_len(&data);
    assert!(sb_len >= 2, "expected ≥2 scrollback rows, got {sb_len}");
}

#[test]
fn frame_scrolled_state_hides_cursor() {
    let mut h = TerminalHarness::new(10, 2);
    h.feed_str("line1\r\nline2\r\nline3\r\n"); // generate scrollback
    assert!(h.scrollback_len() > 0);
    let data = serialize_grid(&h.emu.grid, 1);
    assert_eq!(header_is_scrolled(&data), 1);
    assert_eq!(header_cursor_visible(&data), 0);
}

#[test]
fn frame_not_scrolled_when_offset_zero() {
    let mut h = TerminalHarness::new(10, 2);
    h.feed_str("line1\r\nline2\r\nline3\r\n");
    let data = serialize_grid(&h.emu.grid, 0);
    assert_eq!(header_is_scrolled(&data), 0);
}

// ── Round-trip: feed → serialize → verify ────────────────────────────────────

#[test]
fn round_trip_multiline_text() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("AAA\r\nBBB\r\nCCC");
    let data = serialize_grid(&h.emu.grid, 0);
    let (a, _, _, _, _) = cell_at(&data, 20, 0, 0);
    let (b, _, _, _, _) = cell_at(&data, 20, 1, 0);
    let (c, _, _, _, _) = cell_at(&data, 20, 2, 0);
    assert_eq!(a, 'A');
    assert_eq!(b, 'B');
    assert_eq!(c, 'C');
}

#[test]
fn round_trip_sgr_reset_clears_colors() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("\x1b[38;2;255;0;0m"); // red fg
    h.feed_str("R");
    h.feed_str("\x1b[0m");            // reset
    h.feed_str("N");                   // normal
    let data = serialize_grid(&h.emu.grid, 0);
    let (_, fg_r, _, _, _) = cell_at(&data, 20, 0, 0);
    let (_, fg_n, _, _, _) = cell_at(&data, 20, 0, 1);
    // 'R' should have red fg
    assert_eq!(fg_r, Rgb { r: 255, g: 0, b: 0 });
    // 'N' should have default fg (not red)
    use crate::terminal::color::DEFAULT_FG;
    assert_eq!(fg_n, DEFAULT_FG);
}
