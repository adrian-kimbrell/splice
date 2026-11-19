//! `last_text_lines`: the text an agent gets from `read_terminal`.
use super::TerminalHarness;
use crate::terminal::grid::last_text_lines;

#[test]
fn returns_the_last_non_blank_lines_oldest_first() {
    let mut h = TerminalHarness::new(20, 4);
    h.feed_str("one\r\ntwo\r\n\r\nthree");
    assert_eq!(last_text_lines(&h.emu.grid, 10), vec!["one", "two", "three"]);
    assert_eq!(last_text_lines(&h.emu.grid, 2), vec!["two", "three"]);
}

#[test]
fn reaches_into_scrollback_and_trims_trailing_space() {
    let mut h = TerminalHarness::new(10, 2);
    for i in 0..6 {
        h.feed_str(&format!("line{i}  \r\n"));
    }
    let lines = last_text_lines(&h.emu.grid, 4);
    assert_eq!(lines, vec!["line2", "line3", "line4", "line5"]);
}

#[test]
fn empty_terminal_and_zero_lines_give_nothing() {
    let mut h = TerminalHarness::new(10, 2);
    assert!(last_text_lines(&h.emu.grid, 5).is_empty());
    h.feed_str("x");
    assert!(last_text_lines(&h.emu.grid, 0).is_empty());
}
