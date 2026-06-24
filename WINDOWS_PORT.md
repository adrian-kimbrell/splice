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

- [x] Add a `windows-latest` build-check workflow on this branch (`.github/workflows/windows-build.yml`).
- [x] First run failed in the Rust `Build` step (npm/frontend passed) — as predicted.
- [x] Write the ranked list of real compile blockers here.
- [ ] Confirm the gating produces a clean Windows compile (CI).

**Exit:** a concrete, verified blocker list. No design decisions yet.

### Phase 0 findings

Audited the whole tree. The cross-platform groundwork was already mostly done:
`check_pid_alive` and `attention/token.rs` already have `#[cfg(unix)]` paths with
non-unix fallbacks; `libc` compiles on Windows; the macOS-only modules (`dock`,
`window_swizzle`) are already `#[cfg(target_os = "macos")]`-gated.

**The only real blocker was `openssh`** (the `native-mux` feature = Unix domain
sockets + ssh ControlMaster, won't compile on Windows). Gated in this commit:
- `Cargo.toml`: `openssh` moved to `[target.'cfg(not(windows))'.dependencies]`.
- `commands/mod.rs`: `pub mod ssh` behind `#[cfg(not(windows))]`.
- `state.rs`: `ssh_sessions` field + init behind `#[cfg(not(windows))]`.
- `lib.rs`: the 6 SSH command registrations behind `#[cfg(not(windows))]` (all 3 handler blocks).

Net effect on Windows: SSH/SFTP remote workspaces are absent; everything else
builds. The frontend SSH UI still exists and will error at runtime if invoked —
hiding it on Windows is a Phase 1 task.

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
