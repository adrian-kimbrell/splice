use super::TerminalHarness;

// ── OSC 0 / 2 — window title ──────────────────────────────────────────────────

#[test]
fn osc_0_sets_title() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b]0;My Terminal Title\x07");
    assert_eq!(h.pending_title(), Some("My Terminal Title"));
}

#[test]
fn osc_2_sets_title() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b]2;Another Title\x07");
    assert_eq!(h.pending_title(), Some("Another Title"));
}

#[test]
fn osc_0_overwrites_previous_title() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b]0;First\x07");
    h.feed_str("\x1b]0;Second\x07");
    assert_eq!(h.pending_title(), Some("Second"));
}

#[test]
fn osc_0_empty_title() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b]0;\x07");
    assert_eq!(h.pending_title(), Some(""));
}

// ── OSC 52 — clipboard ────────────────────────────────────────────────────────

#[test]
fn osc_52_base64_clipboard() {
    let mut h = TerminalHarness::new(80, 24);
    // base64("hello") = "aGVsbG8="
    h.feed_str("\x1b]52;c;aGVsbG8=\x07");
    assert_eq!(h.take_clipboard(), Some("hello".to_string()));
}

#[test]
fn osc_52_multiword_clipboard() {
    let mut h = TerminalHarness::new(80, 24);
    // base64("hello world") = "aGVsbG8gd29ybGQ="
    h.feed_str("\x1b]52;c;aGVsbG8gd29ybGQ=\x07");
    assert_eq!(h.take_clipboard(), Some("hello world".to_string()));
}

#[test]
fn osc_52_invalid_base64_ignored() {
    // If the base64 is malformed the clipboard should remain None
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b]52;c;!!!notbase64!!!\x07");
    assert_eq!(h.take_clipboard(), None);
}

// ── OSC with ST terminator ────────────────────────────────────────────────────

#[test]
fn osc_st_terminated_title() {
    // ST = ESC \ (0x1b 0x5c)
    let mut h = TerminalHarness::new(80, 24);
    let seq = b"\x1b]0;ST Title\x1b\\";
    h.feed(seq);
    assert_eq!(h.pending_title(), Some("ST Title"));
}

// ── Unknown OSC codes ─────────────────────────────────────────────────────────

#[test]
fn osc_unknown_code_ignored_no_panic() {
    let mut h = TerminalHarness::new(80, 24);
    // OSC 9 (iTerm2 notification) — not handled, should be silently ignored
    h.feed_str("\x1b]9;some notification text\x07");
    assert_eq!(h.pending_title(), None);
    assert_eq!(h.take_clipboard(), None);
    // No crash, cursor/screen unaffected
    assert_eq!(h.cursor(), (0, 0));
}

#[test]
fn osc_999_unknown_ignored() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b]999;garbage data here\x07");
    // Grid should be unchanged
    assert_eq!(h.row_text(0), "");
}
