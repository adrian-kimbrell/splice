export interface Settings {
  general: {
    auto_save: "off" | "onFocusChange" | "afterDelay";
    auto_save_delay: number;
    restore_previous_session: boolean;
  };
  editor: {
    font_family: string;
    font_size: number;
    tab_size: number;
    word_wrap: boolean;
    line_numbers: boolean;
    minimap: boolean;
    insert_spaces: boolean;
    bracket_matching: boolean;
    auto_close_brackets: boolean;
    highlight_active_line: boolean;
    scroll_past_end: boolean;
    indent_guides: boolean;
  };
  appearance: {
    theme: string;
    ui_scale: number;
    show_status_bar: boolean;
    explorer_side: "left" | "right";
  };
  terminal: {
    default_shell: string;
    font_size: number;
    cursor_style: string;
    cursor_blink: boolean;
    scrollback_lines: number;
    font_family: string;
    copy_on_select: boolean;
  };
}

const defaultSettings: Settings = {
  general: {
    auto_save: "off",
    auto_save_delay: 1000,
    restore_previous_session: true,
  },
  editor: {
    font_family: "Menlo",
    font_size: 13,
    tab_size: 4,
    word_wrap: false,
    line_numbers: true,
    minimap: false,
    insert_spaces: true,
    bracket_matching: true,
    auto_close_brackets: true,
    highlight_active_line: true,
    scroll_past_end: true,
    indent_guides: true,
  },
  appearance: {
    theme: "Splice Default",
    ui_scale: 100,
    show_status_bar: true,
    explorer_side: "left",
  },
  terminal: {
    default_shell: "/bin/zsh",
    font_size: 12,
    cursor_style: "Block",
    cursor_blink: true,
    scrollback_lines: 10000,
    font_family: "Menlo",
    copy_on_select: false,
  },
};

export const settings = $state<Settings>(structuredClone(defaultSettings));

let settingsInitialized = false;

export async function initSettings(): Promise<void> {
  if (settingsInitialized) return;
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!isTauri) return;

  try {
    const { getSettings } = await import("../ipc/commands");
    const loaded = await getSettings();
    // Defensively merge each category (old settings.json may lack `general`)
    if (loaded.general) Object.assign(settings.general, loaded.general);
    if (loaded.editor) Object.assign(settings.editor, loaded.editor);
    if (loaded.appearance) Object.assign(settings.appearance, loaded.appearance);
    if (loaded.terminal) Object.assign(settings.terminal, loaded.terminal);
    settingsInitialized = true;
  } catch (e) {
    console.error("Failed to load settings:", e);
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function debouncedSaveSettings(): void {
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!isTauri || !settingsInitialized) return;

  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const { updateSettings } = await import("../ipc/commands");
      await updateSettings(JSON.parse(JSON.stringify(settings)));
    } catch (e) {
      console.error("Failed to save settings:", e);
    }
  }, 500);
}
