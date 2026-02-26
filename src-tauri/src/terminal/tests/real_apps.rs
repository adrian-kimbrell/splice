use super::TerminalHarness;
use crate::terminal::color::{Rgb, ANSI_COLORS};
use crate::terminal::grid::flags;

// ── bash — color prompt ───────────────────────────────────────────────────────

#[test]
fn bash_color_prompt() {
    // Simulates: \e[32m\e[1muser@host\e[0m:\e[34m~/code\e[0m$
    let prompt = b"\x1b[32m\x1b[1muser@host\x1b[0m:\x1b[34m~/code\x1b[0m$ ";
    let mut h = TerminalHarness::new(80, 24);
    h.feed(prompt);
    assert_eq!(h.char_at(0, 0), 'u');
    // "user@host" should have green + bold
    assert_eq!(h.fg_at(0, 0), ANSI_COLORS[2]); // green
    assert_ne!(h.flags_at(0, 0) & flags::BOLD, 0);
    // ':' should be default (after reset)
    let colon_col = "user@host".len();
    assert_eq!(h.char_at(0, colon_col), ':');
    // "~/code" starts after the colon; should be blue
    let code_col = colon_col + 1;
    assert_eq!(h.fg_at(0, code_col), ANSI_COLORS[4]); // blue
}

// ── ls — LS_COLORS output ─────────────────────────────────────────────────────

#[test]
fn ls_color_directory() {
    // Blue bold directory name (typical LS_COLORS)
    let ls_out = b"\x1b[1;34mDocuments\x1b[0m";
    let mut h = TerminalHarness::new(80, 24);
    h.feed(ls_out);
    assert_eq!(h.row_text(0), "Documents");
    assert_eq!(h.fg_at(0, 0), ANSI_COLORS[4]); // blue
    assert_ne!(h.flags_at(0, 0) & flags::BOLD, 0);
}

#[test]
fn ls_color_executable() {
    // Bright green executable
    let ls_out = b"\x1b[1;32mmyscript.sh\x1b[0m";
    let mut h = TerminalHarness::new(80, 24);
    h.feed(ls_out);
    assert_eq!(h.row_text(0), "myscript.sh");
    assert_ne!(h.flags_at(0, 0) & flags::BOLD, 0);
}

// ── vim — startup sequence ────────────────────────────────────────────────────

#[test]
fn vim_startup_alt_screen_cleared() {
    // vim enters alt screen, hides cursor, clears screen, positions cursor
    let vim_init = b"\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H";
    let mut h = TerminalHarness::new(80, 24);
    h.feed(vim_init);
    assert!(h.is_alt_screen());
    assert!(!h.cursor_visible());
    assert_eq!(h.cursor(), (0, 0));
    // Screen is blank
    assert_eq!(h.row_text(0), "");
}

#[test]
fn vim_leave_alt_screen() {
    let vim_init = b"\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H";
    let vim_exit = b"\x1b[?25h\x1b[?1049l";
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("Primary content");
    h.feed(vim_init);
    h.feed(vim_exit);
    assert!(!h.is_alt_screen());
    assert!(h.cursor_visible());
    // Primary content restored
    assert_eq!(h.row_text(0), "Primary content");
}

// ── htop — DEC box drawing ────────────────────────────────────────────────────

#[test]
fn htop_box_drawing() {
    // Top border: ESC(0 lqqqk ESC(B
    let top = b"\x1b(0lqqqk\x1b(B";
    let mut h = TerminalHarness::new(20, 5);
    h.feed(top);
    assert_eq!(h.char_at(0, 0), '┌');
    assert_eq!(h.char_at(0, 1), '─');
    assert_eq!(h.char_at(0, 2), '─');
    assert_eq!(h.char_at(0, 3), '─');
    assert_eq!(h.char_at(0, 4), '┐');
    // Back to ASCII
    h.feed_str("ABC");
    assert_eq!(h.char_at(0, 5), 'A');
}

#[test]
fn htop_vertical_border() {
    let side = b"\x1b(0x\x1b(B text \x1b(0x\x1b(B";
    let mut h = TerminalHarness::new(20, 5);
    h.feed(side);
    assert_eq!(h.char_at(0, 0), '│');
    assert_eq!(h.char_at(0, 7), '│');
}

// ── Progress bar — CR overwrite ───────────────────────────────────────────────

#[test]
fn progress_bar_cr_overwrite() {
    let mut h = TerminalHarness::new(40, 5);
    h.feed_str("Loading [====  ]\r");
    h.feed_str("Loading [======]");
    // The second write overwrites the first
    assert_eq!(h.row_text(0), "Loading [======]");
}

#[test]
fn progress_bar_multiple_steps() {
    let mut h = TerminalHarness::new(20, 5);
    for i in 0..=5 {
        let bar = format!("[{}>{}]\r", "=".repeat(i), " ".repeat(5 - i));
        h.feed_str(&bar);
    }
    // Final state: [=====]
    assert_eq!(h.row_text(0), "[=====>]");
}

// ── git diff — red/green lines ────────────────────────────────────────────────

#[test]
fn git_diff_output() {
    // Use \r\n so each line starts at col 0
    let diff = b"\x1b[1mdiff --git a/foo b/foo\x1b[0m\r\n\x1b[31m-old line\x1b[0m\r\n\x1b[32m+new line\x1b[0m\r\n";
    let mut h = TerminalHarness::new(80, 24);
    h.feed(diff);
    // Row 0: bold header
    assert_ne!(h.flags_at(0, 0) & flags::BOLD, 0);
    // Row 1: red removed line
    assert_eq!(h.char_at(1, 0), '-');
    assert_eq!(h.fg_at(1, 0), ANSI_COLORS[1]); // red
    // Row 2: green added line
    assert_eq!(h.char_at(2, 0), '+');
    assert_eq!(h.fg_at(2, 0), ANSI_COLORS[2]); // green
}

// ── neovim — true color statusline ───────────────────────────────────────────

#[test]
fn neovim_true_color_statusline() {
    // 24-bit color background + text
    let status = b"\x1b[48;2;35;38;52m\x1b[38;2;152;195;121m NORMAL \x1b[0m";
    let mut h = TerminalHarness::new(80, 24);
    h.feed(status);
    assert_eq!(h.char_at(0, 0), ' ');
    assert_eq!(h.fg_at(0, 0), Rgb { r: 152, g: 195, b: 121 });
    assert_eq!(h.bg_at(0, 0), Rgb { r: 35, g: 38, b: 52 });
}

// ── Long line wrapping ────────────────────────────────────────────────────────

#[test]
fn long_line_wraps_correctly() {
    let mut h = TerminalHarness::new(80, 5);
    let line: String = "X".repeat(85);
    h.feed_str(&line);
    // Row 0 should have 80 X's
    assert_eq!(h.row_text(0).len(), 80);
    assert_eq!(h.row_text(0), "X".repeat(80));
    // Row 1 should have remaining 5 X's
    assert_eq!(h.row_text(1), "XXXXX");
}

#[test]
fn exact_line_fill_no_spurious_wrap() {
    // Writing exactly 80 chars should NOT cause a scroll
    let mut h = TerminalHarness::new(80, 3);
    let line: String = "A".repeat(80);
    h.feed_str(&line);
    // All 80 chars on row 0
    assert_eq!(h.row_text(0), "A".repeat(80));
    // Row 1 empty
    assert_eq!(h.row_text(1), "");
    // Cursor is at col 80 (past last col — will wrap on next write)
    assert_eq!(h.cursor().0, 80);
}

// ── Shell — command output with mixed control chars ───────────────────────────

#[test]
fn mixed_control_and_text() {
    // Simulate: write "$ ", get output, cursor moves (use \r\n for proper column reset)
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("$ echo hello\r\n");
    h.feed_str("hello\r\n");
    h.feed_str("$ ");
    assert_eq!(h.row_text(0), "$ echo hello");
    assert_eq!(h.row_text(1), "hello");
    assert_eq!(h.row_text(2), "$");
}
