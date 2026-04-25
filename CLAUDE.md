# Splice — Desktop Code Editor

Tauri v2 (Rust) + Svelte 5 (runes) + Tailwind v3 + Canvas-based terminal emulator.

## Build & Test

```bash
npm run tauri:dev          # Dev mode with hot reload
npm run tauri:build        # Production build
cargo test                 # Rust unit tests (275+ terminal tests across 18 modules)
npm test                   # Vitest frontend tests
npm run test:e2e           # WebdriverIO E2E (requires build:e2e first)
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  Svelte 5 Frontend (src/)                           │
│                                                     │
│  App.svelte ──── PaneGrid ──── EditorPane           │
│      │               │         TerminalPane         │
│      │               │                              │
│  LeftSidebar    TitleBar    RightSidebar             │
│  (explorer)    (drag+alerts) (workspaces)           │
│                                                     │
│  ┌─── Stores ──────────────────────────────┐        │
│  │ workspace.svelte.ts  (god store)        │        │
│  │ layout.svelte.ts     (binary tree)      │        │
│  │ settings.svelte.ts   (persistence)      │        │
│  │ ui.svelte.ts         (sidebar/zen)      │        │
│  │ drag.svelte.ts       (tab DnD)          │        │
│  │ attention.svelte.ts  (Claude alerts)    │        │
│  │ diagnostics.svelte.ts (LSP errors)      │        │
│  └─────────────────────────────────────────┘        │
│                     │                               │
│            lib/ipc/commands.ts                      │
│            (67 typed invoke wrappers)               │
└──────────────────── │ ──────────────────────────────┘
                      │  Tauri IPC (camelCase → snake_case)
┌──────────────────── │ ──────────────────────────────┐
│  Rust Backend (src-tauri/src/)                      │
│                                                     │
│  lib.rs ──── commands/ ──── fs/  terminal  ssh      │
│    │              │         workspace  settings     │
│    │              │         lsp  git  themes        │
│    │         state.rs (AppState: Mutex<>)            │
│    │                                                │
│  terminal/ ──── pty.rs → term.rs → grid.rs          │
│    │                        │                       │
│    │                   emitter.rs → binary frame     │
│    │                        → Tauri event            │
│  attention/ ── server.rs (HTTP) + hook.rs (Claude)  │
│  lsp/ ──────── mod.rs (JSON-RPC bridge)             │
│  workspace/ ── layout.rs (serialization)            │
└─────────────────────────────────────────────────────┘
```

## Key Data Flows

### Terminal Rendering Pipeline
```
User types → PTY (pty.rs) → VTE parser (term.rs) → Grid cells (grid.rs)
→ Emitter thread (emitter.rs) → 20-byte header + 12 bytes/cell binary frame
→ Tauri event "terminal:grid" → base64 decode (lib/ipc/events.ts)
→ Canvas renderer (lib/terminal/renderer.ts) → dirty-rect paint
```

### Workspace State
```
workspace.svelte.ts (source of truth for all workspace state)
  ├── delegates to workspace-file-ops.ts (open/close/save files)
  ├── delegates to workspace-tab-ops.ts (tab reorder, close others)
  ├── delegates to workspace-session.ts (persist/restore terminals)
  ├── layout mutations via layout.svelte.ts (binary tree: split, close, resize)
  └── components receive data as props via App.svelte paneSnippet
```

### Settings Persistence
```
UI mutates settings reactive state → debouncedSaveSettings() (500ms)
→ updateSettings IPC → Rust saves to ~/.config/Splice/settings.json
→ Rust emits "settings-changed" to all windows → other windows update
```

### Attention/Claude Hook System
```
Splice starts → attention::start_server (HTTP on port 19876-19878)
→ install_hook() writes Python one-liner to ~/.config/claude/hooks/
→ Claude Code triggers hook → curl POST to localhost with Bearer token
→ server.rs parses request → emits "terminal:attention-notify" event
→ attention.svelte.ts store → TitleBar shows notification badge
```

### Drag-and-Drop (Tabs/Panes)
```
mousedown on tab → beginDrag() in drag.svelte.ts (captures payload)
→ mousemove: 4px threshold activates ghost, hit-tests registered panes
→ computeZone: outer 25% = split direction, center = move tab
→ mouseup: dropCallback fires → workspace manager performs layout mutation
```

## File Ownership & Relationships

### Frontend Stores (src/lib/stores/)
| Store | Owns | Consumed By |
|-------|------|-------------|
| `workspace.svelte.ts` | All workspace/file/pane state | App.svelte, sidebars, pane components |
| `layout.svelte.ts` | Binary tree layout ops | workspace.svelte.ts exclusively |
| `settings.svelte.ts` | App preferences | App.svelte, theme system, components |
| `ui.svelte.ts` | Transient UI state (sidebar visibility, zen mode) | App.svelte, TitleBar, sidebars |
| `drag.svelte.ts` | Tab/pane drag-and-drop | PaneGrid, TabBar, App.svelte (callback) |
| `attention.svelte.ts` | Claude notification state | TitleBar, TerminalTitlebar |
| `diagnostics.svelte.ts` | LSP diagnostic aggregation | LeftSidebar (problems panel), StatusBar |
| `files.svelte.ts` | FileEntry/OpenFile type definitions | workspace.svelte.ts, components |

### Rust Command Modules (src-tauri/src/commands/)
| Module | Commands | Purpose |
|--------|----------|---------|
| `fs/` | 21 commands | File I/O, directory tree, file watching, clipboard |
| `terminal.rs` | 12 commands | PTY spawn/write/resize/kill, Claude hook install |
| `workspace.rs` | 11 commands | Layout persistence, window registry, workspace lifecycle |
| `ssh.rs` | 6 commands | SSH connections, SFTP file operations |
| `lsp/` | 5 commands | LSP server lifecycle, JSON-RPC bridge |
| `settings.rs` | 3 commands | Settings load/save, macOS traffic light position |
| `git.rs` | 7 commands | Git status/stage/commit/diff via subprocess |
| `themes.rs` | 3 commands | Custom theme import/list/delete |

## Conventions

- **IPC naming**: Frontend uses camelCase (`readFile`), Rust uses snake_case (`read_file`). The `lib/ipc/commands.ts` file is the single source of truth for all command signatures.
- **Svelte 5 runes**: All reactive state uses `$state()`, `$derived()`, `$effect()`. No legacy `$:` or writable stores.
- **Store pattern**: Stores export a single `$state` object (e.g., `export const ui = $state({...})`). Complex stores like workspace use a class with methods.
- **Path security**: All file operations go through `state.rs::validate_path()` which canonicalizes and checks against `allowed_roots`.
- **Terminal IDs**: Monotonically increasing integers from `AppState.next_terminal_id`.
- **Layout tree**: Binary tree with `{ type: "split", direction, ratio, children }` or `{ type: "leaf", paneId }`. Resize mutates in-place; structural ops (split/close) build a fresh tree.
- **CSS theming**: All colors are CSS custom properties set on `:root` by `applyTheme()`. Terminal canvas reads them via `getComputedStyle`. 73 built-in themes + custom theme support.
- **Binary terminal protocol**: 20-byte header (version, rows, cols, cursorRow, cursorCol, flags, scrollback, firstDisplayRow, activeRow, activeCol) + 12 bytes per cell (codepoint, fg, bg, flags). See `emitter.rs` for full spec.

## Important Gotchas

- **Svelte a11y warnings**: Suppressed in `vite.config.ts` via `onwarn` — this is a desktop app, not a web page.
- **`#[cfg(debug_assertions)]` modules**: `dev_server.rs` and `commands/dev.rs` are gitignored. Never reference them in committed code or CI will fail.
- **Layout proxy reparenting**: Svelte 5's `$state` proxies break when you move a node between parents. `layout.svelte.ts` uses `structuredClone` + fresh assignment for structural mutations.
- **Workspace persistence**: Per-window config files at `~/.config/Splice/workspace-{label}.json`. Active windows tracked in `~/.config/Splice/windows.json`.
- **Traffic light animation**: macOS native controls are repositioned via `setTrafficLightPosition` IPC with a JS requestAnimationFrame lerp to animate between compact (22px) and normal (32px) title bar states.
