use super::TerminalHarness;

// ── Basic push ────────────────────────────────────────────────────────────────

#[test]
fn pushes_to_scrollback_on_lf_at_bottom() {
    let mut h = TerminalHarness::new(10, 3);
    h.feed_str("AAA"); // row 0
    h.feed_str("\n");
    h.feed_str("BBB"); // row 1
    h.feed_str("\n");
    h.feed_str("CCC"); // row 2 = scroll_bottom
    h.feed_str("\n");  // LF at bottom → scroll up → "AAA" pushed to scrollback
    assert!(h.scrollback_len() >= 1);
    assert_eq!(h.scrollback_text(0), "AAA");
}

#[test]
fn scrollback_accumulates_in_order() {
    let mut h = TerminalHarness::new(10, 2);
    // With a 2-row terminal, each LF at the bottom evicts row 0
    for i in 0..5u8 {
        h.feed_str(&format!("{}", (b'A' + i) as char));
        h.feed_str("\n");
    }
    // Scrollback should have accumulated; oldest first
    let sb_len = h.scrollback_len();
    assert!(sb_len > 0);
    // The first scrollback entry should be the earliest line pushed
    let first = h.scrollback_text(0);
    assert_eq!(&first, "A");
}

// ── Capacity cap ─────────────────────────────────────────────────────────────

#[test]
fn scrollback_capped_at_max() {
    let max = 5;
    let mut h = TerminalHarness::with_scrollback(10, 2, max);
    // Evict 10 lines (more than max)
    for _ in 0..10 {
        h.feed_str("X\n");
    }
    assert!(h.scrollback_len() <= max);
}

#[test]
fn scrollback_zero_capacity_never_fills() {
    let mut h = TerminalHarness::with_scrollback(10, 2, 0);
    for _ in 0..10 {
        h.feed_str("X\n");
    }
    assert_eq!(h.scrollback_len(), 0);
}

// ── Content correctness ───────────────────────────────────────────────────────

#[test]
fn scrollback_content_matches_evicted_rows() {
    let mut h = TerminalHarness::new(20, 2);
    h.feed_str("Hello World\n"); // evicts when row 1 is full and LF occurs
    h.feed_str("line2\n");
    h.feed_str("line3\n");
    // "Hello World" should be in scrollback (first evicted)
    assert_eq!(h.scrollback_text(0), "Hello World");
}

#[test]
fn scrollback_preserves_full_row_width() {
    let mut h = TerminalHarness::new(10, 2);
    h.feed_str("ABCDEFGHIJ\n"); // exactly 10 chars = full row
    h.feed_str("NEXT\n");
    assert_eq!(h.scrollback_text(0), "ABCDEFGHIJ");
}

// ── Alt screen isolation ──────────────────────────────────────────────────────

#[test]
fn scrollback_not_pushed_in_alt_screen() {
    let mut h = TerminalHarness::new(10, 2);
    h.feed_str("\x1b[?1049h"); // enter alt screen (max_scrollback=0 for alt)
    for _ in 0..5 {
        h.feed_str("X\n");
    }
    // Alt screen has 0 scrollback capacity
    assert_eq!(h.emu.grid.alt.scrollback.len(), 0);
    h.feed_str("\x1b[?1049l"); // leave alt screen
    // Primary scrollback also unaffected
    assert_eq!(h.scrollback_len(), 0);
}

// ── Partial scroll region ─────────────────────────────────────────────────────

#[test]
fn scrollback_not_pushed_when_scroll_region_not_full_screen() {
    let mut h = TerminalHarness::new(10, 5);
    h.feed_str("ROW0\n");
    // Set a partial scroll region (rows 2–4 = 1-based; 0-based 1–3)
    h.feed_str("\x1b[2;4r");
    // Scroll within the partial region many times
    for _ in 0..20 {
        h.feed_str("\x1b[4;1H"); // bottom of region
        h.feed_str("\n");
    }
    // Partial region scrolling should NOT push to scrollback
    assert_eq!(h.scrollback_len(), 0);
}

// ── resize preserves scrollback ───────────────────────────────────────────────

#[test]
fn resize_preserves_scrollback_content() {
    let mut h = TerminalHarness::new(20, 3);
    h.feed_str("PRESERVED\n");
    h.feed_str("line2\n");
    h.feed_str("line3\n");
    // Trigger a scrollback entry
    h.feed_str("line4\n");
    let sb_before = h.scrollback_len();
    assert!(sb_before > 0);
    // Resize
    h.emu.resize(30, 4);
    // Scrollback should still have the content
    assert_eq!(h.scrollback_len(), sb_before);
    assert_eq!(h.scrollback_text(0), "PRESERVED");
}

// ── Cleared flag interaction ──────────────────────────────────────────────────

#[test]
fn scrollback_scroll_clears_the_cleared_flag() {
    let mut h = TerminalHarness::new(10, 2);
    h.feed_str("\x1b[2J"); // clear screen → sets cleared=true
    assert!(h.emu.grid.primary.cleared);
    // Must be at scroll_bottom for LF to trigger scroll_up_in_region
    h.feed_str("\x1b[2;1H"); // cursor to row 2 (1-based) = row 1 (0-based) = scroll_bottom
    h.feed_str("\n");        // LF at scroll_bottom → scroll_up_in_region → clears cleared flag
    assert!(!h.emu.grid.primary.cleared);
}
