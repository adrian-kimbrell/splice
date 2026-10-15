use super::TerminalHarness;

// ── Column changes ────────────────────────────────────────────────────────────

#[test]
fn grow_cols_adds_blank_cells() {
    let mut h = TerminalHarness::new(10, 5);
    h.feed_str("ABCDEFGHIJ"); // fill row 0
    h.emu.resize(15, 5);
    // Original cells preserved
    assert_eq!(h.char_at(0, 0), 'A');
    assert_eq!(h.char_at(0, 9), 'J');
    // New cells blank
    assert_eq!(h.char_at(0, 10), ' ');
    assert_eq!(h.char_at(0, 14), ' ');
    assert_eq!(h.emu.grid.cols, 15);
}

#[test]
fn shrink_cols_truncates_rows() {
    let mut h = TerminalHarness::new(10, 5);
    h.feed_str("ABCDEFGHIJ");
    h.emu.resize(5, 5);
    // Only first 5 cells remain
    assert_eq!(h.char_at(0, 0), 'A');
    assert_eq!(h.char_at(0, 4), 'E');
    assert_eq!(h.emu.grid.cols, 5);
    // Row has exactly 5 cells
    assert_eq!(h.emu.grid.primary.lines[0].cells.len(), 5);
}

// ── Row changes ───────────────────────────────────────────────────────────────

#[test]
fn grow_rows_adds_blank_lines() {
    let mut h = TerminalHarness::new(10, 3);
    h.feed_str("AAA\r\nBBB\r\nCCC");
    h.emu.resize(10, 5);
    assert_eq!(h.emu.grid.rows, 5);
    assert_eq!(h.row_text(0), "AAA");
    assert_eq!(h.row_text(1), "BBB");
    assert_eq!(h.row_text(2), "CCC");
    // New rows are blank
    assert_eq!(h.row_text(3), "");
    assert_eq!(h.row_text(4), "");
}

#[test]
fn shrink_rows_pushes_to_scrollback() {
    let mut h = TerminalHarness::new(10, 5);
    // Fill all rows, cursor at bottom (use \r\n so content starts at col 0)
    h.feed_str("ROW0\r\nROW1\r\nROW2\r\nROW3\r\nROW4");
    assert_eq!(h.cursor().1, 4); // cursor at last row
    // Shrink to 3 rows: rows 0 and 1 should be pushed to scrollback
    h.emu.resize(10, 3);
    assert_eq!(h.emu.grid.rows, 3);
    assert!(h.scrollback_len() >= 2);
    assert_eq!(h.scrollback_text(0), "ROW0");
    assert_eq!(h.scrollback_text(1), "ROW1");
}

#[test]
fn cursor_clamped_on_shrink() {
    let mut h = TerminalHarness::new(20, 10);
    h.feed_str("\x1b[8;15H"); // row=8 (1-based), col=15 (1-based) → row=7, col=14
    assert_eq!(h.cursor(), (14, 7));
    h.emu.resize(10, 5); // shrink both
    let (col, row) = h.cursor();
    assert!(col <= 9, "col {} must be <= 9", col);
    assert!(row <= 4, "row {} must be <= 4", row);
}

#[test]
fn resize_1x1_terminal_no_panic() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("Hello");
    h.emu.resize(1, 1); // extreme shrink
    // Should not panic; cursor at (0, 0)
    let (col, row) = h.cursor();
    assert_eq!(col, 0);
    assert_eq!(row, 0);
}

#[test]
fn resize_preserves_scrollback() {
    let mut h = TerminalHarness::new(20, 3);
    h.feed_str("PRESERVED\n");
    h.feed_str("line2\n");
    h.feed_str("line3\n");
    h.feed_str("line4\n");
    let sb_before = h.scrollback_len();
    h.emu.resize(30, 5);
    assert_eq!(h.scrollback_len(), sb_before);
}

#[test]
fn resize_resets_scroll_region_to_full_screen() {
    let mut h = TerminalHarness::new(10, 10);
    h.feed_str("\x1b[3;7r"); // partial scroll region
    h.emu.resize(10, 8);
    // After resize, scroll region should be reset to full screen
    let buf = h.emu.grid.active();
    assert_eq!(buf.scroll_top, 0);
    assert_eq!(buf.scroll_bottom, 7);
}

// ── Same-size resize is a no-op ───────────────────────────────────────────────

#[test]
fn same_size_resize_preserves_content() {
    let mut h = TerminalHarness::new(10, 5);
    h.feed_str("HELLO");
    h.emu.resize(10, 5);
    assert_eq!(h.row_text(0), "HELLO");
}

// ── Saved cursor vs. resize ───────────────────────────────────────────────────
// Regression: DECSC/alt-screen saved the cursor at row 23 of 24; the pane shrank to
// 10 rows while vim was open; DECRC restored row 23 into a 10-row grid. Every
// printed character was then dropped (write_char bounds check) and `CSI 1 J`
// indexed past the end of `lines` and panicked.

#[test]
fn restore_cursor_after_shrink_is_clamped_and_output_is_visible() {
    let mut h = TerminalHarness::new(10, 5);
    h.feed_str("a\r\nb\r\nc\r\nd\r\nprompt"); // cursor on row 4
    assert_eq!(h.cursor().1, 4);
    h.esc("7"); // DECSC
    h.emu.resize(10, 2);
    h.esc("8"); // DECRC
    let (_, row) = h.cursor();
    assert!(row <= 1, "restored row {row} must be inside the 2-row grid");
    h.feed_str("\r\nhello");
    assert!(
        h.screen_text().iter().any(|l| l.contains("hello")),
        "output after restore must land on screen: {:?}",
        h.screen_text()
    );
}

#[test]
fn erase_above_after_restore_into_smaller_grid_does_not_panic() {
    let mut h = TerminalHarness::new(10, 5);
    h.feed_str("a\r\nb\r\nc\r\nd\r\ne");
    h.esc("7");
    h.emu.resize(10, 2);
    h.esc("8");
    h.csi("1J"); // used to index lines[0..4] in a 2-row buffer
    assert_eq!(h.emu.grid.rows, 2);
}

#[test]
fn alt_screen_round_trip_across_shrink_keeps_cursor_in_bounds() {
    let mut h = TerminalHarness::new(10, 5);
    h.feed_str("a\r\nb\r\nc\r\nd\r\nprompt");
    h.csi("?1049h"); // save cursor + switch to alt screen (vim)
    h.emu.resize(10, 2);
    h.csi("?1049l"); // leave alt screen + restore cursor (quit vim)
    assert!(h.cursor().1 <= 1);
    h.feed_str("\r\nback");
    assert!(h.screen_text().iter().any(|l| l.contains("back")), "{:?}", h.screen_text());
}

#[test]
fn saved_cursor_follows_content_pushed_to_scrollback() {
    // Save on row 1 of 5 with the cursor on row 4; shrinking to 3 rows evicts two
    // top rows into scrollback, so the saved row moves up by two as well.
    let mut h = TerminalHarness::new(10, 5);
    h.feed_str("a\r\nb");
    h.esc("7"); // saved at row 1
    h.feed_str("\r\nc\r\nd\r\ne"); // cursor row 4
    h.emu.resize(10, 3);
    h.esc("8");
    assert_eq!(h.cursor().1, 0, "saved row 1 minus two evicted rows");
}
