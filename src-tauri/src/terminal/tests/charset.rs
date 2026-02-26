use super::TerminalHarness;

// ── DEC Special Graphics — full mapping table ─────────────────────────────────

#[test]
fn dec_special_full_table() {
    let mut h = TerminalHarness::new(40, 5);
    h.feed_str("\x1b(0"); // G0 = DEC special graphics
    // All mapped characters from dec_special_map in term.rs
    let cases: &[(&str, char)] = &[
        ("j", '┘'),
        ("k", '┐'),
        ("l", '┌'),
        ("m", '└'),
        ("n", '┼'),
        ("q", '─'),
        ("t", '├'),
        ("u", '┤'),
        ("v", '┴'),
        ("w", '┬'),
        ("x", '│'),
        ("`", '◆'),
        ("a", '▒'),
        ("f", '°'),
        ("g", '±'),
        ("o", '⎺'),
        ("p", '⎻'),
        ("r", '⎼'),
        ("s", '⎽'),
        ("y", '≤'),
        ("z", '≥'),
        ("{", 'π'),
        ("}", '£'),
        ("~", '·'),
    ];

    for (i, (input, expected)) in cases.iter().enumerate() {
        let mut h2 = TerminalHarness::new(40, 5);
        h2.feed_str("\x1b(0");
        h2.feed_str(input);
        assert_eq!(
            h2.char_at(0, 0),
            *expected,
            "DEC special '{}' (col {}) should map to '{}'",
            input, i, expected
        );
    }
}

#[test]
fn dec_unmapped_chars_pass_through() {
    // Characters not in the DEC special table should be printed as-is
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("\x1b(0"); // DEC special
    h.feed_str("A");      // 'A' is not in the map, should pass through
    assert_eq!(h.char_at(0, 0), 'A');
}

// ── SO / SI charset switching ─────────────────────────────────────────────────

#[test]
fn so_si_switches_g0_g1() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("\x1b(0"); // G0 = DEC special
    h.feed_str("\x1b)B"); // G1 = ASCII

    // G0 active (default) → DEC special
    h.feed_str("j"); // → ┘
    assert_eq!(h.char_at(0, 0), '┘');

    h.feed_str("\x0e"); // SO: switch to G1 (ASCII)
    h.feed_str("j");    // → literal 'j'
    assert_eq!(h.char_at(0, 1), 'j');

    h.feed_str("\x0f"); // SI: switch back to G0 (DEC special)
    h.feed_str("j");    // → ┘
    assert_eq!(h.char_at(0, 2), '┘');
}

#[test]
fn esc_paren_0_designates_dec_g0() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("\x1b(0"); // ESC ( 0 → G0 = DEC special
    assert_eq!(h.emu.grid.primary.charset_g0, 1);
}

#[test]
fn esc_paren_b_restores_ascii_g0() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("\x1b(0"); // G0 = DEC special
    h.feed_str("\x1b(B"); // G0 = ASCII
    assert_eq!(h.emu.grid.primary.charset_g0, 0);
    h.feed_str("j");
    assert_eq!(h.char_at(0, 0), 'j');
}

#[test]
fn esc_paren_0_designates_dec_g1() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("\x1b)0"); // ESC ) 0 → G1 = DEC special
    assert_eq!(h.emu.grid.primary.charset_g1, 1);
}

#[test]
fn dec_in_g1_with_so() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("\x1b)0"); // G1 = DEC special
    h.feed_str("\x0e");   // SO: use G1
    h.feed_str("x");      // → │
    assert_eq!(h.char_at(0, 0), '│');
}

// ── Wide characters ───────────────────────────────────────────────────────────

#[test]
fn wide_char_advances_two_cols() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("あ"); // CJK, width=2
    assert_eq!(h.cursor(), (2, 0));
}

#[test]
fn wide_char_left_half_has_width_two() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("あ");
    assert_eq!(h.char_at(0, 0), 'あ');
    assert_eq!(h.width_at(0, 0), 2);
}

#[test]
fn wide_char_right_half_is_placeholder() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("あ");
    assert_eq!(h.char_at(0, 1), ' ');
    assert_eq!(h.width_at(0, 1), 0);
}

#[test]
fn wide_char_wraps_when_one_col_remaining() {
    let mut h = TerminalHarness::new(5, 5);
    // Move to last column
    h.emu.grid.primary.cursor_col = 4;
    h.feed_str("あ"); // width=2, doesn't fit → wraps
    assert_eq!(h.cursor(), (2, 1)); // written at (row=1, col=0), cursor after = col=2
    assert_eq!(h.char_at(1, 0), 'あ');
}

#[test]
fn emoji_wide() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("🦀"); // crab emoji, width=2
    assert_eq!(h.char_at(0, 0), '🦀');
    assert_eq!(h.width_at(0, 0), 2);
    assert_eq!(h.width_at(0, 1), 0);
    assert_eq!(h.cursor(), (2, 0));
}

#[test]
fn multiple_wide_chars_advance_correctly() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("漢字"); // 2 CJK chars, each width=2
    assert_eq!(h.cursor(), (4, 0));
    assert_eq!(h.char_at(0, 0), '漢');
    assert_eq!(h.char_at(0, 2), '字');
}

// ── Combining zero-width characters ──────────────────────────────────────────

#[test]
fn combining_zero_width_does_not_advance_cursor() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("a");         // cursor → col 1
    h.feed_str("\u{0301}");  // combining acute accent (zero-width)
    // Cursor should still be at col 1 (zero-width char doesn't advance)
    assert_eq!(h.cursor().0, 1);
}

#[test]
fn combining_zero_width_does_not_overwrite_base_char() {
    let mut h = TerminalHarness::new(20, 5);
    h.feed_str("a");
    h.feed_str("\u{0301}"); // combining accent — ignored by current implementation
    assert_eq!(h.char_at(0, 0), 'a');
}
