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
    assert!(col <= 0);
    assert!(row <= 0);
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
