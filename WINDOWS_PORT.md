# Windows Port — Plan & Status

Splice was macOS-only. This tracks bringing it to Windows. Work happens on the
`windows-support` branch and merges to `main` only when a phase is green on
**both** OSes.

## Audit: what's portable vs. macOS-coupled

**Already cross-platform (no work):** Tauri itself, the terminal (`portable-pty`
→ ConPTY on Windows, `vte` parser, canvas renderer, scrollback), the editor
(CodeMirror), file watching (`notify`), git (subprocess), settings, LSP, the
attention HTTP server, and config paths (`dirs::config_dir()` → `%APPDATA%`).

**macOS-coupled (needed work):**

| # | Area | Why it was macOS-only | Resolution |
|---|------|-----------------------|------------|
| 1 | **SSH** | `openssh` + `native-mux` uses Unix domain sockets + ssh ControlMaster. | ✅ Windows drives its bundled `ssh.exe`; both platforms sit behind `RemoteSession`. |
| 2 | **Window chrome** | Overlay title bar + traffic-light positioning (`window_swizzle.rs`, `dock.rs`). | ✅ Frameless window + custom `WindowControls.svelte`; no native menu on Windows. |
| 3 | **Keybindings** | macOS uses Cmd for app shortcuts (Ctrl stays free for the terminal); Windows has only Ctrl. | ✅ Ctrl outside terminals, Ctrl+Shift inside them. |
| 4 | **Path handling** | Frontend splits on `"/"` in ~30 spots; Windows uses `\`. | ✅ Rust normalizes at the IPC boundary (`state::to_ui_path`); `toUiPath` covers dialog/drag-drop. |
| 5 | **Attention/Claude hook** | Inline `python3 -c` one-liner, Unix paths. | ✅ PowerShell helper script on Windows. |
| 6 | **Open With** | macOS `Info.plist`; Windows delivers files as argv, not `RunEvent::Opened`. | ✅ argv handled at startup + `bundle.fileAssociations`. Single-instance forwarding still open. |
| 7 | **CI / signing** | Release workflow was macOS-only. | ✅ `windows-latest` job builds MSI/NSIS and runs both test suites. Authenticode signing still open. |

## Phase 0 — Surface reality ✅

**Goal:** stop guessing — find what actually breaks on a real Windows compile.

Two blockers, both found by reading real `windows-latest` compiles: the `openssh`
crate (gated, later replaced — see Phase 1) and `WebviewWindowBuilder::title_bar_style`,
a macOS-only Tauri method called unconditionally (now `#[cfg]`-gated).

The groundwork was already mostly done: `check_pid_alive` and `attention/token.rs`
had `#[cfg(unix)]` paths with non-unix fallbacks, `libc` compiles on Windows, and
the macOS-only modules (`dock`, `window_swizzle`) were already gated.

## Phase 1 — Feature parity with the macOS build ✅

**Goal:** everything the macOS build does, the Windows build does.

- [x] Windows title bar variant (custom window controls, frameless, no native menu).
- [x] CI produces an MSI/NSIS artifact (unsigned) and publishes a rolling preview release.
- [x] Terminal spawn: host default shell, no flashing console windows, working maximize.
- [x] Keyboard: Ctrl+Shift for shortcuts *inside* terminals, since plain Ctrl belongs to
      the shell. Copy is Ctrl+Shift+C; paste is Ctrl+V or Ctrl+Shift+V. `keyboard.ts`
      drops reserved Ctrl+Shift+letter combos so they don't reach the PTY as well.
- [x] Separator-agnostic paths, including stripping the `\\?\` prefix `canonicalize`
      returns on Windows so canonical and user-supplied paths still compare equal.
- [x] Clipboard (`arboard`) and reveal-in-file-manager (`explorer.exe /select,`) —
      both were unguarded macOS binaries (`pbcopy`, `open -R`) that compiled on
      Windows and failed at runtime.
- [x] Attention hook via a PowerShell helper.
- [x] SSH/SFTP remote workspaces via the bundled OpenSSH client.
- [x] Shell working directory via OSC 7 / OSC 9;9, driving "Name Follows Folder"
      and per-terminal cwd persistence.
- [x] Process liveness via `OpenProcess` + `GetExitCodeProcess`, so Claude session
      resume doesn't offer sessions that already exited.
- [x] "Open With" / `splice <path>` via argv + `bundle.fileAssociations`.

### Known differences from macOS

Not bugs — consequences of the platform, worth knowing before filing one:

- **Shifted shortcuts inside a terminal.** Ctrl+Shift is the modifier there, so Shift
  can't also distinguish a shortcut. Save As, Find in Files, Problems and Replace are
  reachable everywhere *except* while focus is inside a terminal.
- **SSH is slower.** Win32-OpenSSH has no ControlMaster, so every remote request
  reconnects. It also needs key auth or a running ssh-agent: `BatchMode=yes` means a
  password prompt fails fast rather than hanging on a prompt nobody can answer.
- **`Ctrl+V` no longer reaches the shell** as readline's quoted-insert, because paste
  has to ride a native accelerator for the webview to fire a paste event. Same trade
  Windows Terminal makes.
- **"Name Follows Folder" depends on the shell reporting its directory.** Splice asks
  PowerShell and cmd to do so at spawn (a prompt wrapper / the `PROMPT` variable);
  Windows has no reliable way to read another process's cwd, and PowerShell's
  `Set-Location` deliberately never updates it.

## Phase 2 — Distribution polish

- [ ] Authenticode code signing (SmartScreen warns on first launch until then).
- [ ] Single-instance argv forwarding, so opening a file while Splice is running
      reuses the existing window instead of starting a second instance.
- [ ] Canvas DPI/font polish, snap layouts, taskbar behavior.
- [ ] Rewrite SSH on a native library (`russh`) to restore multiplexing — the
      `RemoteSession` interface is the seam to do it behind.

**Exit:** a signed Windows release alongside macOS.

## Verifying

Windows-only code paths can't run on a macOS dev machine, so
`.github/workflows/windows-build.yml` runs `npm test` and `cargo test` on
`windows-latest` before bundling. Anything Windows-specific needs a test there to
count as verified — `exited_process_is_not_alive` is the model: it exercises the raw
Win32 calls that no local build touches.
