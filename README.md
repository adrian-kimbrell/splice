# malloc

A terminal-native code editor built with Tauri, Svelte 5, and Rust.

![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Custom terminal emulator** — Built from scratch: VTE parser, Grid model, binary serialization, Canvas 2D rendering. Full xterm-256color compatibility with truecolor, 256-color palette, and One Dark theme
- **Multi-pane editing** — Binary tree layout with horizontal/vertical splits, drag-to-resize from edges or intersection corners
- **Spatial pane navigation** — Navigate between panes directionally based on their physical position in the layout
- **Workspaces** — Multiple independent workspaces, each with their own file tree, terminals, and layout
- **Pane zoom** — Maximize any pane to full screen, toggle back instantly
- **Command palette** — Quick access to actions
- **Syntax highlighting** — CodeMirror 6 with TypeScript, Rust, Python, HTML, CSS, JSON, and Markdown
- **File explorer** — Tree view with indent guides and folder open/collapse
- **Tab drag & drop** — Move tabs between panes or split into new panes by dragging to edge zones

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+Option+Arrow | Navigate to adjacent pane (spatial) |
| Cmd+Option+Shift+Left/Right | Switch workspace prev/next |
| Cmd+Z | Toggle pane zoom |
| Cmd+1-9 | Switch to pane by index |
| Cmd+N | New file |
| Cmd+K | Command palette |
| Cmd+, | Settings |
| Cmd+B | Toggle file explorer |
| Escape | Close overlays / unzoom |

## Terminal

The terminal emulator is a custom implementation replacing xterm.js, with full xterm-256color parity:

- **Rendering pipeline:** PTY reader &rarr; VTE parser &rarr; Grid mutations &rarr; binary serialization &rarr; Tauri event &rarr; Canvas 2D
- **Binary protocol:** 12-byte header + 12 bytes/cell (codepoint, fg/bg RGB, flags), base64-encoded over Tauri events
- **Frame scheduling:** Condvar-based wake with 8ms minimum frame interval (~120fps cap)
- **Scrollback:** 10,000 lines on primary screen, mouse wheel scrolling with smooth accumulation
- **Selection:** Click, double-click (word), triple-click (line), drag selection with copy support
- **Keyboard:** Full modifier-aware encoding &mdash; Shift+Tab, Ctrl/Alt/Shift+Arrow, modified F-keys, Ctrl+@/^/_
- **Sequences:** DSR, DA, DECALN, REP, HTS/TBC/CBT, IND/NEL, DECKPAM/DECKPNM, alt screen variants, SGR blink/hidden, bracketed paste
- **Colors:** One Dark palette, ANSI 16 + 256-color + 24-bit truecolor

## Stack

- **Frontend:** Svelte 5 (runes) + Tailwind CSS v3 + CodeMirror 6 + Canvas 2D terminal
- **Backend:** Tauri v2 + Rust
- **Terminal:** VTE crate for parsing, custom Grid model, `portable-pty` for PTY management
- **IPC:** Typed invoke wrappers with binary frame data over Tauri events

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
src/                          # Svelte frontend
  components/
    panes/                    # PaneGrid, EditorPane, TerminalPane, TabBar
    terminal/                 # CanvasTerminal, TerminalTitlebar
    sidebar/                  # File explorer, right sidebar
    topbar/                   # Top bar with workspace tabs
    overlays/                 # Command palette, settings
  lib/
    ipc/                      # Tauri IPC command/event wrappers
    stores/                   # Svelte 5 reactive stores (workspace, layout, UI, drag)
    terminal/                 # Canvas renderer
    utils/                    # Keybindings, language detection
src-tauri/                    # Rust backend
  src/
    terminal/
      grid.rs                 # Grid model, ScreenBuffer, Cell, tab stops, scroll regions
      term.rs                 # VTE Perform implementation, CSI/ESC/SGR dispatch
      emitter.rs              # Frame serialization, Condvar-based emitter thread
      color.rs                # One Dark palette, ANSI 256-color table
      pty.rs                  # PTY spawning, read/write threads
    commands/                 # Tauri command handlers
    workspace/                # Workspace persistence
```

## License

MIT
