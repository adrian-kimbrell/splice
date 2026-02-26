use super::TerminalHarness;

// ── Primary Device Attributes (DA) ───────────────────────────────────────────

#[test]
fn da_primary_response() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[c"); // CSI c — send DA request
    let reply = h.take_reply();
    // Response should be a valid DA response starting with ESC [ ?
    assert!(
        reply.starts_with(b"\x1b[?"),
        "DA reply should start with ESC[?: {:?}",
        reply
    );
}

#[test]
fn da_primary_response_exact() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[c");
    let reply = h.take_reply();
    // Implementation returns "ESC[?1;2c" (VT100 with advanced video)
    assert_eq!(reply, b"\x1b[?1;2c");
}

#[test]
fn da_secondary_response() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[>c"); // CSI > c — secondary DA
    let reply = h.take_reply();
    assert!(
        reply.starts_with(b"\x1b[>"),
        "Secondary DA reply should start with ESC[>: {:?}",
        reply
    );
}

// ── Device Status Report (DSR) ────────────────────────────────────────────────

#[test]
fn dsr_cursor_report_is_one_based() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[5;10H"); // row=5, col=10 (1-based)
    h.feed_str("\x1b[6n");    // DSR: cursor position
    let reply = h.take_reply();
    // Reply: ESC [ row ; col R (1-based)
    assert_eq!(reply, b"\x1b[5;10R");
}

#[test]
fn dsr_at_origin_reports_one_one() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[6n");
    let reply = h.take_reply();
    assert_eq!(reply, b"\x1b[1;1R");
}

#[test]
fn dsr_after_movement_reports_correct_position() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[12;24H");
    h.feed_str("\x1b[6n");
    let reply = h.take_reply();
    assert_eq!(reply, b"\x1b[12;24R");
}

#[test]
fn dsr_status_5_reports_ok() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[5n"); // DSR: terminal status
    let reply = h.take_reply();
    assert_eq!(reply, b"\x1b[0n");
}

// ── Multiple replies accumulate ───────────────────────────────────────────────

#[test]
fn multiple_dsr_accumulate_in_reply_buffer() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[6n"); // first DSR
    h.feed_str("\x1b[6n"); // second DSR (cursor at same position = twice the same reply)
    let reply = h.take_reply();
    // Both replies concatenated
    let expected = b"\x1b[1;1R\x1b[1;1R";
    assert_eq!(reply, expected);
}

#[test]
fn take_reply_clears_the_buffer() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[6n");
    let _ = h.take_reply();
    let second = h.take_reply();
    assert!(second.is_empty(), "reply buffer should be empty after take");
}
