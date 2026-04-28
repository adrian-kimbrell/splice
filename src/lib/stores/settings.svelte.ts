/**
 * Settings persistence bridge between Svelte 5 reactive state and Rust-side file I/O.
 *
 * On startup, `initSettings()` loads settings from the Rust backend via the
 * `getSettings` IPC command and defensively merges each category into the
 * reactive `settings` object (handles older settings files missing new keys).
 *
 * When the UI mutates `settings`, call `debouncedSaveSettings()` to write
 * changes back to disk after a 500ms debounce. `flushSettingsSave()` forces
 * an immediate write (used before window close).
 *
 * Settings are organized into four categories:
 * - `general` -- auto-save behavior, session restore, Claude notification prefs
 * - `editor` -- font, tab size, word wrap, minimap, bracket matching, etc.
 * - `appearance` -- theme, UI scale, status bar, explorer/workspaces widths
 * - `terminal` -- shell, font, cursor style, scrollback
 *
 * @exports Settings - Full settings interface
 * @exports settings - Svelte 5 reactive state (mutate directly, then call debouncedSaveSettings)
 * @exports initSettings - One-shot loader, safe to call multiple times (deduped)
 * @exports debouncedSaveSettings - Debounced write-back to Rust
 * @exports flushSettingsSave - Immediate write-back for shutdown paths
 */

export interface Settings {
  general: {
    auto_save: "off" | "onFocusChange" | "afterDelay";
    auto_save_delay: number;
    restore_previous_session: boolean;
    claude_notifications: boolean;
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
    font_size: number;
    ui_scale: number;
    show_status_bar: boolean;
    explorer_side: "left" | "right";
    explorer_width: number;
    workspaces_width: number;
  };
  terminal: {
    default_shell: string;
    font_size: number;
    cursor_style: string;
    cursor_blink: boolean;
    scrollback_lines: number;
    font_family: string;
    copy_on_select: boolean;
    show_full_path: boolean;
  };
}

const defaultSettings: Settings = {
  general: {
    auto_save: "off",
    auto_save_delay: 1000,
    restore_previous_session: true,
    claude_notifications: true,
  },
  editor: {
    font_family: "Menlo",
    font_size: 15,
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
    font_size: 15,
    ui_scale: 100,
    show_status_bar: true,
    explorer_side: "left",
    explorer_width: 240,
    workspaces_width: 220,
  },
  terminal: {
    default_shell: "/bin/zsh",
    font_size: 15,
    cursor_style: "Block",
    cursor_blink: true,
    scrollback_lines: 10000,
    font_family: "Menlo",
    copy_on_select: false,
    show_full_path: false,
  },
};

export const settings = $state<Settings>(structuredClone(defaultSettings));

/** A partial subset of Settings — anything not specified falls through to user settings. */
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** Project-level overrides loaded from `<workspaceRoot>/.splice/settings.json`.
 * Internal — modify only via `loadProjectSettings()`. Read indirectly through
 * `effectiveSettings`. Reset to `{}` when no workspace is active. */
let projectSettings = $state<DeepPartial<Settings>>({});

/** The merged view of user settings + project overrides. Read-only.
 * Project values take precedence over user values for any key they specify.
 * Components and non-component code should read from this when they want
 * the value that should actually apply for the current workspace.
 *
 * Bindings in the Settings panel still use `settings` directly so the user
 * is editing their *user* settings, not the merged effective view.
 *
 * Wrapped in a class with `$derived` fields per category because Svelte 5
 * forbids exporting bare `$derived` from a module (see svelte.dev/e/derived_invalid_export). */
class EffectiveSettings {
  general = $derived({ ...settings.general, ...(projectSettings.general ?? {}) });
  editor = $derived({ ...settings.editor, ...(projectSettings.editor ?? {}) });
  appearance = $derived({ ...settings.appearance, ...(projectSettings.appearance ?? {}) });
  terminal = $derived({ ...settings.terminal, ...(projectSettings.terminal ?? {}) });
}
export const effectiveSettings = new EffectiveSettings();

/**
 * Ensure `<workspaceRoot>/.splice/settings.json` exists (creating it with
 * `{}` if absent), then return its absolute path so a caller can open it
 * in an editor pane. Returns `null` if no workspace is active.
 */
export async function ensureWorkspaceSettingsFile(workspaceRoot: string | null): Promise<string | null> {
  if (!workspaceRoot) return null;
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!isTauri) return null;
  const { readProjectSettings, writeProjectSettings } = await import("../ipc/commands");
  const raw = await readProjectSettings(workspaceRoot).catch(() => "");
  if (!raw.trim()) {
    await writeProjectSettings(workspaceRoot, "{\n  \n}\n").catch((e) =>
      console.error("Failed to create workspace settings file:", e),
    );
  }
  return `${workspaceRoot}/.splice/settings.json`;
}

/** Load `.splice/settings.json` from a workspace's root directory. Pass `null`
 * to clear the overrides (e.g. when no workspace is active). Idempotent. */
export async function loadProjectSettings(workspaceRoot: string | null): Promise<void> {
  if (!workspaceRoot) {
    projectSettings = {};
    return;
  }
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!isTauri) return;
  try {
    const { readProjectSettings } = await import("../ipc/commands");
    const raw = await readProjectSettings(workspaceRoot);
    if (!raw.trim()) {
      projectSettings = {};
      return;
    }
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      projectSettings = parsed as DeepPartial<Settings>;
    } else {
      projectSettings = {};
    }
  } catch (e) {
    console.warn(`Failed to load project settings for ${workspaceRoot}:`, e);
    projectSettings = {};
  }
}

let settingsInitPromise: Promise<void> | null = null;

export async function initSettings(): Promise<void> {
  if (settingsInitPromise) return settingsInitPromise;
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!isTauri) return;

  settingsInitPromise = (async () => {
    try {
      const { getSettings } = await import("../ipc/commands");
      const loaded = await getSettings();
      // Defensively merge each category (old settings.json may lack `general`)
      if (loaded.general) Object.assign(settings.general, loaded.general);
      if (loaded.editor) Object.assign(settings.editor, loaded.editor);
      if (loaded.appearance) Object.assign(settings.appearance, loaded.appearance);
      if (loaded.terminal) Object.assign(settings.terminal, loaded.terminal);
    } catch (e) {
      console.error("Failed to load settings:", e);
    }
  })();
  return settingsInitPromise;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function debouncedSaveSettings(): void {
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!isTauri || !settingsInitPromise) return;

  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const { updateSettings } = await import("../ipc/commands");
      await updateSettings(JSON.parse(JSON.stringify(settings)));
    } catch (e) {
      console.error("Failed to save settings:", e);
    }
  }, 500);
}

export function flushSettingsSave(): void {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!isTauri || !settingsInitPromise) return;
  import("../ipc/commands").then(({ updateSettings }) =>
    updateSettings(JSON.parse(JSON.stringify(settings)))
  ).catch((e) => console.error("Failed to flush settings:", e));
}
