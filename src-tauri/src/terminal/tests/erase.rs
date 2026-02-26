use super::TerminalHarness;
use crate::terminal::color::{Rgb, DEFAULT_BG, DEFAULT_FG};

// ── ED — Erase in Display ─────────────────────────────────────────────────────

#[test]
fn ed0_from_cursor_to_end() {
    let mut h = TerminalHarness::new(10, 3);
    // Write "ABCDE" on row 0
    h.feed_str("ABCDE");
    // Move cursor to col 2 (third char)
    h.feed_str("\x1b[1;3H"); // row=1, col=3 (1-based) → row=0, col=2
    h.feed_str("\x1b[0J");   // ED 0: from cursor to end
    assert_eq!(h.char_at(0, 0), 'A');
    assert_eq!(h.char_at(0, 1), 'B');
    // col 2+ should be cleared
    assert_eq!(h.char_at(0, 2), ' ');
    assert_eq!(h.char_at(0, 3), ' ');
    assert_eq!(h.char_at(0, 4), ' ');
    // row 1 and 2 also cleared
    assert_eq!(h.char_at(1, 0), ' ');
    assert_eq!(h.char_at(2, 0), ' ');
}

#[test]
fn ed1_from_start_to_cursor() {
    let mut h = TerminalHarness::new(10, 3);
    h.feed_str("ABCDE");
    h.feed_str("\x1b[1;4H"); // cursor to row=0, col=3 (1-based)
    h.feed_str("\x1b[1J");   // ED 1: from start to cursor (inclusive)
    // cols 0..=3 cleared
    assert_eq!(h.char_at(0, 0), ' ');
    assert_eq!(h.char_at(0, 1), ' ');
    assert_eq!(h.char_at(0, 2), ' ');
    assert_eq!(h.char_at(0, 3), ' ');
    // col 4 unchanged
    assert_eq!(h.char_at(0, 4), 'E');
}

#[test]
fn ed2_clears_entire_screen_preserves_cursor() {
    let mut h = TerminalHarness::new(10, 3);
    h.feed_str("ABCDE");
    h.feed_str("\x1b[2;5H"); // move cursor away
    h.feed_str("\x1b[2J");   // ED 2
    // All cells cleared
    for row in 0..3 {
        for col in 0..10 {
            assert_eq!(h.char_at(row, col), ' ');
        }
    }
    // Cursor NOT moved by ED 2
    assert_eq!(h.cursor(), (4, 1));
}

#[test]
fn ed2_sets_cleared_flag() {
    let mut h = TerminalHarness::new(10, 3);
    h.feed_str("\x1b[2J");
    assert!(h.emu.grid.primary.cleared);
}

#[test]
fn ed3_also_clears_scrollback() {
    let mut h = TerminalHarness::new(10, 3);
    // Trigger some scrollback by scrolling
    for _ in 0..5 {
        h.feed_str("line\n");
    }
    assert!(h.scrollback_len() > 0);
    h.feed_str("\x1b[3J"); // ED 3: clear screen + scrollback
    assert_eq!(h.scrollback_len(), 0);
}

// ── EL — Erase in Line ────────────────────────────────────────────────────────

#[test]
fn el0_from_cursor_to_end_of_line() {
    let mut h = TerminalHarness::new(10, 3);
    h.feed_str("ABCDE");
    h.feed_str("\x1b[1;3H"); // row=0, col=2
    h.feed_str("\x1b[0K");   // EL 0
    assert_eq!(h.char_at(0, 0), 'A');
    assert_eq!(h.char_at(0, 1), 'B');
    assert_eq!(h.char_at(0, 2), ' ');
    assert_eq!(h.char_at(0, 4), ' ');
}

#[test]
fn el1_from_start_to_cursor() {
    let mut h = TerminalHarness::new(10, 3);
    h.feed_str("ABCDE");
    h.feed_str("\x1b[1;4H"); // row=0, col=3
    h.feed_str("\x1b[1K");   // EL 1
    assert_eq!(h.char_at(0, 0), ' ');
    assert_eq!(h.char_at(0, 1), ' ');
    assert_eq!(h.char_at(0, 2), ' ');
    assert_eq!(h.char_at(0, 3), ' ');
    assert_eq!(h.char_at(0, 4), 'E');
}

#[test]
fn el2_entire_line() {
    let mut h = TerminalHarness::new(10, 3);
    h.feed_str("ABCDE");
    h.feed_str("\x1b[1;1H");
    h.feed_str("\x1b[2K"); // EL 2
    for col in 0..10 {
        assert_eq!(h.char_at(0, col), ' ');
    }
}

#[test]
fn el_does_not_affect_other_rows() {
    let mut h = TerminalHarness::new(10, 3);
    h.feed_str("AAAAAA\n");
    h.feed_str("BBBBBB");
    h.feed_str("\x1b[2;1H"); // cursor to row 1
    h.feed_str("\x1b[2K");   // clear row 1
    assert_eq!(h.char_at(0, 0), 'A'); // row 0 untouched
}

// ── ECH — Erase Characters ────────────────────────────────────────────────────

#[test]
fn ech_erases_n_chars_at_cursor() {
    let mut h = TerminalHarness::new(10, 3);
    h.feed_str("ABCDEFGH");
    h.feed_str("\x1b[1;3H"); // row=0, col=2
    h.feed_str("\x1b[3X");   // ECH: erase 3 chars
    assert_eq!(h.char_at(0, 0), 'A');
    assert_eq!(h.char_at(0, 1), 'B');
    assert_eq!(h.char_at(0, 2), ' ');
    assert_eq!(h.char_at(0, 3), ' ');
    assert_eq!(h.char_at(0, 4), ' ');
    assert_eq!(h.char_at(0, 5), 'F'); // unchanged
}

#[test]
fn ech_past_end_of_line_clamped() {
    let mut h = TerminalHarness::new(10, 3);
    h.feed_str("ABCDE");
    h.feed_str("\x1b[1;8H"); // col=7 (0-based)
    h.feed_str("\x1b[9999X"); // far past end — should not panic
    assert_eq!(h.char_at(0, 0), 'A'); // other rows untouched
}

#[test]
fn ech_does_not_move_cursor() {
    let mut h = TerminalHarness::new(10, 3);
    h.feed_str("ABCDE");
    h.feed_str("\x1b[1;3H"); // row=0, col=2
    h.feed_str("\x1b[5X");
    assert_eq!(h.cursor(), (2, 0)); // cursor unmoved
}

// ── DCH / ICH ─────────────────────────────────────────────────────────────────

#[test]
fn dch_shifts_remaining_chars_left() {
    let mut h = TerminalHarness::new(10, 3);
    h.feed_str("ABCDE");
    h.feed_str("\x1b[1;2H"); // col=1
    h.feed_str("\x1b[2P");   // DCH: delete 2 chars
    // B and C deleted; D, E shift left to cols 1, 2; blanks at end
    assert_eq!(h.char_at(0, 0), 'A');
    assert_eq!(h.char_at(0, 1), 'D');
    assert_eq!(h.char_at(0, 2), 'E');
    assert_eq!(h.char_at(0, 3), ' ');
    assert_eq!(h.char_at(0, 4), ' ');
}

#[test]
fn ich_inserts_blank_chars_shifting_right() {
    let mut h = TerminalHarness::new(10, 3);
    h.feed_str("ABCDE");
    h.feed_str("\x1b[1;2H"); // col=1
    h.feed_str("\x1b[2@");   // ICH: insert 2 blanks
    assert_eq!(h.char_at(0, 0), 'A');
    assert_eq!(h.char_at(0, 1), ' ');
    assert_eq!(h.char_at(0, 2), ' ');
    assert_eq!(h.char_at(0, 3), 'B');
    assert_eq!(h.char_at(0, 4), 'C');
}

// ── BCE — Background Color Erase ─────────────────────────────────────────────
// Erased cells adopt the current pen background color (BCE compliance).

#[test]
fn bce_el2_uses_pen_bg() {
    let mut h = TerminalHarness::new(10, 3);
    h.feed_str("\x1b[48;2;0;200;100m"); // set custom bg
    h.feed_str("A");
    h.feed_str("\x1b[1;1H");
    h.feed_str("\x1b[2K"); // EL 2 with custom bg active
    assert_eq!(h.fg_at(0, 0), DEFAULT_FG);
    assert_eq!(h.bg_at(0, 0), Rgb { r: 0, g: 200, b: 100 });
}

#[test]
fn bce_ed2_uses_pen_bg() {
    let mut h = TerminalHarness::new(10, 3);
    h.feed_str("\x1b[48;2;50;60;70m");
    h.feed_str("\x1b[2J"); // ED 2
    assert_eq!(h.bg_at(0, 0), Rgb { r: 50, g: 60, b: 70 });
    assert_eq!(h.bg_at(2, 9), Rgb { r: 50, g: 60, b: 70 });
}

#[test]
fn bce_ech_uses_pen_bg() {
    let mut h = TerminalHarness::new(10, 3);
    h.feed_str("ABCDE");
    h.feed_str("\x1b[48;2;100;0;200m");
    h.feed_str("\x1b[1;2H"); // col 1
    h.feed_str("\x1b[3X"); // ECH 3
    assert_eq!(h.bg_at(0, 1), Rgb { r: 100, g: 0, b: 200 });
    assert_eq!(h.bg_at(0, 3), Rgb { r: 100, g: 0, b: 200 });
    assert_eq!(h.char_at(0, 4), 'E'); // unchanged
}

#[test]
fn bce_ich_uses_pen_bg() {
    let mut h = TerminalHarness::new(10, 3);
    h.feed_str("ABCDE");
    h.feed_str("\x1b[48;2;10;20;30m");
    h.feed_str("\x1b[1;2H"); // col 1
    h.feed_str("\x1b[2@"); // ICH 2: insert 2 blanks at col 1
    assert_eq!(h.bg_at(0, 1), Rgb { r: 10, g: 20, b: 30 });
    assert_eq!(h.bg_at(0, 2), Rgb { r: 10, g: 20, b: 30 });
}

#[test]
fn bce_dch_uses_pen_bg_for_trailing_blanks() {
    let mut h = TerminalHarness::new(10, 3);
    h.feed_str("ABCDE");
    h.feed_str("\x1b[48;2;5;5;5m");
    h.feed_str("\x1b[1;2H"); // col 1
    h.feed_str("\x1b[2P"); // DCH 2: delete 2 chars at col 1
    // Trailing blank cells at end of line get pen bg
    assert_eq!(h.bg_at(0, 8), Rgb { r: 5, g: 5, b: 5 });
    assert_eq!(h.bg_at(0, 9), Rgb { r: 5, g: 5, b: 5 });
}

#[test]
fn bce_default_pen_gives_default_bg() {
    // When pen is default, erase should produce DEFAULT_BG
    let mut h = TerminalHarness::new(10, 3);
    h.feed_str("HELLO");
    h.feed_str("\x1b[1;1H");
    h.feed_str("\x1b[2K");
    assert_eq!(h.bg_at(0, 0), DEFAULT_BG);
}

#[test]
fn bce_fg_always_stays_default() {
    // BCE only applies pen bg; fg is always DEFAULT_FG on erased cells
    let mut h = TerminalHarness::new(10, 3);
    h.feed_str("\x1b[38;2;255;0;0m"); // red fg
    h.feed_str("\x1b[48;2;0;0;255m"); // blue bg
    h.feed_str("\x1b[2K");
    assert_eq!(h.fg_at(0, 0), DEFAULT_FG); // fg reset to default
    assert_eq!(h.bg_at(0, 0), Rgb { r: 0, g: 0, b: 255 }); // bg from pen
}
