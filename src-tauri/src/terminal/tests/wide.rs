//! Wide (double-cell) characters: a width-2 left half and its width-0 placeholder
//! must always travel as a pair. The renderer never paints width-0 cells, so an
//! orphaned placeholder would keep stale pixels on screen until a full redraw.
use super::TerminalHarness;

fn widths(h: &TerminalHarness, row: usize, n: usize) -> Vec<u8> {
    (0..n).map(|c| h.width_at(row, c)).collect()
}

#[test]
fn wide_char_writes_left_half_and_placeholder() {
    let mut h = TerminalHarness::new(10, 2);
    h.feed_str("あ");
    assert_eq!(h.char_at(0, 0), 'あ');
    assert_eq!(widths(&h, 0, 3), vec![2, 0, 1]);
    assert_eq!(h.cursor().0, 2);
}

#[test]
fn narrow_over_left_half_clears_the_placeholder() {
    let mut h = TerminalHarness::new(10, 2);
    h.feed_str("あ").csi("1;1H").feed_str("X");
    assert_eq!(h.char_at(0, 0), 'X');
    assert_eq!(widths(&h, 0, 3), vec![1, 1, 1], "placeholder must become a plain blank");
    assert_eq!(h.char_at(0, 1), ' ');
}

#[test]
fn narrow_over_placeholder_clears_the_left_half() {
    let mut h = TerminalHarness::new(10, 2);
    h.feed_str("あ").csi("1;2H").feed_str("X");
    assert_eq!(h.char_at(0, 1), 'X');
    assert_eq!(h.char_at(0, 0), ' ', "left half without its placeholder is blanked");
    assert_eq!(widths(&h, 0, 3), vec![1, 1, 1]);
}

#[test]
fn wide_over_the_second_half_of_another_wide_repairs_both() {
    let mut h = TerminalHarness::new(10, 2);
    h.feed_str("あい"); // cols 0-1, 2-3
    h.csi("1;2H").feed_str("う"); // cols 1-2: destroys あ's placeholder and い's left half
    assert_eq!(h.char_at(0, 0), ' ');
    assert_eq!(h.char_at(0, 1), 'う');
    assert_eq!(widths(&h, 0, 5), vec![1, 2, 0, 1, 1]);
    assert_eq!(h.char_at(0, 3), ' ', "い's orphaned placeholder is blanked");
}

#[test]
fn erase_chars_on_left_half_clears_pair() {
    let mut h = TerminalHarness::new(10, 2);
    h.feed_str("あ").csi("1;1H").csi("1X");
    assert_eq!(widths(&h, 0, 3), vec![1, 1, 1]);
}

#[test]
fn erase_line_from_the_placeholder_clears_the_left_half() {
    let mut h = TerminalHarness::new(10, 2);
    h.feed_str("あb").csi("1;2H").csi("0K");
    assert_eq!(h.row_text(0), "");
    assert_eq!(widths(&h, 0, 3), vec![1, 1, 1]);
}

#[test]
fn erase_display_to_end_from_placeholder_clears_the_left_half() {
    let mut h = TerminalHarness::new(10, 2);
    h.feed_str("あb").csi("1;2H").csi("0J");
    assert_eq!(widths(&h, 0, 3), vec![1, 1, 1]);
}

#[test]
fn delete_chars_through_a_wide_char_leaves_no_orphan() {
    let mut h = TerminalHarness::new(10, 2);
    h.feed_str("あb").csi("1;1H").csi("1P"); // shifts the placeholder into col 0
    assert!(widths(&h, 0, 3).iter().all(|&w| w == 1), "{:?}", widths(&h, 0, 3));
    assert_eq!(h.char_at(0, 1), 'b');
}

#[test]
fn delete_chars_before_a_wide_char_keeps_it_paired() {
    let mut h = TerminalHarness::new(10, 2);
    h.feed_str("xあ").csi("1;1H").csi("1P");
    assert_eq!(h.char_at(0, 0), 'あ');
    assert_eq!(widths(&h, 0, 3), vec![2, 0, 1]);
}

#[test]
fn insert_blank_before_a_wide_char_keeps_it_paired() {
    let mut h = TerminalHarness::new(10, 2);
    h.feed_str("あ").csi("1;1H").csi("1@");
    assert_eq!(h.char_at(0, 1), 'あ');
    assert_eq!(widths(&h, 0, 4), vec![1, 2, 0, 1]);
}

#[test]
fn insert_blank_inside_a_wide_char_blanks_it() {
    let mut h = TerminalHarness::new(10, 2);
    h.feed_str("あ").csi("1;2H").csi("1@");
    assert!(widths(&h, 0, 4).iter().all(|&w| w == 1), "{:?}", widths(&h, 0, 4));
}

#[test]
fn insert_pushes_a_left_half_off_the_right_edge_cleanly() {
    let mut h = TerminalHarness::new(4, 2);
    h.feed_str("xxあ"); // あ at cols 2-3
    h.csi("1;1H").csi("1@"); // あ's left half lands on col 3, its placeholder falls off
    assert_eq!(h.width_at(0, 3), 1, "a left half with no room for its placeholder is blanked");
}

#[test]
fn copy_text_from_screen_has_one_char_per_wide_glyph() {
    let mut h = TerminalHarness::new(10, 2);
    h.feed_str("漢字x");
    let cols = h.emu.grid.cols as usize;
    let (text, _) = crate::commands::terminal::row_text_and_columns(&h.emu.grid.active().lines[0].cells, cols);
    assert_eq!(text.trim_end(), "漢字x");
}
