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
      },
    },
  },
  plugins: [],
};
