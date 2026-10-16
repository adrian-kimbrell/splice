# Splice — Desktop Code Editor

Tauri v2 (Rust) + Svelte 5 (runes) + Tailwind v3 + Canvas-based terminal emulator.

## Build & Test

```bash
npm run tauri:dev          # Dev mode with hot reload
npm run tauri:build        # Production build
cargo test                 # Rust unit tests (400+ across terminal, attention, workspace, fs)
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
│            (72 typed invoke wrappers)               │
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
→ updateSettings IPC → Rust saves settings.json in the Splice config dir
   (`~/Library/Application Support/Splice` on macOS, `~/.config/Splice` on Linux)
→ Rust emits "settings-changed" to all windows → other windows update
```

### Attention/Claude Hook System
```
Splice starts → attention::start_server (HTTP on port 19876-19878)
→ install_hook() writes splice_hook.py to ~/.claude/splice-hooks/ and registers it in ~/.claude/settings.json
→ Claude Code triggers hook → Python urllib POST to localhost with X-Splice-Token header
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
| `diagnostics.svelte.ts` | LSP diagnostic aggregation | LeftSidebar (problems panel) |
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
- **Adding a Tauri command**: add the `#[tauri::command]` fn, list it once in the `splice_handlers!` macro in `lib.rs` (the e2e build appends its extras there), and add the typed wrapper in `lib/ipc/commands.ts`.
- **Logging**: use `log.debug/warn/error` from `lib/utils/log.ts`, never bare `console.*`. `debug` is silent in release builds; `window.__spliceLog.setLevel("debug")` turns it on at runtime.
- **Closing workspaces**: always go through `requestCloseWorkspace` (`lib/utils/close-workspace.ts`), which confirms before terminals are killed.
- **Entry vs. content paths (Rust)**: commands that act on a directory *entry* (delete, rename, duplicate, copy destination, create) use `validate_entry_path` (canonical parent + verbatim leaf, so a symlink is handled as the link); commands that read or write *content* use `validate_path` (resolves the target).
- **Config files**: parse leniently (`#[serde(default)]` on every settings/workspace field; `Workspace.layout` is `Option`, `None` = no panes) and never overwrite a file that failed to parse; back it up as `<name>.corrupt-<ts>` first. Same rule for `~/.claude/settings.json`, which is left untouched on a parse error.
- **git status**: `git_status` returns `{ repo_root, files }`; `files[].path` is relative to `repo_root`, which can lie above the workspace root. All pathspec commands run from the repo root and read status with `-z`.
- **File watchers**: `watch_path` / `unwatch_path` are reference counted per canonical path. Always pair them; never assume a path has exactly one watcher.
- **Self-writes**: call `markSelfWrite(path)` (`lib/stores/self-writes.ts`) before writing a file the watcher may report, so the `file:changed` handler can tell our own saves from external edits.
- **openFiles / openFileIndex**: insert through `addOpenFile` so both hold the same `$state` proxy; pushing a raw object into both creates two proxies that do not share writes.
- **Svelte 5 runes**: All reactive state uses `$state()`, `$derived()`, `$effect()`. No legacy `$:` or writable stores.
- **Store pattern**: Stores export a single `$state` object (e.g., `export const ui = $state({...})`). Complex stores like workspace use a class with methods.
- **Path security**: All file operations go through `state.rs::validate_path()` which canonicalizes and checks against `allowed_roots`.
- **Terminal IDs**: Monotonically increasing integers from `AppState.next_terminal_id`.
- **Layout tree**: Binary tree with `{ type: "split", direction, ratio, children }` or `{ type: "leaf", paneId }`. Resize mutates in-place; structural ops (split/close) build a fresh tree.
- **CSS theming**: All colors are CSS custom properties set on `:root` by `applyTheme()`. Terminal canvas reads them via `getComputedStyle`. 73 built-in themes + custom theme support.
- **Binary terminal protocol**: 20-byte header (version, rows, cols, cursorRow, cursorCol, flags, scrollback, firstDisplayRow, activeRow, activeCol) + 12 bytes per cell (codepoint, fg, bg, flags). See `emitter.rs` for full spec.

## Important Gotchas

- **Svelte a11y warnings**: Suppressed in `vite.config.ts` via `onwarn` — this is a desktop app, not a web page.
- **Dev API / E2E hooks**: `dev_server.rs` and `commands/dev.rs` compile only in debug builds (`#[cfg(debug_assertions)]`) and are listed in the debug arms of `invoke_handler`. The frontend bridge `src/lib/dev/` (dev API listeners + `window.__spliceTest`) loads only when `import.meta.env.DEV` or `MODE === "e2e"`, so `npm run build:e2e` builds through `src-tauri/tauri.e2e.conf.json`, whose `beforeBuildCommand` is `vite build --mode e2e` (a plain `tauri build` would overwrite `dist/` with the production bundle). Specs find the root element by `#app-root`.
- **Layout proxy reparenting**: Svelte 5's `$state` proxies break when you move a node between parents. `layout.svelte.ts` uses `structuredClone` + fresh assignment for structural mutations.
- **Workspace persistence**: Per-window files `workspace-{label}.json` plus `windows.json` in the Splice config dir (`~/Library/Application Support/Splice` on macOS; debug builds use `Splice-dev` for these). Every config path goes through `state::splice_config_dir`, and `SPLICE_CONFIG_DIR` overrides it wholesale (the E2E harness sets it to a temp dir; the Claude hook is not installed when it is set).
- **Terminal shutdown**: dropping a `PtySession` SIGHUPs the shell's process group and reaps it on a detached thread (`terminate_child`). Closing our fds alone never delivers a hangup because the reader thread holds a dup of the master.
- **Traffic light animation**: macOS native controls are repositioned via `setTrafficLightPosition` IPC with a JS requestAnimationFrame lerp to animate between compact (22px) and normal (32px) title bar states.
