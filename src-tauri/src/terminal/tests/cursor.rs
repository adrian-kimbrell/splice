use super::TerminalHarness;

// ── CUP (Cursor Position) ─────────────────────────────────────────────────────

#[test]
fn cup_absolute() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[5;10H"); // row=5, col=10 (1-based)
    assert_eq!(h.cursor(), (9, 4)); // 0-based
}

#[test]
fn cup_zero_params_treated_as_one() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[5;5H");  // move away first
    h.feed_str("\x1b[0;0H"); // 0 → treated as 1 → home
    assert_eq!(h.cursor(), (0, 0));
}

#[test]
fn cup_clamps_to_grid() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[999;999H");
    assert_eq!(h.cursor(), (79, 23));
}

#[test]
fn cup_one_one_is_home() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[5;5H");
    h.feed_str("\x1b[1;1H");
    assert_eq!(h.cursor(), (0, 0));
}

// ── CUU / CUD / CUF / CUB ────────────────────────────────────────────────────

#[test]
fn cuu_by_one() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[5;1H"); // row=5 (0-based 4)
    h.feed_str("\x1b[A");    // CUU 1
    assert_eq!(h.cursor().1, 3);
}

#[test]
fn cuu_by_n() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[10;1H");
    h.feed_str("\x1b[3A"); // CUU 3
    assert_eq!(h.cursor().1, 6);
}

#[test]
fn cuu_clamps_at_top() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[2;1H"); // row=2 (0-based 1)
    h.feed_str("\x1b[99A");  // large CUU — should clamp to row 0
    assert_eq!(h.cursor().1, 0);
}

#[test]
fn cud_by_n() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[1;1H");  // home
    h.feed_str("\x1b[2B");    // CUD 2
    assert_eq!(h.cursor().1, 2);
}

#[test]
fn cud_clamps_at_bottom() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[99B");
    assert_eq!(h.cursor().1, 23);
}

#[test]
fn cuf_by_n() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[1;1H");
    h.feed_str("\x1b[5C"); // CUF 5
    assert_eq!(h.cursor().0, 5);
}

#[test]
fn cuf_clamps_at_right_edge() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[999C");
    assert_eq!(h.cursor().0, 79);
}

#[test]
fn cub_by_n() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[1;10H"); // col=10 (0-based 9)
    h.feed_str("\x1b[3D");    // CUB 3
    assert_eq!(h.cursor().0, 6);
}

#[test]
fn cub_clamps_at_col_zero() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[1;5H"); // col=5 (0-based 4)
    h.feed_str("\x1b[999D");
    assert_eq!(h.cursor().0, 0);
}

// ── Save / Restore cursor ─────────────────────────────────────────────────────

#[test]
fn save_restore_cursor_position() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[5;10H"); // set position
    h.feed_str("\x1b7");       // DECSC save
    h.feed_str("\x1b[1;1H");  // move to home
    h.feed_str("\x1b8");       // DECRC restore
    assert_eq!(h.cursor(), (9, 4));
}

#[test]
fn save_restore_via_csi_s_u() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[8;20H");
    h.feed_str("\x1b[s"); // CSI s = save
    h.feed_str("\x1b[1;1H");
    h.feed_str("\x1b[u"); // CSI u = restore
    assert_eq!(h.cursor(), (19, 7));
}

// ── HPA / VPA ─────────────────────────────────────────────────────────────────

#[test]
fn hpa_sets_column() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[5;5H");
    h.feed_str("\x1b[10G"); // HPA: col=10 (1-based) → col=9 (0-based)
    assert_eq!(h.cursor().0, 9);
    assert_eq!(h.cursor().1, 4); // row unchanged
}

#[test]
fn vpa_sets_row() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[5;5H");
    h.feed_str("\x1b[8d"); // VPA: row=8 (1-based) → row=7 (0-based)
    assert_eq!(h.cursor().0, 4); // col unchanged
    assert_eq!(h.cursor().1, 7);
}

// ── NEL / RI ──────────────────────────────────────────────────────────────────

#[test]
fn nel_moves_to_col_zero_and_down() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[3;10H"); // row=3, col=10 (0-based: row=2, col=9)
    h.feed_str("\x1bE");       // NEL = CR + LF
    assert_eq!(h.cursor(), (0, 3));
}

#[test]
fn ri_moves_cursor_up_one_row() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[5;1H"); // row=5 (0-based 4)
    h.feed_str("\x1bM");      // RI = reverse index
    assert_eq!(h.cursor().1, 3);
}

#[test]
fn ri_at_scroll_top_scrolls_content_down() {
    let mut h = TerminalHarness::new(10, 5);
    // Write 'A' at row 0
    h.feed_str("A");
    h.feed_str("\x1b[1;1H"); // back to home (row 0)
    h.feed_str("\x1bM");      // RI at scroll_top=0 → scroll down, blank inserted at top
    // Row 0 should now be blank (new blank row inserted), original 'A' pushed to row 1
    assert_eq!(h.char_at(0, 0), ' ');
    assert_eq!(h.char_at(1, 0), 'A');
}

// ── DSR cursor position report ────────────────────────────────────────────────

#[test]
fn dsr_cursor_report_one_based() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[5;10H"); // row=5, col=10 (1-based)
    h.feed_str("\x1b[6n");    // DSR request
    let reply = h.take_reply();
    let expected = b"\x1b[5;10R";
    assert_eq!(reply, expected);
}

#[test]
fn dsr_at_home_reports_one_one() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[6n");
    let reply = h.take_reply();
    assert_eq!(reply, b"\x1b[1;1R");
}

// ── CNL / CPL ─────────────────────────────────────────────────────────────────

#[test]
fn cnl_moves_down_and_to_col_zero() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[3;10H"); // row=3, col=10 (0-based: row=2, col=9)
    h.feed_str("\x1b[2E");    // CNL 2
    assert_eq!(h.cursor(), (0, 4));
}

#[test]
fn cpl_moves_up_and_to_col_zero() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[10;10H");
    h.feed_str("\x1b[3F"); // CPL 3
    assert_eq!(h.cursor(), (0, 6));
}

// ── IND — Index (ESC D) ───────────────────────────────────────────────────────

#[test]
fn ind_moves_cursor_down_one_row() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[3;5H"); // row=3, col=5 (1-based) → row=2, col=4
    h.esc("D");               // IND
    assert_eq!(h.cursor(), (4, 3)); // col unchanged, row+1
}

#[test]
fn ind_at_scroll_bottom_scrolls_up() {
    let mut h = TerminalHarness::new(10, 3);
    h.feed_str("AAA");        // row 0
    h.feed_str("\x1b[3;1H"); // cursor to scroll_bottom (row 2, 0-based)
    h.esc("D");               // IND at bottom → scroll
    assert_eq!(h.scrollback_len(), 1);
    assert_eq!(h.scrollback_text(0), "AAA");
}

#[test]
fn ind_col_unchanged() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[5;10H");
    h.esc("D");
    assert_eq!(h.cursor().0, 9); // col stays
}

// ── Cursor visibility ─────────────────────────────────────────────────────────

#[test]
fn hide_and_show_cursor() {
    let mut h = TerminalHarness::new(80, 24);
    assert!(h.cursor_visible());
    h.feed_str("\x1b[?25l"); // hide
    assert!(!h.cursor_visible());
    h.feed_str("\x1b[?25h"); // show
    assert!(h.cursor_visible());
}
