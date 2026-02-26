use super::TerminalHarness;

// ── Adversarial / fuzz inputs — goal: no panics, cursor always in bounds ─────

/// All 256 single-byte values fed individually — none should panic.
#[test]
fn all_single_bytes_no_panic() {
    let mut h = TerminalHarness::new(80, 24);
    for b in 0u8..=255 {
        h.feed(&[b]);
    }
    assert!(h.cursor().0 < 80);
    assert!(h.cursor().1 < 24);
}

/// All 2-byte ESC + b sequences.
#[test]
fn all_esc_two_byte_sequences_no_panic() {
    let mut h = TerminalHarness::new(80, 24);
    for b in 0u8..=255 {
        h.feed(&[0x1b, b]);
    }
    assert!(h.cursor().0 < 80);
    assert!(h.cursor().1 < 24);
}

/// ESC [ followed by every CSI final byte (0x40–0x7e).
#[test]
fn all_csi_final_bytes_no_panic() {
    let mut h = TerminalHarness::new(80, 24);
    for b in 0x40u8..=0x7eu8 {
        h.feed(&[0x1b, b'[', b]);
    }
    assert!(h.cursor().0 < 80);
    assert!(h.cursor().1 < 24);
}

/// ESC [ with a large parameter followed by every CSI final byte.
#[test]
fn all_csi_with_large_param_no_panic() {
    let mut h = TerminalHarness::new(80, 24);
    for b in 0x40u8..=0x7eu8 {
        h.feed(format!("\x1b[9999{}", b as char).as_bytes());
    }
    assert!(h.cursor().0 < 80);
    assert!(h.cursor().1 < 24);
}

/// Interleaved text and CUP sequences — stress cursor bounds.
#[test]
fn interleaved_text_and_csi_no_panic() {
    let mut h = TerminalHarness::new(40, 10);
    for i in 0u32..100 {
        h.feed_str("Hello");
        h.feed(format!("\x1b[{};{}H", (i % 10) + 1, (i % 40) + 1).as_bytes());
    }
    assert!(h.cursor().0 < 40);
    assert!(h.cursor().1 < 10);
}

/// Pseudo-random byte stream using a deterministic LCG — reproducible.
#[test]
fn lcg_random_bytes_no_panic() {
    let mut h = TerminalHarness::new(80, 24);
    let mut state: u64 = 0x1234_5678_9abc_def0;
    let mut buf = [0u8; 64];
    for _ in 0..500 {
        for byte in &mut buf {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            *byte = (state >> 33) as u8;
        }
        h.feed(&buf);
    }
    assert!(h.cursor().0 < 80);
    assert!(h.cursor().1 < 24);
}

/// Truncated sequences — final byte never arrives.
#[test]
fn truncated_csi_sequences_no_panic() {
    let mut h = TerminalHarness::new(80, 24);
    for s in &[
        "\x1b[",
        "\x1b[1",
        "\x1b[1;",
        "\x1b[1;2",
        "\x1b]0;title", // OSC without BEL/ST
    ] {
        h.feed(s.as_bytes());
        h.feed_str("X"); // normal byte after truncated sequence
    }
    // Terminal should still be usable
    h.feed_str("ABC");
}

/// Very long digit string in a CSI parameter — should not overflow or panic.
#[test]
fn very_long_digit_param_no_panic() {
    let mut h = TerminalHarness::new(80, 24);
    let long_num = "9".repeat(100);
    h.feed(format!("\x1b[{}A", long_num).as_bytes());
    assert_eq!(h.cursor().1, 0); // clamped to top
}

/// 50 semicolons in a CSI param list.
#[test]
fn many_semicolons_in_csi_no_panic() {
    let mut h = TerminalHarness::new(80, 24);
    let params = ";".repeat(50);
    h.feed(format!("\x1b[{}m", params).as_bytes());
}

/// 10 000 newlines on a small terminal — cursor and scrollback stay valid.
#[test]
fn many_newlines_no_panic() {
    let mut h = TerminalHarness::new(80, 4);
    for _ in 0..10_000 {
        h.feed(b"\r\n");
    }
    assert!(h.cursor().1 < 4);
}

/// 10 000 CUF on an 80-col terminal.
#[test]
fn many_cuf_no_panic() {
    let mut h = TerminalHarness::new(80, 24);
    for _ in 0..10_000 {
        h.feed_str("\x1b[C");
    }
    assert!(h.cursor().0 < 80);
}

/// Rapid mode toggling — no panic, modes clear correctly.
#[test]
fn rapid_mode_toggle_no_panic() {
    let mut h = TerminalHarness::new(80, 24);
    for _ in 0..1000 {
        h.feed_str("\x1b[?1000h\x1b[?1000l");
        h.feed_str("\x1b[?1049h\x1b[?1049l");
    }
    assert!(!h.is_alt_screen());
    assert_eq!(h.mouse_mode(), 0);
}

/// Alt screen entered and exited 1000 times — no leak.
#[test]
fn repeated_alt_screen_no_leak() {
    let mut h = TerminalHarness::new(80, 24);
    for _ in 0..1000 {
        h.feed_str("\x1b[?1049h");
        h.feed_str("some content");
        h.feed_str("\x1b[?1049l");
    }
    assert!(!h.is_alt_screen());
}

/// All printable ASCII chars on a 1×1 terminal — no panic.
#[test]
fn printable_ascii_on_tiny_terminal() {
    let mut h = TerminalHarness::new(1, 1);
    for b in 0x20u8..=0x7eu8 {
        h.feed(&[b]);
    }
}

/// All DEC special graphics chars on a small terminal.
#[test]
fn dec_special_graphics_all_chars_no_panic() {
    let mut h = TerminalHarness::new(80, 5);
    h.feed_str("\x1b(0"); // activate DEC special graphics
    // Feed entire printable range
    for b in 0x20u8..=0x7eu8 {
        h.feed(&[b]);
    }
}
