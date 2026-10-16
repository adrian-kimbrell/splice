import { describe, it, expect } from "vitest";
import { clampSettings, SETTING_RANGES, type Settings } from "./settings.svelte";

// Numeric settings are range-checked on load so a damaged settings.json
// (font_size 0, ui_scale 0) cannot yield a 0px font or a zoom of 0.

function base(): Settings {
  return {
    general: { auto_save: "off", auto_save_delay: 1000, restore_previous_session: true, claude_notifications: true, default_single_view: false },
    editor: { font_family: "Menlo", font_size: 15, tab_size: 4, word_wrap: false, line_numbers: true, minimap: false, insert_spaces: true, bracket_matching: true, auto_close_brackets: true, highlight_active_line: true, scroll_past_end: true, indent_guides: true },
    appearance: { theme: "x", font_size: 15, ui_scale: 100, show_status_bar: true, explorer_side: "left", explorer_width: 240, workspaces_width: 220 },
    terminal: { default_shell: "/bin/zsh", font_size: 15, cursor_style: "Block", cursor_blink: true, scrollback_lines: 10000, font_family: "Menlo", copy_on_select: false, show_full_path: false, name_follows_cwd: false },
  };
}

describe("clampSettings", () => {
  it("zero_font_sizes_and_zoom_are_pulled_up_to_the_minimum", () => {
    const s = base();
    s.terminal.font_size = 0;
    s.editor.font_size = 0;
    s.appearance.ui_scale = 0;
    clampSettings(s);
    expect(s.terminal.font_size).toBe(SETTING_RANGES.fontSize[0]);
    expect(s.editor.font_size).toBe(SETTING_RANGES.fontSize[0]);
    expect(s.appearance.ui_scale).toBe(SETTING_RANGES.uiScale[0]);
  });

  it("oversized_values_are_capped", () => {
    const s = base();
    s.appearance.ui_scale = 999;
    s.terminal.scrollback_lines = 10_000_000;
    s.editor.tab_size = 40;
    clampSettings(s);
    expect(s.appearance.ui_scale).toBe(SETTING_RANGES.uiScale[1]);
    expect(s.terminal.scrollback_lines).toBe(SETTING_RANGES.scrollback[1]);
    expect(s.editor.tab_size).toBe(SETTING_RANGES.tabSize[1]);
  });

  it("non_numeric_garbage_falls_back_to_the_default", () => {
    const s = base();
    (s.editor as unknown as { font_size: unknown }).font_size = "big";
    (s.general as unknown as { auto_save_delay: unknown }).auto_save_delay = null;
    clampSettings(s);
    expect(s.editor.font_size).toBe(15);
    expect(s.general.auto_save_delay).toBe(1000);
  });

  it("sane_values_are_untouched", () => {
    const s = base();
    const before = JSON.stringify(s);
    clampSettings(s);
    expect(JSON.stringify(s)).toBe(before);
  });
});
