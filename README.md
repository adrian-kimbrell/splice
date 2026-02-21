# Splice

**All your work. One window.**

Splice is a code editor built around workspaces — fully isolated environments, each with their own file tree, terminals, editor panes, and layout. Switch between projects in a keystroke. Run multiple agents in parallel. Keep everything in context without juggling windows.

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## The workspace

A workspace in Splice is a complete development context:

- **Its own file tree** — open a different root folder per workspace
- **Its own terminals** — sessions that keep running when you switch away
- **Its own editor state** — open files, tabs, active file, scroll position
- **Its own pane layout** — arrange terminals and editors per project, not globally

Switch workspaces with `Cmd+Opt+Shift+Arrow`. Everything you left is exactly where you left it.

Most editors give you one context and ask you to manage the rest yourself. Splice keeps multiple contexts alive simultaneously — organized, not crammed.

---

## Features

**Workspaces**
- Multiple independent workspaces per window — create, rename, close
- Each workspace has its own file tree, terminals, editor tabs, and pane layout
- State is fully isolated: switching workspaces never disturbs the other

**Layout**
- Binary tree split system — split any pane horizontally or vertically into a terminal or editor
- Drag to resize from edges or intersection corners
- Spatial pane navigation — move between panes by physical position (`Cmd+Opt+Arrow`)
- Pane zoom — maximize any pane to full screen and back (`Cmd+Z`)
- Tab drag & drop — move tabs between panes or split into a new pane by dragging to an edge zone

**Editor**
- CodeMirror 6 with syntax highlighting for TypeScript, Rust, Python, HTML, CSS, JSON, and Markdown
- Minimap, indent guides, bracket matching, auto-close brackets, word wrap
- Preview tabs — single-click opens a preview, double-click or edit promotes to permanent
- Git branch indicator per workspace
- Recent files

**Terminal**
- Custom emulator built from scratch — no xterm.js
- Full xterm-256color parity, 24-bit truecolor, One Dark palette
- 10,000-line scrollback, ~120fps frame cap, Condvar-based emitter (no polling)
- Click, double-click (word), triple-click (line), drag selection

**File explorer**
- Per-workspace tree view with indent guides and folder open/collapse
- File system watching — tree updates automatically when files change on disk

**Claude attention**
- Surfaces Claude Code permission requests and idle states inline in the footer
- Identifies the specific terminal and workspace that needs attention
- Dismiss with a keypress or click; stacks multiple alerts with a dropdown

---

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Opt+Arrow` | Navigate to adjacent pane (spatial) |
| `Cmd+Opt+Shift+Left/Right` | Switch workspace prev/next |
| `Cmd+Z` | Toggle pane zoom |
| `Cmd+1–9` | Focus pane by index |
| `Cmd+K` | Command palette |
| `Cmd+N` | New file |
| `Cmd+S` | Save file |
| `Cmd+B` | Toggle file explorer |
| `Cmd+,` | Settings |
| `Escape` | Close overlays / unzoom |

---

## Terminal

The terminal emulator is a complete ground-up implementation — not a wrapper around xterm.js. Built to be fast and reliable enough for the workspace model: multiple concurrent sessions, long-running agent processes, full compatibility with modern CLI tools.

**Rendering pipeline:**
```
PTY reader → VTE parser → Grid mutations → binary serialization → Tauri event → Canvas 2D
```

**Binary frame protocol:** 12-byte header (cols, rows, cursor, flags) + 12 bytes per cell (codepoint, fg RGB, bg RGB, flags). Base64-encoded over Tauri events.

**Frame scheduling:** Condvar-based wake with 8ms minimum frame interval (~120fps cap). No polling.

**Compatibility:** xterm-256color, COLORTERM=truecolor. One Dark palette. Full modifier-aware keyboard encoding, bracketed paste, alt screen, REP, HTS/TBC/CBT, IND/NEL, DECKPAM/DECKPNM, SGR blink/hidden.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Svelte 5 (runes) + Tailwind CSS v3 |
| Editor | CodeMirror 6 |
| Terminal renderer | Canvas 2D (custom) |
| Backend | Tauri v2 + Rust |
| Terminal | `vte` crate + custom Grid model + `portable-pty` |
| File watching | `notify` crate |
| IPC | Typed invoke wrappers + binary frame events |

---

## Development

**Prerequisites:** Node.js 18+, Rust stable, [Tauri CLI](https://v2.tauri.app/start/prerequisites/)

```bash
npm install
cargo tauri dev       # development with HMR
cargo tauri build     # production build
```

---

## Project structure

```
src/                          # Svelte frontend
  components/
    panes/                    # PaneGrid, EditorPane, TerminalPane, TabBar
    terminal/                 # CanvasTerminal, TerminalTitlebar
    sidebar/                  # File explorer, workspace sidebar
    topbar/                   # Footer bar, notifications
    overlays/                 # Command palette, settings
  lib/
    ipc/                      # Tauri IPC command/event wrappers
    stores/                   # Svelte 5 reactive stores (workspace, layout, UI, attention)
    terminal/                 # Canvas renderer
    theme/                    # Theme definitions
    utils/                    # Keybindings, language detection, settings window

src-tauri/                    # Rust backend
  src/
    terminal/
      grid.rs                 # Grid model, ScreenBuffer, scroll regions, tab stops
      term.rs                 # VTE Perform — CSI/ESC/SGR dispatch
      emitter.rs              # Frame serialization, Condvar-based emitter thread
      color.rs                # One Dark palette, ANSI 256-color table
      pty.rs                  # PTY spawn, read/write threads
    attention/                # Claude hook HTTP server, process tree matching
    commands/                 # Tauri command handlers (fs, terminal, workspace, settings)
    workspace/                # Workspace persistence and layout types
```

---

## License

MIT
