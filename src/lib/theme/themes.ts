export interface ThemeColors {
  "bg-editor": string;
  "bg-sidebar": string;
  "bg-statusbar": string;
  "bg-tab": string;
  "bg-tab-active": string;
  "bg-hover": string;
  "bg-selected": string;
  "bg-input": string;
  "bg-palette": string;
  border: string;
  text: string;
  "text-dim": string;
  "text-bright": string;
  accent: string;
  "tab-indicator": string;
}

export const themes: Record<string, ThemeColors> = {
  "One Dark": {
    "bg-editor": "#282c34",
    "bg-sidebar": "#21252b",
    "bg-statusbar": "#21252b",
    "bg-tab": "#21252b",
    "bg-tab-active": "#282c34",
    "bg-hover": "#2c313a",
    "bg-selected": "#3e4451",
    "bg-input": "#1b1d23",
    "bg-palette": "#21252b",
    border: "#181a1f",
    text: "#abb2bf",
    "text-dim": "#636d83",
    "text-bright": "#d7dae0",
    accent: "#528bff",
    "tab-indicator": "#528bff",
  },
};

export function applyTheme(name: string) {
  const theme = themes[name];
  if (!theme) return;

  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme)) {
    root.style.setProperty(`--${key}`, value);
  }
}
