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
  // Syntax / ANSI colors
  "syn-kw": string;
  "syn-fn": string;
  "syn-str": string;
  "syn-ty": string;
  "syn-num": string;
  "syn-cm": string;
  "syn-mac": string;
  "syn-attr": string;
  "ansi-red": string;
  "ansi-yellow": string;
}

type GroupLoader = () => Promise<Record<string, ThemeColors>>;

const builtinLoader: GroupLoader = () => import("./themes/builtin").then(m => m.default);
const popularLoader: GroupLoader = () => import("./themes/popular").then(m => m.default);
const extendedLoader: GroupLoader = () => import("./themes/extended").then(m => m.default);

// Maps each theme name to the chunk loader that contains it.
// Builtin themes load immediately; popular/extended load on first use.
const themeGroup: Record<string, GroupLoader> = {
  // builtin
  "Splice Default": builtinLoader,
  "Dark": builtinLoader,
  "Light": builtinLoader,
  // popular
  "Dracula": popularLoader,
  "Solarized Dark": popularLoader,
  "Solarized Light": popularLoader,
  "Nord": popularLoader,
  "Monokai": popularLoader,
  "One Dark": popularLoader,
  "Gruvbox Dark": popularLoader,
  "Tokyo Night": popularLoader,
  "Catppuccin Mocha": popularLoader,
  "Catppuccin Macchiato": popularLoader,
  "Catppuccin Frappé": popularLoader,
  "Catppuccin Latte": popularLoader,
  "GitHub Dark": popularLoader,
  "GitHub Light": popularLoader,
  // extended
  "Cobalt2": extendedLoader,
  "Material Ocean": extendedLoader,
  "Palenight": extendedLoader,
  "Ayu Mirage": extendedLoader,
  "Horizon": extendedLoader,
  "Shades of Purple": extendedLoader,
  "Rosé Pine": extendedLoader,
  "Rosé Pine Moon": extendedLoader,
  "Rosé Pine Dawn": extendedLoader,
  "Kanagawa": extendedLoader,
  "Everforest Dark": extendedLoader,
  "Everforest Light": extendedLoader,
  "Night Owl": extendedLoader,
  "Synthwave '84": extendedLoader,
  "Vesper": extendedLoader,
  "Poimandres": extendedLoader,
  "Moonlight": extendedLoader,
  "Andromeda": extendedLoader,
  "One Light": extendedLoader,
  "Vitesse Dark": extendedLoader,
  "Vitesse Light": extendedLoader,
  "Bluloco Dark": extendedLoader,
  "Fleet Dark": extendedLoader,
  "Atom One Dark": extendedLoader,
  "Flexoki Dark": extendedLoader,
  "Flexoki Light": extendedLoader,
  "Houston": extendedLoader,
  "Min Dark": extendedLoader,
  "Min Light": extendedLoader,
  "Ayu Dark": extendedLoader,
  "Ayu Light": extendedLoader,
  "Monochrome": extendedLoader,
  "Slack Dark": extendedLoader,
  "Palenight Operator": extendedLoader,
  "Tokyo Night Storm": extendedLoader,
  "Tokyo Night Light": extendedLoader,
  "Snazzy": extendedLoader,
  "Gruvbox Light": extendedLoader,
  "Dracula Soft": extendedLoader,
  "Monokai Pro": extendedLoader,
  "Zenburn": extendedLoader,
  "Material Darker": extendedLoader,
  "Noctis": extendedLoader,
  "Panda": extendedLoader,
  "Solarized Nebraska": extendedLoader,
  "Noctis Minimus": extendedLoader,
  "High Contrast": extendedLoader,
  "High Contrast Light": extendedLoader,
  "Nord Light": extendedLoader,
  "Bearded Arc": extendedLoader,
  "Winter Is Coming": extendedLoader,
  "Remedy Dark": extendedLoader,
  "Quiet Light": extendedLoader,
  "Neon Night": extendedLoader,
  "Ember Dark": extendedLoader,
  "Dark Moss": extendedLoader,
  "Sepia": extendedLoader,
};

export const themeNames: string[] = Object.keys(themeGroup);

export async function applyTheme(name: string): Promise<void> {
  const loader = themeGroup[name];
  if (!loader) return;
  const group = await loader();
  const theme = group[name];
  if (!theme) return;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme)) {
    root.style.setProperty(`--${key}`, value);
  }
}
