# Splice

A modern, terminal-native code editor built with Tauri, Svelte 5, and Rust.

![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Multi-pane editing** — Split horizontally/vertically, resize from edges or drag intersection corners to resize multiple panes at once
- **Integrated terminal** — Full PTY-backed terminal with WebGL rendering via xterm.js
- **Workspaces** — Multiple independent workspaces with their own file trees, terminals, and layouts
- **Pane zoom** — Alt+Z to maximize any pane, toggle back instantly
- **Command palette** — Quick access to actions via Cmd+K
- **Syntax highlighting** — CodeMirror 6 with support for TypeScript, Rust, Python, HTML, CSS, JSON, and Markdown
- **File explorer** — Tree view with indent guides and folder open/collapse
- **Tab drag & drop** — Move tabs between panes or split into new panes by dragging

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+N | New file |
| Cmd+K | Command palette |
| Cmd+, | Settings |
| Cmd+B | Toggle file explorer |
| Cmd+1-9 | Switch to pane by index |
| Cmd+Shift+[ / ] | Switch workspace prev/next |
| Alt+Z | Toggle pane zoom |

## Stack

- **Frontend:** Svelte 5 (runes) + Tailwind CSS + CodeMirror 6 + xterm.js
- **Backend:** Tauri v2 + Rust
- **Terminal:** `portable-pty` crate with raw byte streaming
- **Rendering:** WebGL-accelerated terminal, hardware-accelerated editor

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://rustup.rs/) (stable)
- [Tauri CLI](https://v2.tauri.app/start/prerequisites/)

### Setup

```bash
npm install
```

### Run in development

```bash
cargo tauri dev
```

### Build for production

```bash
cargo tauri build
```

## Project Structure

```
src/                    # Svelte frontend
  components/           # UI components (panes, sidebar, topbar, overlays)
  lib/
    ipc/                # Tauri IPC command/event wrappers
    stores/             # Svelte 5 reactive stores
    utils/              # Keybindings, language detection, layout geometry
src-tauri/              # Rust backend
  src/
    main.rs             # Tauri commands, PTY management
```

## License

MIT
