use super::TerminalHarness;

// ── DECSTBM — Set Top and Bottom Margins ─────────────────────────────────────

#[test]
fn decstbm_restricts_scroll_to_region() {
    let mut h = TerminalHarness::new(10, 6);
    // Write content in rows 0–5 (use \r\n so cursor col resets between rows)
    h.feed_str("AAA\r\nBBB\r\nCCC\r\nDDD\r\nEEE\r\nFFF");
    // Set scroll region to rows 3–5 (1-based: rows 3–5 = 0-based: 2–4)
    h.feed_str("\x1b[3;5r"); // DECSTBM: top=3, bottom=5
    // Cursor should go home after DECSTBM
    assert_eq!(h.cursor(), (0, 0));
    // Move cursor to bottom of scroll region (row 5, 1-based = row 4, 0-based)
    h.feed_str("\x1b[5;1H");
    h.feed_str("\n"); // LF at bottom of region → scroll only within region
    // Row 2 (first in region, 0-based) should now be "DDD" (row 3 shifted up)
    assert_eq!(h.row_text(2), "DDD");
    // Row 0 and 1 (outside region) should be unchanged
    assert_eq!(h.row_text(0), "AAA");
    assert_eq!(h.row_text(1), "BBB");
}

#[test]
fn decstbm_resets_cursor_to_home() {
    let mut h = TerminalHarness::new(10, 6);
    h.feed_str("\x1b[5;5H"); // move cursor away
    h.feed_str("\x1b[2;4r"); // DECSTBM
    assert_eq!(h.cursor(), (0, 0));
}

#[test]
fn lf_at_scroll_bottom_scrolls_in_region() {
    let mut h = TerminalHarness::new(10, 5);
    // Set scroll region rows 2–4 (1-based) = 0-based rows 1–3
    h.feed_str("\x1b[2;4r");
    // Position cursor and write (CUP resets col to 0, so cursor column is fine)
    h.feed_str("\x1b[2;1H"); h.feed_str("ROW1");
    h.feed_str("\x1b[3;1H"); h.feed_str("ROW2");
    h.feed_str("\x1b[4;1H"); h.feed_str("ROW3");
    // Move to scroll_bottom (row 4, 1-based = row 3, 0-based) and LF
    h.feed_str("\x1b[4;1H");
    h.feed_str("\n"); // LF at bottom of region → scroll region up
    assert_eq!(h.row_text(1), "ROW2");
    assert_eq!(h.row_text(2), "ROW3");
    assert_eq!(h.row_text(3), ""); // blank line inserted at bottom
}

#[test]
fn lf_outside_region_does_not_scroll() {
    let mut h = TerminalHarness::new(10, 5);
    h.feed_str("AAA\r\nBBB\r\nCCC");
    // Set region to rows 4–5 (1-based) — cursor is now at row 2 (0-based)
    h.feed_str("\x1b[4;5r");
    // Cursor outside the region; LF should just move cursor down, not scroll
    h.feed_str("\x1b[3;1H"); // row 3 (1-based) = row 2 (0-based), outside region
    h.feed_str("\n");         // move down to row 3 (0-based) — no scroll
    // Row 0 should still have original content
    assert_eq!(h.row_text(0), "AAA");
    assert_eq!(h.row_text(1), "BBB");
}

#[test]
fn decstbm_full_screen_is_default() {
    let mut h = TerminalHarness::new(10, 5);
    // Explicitly set full-screen region
    h.feed_str("\x1b[1;5r");
    let buf = h.emu.grid.active();
    assert_eq!(buf.scroll_top, 0);
    assert_eq!(buf.scroll_bottom, 4);
}

// ── IL / DL — Insert / Delete Lines ─────────────────────────────────────────

#[test]
fn il_insert_n_lines_at_cursor() {
    let mut h = TerminalHarness::new(10, 5);
    h.feed_str("AAAAA\r\nBBBBB\r\nCCCCC\r\nDDDDD\r\nEEEEE");
    h.feed_str("\x1b[2;1H"); // cursor to row 2 (1-based) = row 1 (0-based)
    h.feed_str("\x1b[2L");   // IL: insert 2 blank lines
    assert_eq!(h.row_text(0), "AAAAA");
    assert_eq!(h.row_text(1), "");     // blank
    assert_eq!(h.row_text(2), "");     // blank
    assert_eq!(h.row_text(3), "BBBBB");
    assert_eq!(h.row_text(4), "CCCCC");
    // DDDDD and EEEEE are pushed off the bottom
}

#[test]
fn dl_delete_n_lines() {
    let mut h = TerminalHarness::new(10, 5);
    h.feed_str("AAAAA\r\nBBBBB\r\nCCCCC\r\nDDDDD\r\nEEEEE");
    h.feed_str("\x1b[2;1H"); // cursor to row 2 (1-based) = row 1 (0-based)
    h.feed_str("\x1b[2M");   // DL: delete 2 lines — rows 1&2 (BBBBB,CCCCC) removed
    // Rows 3 and 4 shift up; blanks inserted at bottom
    assert_eq!(h.row_text(0), "AAAAA");
    assert_eq!(h.row_text(1), "DDDDD"); // was row 3
    assert_eq!(h.row_text(2), "EEEEE"); // was row 4
    assert_eq!(h.row_text(3), "");      // blank
    assert_eq!(h.row_text(4), "");      // blank
}

#[test]
fn il_outside_scroll_region_noop() {
    let mut h = TerminalHarness::new(10, 5);
    h.feed_str("AAAAA\r\nBBBBB\r\nCCCCC");
    // Set scroll region rows 3–5 (1-based) = 0-based 2–4
    h.feed_str("\x1b[3;5r");
    // Cursor is now at row 0 (home after DECSTBM)
    // Insert lines at row 0 — outside scroll region → noop
    h.feed_str("\x1b[2L");
    assert_eq!(h.row_text(0), "AAAAA");
    assert_eq!(h.row_text(1), "BBBBB");
}

#[test]
fn dl_outside_scroll_region_noop() {
    let mut h = TerminalHarness::new(10, 5);
    h.feed_str("AAAAA\r\nBBBBB\r\nCCCCC");
    h.feed_str("\x1b[3;5r");
    // Cursor at row 0 (outside region)
    h.feed_str("\x1b[2M"); // delete outside region → noop
    assert_eq!(h.row_text(0), "AAAAA");
}

// ── RI at top of scroll region ────────────────────────────────────────────────

#[test]
fn ri_at_top_of_region_scrolls_down_in_region() {
    let mut h = TerminalHarness::new(10, 5);
    // Set scroll region rows 2–4 (1-based) = 0-based 1–3
    h.feed_str("\x1b[2;4r");
    // Write content in region using explicit CUP (resets col to 0)
    h.feed_str("\x1b[2;1H"); h.feed_str("ROW1");
    h.feed_str("\x1b[3;1H"); h.feed_str("ROW2");
    h.feed_str("\x1b[4;1H"); h.feed_str("ROW3");
    // Move cursor to scroll_top (row 1, 0-based) and reverse index
    h.feed_str("\x1b[2;1H");
    h.feed_str("\x1bM"); // RI at scroll_top → scroll_down_in_region
    // Blank line inserted at top of region; old content shifts down
    assert_eq!(h.row_text(1), ""); // blank line inserted at scroll_top
    assert_eq!(h.row_text(2), "ROW1");
    assert_eq!(h.row_text(3), "ROW2");
    // ROW3 was at the bottom of the region and got pushed out
}

// ── Scroll commands (CSI S / T) ───────────────────────────────────────────────

#[test]
fn csi_s_scrolls_up_n_lines() {
    let mut h = TerminalHarness::new(10, 4);
    h.feed_str("AAAA\r\nBBBB\r\nCCCC\r\nDDDD");
    h.feed_str("\x1b[1;1H");
    h.feed_str("\x1b[2S"); // scroll up 2 lines
    assert_eq!(h.row_text(0), "CCCC");
    assert_eq!(h.row_text(1), "DDDD");
    assert_eq!(h.row_text(2), "");
    assert_eq!(h.row_text(3), "");
}

#[test]
fn csi_t_scrolls_down_n_lines() {
    let mut h = TerminalHarness::new(10, 4);
    h.feed_str("AAAA\r\nBBBB\r\nCCCC\r\nDDDD");
    h.feed_str("\x1b[1;1H");
    h.feed_str("\x1b[2T"); // scroll down 2 lines
    assert_eq!(h.row_text(0), "");
    assert_eq!(h.row_text(1), "");
    assert_eq!(h.row_text(2), "AAAA");
    assert_eq!(h.row_text(3), "BBBB");
}

// ── Scroll region boundary enforcement ───────────────────────────────────────

#[test]
fn cursor_down_clamped_at_scroll_bottom() {
    let mut h = TerminalHarness::new(10, 10);
    h.feed_str("\x1b[2;5r"); // scroll region rows 2–5 (0-based 1–4)
    h.feed_str("\x1b[2;1H"); // cursor at row 1 (inside region)
    h.feed_str("\x1b[99B");  // large CUD — clamps at scroll_bottom (row 4)
    assert_eq!(h.cursor().1, 4);
}

#[test]
fn cursor_up_clamped_at_scroll_top() {
    let mut h = TerminalHarness::new(10, 10);
    h.feed_str("\x1b[3;8r"); // scroll region rows 3–8 (0-based 2–7)
    h.feed_str("\x1b[5;1H"); // cursor at row 4 (inside region)
    h.feed_str("\x1b[99A");  // large CUU — clamps at scroll_top (row 2)
    assert_eq!(h.cursor().1, 2);
}
