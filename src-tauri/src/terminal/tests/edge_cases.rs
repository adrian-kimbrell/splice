use super::TerminalHarness;
use crate::terminal::color::{DEFAULT_BG, DEFAULT_FG};

// ── Tiny terminals ────────────────────────────────────────────────────────────

#[test]
fn one_by_one_terminal_no_panic() {
    let mut h = TerminalHarness::new(1, 1);
    h.feed_str("A");
    assert_eq!(h.char_at(0, 0), 'A');
}

#[test]
fn one_by_one_wrap_no_panic() {
    let mut h = TerminalHarness::new(1, 1);
    h.feed_str("ABCDE"); // fill + wrap repeatedly — should not panic
    // Last char wins
    assert_eq!(h.char_at(0, 0), 'E');
}

#[test]
fn two_col_wide_char_no_panic() {
    // Wide char in a 2-col terminal: fits exactly
    let mut h = TerminalHarness::new(2, 2);
    h.feed_str("あ"); // width=2
    assert_eq!(h.char_at(0, 0), 'あ');
}

// ── Cursor bounds ─────────────────────────────────────────────────────────────

#[test]
fn cursor_never_exceeds_cols() {
    let mut h = TerminalHarness::new(80, 24);
    for _ in 0..1000 {
        h.feed_str("\x1b[C"); // CUF 1
    }
    assert!(h.cursor().0 < 80, "cursor col {} must be < 80", h.cursor().0);
}

#[test]
fn cursor_never_exceeds_rows() {
    let mut h = TerminalHarness::new(80, 24);
    for _ in 0..1000 {
        h.feed_str("\x1b[B"); // CUD 1
    }
    assert!(h.cursor().1 < 24, "cursor row {} must be < 24", h.cursor().1);
}

#[test]
fn cup_beyond_bounds_clamped() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[9999;9999H");
    assert_eq!(h.cursor(), (79, 23));
}

// ── Zero-param treatment ─────────────────────────────────────────────────────

#[test]
fn zero_param_cuu_treated_as_one() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[5;1H");
    h.feed_str("\x1b[0A"); // CUU with param=0 → treated as 1
    assert_eq!(h.cursor().1, 3);
}

#[test]
fn zero_param_cud_treated_as_one() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[0B"); // CUD param=0 → move down 1
    assert_eq!(h.cursor().1, 1);
}

#[test]
fn zero_param_cuf_treated_as_one() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[0C");
    assert_eq!(h.cursor().0, 1);
}

// ── Very large params — no panics ────────────────────────────────────────────

#[test]
fn very_large_cuu_param_clamped_no_panic() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[5;1H");
    h.feed_str("\x1b[9999999A"); // should clamp, not panic
    assert_eq!(h.cursor().1, 0);
}

#[test]
fn very_large_ech_param_clamped_no_panic() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("ABCDE");
    h.feed_str("\x1b[1;1H");
    h.feed_str("\x1b[9999999X"); // should clamp to line length
}

#[test]
fn very_large_cup_no_panic() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[65535;65535H");
    assert_eq!(h.cursor(), (79, 23));
}

// ── C0 controls embedded in text ─────────────────────────────────────────────

#[test]
fn backspace_moves_cursor_back() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("AB");
    h.feed(b"\x08"); // BS
    h.feed_str("C");  // overwrites 'B' position
    assert_eq!(h.char_at(0, 1), 'C');
    assert_eq!(h.cursor().0, 2);
}

#[test]
fn cr_resets_col_to_zero() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("ABCDE");
    h.feed(b"\r");
    assert_eq!(h.cursor().0, 0);
}

#[test]
fn lf_advances_row() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("ABC\r\nDEF");
    assert_eq!(h.char_at(0, 0), 'A');
    assert_eq!(h.char_at(1, 0), 'D');
}

#[test]
fn cr_lf_overwrites_same_line() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("AAAAA\rBBBBB"); // CR then rewrite
    assert_eq!(h.row_text(0), "BBBBB");
}

#[test]
fn nul_byte_ignored() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("A");
    h.feed(b"\x00"); // NUL — should be ignored
    h.feed_str("B");
    // Cursor should be at col 2 (NUL did nothing)
    assert_eq!(h.cursor().0, 2);
    assert_eq!(h.char_at(0, 0), 'A');
    assert_eq!(h.char_at(0, 1), 'B');
}

#[test]
fn bel_sets_pending_bell() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed(b"\x07");
    assert!(h.pending_bell());
}

// ── Full reset ────────────────────────────────────────────────────────────────

#[test]
fn full_reset_clears_screen_and_scrollback() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("Hello World\n");
    h.feed_str("More text\n");
    h.feed_str("\x1b[?1000h"); // set some modes
    h.feed_str("\x1b[38;2;255;0;0m");
    h.feed_str("\x1bc"); // RIS — full reset
    // Screen cleared
    assert_eq!(h.row_text(0), "");
    // Cursor at origin
    assert_eq!(h.cursor(), (0, 0));
    // Modes reset
    assert_eq!(h.mouse_mode(), 0);
    // Pen reset to default
    assert_eq!(h.emu.grid.primary.pen.fg, DEFAULT_FG);
    assert_eq!(h.emu.grid.primary.pen.bg, DEFAULT_BG);
    assert_eq!(h.emu.grid.primary.pen.flags, 0);
}

// ── DECALN — screen alignment test ───────────────────────────────────────────

#[test]
fn decaln_fills_screen_with_e() {
    let mut h = TerminalHarness::new(10, 5);
    h.feed_str("\x1b#8"); // ESC # 8 = DECALN
    for row in 0..5 {
        for col in 0..10 {
            assert_eq!(h.char_at(row, col), 'E');
        }
    }
}

// ── REP — Repeat last character ───────────────────────────────────────────────

#[test]
fn rep_repeats_last_char() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("X");        // last_char = 'X'
    h.feed_str("\x1b[3b"); // REP 3: repeat 'X' 3 more times
    assert_eq!(h.char_at(0, 0), 'X');
    assert_eq!(h.char_at(0, 1), 'X');
    assert_eq!(h.char_at(0, 2), 'X');
    assert_eq!(h.char_at(0, 3), 'X');
    assert_eq!(h.cursor().0, 4);
}

// ── DECKPAM / DECKPNM ────────────────────────────────────────────────────────

#[test]
fn deckpam_sets_app_keypad() {
    let mut h = TerminalHarness::new(80, 24);
    assert!(!h.emu.grid.app_keypad);
    h.feed_str("\x1b="); // DECKPAM
    assert!(h.emu.grid.app_keypad);
}

#[test]
fn deckpnm_clears_app_keypad() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b="); // set
    h.feed_str("\x1b>"); // DECKPNM: clear
    assert!(!h.emu.grid.app_keypad);
}

// ── DECSCUSR — cursor style ───────────────────────────────────────────────────

#[test]
fn decscusr_sets_cursor_style() {
    let mut h = TerminalHarness::new(80, 24);
    for style in 0u8..=6 {
        h.feed_str(&format!("\x1b[{} q", style));
        assert_eq!(h.emu.grid.cursor_style, style, "style {}", style);
    }
}

#[test]
fn decscusr_zero_is_default_block() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[4 q"); // underline cursor
    h.feed_str("\x1b[0 q"); // back to default (0 = default blinking block)
    assert_eq!(h.emu.grid.cursor_style, 0);
}

// ── Unknown sequences are silently ignored ───────────────────────────────────

#[test]
fn unknown_csi_sequence_ignored_no_panic() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("before");
    h.feed_str("\x1b[999;999;999y"); // unknown CSI
    h.feed_str("after");
    assert_eq!(h.char_at(0, 0), 'b');
}
