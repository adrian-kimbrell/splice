use super::TerminalHarness;

// ── Default tab stops ─────────────────────────────────────────────────────────

#[test]
fn default_tab_stops_at_8() {
    let mut h = TerminalHarness::new(80, 5);
    // Tab from col 0 → should jump to col 8
    h.feed(b"\t");
    assert_eq!(h.cursor().0, 8);
}

#[test]
fn tab_from_col_8_jumps_to_col_16() {
    let mut h = TerminalHarness::new(80, 5);
    h.feed_str("\x1b[1;9H"); // col=9 (1-based) = col=8 (0-based)
    h.feed(b"\t");
    assert_eq!(h.cursor().0, 16);
}

#[test]
fn tab_at_last_stop_stays_at_last_col() {
    let mut h = TerminalHarness::new(20, 5); // tab stops at 8, 16; 20 cols
    // Move to col 16 (last tab stop that fits in 20 cols)
    h.feed_str("\x1b[1;17H"); // col=17 (1-based) = col=16 (0-based)
    h.feed(b"\t"); // no more tab stop → goes to cols-1 = 19
    assert_eq!(h.cursor().0, 19);
}

#[test]
fn multiple_tabs_advance_correctly() {
    let mut h = TerminalHarness::new(80, 5);
    h.feed(b"\t\t"); // two tabs from col 0 → col 8 → col 16
    assert_eq!(h.cursor().0, 16);
}

// ── HTS — Horizontal Tab Set ─────────────────────────────────────────────────

#[test]
fn hts_sets_tab_stop_at_cursor() {
    let mut h = TerminalHarness::new(80, 5);
    // Move to col 5 and set a tab stop there
    h.feed_str("\x1b[1;6H"); // col=6 (1-based) = col=5 (0-based)
    h.esc("H");              // HTS
    // Now tab from col 0 should go to col 5 (new stop before col 8)
    h.feed_str("\x1b[1;1H"); // back to col 0
    h.feed(b"\t");
    assert_eq!(h.cursor().0, 5);
}

// ── TBC — Tab Clear ───────────────────────────────────────────────────────────

#[test]
fn tbc_clears_current_tab_stop() {
    let mut h = TerminalHarness::new(80, 5);
    // Move cursor to the default tab stop at col 8
    h.feed_str("\x1b[1;9H"); // col=9 (1-based) = col=8 (0-based)
    h.feed_str("\x1b[0g");   // TBC: clear tab stop at cursor (col 8)
    // Tab from col 0 should now skip col 8 and go to col 16
    h.feed_str("\x1b[1;1H");
    h.feed(b"\t");
    assert_eq!(h.cursor().0, 16);
}

#[test]
fn tbc_clears_all_tab_stops() {
    let mut h = TerminalHarness::new(80, 5);
    h.feed_str("\x1b[3g"); // TBC: clear all tab stops
    // Tab from col 0 should go to cols-1 (no stops remaining)
    h.feed(b"\t");
    assert_eq!(h.cursor().0, 79); // last column
}

// ── Backtab (CBT) ─────────────────────────────────────────────────────────────

#[test]
fn backtab_moves_to_previous_tab_stop() {
    let mut h = TerminalHarness::new(80, 5);
    h.feed_str("\x1b[1;17H"); // col=17 (1-based) = col=16 (0-based)
    h.feed_str("\x1b[Z");     // CBT 1: backtab
    assert_eq!(h.cursor().0, 8);
}

#[test]
fn backtab_n_tabs() {
    let mut h = TerminalHarness::new(80, 5);
    h.feed_str("\x1b[1;25H"); // col=25 (1-based) = col=24 (0-based), between stops 16 and 24
    h.feed_str("\x1b[2Z");    // CBT 2: go back 2 tab stops
    assert_eq!(h.cursor().0, 8);
}

#[test]
fn backtab_at_col_zero_stays() {
    let mut h = TerminalHarness::new(80, 5);
    // Cursor already at col 0
    h.feed_str("\x1b[Z");
    assert_eq!(h.cursor().0, 0);
}
