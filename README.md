# Splice

**All your work. One window.**

Splice is a code editor built for the way modern development actually works — multiple projects, multiple terminals, multiple agents running at once, without ever losing your place.

[**Download for macOS (Apple Silicon) →**](https://github.com/adrian-kimbrell/splice/releases/latest)

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> **macOS:** Because Splice is not yet notarized, you may see a "damaged" warning on first launch. Run `xattr -cr /Applications/Splice.app` in Terminal to fix it, then open normally.

---

## The problem with other editors

Every project you work on deserves its own full context — its own file tree, its own terminal sessions, its own editor layout. But most editors give you one of everything and expect you to manage the rest yourself. You end up with a mess of terminal tabs, jumbled file trees, and constant context-switching overhead.

Splice solves this with **workspaces**.

---

## Workspaces

A workspace in Splice is a complete, isolated development environment:

- Its own **file tree** — each workspace opens a different root folder
- Its own **terminals** — sessions keep running when you switch away
- Its own **editor state** — open files, tabs, scroll positions, all preserved
- Its own **pane layout** — arrange your editors and terminals per project, not globally

Switch between workspaces instantly with `Cmd+Opt+Shift+Arrow`. Everything you left is exactly where it was. No reloading, no re-navigating, no losing your train of thought.

---

## Built for agents

Splice was designed from the ground up for running AI coding agents alongside your work.

The **Claude attention system** surfaces permission requests and idle notifications inline — without interrupting your focus. You see exactly which terminal needs attention, dismiss it with a click, and get back to work. Multiple alerts stack cleanly in a dropdown.

---

## What's inside

**A terminal that's actually fast**
Splice ships a custom terminal emulator built from scratch — no xterm.js. Full 256-color and truecolor support, 10,000-line scrollback, ~120fps rendering, and complete compatibility with modern CLI tools and TUI apps.

**A real editor**
CodeMirror 6 with syntax highlighting, LSP-powered completions, hover docs, go-to-definition, diagnostics, rename, and code actions. Works out of the box for TypeScript, Rust, and Python with automatic language server installation.

**SSH remote workspaces**
Connect to any remote server via SSH and work as if it were local. Browse the remote file tree, open and edit files over SFTP, and get a remote terminal — all inside the same workspace model.

**Flexible layouts**
Split any pane horizontally or vertically. Drag to resize. Zoom a pane to full screen and back. Drag tabs between panes or split them into new ones. Navigate panes spatially with `Cmd+Opt+Arrow`.

**Multi-window**
Open a second (or third) window with `Cmd+Shift+N`. Each window has its own workspace state and persists independently. Close a window and it's gone; crash and it comes back on next launch.

---

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Opt+Shift+←/→` | Switch workspace |
| `Cmd+Opt+Arrow` | Navigate between panes |
| `Cmd+Z` | Zoom / unzoom pane |
| `Cmd+K` | Command palette |
| `Cmd+Shift+N` | New window |
| `Cmd+N` | New file |
| `Cmd+S` | Save |
| `Cmd+B` | Toggle file explorer |
| `Cmd+F` | Find (editor or terminal) |
| `Cmd+=` / `Cmd+-` | Zoom UI in / out |
| `Cmd+,` | Settings |

---

## Build from source

**Prerequisites:** Node.js 18+, Rust stable, [Tauri CLI](https://v2.tauri.app/start/prerequisites/)

```bash
npm install
cargo tauri dev          # dev mode with hot reload
cargo tauri build        # release build
```

---

## Stack

Tauri v2 + Rust · Svelte 5 · CodeMirror 6 · Canvas 2D terminal renderer · `vte` + `portable-pty`

---

## License

MIT
