import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve } from "path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [svelte({
    onwarn(warning, defaultHandler) {
      // Suppress a11y warnings — this is a desktop app, not a web page
      if (warning.code.startsWith('a11y')) return;
      defaultHandler(warning);
    },
  })],
  clearScreen: false,
  // CodeMirror ships several packages that MUST be singletons — the editor core is
  // imported statically while language packages (@codemirror/lang-*) are imported
  // dynamically. Without dedupe + prebundling, Vite/Rollup can hand the dynamic
  // chunks a second copy of @codemirror/state and @lezer/highlight, so the parser's
  // highlight `tags` differ by identity from the ones HighlightStyle matches against
  // → zero matches → all syntax highlighting silently renders monochrome.
  resolve: {
    dedupe: [
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/language",
      "@lezer/common",
      "@lezer/highlight",
    ],
  },
  optimizeDeps: {
    include: [
      "@codemirror/lang-javascript",
      "@codemirror/lang-html",
      "@codemirror/lang-css",
      "@codemirror/lang-json",
      "@codemirror/lang-rust",
      "@codemirror/lang-python",
      "@codemirror/lang-markdown",
    ],
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        settings: resolve(__dirname, "settings.html"),
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
