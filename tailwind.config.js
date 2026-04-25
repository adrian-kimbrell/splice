/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{svelte,ts,js,html}", "./index.html"],
  theme: {
    extend: {
      colors: {
        editor: "var(--bg-editor)",
        sidebar: "var(--bg-sidebar)",
        statusbar: "var(--bg-statusbar)",
        tab: "var(--bg-tab)",
        "tab-active": "var(--bg-tab-active)",
        hover: "var(--bg-hover)",
        selected: "var(--bg-selected)",
        input: "var(--bg-input)",
        palette: "var(--bg-palette)",
        border: "var(--border)",
        txt: "var(--text)",
        "txt-dim": "var(--text-dim)",
        "txt-bright": "var(--text-bright)",
        accent: "var(--accent)",
        "tab-indicator": "var(--tab-indicator)",
        "git-added": "var(--git-added)",
        "git-modified": "var(--git-modified)",
        "git-deleted": "var(--git-deleted)",
      },
      boxShadow: {
        // Intentionally override Tailwind defaults with our design tokens
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
        xl: "var(--shadow-xl)",
      },
      transitionDuration: {
        fast: "var(--duration-fast)",
        base: "var(--duration-base)",
        slow: "var(--duration-slow)",
      },
      transitionTimingFunction: {
        default: "var(--ease-default)",
      },
    },
  },
  plugins: [],
};
