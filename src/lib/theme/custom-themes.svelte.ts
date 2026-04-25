/**
 * Reactive store for user-defined custom themes.
 *
 * Custom themes are loaded from the Rust backend at startup via
 * {@link loadCustomThemes} and stored in a Svelte 5 `$state` map so the
 * theme picker updates automatically. Themes can also be registered and
 * unregistered at runtime (e.g. from the settings UI).
 *
 * Custom themes take priority over built-in themes in {@link applyTheme}.
 */
import type { ThemeColors } from "./themes";

export const customThemeMap = $state<Record<string, ThemeColors>>({});

export function registerCustomTheme(name: string, colors: ThemeColors): void {
  customThemeMap[name] = colors;
}

export function unregisterCustomTheme(name: string): void {
  delete customThemeMap[name];
}

export function getCustomThemeNames(): string[] {
  return Object.keys(customThemeMap);
}

export async function loadCustomThemes(): Promise<void> {
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!isTauri) return;
  try {
    const { listCustomThemes } = await import("../ipc/commands");
    const themes = await listCustomThemes();
    for (const t of themes) {
      customThemeMap[t.name] = t.colors as unknown as ThemeColors;
    }
  } catch (e) {
    console.error("Failed to load custom themes:", e);
  }
}
