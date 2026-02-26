use super::TerminalHarness;

// ── Mouse modes ───────────────────────────────────────────────────────────────

#[test]
fn mouse_x10_set_clear() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[?1000h");
    assert_eq!(h.mouse_mode(), 1);
    h.feed_str("\x1b[?1000l");
    assert_eq!(h.mouse_mode(), 0);
}

#[test]
fn mouse_button_tracking_set_clear() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[?1002h");
    assert_eq!(h.mouse_mode(), 2);
    h.feed_str("\x1b[?1002l");
    assert_eq!(h.mouse_mode(), 0);
}

#[test]
fn mouse_any_event_set_clear() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[?1003h");
    assert_eq!(h.mouse_mode(), 3);
    h.feed_str("\x1b[?1003l");
    assert_eq!(h.mouse_mode(), 0);
}

#[test]
fn mouse_only_one_mode_active_at_a_time() {
    // Setting mode 1002 while 1000 is active replaces it
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[?1000h");
    h.feed_str("\x1b[?1002h");
    assert_eq!(h.mouse_mode(), 2);
    h.feed_str("\x1b[?1002l");
    assert_eq!(h.mouse_mode(), 0);
}

#[test]
fn mouse_clear_wrong_mode_ignored() {
    // Clearing mode 1000 when mode 1002 is active should be a no-op
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[?1002h");
    h.feed_str("\x1b[?1000l"); // try to clear x10 — should not clear 1002
    assert_eq!(h.mouse_mode(), 2);
}

// ── SGR mouse ─────────────────────────────────────────────────────────────────

#[test]
fn mouse_sgr_set_clear() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[?1006h");
    assert!(h.mouse_sgr());
    h.feed_str("\x1b[?1006l");
    assert!(!h.mouse_sgr());
}

// ── Focus events ──────────────────────────────────────────────────────────────

#[test]
fn focus_events_set_clear() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[?1004h");
    assert!(h.focus_events());
    h.feed_str("\x1b[?1004l");
    assert!(!h.focus_events());
}

// ── Bracketed paste ───────────────────────────────────────────────────────────

#[test]
fn bracketed_paste_set_clear() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[?2004h");
    assert!(h.bracketed_paste());
    h.feed_str("\x1b[?2004l");
    assert!(!h.bracketed_paste());
}

// ── Application cursor keys ───────────────────────────────────────────────────

#[test]
fn app_cursor_keys_set_clear() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[?1h");
    assert!(h.app_cursor_keys());
    h.feed_str("\x1b[?1l");
    assert!(!h.app_cursor_keys());
}

// ── DECAWM (auto-wrap mode) ───────────────────────────────────────────────────

#[test]
fn decawm_disable_overwrites_last_cell() {
    let mut h = TerminalHarness::new(5, 3);
    h.feed_str("\x1b[?7l"); // disable auto-wrap
    assert!(!h.auto_wrap());
    // Write 7 chars — extra chars overwrite the last cell, no wrap
    h.feed_str("ABCDEFG");
    // A-E fill cols 0-4; F and G overwrite col 4
    assert_eq!(h.char_at(0, 0), 'A');
    assert_eq!(h.char_at(0, 4), 'G');
    // Row 1 should be empty (no wrap occurred)
    assert_eq!(h.row_text(1), "");
}

#[test]
fn decawm_enable_wraps_normally() {
    let mut h = TerminalHarness::new(5, 3);
    h.feed_str("\x1b[?7h"); // enable auto-wrap (default)
    assert!(h.auto_wrap());
    h.feed_str("ABCDEFG");
    assert_eq!(h.char_at(0, 4), 'E');
    assert_eq!(h.char_at(1, 0), 'F');
    assert_eq!(h.char_at(1, 1), 'G');
}

// ── Alt screen ────────────────────────────────────────────────────────────────

#[test]
fn alt_screen_state_isolation() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("Primary content");
    h.feed_str("\x1b[?1049h"); // enter alt screen
    assert!(h.is_alt_screen());
    // Alt screen starts blank
    assert_eq!(h.row_text(0), "");
    // Primary screen is unaffected
    assert_eq!(h.emu.grid.primary.lines[0].cells[0].ch, 'P');
}

#[test]
fn alt_screen_leave_restores_primary() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("Main");
    h.feed_str("\x1b[?1049h");
    h.feed_str("Alt content");
    h.feed_str("\x1b[?1049l"); // leave alt screen
    assert!(!h.is_alt_screen());
    assert_eq!(h.row_text(0), "Main");
}

#[test]
fn alt_screen_simple_47() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[?47h"); // enter alt (no cursor save)
    assert!(h.is_alt_screen());
    h.feed_str("\x1b[?47l"); // leave alt
    assert!(!h.is_alt_screen());
}

#[test]
fn alt_screen_restores_primary_scrollback_intact() {
    let mut h = TerminalHarness::new(10, 2);
    // Generate some scrollback on primary
    h.feed_str("SB line\n");
    h.feed_str("line2\n");
    let sb_before = h.scrollback_len();
    // Enter and leave alt screen
    h.feed_str("\x1b[?1049h");
    h.feed_str("\x1b[?1049l");
    // Primary scrollback should be unchanged
    assert_eq!(h.scrollback_len(), sb_before);
}

// ── Full reset ────────────────────────────────────────────────────────────────

#[test]
fn full_reset_clears_all_modes() {
    let mut h = TerminalHarness::new(80, 24);
    // Enable a bunch of modes
    h.feed_str("\x1b[?1000h");
    h.feed_str("\x1b[?1006h");
    h.feed_str("\x1b[?1004h");
    h.feed_str("\x1b[?2004h");
    h.feed_str("\x1b[?1h");
    h.feed_str("\x1b[?7l"); // disable autowrap
    h.feed_str("\x1b[?25l"); // hide cursor
    // Full reset
    h.feed_str("\x1bc");
    assert_eq!(h.mouse_mode(), 0);
    assert!(!h.mouse_sgr());
    assert!(!h.focus_events());
    assert!(!h.bracketed_paste());
    assert!(!h.app_cursor_keys());
    assert!(h.auto_wrap()); // autowrap restored to true
    assert!(h.cursor_visible()); // cursor visible again
    assert!(!h.is_alt_screen());
}

// ── Multiple DEC modes in one sequence ───────────────────────────────────────

#[test]
fn multi_mode_set_in_one_sequence() {
    // CSI ? 1049 ; 1 h — set both alt screen and app cursor keys
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[?1049;1h");
    assert!(h.is_alt_screen());
    assert!(h.app_cursor_keys());
}

// ── Mode interaction edge cases ───────────────────────────────────────────────

#[test]
fn single_row_scroll_region_becomes_blank_on_lf() {
    // A scroll region that is exactly one row tall (scroll_top == scroll_bottom).
    // LF when cursor is at that row should make it blank (content scrolled out).
    let mut h = TerminalHarness::new(10, 5);
    h.feed_str("AAA\r\nBBB\r\nCCC\r\nDDD\r\nEEE");
    // Set region to row 3 only (1-based 3–3 = 0-based row 2)
    h.feed_str("\x1b[3;3r");       // DECSTBM; cursor goes home (row 0)
    h.feed_str("\x1b[3;1H");       // move cursor to the single-row region
    h.feed_str("\n");               // LF at scroll_bottom == scroll_top → row becomes blank
    assert_eq!(h.row_text(2), ""); // the region row was cleared
    // Rows outside the region are untouched
    assert_eq!(h.row_text(0), "AAA");
    assert_eq!(h.row_text(1), "BBB");
}

#[test]
fn decawm_off_wide_char_at_last_col_no_panic() {
    // With DECAWM off, feeding a wide char when only 1 column remains should
    // not panic. The char either overwrites the last cell or is discarded.
    // cursor_col may land at `cols` (pending-wrap state) — that is valid.
    let mut h = TerminalHarness::new(10, 3);
    h.feed_str("\x1b[?7l");    // disable auto-wrap
    h.feed_str("\x1b[1;10H"); // move to col 10 (1-based) = col 9 (0-based), last col
    h.feed_str("あ");          // wide char — only 1 cell available; should not panic
    // Cursor stays on row 0 (no wrap occurred)
    assert_eq!(h.cursor().1, 0);
    // Row 1 should be empty (no wrap)
    assert_eq!(h.row_text(1), "");
}
