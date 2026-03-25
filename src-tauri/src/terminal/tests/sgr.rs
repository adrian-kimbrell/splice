use super::TerminalHarness;
use crate::terminal::color::{ansi_256_color, Rgb, ANSI_COLORS, DEFAULT_BG, DEFAULT_FG};
use crate::terminal::grid::flags;

// ── Reset ─────────────────────────────────────────────────────────────────────

#[test]
fn sgr_reset_all() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[1;3;4;31;42m"); // bold + italic + underline + red fg + green bg
    h.feed_str("\x1b[0m");            // reset
    assert_eq!(h.emu.grid.primary.pen.flags, 0);
    assert_eq!(h.emu.grid.primary.pen.fg, DEFAULT_FG);
    assert_eq!(h.emu.grid.primary.pen.bg, DEFAULT_BG);
}

#[test]
fn sgr_reset_via_empty_sequence() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[1m");
    h.feed_str("\x1b[m"); // bare SGR with no params → reset
    assert_eq!(h.emu.grid.primary.pen.flags & flags::BOLD, 0);
}

// ── Individual flags ──────────────────────────────────────────────────────────

#[test]
fn sgr_bold() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[1m");
    assert_ne!(h.emu.grid.primary.pen.flags & flags::BOLD, 0);
}

#[test]
fn sgr_dim() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[2m");
    assert_ne!(h.emu.grid.primary.pen.flags & flags::DIM, 0);
}

#[test]
fn sgr_italic() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[3m");
    assert_ne!(h.emu.grid.primary.pen.flags & flags::ITALIC, 0);
}

#[test]
fn sgr_underline() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[4m");
    assert_ne!(h.emu.grid.primary.pen.flags & flags::UNDERLINE, 0);
}

#[test]
fn sgr_blink() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[5m");
    assert_ne!(h.emu.grid.primary.pen.flags & flags::BLINK, 0);
}

#[test]
fn sgr_inverse() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[7m");
    assert_ne!(h.emu.grid.primary.pen.flags & flags::INVERSE, 0);
}

#[test]
fn sgr_hidden() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[8m");
    assert_ne!(h.emu.grid.primary.pen.flags & flags::HIDDEN, 0);
}

#[test]
fn sgr_strikethrough() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[9m");
    assert_ne!(h.emu.grid.primary.pen.flags & flags::STRIKETHROUGH, 0);
}

// ── Flag resets (22–29) ───────────────────────────────────────────────────────

#[test]
fn sgr_22_clears_bold_and_dim() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[1;2m"); // bold + dim
    h.feed_str("\x1b[22m");  // reset intensity
    assert_eq!(h.emu.grid.primary.pen.flags & (flags::BOLD | flags::DIM), 0);
}

#[test]
fn sgr_23_clears_italic() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[3m\x1b[23m");
    assert_eq!(h.emu.grid.primary.pen.flags & flags::ITALIC, 0);
}

#[test]
fn sgr_24_clears_underline() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[4m\x1b[24m");
    assert_eq!(h.emu.grid.primary.pen.flags & flags::UNDERLINE, 0);
}

// ── Stacked attributes ────────────────────────────────────────────────────────

#[test]
fn sgr_stacked_attrs() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[1;4;31m"); // bold + underline + red fg
    let pen = h.emu.grid.primary.pen;
    assert_ne!(pen.flags & flags::BOLD, 0);
    assert_ne!(pen.flags & flags::UNDERLINE, 0);
    assert_eq!(pen.fg, ANSI_COLORS[1]); // red = index 1
}

// ── 16-color foreground (30–37, 90–97) ───────────────────────────────────────

#[test]
fn sgr_fg_16_normal_colors() {
    let mut h = TerminalHarness::new(80, 24);
    for i in 0u16..8 {
        h.feed_str(&format!("\x1b[{}m", 30 + i));
        assert_eq!(h.emu.grid.primary.pen.fg, ANSI_COLORS[i as usize]);
    }
}

#[test]
fn sgr_fg_bright_colors() {
    let mut h = TerminalHarness::new(80, 24);
    for i in 0u16..8 {
        h.feed_str(&format!("\x1b[{}m", 90 + i));
        assert_eq!(h.emu.grid.primary.pen.fg, ANSI_COLORS[8 + i as usize]);
    }
}

#[test]
fn sgr_fg_reset() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[31m"); // red
    h.feed_str("\x1b[39m"); // default fg
    assert_eq!(h.emu.grid.primary.pen.fg, DEFAULT_FG);
}

// ── 16-color background (40–47, 100–107) ─────────────────────────────────────

#[test]
fn sgr_bg_16_normal_colors() {
    let mut h = TerminalHarness::new(80, 24);
    for i in 0u16..8 {
        h.feed_str(&format!("\x1b[{}m", 40 + i));
        assert_eq!(h.emu.grid.primary.pen.bg, ANSI_COLORS[i as usize]);
    }
}

#[test]
fn sgr_bg_bright_colors() {
    let mut h = TerminalHarness::new(80, 24);
    for i in 0u16..8 {
        h.feed_str(&format!("\x1b[{}m", 100 + i));
        assert_eq!(h.emu.grid.primary.pen.bg, ANSI_COLORS[8 + i as usize]);
    }
}

#[test]
fn sgr_bg_reset() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[41m"); // red bg
    h.feed_str("\x1b[49m"); // default bg
    assert_eq!(h.emu.grid.primary.pen.bg, DEFAULT_BG);
}

// ── 256-color ─────────────────────────────────────────────────────────────────

#[test]
fn sgr_256_fg() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[38;5;200m");
    assert_eq!(h.emu.grid.primary.pen.fg, ansi_256_color(200));
}

#[test]
fn sgr_256_bg() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[48;5;0m");
    assert_eq!(h.emu.grid.primary.pen.bg, ansi_256_color(0));
}

#[test]
fn sgr_256_grayscale_fg() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[38;5;240m"); // index 240 = grayscale
    assert_eq!(h.emu.grid.primary.pen.fg, ansi_256_color(240));
}

// ── Truecolor (38;2 / 48;2) ───────────────────────────────────────────────────

#[test]
fn sgr_truecolor_fg() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[38;2;255;128;0m");
    assert_eq!(h.emu.grid.primary.pen.fg, Rgb { r: 255, g: 128, b: 0 });
}

#[test]
fn sgr_truecolor_bg() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[48;2;0;64;128m");
    assert_eq!(h.emu.grid.primary.pen.bg, Rgb { r: 0, g: 64, b: 128 });
}

#[test]
fn sgr_truecolor_black_fg() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[38;2;0;0;0m");
    assert_eq!(h.emu.grid.primary.pen.fg, Rgb { r: 0, g: 0, b: 0 });
}

#[test]
fn sgr_truecolor_white_bg() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[48;2;255;255;255m");
    assert_eq!(h.emu.grid.primary.pen.bg, Rgb { r: 255, g: 255, b: 255 });
}

// ── Attributes persist across writes ─────────────────────────────────────────

#[test]
fn sgr_persists_across_writes() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[1m"); // bold
    h.feed_str("ABC");
    // Each written cell should have the bold flag
    assert_ne!(h.flags_at(0, 0) & flags::BOLD, 0);
    assert_ne!(h.flags_at(0, 1) & flags::BOLD, 0);
    assert_ne!(h.flags_at(0, 2) & flags::BOLD, 0);
}

#[test]
fn sgr_color_persists_across_writes() {
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[38;2;200;100;50m");
    h.feed_str("XYZ");
    let expected = Rgb { r: 200, g: 100, b: 50 };
    assert_eq!(h.fg_at(0, 0), expected);
    assert_eq!(h.fg_at(0, 1), expected);
    assert_eq!(h.fg_at(0, 2), expected);
}

// ── Kitty underline sub-params (4:X) ─────────────────────────────────────────

#[test]
fn sgr_4_colon_1_sets_underline() {
    // 4:1 = straight underline — should set UNDERLINE, NOT BOLD
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[4:1m");
    assert_ne!(h.emu.grid.primary.pen.flags & flags::UNDERLINE, 0, "UNDERLINE should be set");
    assert_eq!(h.emu.grid.primary.pen.flags & flags::BOLD, 0, "BOLD should NOT be set");
}

#[test]
fn sgr_4_colon_3_sets_underline_not_italic() {
    // 4:3 = curly underline — maps UNDERLINE on; must NOT set ITALIC
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[4:3m");
    assert_ne!(h.emu.grid.primary.pen.flags & flags::UNDERLINE, 0, "UNDERLINE should be set");
    assert_eq!(h.emu.grid.primary.pen.flags & flags::ITALIC, 0, "ITALIC should NOT be set");
}

#[test]
fn sgr_4_colon_0_clears_underline() {
    // 4:0 = no underline — should clear UNDERLINE and NOT reset colors
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[4m");   // set underline
    h.feed_str("\x1b[31m");  // set red fg
    h.feed_str("\x1b[4:0m"); // clear underline via sub-param
    assert_eq!(h.emu.grid.primary.pen.flags & flags::UNDERLINE, 0, "UNDERLINE should be cleared");
    // Color should be preserved — 4:0 must NOT trigger a full reset
    assert_eq!(h.emu.grid.primary.pen.fg, crate::terminal::color::ANSI_COLORS[1], "fg color should survive 4:0");
}

#[test]
fn sgr_38_colon_truecolor_fg() {
    // 38:2:r:g:b — truecolor as colon sub-params
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[38:2:10:20:30m");
    assert_eq!(h.emu.grid.primary.pen.fg, Rgb { r: 10, g: 20, b: 30 });
}

#[test]
fn sgr_48_colon_truecolor_bg() {
    // 48:2:r:g:b — truecolor bg as colon sub-params
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[48:2:50:100:150m");
    assert_eq!(h.emu.grid.primary.pen.bg, Rgb { r: 50, g: 100, b: 150 });
}

#[test]
fn sgr_38_colon_256_fg() {
    // 38:5:n — 256-color fg as colon sub-params
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[38:5:200m");
    assert_eq!(h.emu.grid.primary.pen.fg, ansi_256_color(200));
}

// ── Private-intermediate CSI m must NOT be treated as SGR ────────────────────

#[test]
fn csi_gt_m_modify_other_keys_does_not_set_sgr() {
    // \x1b[>4;2m = xterm Modify Other Keys level 2 — must NOT set UNDERLINE or DIM
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[>4;2m");
    assert_eq!(h.emu.grid.primary.pen.flags & flags::UNDERLINE, 0, "UNDERLINE must not be set by CSI > m");
    assert_eq!(h.emu.grid.primary.pen.flags & flags::DIM, 0, "DIM must not be set by CSI > m");
}

#[test]
fn csi_gt_m_does_not_clobber_existing_sgr() {
    // Existing attributes should survive a CSI > m sequence
    let mut h = TerminalHarness::new(80, 24);
    h.feed_str("\x1b[1;32m");  // bold + green
    h.feed_str("\x1b[>4;2m"); // Modify Other Keys — should be a no-op for SGR
    assert_ne!(h.emu.grid.primary.pen.flags & flags::BOLD, 0, "BOLD should survive CSI > m");
    assert_eq!(h.emu.grid.primary.pen.fg, crate::terminal::color::ANSI_COLORS[2], "green fg should survive");
}
