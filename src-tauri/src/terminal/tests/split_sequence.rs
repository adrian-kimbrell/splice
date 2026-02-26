use super::TerminalHarness;
use crate::terminal::color::Rgb;

// ── Split ESC sequences across multiple advance() calls ───────────────────────
// The vte parser holds state between calls, so every split point must work
// identically to feeding the sequence in one chunk.

#[test]
fn csi_split_at_esc() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed(b"\x1b");
    h.feed(b"[5;10H");
    assert_eq!(h.cursor(), (9, 4));
}

#[test]
fn csi_split_at_bracket() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed(b"\x1b[");
    h.feed(b"5;10H");
    assert_eq!(h.cursor(), (9, 4));
}

#[test]
fn csi_split_in_params() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed(b"\x1b[5;");
    h.feed(b"10H");
    assert_eq!(h.cursor(), (9, 4));
}

#[test]
fn csi_one_byte_at_a_time() {
    let mut h = TerminalHarness::new(80, 24);
    for b in b"\x1b[5;10H" {
        h.feed(std::slice::from_ref(b));
    }
    assert_eq!(h.cursor(), (9, 4));
}

#[test]
fn sgr_truecolor_split_across_calls() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed(b"\x1b[38;2;");
    h.feed(b"255;");
    h.feed(b"128;0m");
    h.feed(b"X");
    assert_eq!(h.fg_at(0, 0), Rgb { r: 255, g: 128, b: 0 });
}

#[test]
fn osc_split_mid_sequence() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed(b"\x1b]0;My");
    h.feed(b" Title\x07");
    assert_eq!(h.pending_title(), Some("My Title"));
}

#[test]
fn multi_byte_utf8_split_byte_by_byte() {
    let mut h = TerminalHarness::new(20, 5);
    // 'あ' is 3 bytes: E3 81 82
    let bytes = "あ".as_bytes();
    assert_eq!(bytes.len(), 3);
    h.feed(&bytes[..1]);
    h.feed(&bytes[1..2]);
    h.feed(&bytes[2..]);
    assert_eq!(h.char_at(0, 0), 'あ');
    assert_eq!(h.cursor().0, 2); // wide char advances 2
}

#[test]
fn multi_byte_utf8_split_at_two() {
    let mut h = TerminalHarness::new(20, 5);
    let bytes = "あ".as_bytes();
    h.feed(&bytes[..2]);
    h.feed(&bytes[2..]);
    assert_eq!(h.char_at(0, 0), 'あ');
}

#[test]
fn dec_special_graphics_split_at_esc() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed(b"\x1b");
    h.feed(b"(0"); // designate DEC special graphics in G0
    h.feed(b"j");  // maps to '┘'
    assert_eq!(h.char_at(0, 0), '┘');
}

#[test]
fn dec_special_graphics_split_mid_intro() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed(b"\x1b(");
    h.feed(b"0");
    h.feed(b"k"); // maps to '┐'
    assert_eq!(h.char_at(0, 0), '┐');
}

#[test]
fn partial_csi_at_end_of_buffer_no_corruption() {
    // Partial CSI left in parser state should not corrupt prior content.
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("Hello");
    h.feed(b"\x1b["); // partial CSI — never completed
    assert_eq!(h.char_at(0, 0), 'H');
    assert_eq!(h.char_at(0, 4), 'o');
}

#[test]
fn text_after_split_esc_sequence_is_placed_correctly() {
    // ESC is buffered; when '[1;1H' completes the CUP and 'Z' is placed.
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[5;10H"); // move away
    h.feed(b"\x1b");
    h.feed(b"[1;1H");
    h.feed(b"Z");
    assert_eq!(h.char_at(0, 0), 'Z');
    assert_eq!(h.cursor().0, 1);
}

#[test]
fn multiple_sequences_split_in_same_call() {
    // Feed two CUPs where the split falls between them.
    let mut h = TerminalHarness::new(80, 24);
    // First CUP complete + second CUP starts — both in different calls.
    h.feed(b"\x1b[3;1H");     // complete CUP: row=2, col=0
    h.feed(b"\x1b[5;5H");     // second CUP: row=4, col=4
    assert_eq!(h.cursor(), (4, 4));
}
