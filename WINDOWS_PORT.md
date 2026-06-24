# Windows Port — Plan & Status

Splice has been macOS-only. This tracks bringing it to Windows. Work happens on
the `windows-support` branch and merges to `main` only when a phase is green on
**both** OSes.

## Audit: what's portable vs. macOS-coupled

**Already cross-platform (no work):** Tauri itself, the terminal (`portable-pty`
→ ConPTY on Windows, `vte` parser, canvas renderer, scrollback), the editor
(CodeMirror), file watching (`notify`), git (subprocess), settings, LSP, the
attention HTTP server, and config paths (`dirs::config_dir()` → `%APPDATA%`).

**macOS-coupled (needs work):**

| # | Area | Why it's macOS-only | Fix |
|---|------|---------------------|-----|
| 1 | **SSH** | `openssh` + `native-mux` uses Unix domain sockets + `ssh` ControlMaster. Likely won't compile on Windows. | Feature-gate off for MVP; rewrite on `russh` for parity. |
| 2 | **Window chrome** | Overlay title bar + traffic-light positioning (`window_swizzle.rs`, `dock.rs`, `--header-traffic-offset`). | Windows title bar variant: custom min/max/close, no left padding. `#[cfg]` code compiles out already. |
| 3 | **Keybindings** | macOS uses Cmd for app shortcuts (Ctrl stays free for the terminal); Windows has only Ctrl. | Ctrl-based scheme; likely Ctrl+Shift for app shortcuts inside terminals. **Real design decision.** |
| 4 | **Path handling** | Frontend splits on `"/"` in ~20 spots; Windows uses `\`. Rust side (`PathBuf`) is fine. | Make frontend separator-agnostic. |
| 5 | **Attention/Claude hook** | Hardcodes `~/Library/Application Support`; assumes `python`/`curl` exist. | Windows paths + dependency check, or disable. |
| 6 | **Open With** | macOS `Info.plist`. Windows uses registry associations; files arrive as argv, not `RunEvent::Opened`. | Windows file associations + single-instance argv handling. |
| 7 | **CI / signing** | Release workflow is macOS-only. | Add `windows-latest` job → MSI/NSIS; Authenticode signing later. |

## Phase 0 — Surface reality  *(current)*

**Goal:** stop guessing — find what actually breaks on a real Windows compile.

- [ ] Add a `windows-latest` build-check workflow on this branch (`.github/workflows/windows-build.yml`).
- [ ] Read the failure log; confirm `openssh` is the first wall and catch anything else.
- [ ] Write the ranked list of real compile blockers here.

**Exit:** a concrete, verified blocker list. No design decisions yet.

### Phase 0 findings
_(to be filled in from the first CI run)_

## Phase 1 — It compiles and runs (MVP)

**Goal:** an unsigned Windows build that launches, edits files, runs terminals.

- [ ] Feature-gate SSH so `openssh` isn't compiled on Windows (SSH workspaces unavailable in MVP).
- [ ] Fix remaining compile blockers from Phase 0.
- [ ] Windows title bar variant (custom window controls; drop traffic-light padding).
- [ ] Ctrl-based keybinding scheme (decide terminal-shortcut modifier explicitly).
- [ ] Separator-agnostic path handling in the frontend.
- [ ] Attention hook: Windows paths + `python`/`curl` check, or disable.
- [ ] CI produces an MSI/NSIS artifact (unsigned).

**Exit:** friend installs the MSI, opens a folder, runs a terminal, edits a file
(SmartScreen warns — acceptable unsigned).

## Phase 2 — First-class Windows

**Goal:** parity, polished, distributable.

- [ ] Rewrite `ssh.rs` on `russh` (restore remote workspaces, both OSes).
- [ ] Open With via Windows file associations + single-instance argv handling.
- [ ] Authenticode code signing.
- [ ] Canvas DPI/font polish, snap layouts, taskbar behavior.

**Exit:** a signed Windows release alongside macOS.
