/**
 * Dev-only tooling — loaded via a single dynamic import in App.svelte only when
 * import.meta.env.DEV is true. Vite completely excludes this from production bundles.
 *
 * Registers all dev API event listeners exactly once, outside of any component
 * lifecycle, so they survive App.svelte HMR updates without re-registering.
 *
 * To exclude from the repo entirely, add to .gitignore:
 *   src/lib/dev/
 */

import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { toPng } from "html-to-image";
import { ui } from "../stores/ui.svelte";
import { workspaceManager } from "../stores/workspace.svelte";
import { attentionStore } from "../stores/attention.svelte";
import * as ipc from "../ipc/commands";

// ---------------------------------------------------------------------------
// Tiny 1×1 transparent PNG — fallback if capture fails so the HTTP waiter
// never hangs waiting for save_screenshot_bytes to resolve.
// ---------------------------------------------------------------------------
const FALLBACK_PNG = new Uint8Array([
  137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,
  8,6,0,0,0,31,21,196,137,0,0,0,10,73,68,65,84,120,156,98,0,1,0,0,
  5,0,1,13,10,45,180,0,0,0,0,73,69,78,68,174,66,96,130,
]);

// ---------------------------------------------------------------------------
// Inject the Bootstrap Icons font as a base64 data URI so html-to-image can
// embed it in the PNG (otherwise icon glyphs render as empty squares).
// Runs once at module load; screenshots taken after ~1s will have icons.
// ---------------------------------------------------------------------------
function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  // Process in chunks to avoid call-stack overflow on large fonts
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function injectIconFont(): Promise<void> {
  if (document.getElementById("dev-icon-font-embed")) return;
  try {
    const res = await fetch("/node_modules/bootstrap-icons/font/fonts/bootstrap-icons.woff2");
    if (!res.ok) return;
    const b64 = bufferToBase64(await res.arrayBuffer());
    const style = document.createElement("style");
    style.id = "dev-icon-font-embed";
    style.textContent = `@font-face {
  font-family: "bootstrap-icons";
  src: url("data:font/woff2;base64,${b64}") format("woff2");
  font-display: block;
}`;
    document.head.appendChild(style);
    console.log("[dev] icon font embedded");
  } catch (e) {
    console.debug("[dev] could not embed icon font:", e);
  }
}

// Unlisten functions from the previous setup() run — used for HMR cleanup so
// editing this file doesn't leave duplicate listeners alive.
let _unlisteners: Array<() => void> = [];

async function setup() {
  // Tear down any previous listeners first (HMR re-runs top-level code)
  for (const fn of _unlisteners) fn();
  _unlisteners = [];

  // -------------------------------------------------------------------------
  // dev:pr-mode  { enabled: boolean }
  // -------------------------------------------------------------------------
  _unlisteners.push(await listen<boolean>("dev:pr-mode", ({ payload }) => {
    ui.prMode = payload;
  }));

  // -------------------------------------------------------------------------
  // dev:open-folder  { path: string }  — create workspace from directory
  // After creating the workspace, cd into it in the new terminal.
  // -------------------------------------------------------------------------
  _unlisteners.push(await listen<string>("dev:open-folder", async ({ payload }) => {
    await workspaceManager.createWorkspaceFromDirectory(payload);
    // Give the workspace a moment to spawn its terminal, then cd into the dir.
    // The terminal CWD restriction means it starts in HOME; this fixes that.
    await new Promise(r => setTimeout(r, 400));
    const ws = workspaceManager.activeWorkspace;
    const termId = ws?.activeTerminalId;
    if (termId != null) {
      const encoded = new TextEncoder().encode(`cd ${JSON.stringify(payload)}\r`);
      await ipc.writeToTerminal(termId, encoded);
    }
  }));

  // -------------------------------------------------------------------------
  // dev:open-file  { path: string }  — open file in active workspace and
  // expand all parent directories up to the workspace root in the file tree.
  // -------------------------------------------------------------------------
  _unlisteners.push(await listen<string>("dev:open-file", async ({ payload }) => {
    let content = "";
    try {
      content = await ipc.readFile(payload);
    } catch { /* ignore — file may be binary or unreadable */ }
    const name = payload.split("/").pop() ?? payload;
    workspaceManager.openFileInWorkspace({ name, path: payload, content });

    // Expand every parent directory between the workspace root and this file
    // so the file tree hierarchy is visible when the explorer is open.
    const ws = workspaceManager.activeWorkspace;
    if (ws?.rootPath && ws.expandedPaths) {
      const root = ws.rootPath;
      const parts = payload.split("/");
      // Walk from just inside the root down to the file's immediate parent
      let current = "";
      for (const part of parts) {
        if (!part) continue;
        current += "/" + part;
        // Only expand directories that are descendants of (not equal to) the root
        if (current.startsWith(root + "/") && current !== payload) {
          ws.expandedPaths.add(current);
        }
      }
    }
  }));

  // -------------------------------------------------------------------------
  // dev:capture-screenshot  { name: string; requestId: string }
  // Capture the entire DOM + canvas as PNG, save via IPC, resolve HTTP waiter.
  // -------------------------------------------------------------------------
  _unlisteners.push(await listen<{ name: string; requestId: string }>("dev:capture-screenshot", async ({ payload }) => {
    try {
      // Let the browser finish any pending paints before capturing
      await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));

      // skipFonts: true stops html-to-image from re-fetching external fonts
      // (which can fail or time out). Our injectIconFont() already put the
      // bootstrap-icons font into the DOM as a data URI, so glyphs render fine.
      const dataUrl = await toPng(document.documentElement, {
        pixelRatio: window.devicePixelRatio || 1,
        skipFonts: true,
      });

      const base64 = dataUrl.split(",")[1];
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      await invoke("save_screenshot_bytes", {
        name: payload.name,
        requestId: payload.requestId,
        bytes: Array.from(bytes),
      });
    } catch (err) {
      console.error("[dev] screenshot capture failed:", err);
      try {
        await invoke("save_screenshot_bytes", {
          name: payload.name + "-error",
          requestId: payload.requestId,
          bytes: Array.from(FALLBACK_PNG),
        });
      } catch (err2) {
        console.error("[dev] fallback screenshot also failed:", err2);
      }
    }
  }));

  // -------------------------------------------------------------------------
  // dev:run-terminal  { cmd: string; terminalId?: number }
  // Write to the specified terminal, or the active workspace's terminal.
  // -------------------------------------------------------------------------
  _unlisteners.push(await listen<{ cmd: string; terminalId?: number }>("dev:run-terminal", async ({ payload }) => {
    const termId = payload.terminalId ?? workspaceManager.activeWorkspace?.activeTerminalId;
    if (termId == null) {
      console.warn("[dev] run-terminal: no active terminal found");
      return;
    }
    const encoded = new TextEncoder().encode(payload.cmd);
    await ipc.writeToTerminal(termId, encoded);
  }));

  // -------------------------------------------------------------------------
  // dev:ui  { workspacesVisible?, explorerVisible?, prMode?,
  //           workspacesWidth?, explorerWidth?, sidebarMode?,
  //           zenMode?, commandPaletteOpen? }
  // -------------------------------------------------------------------------
  _unlisteners.push(await listen<Record<string, unknown>>("dev:ui", ({ payload }) => {
    if (typeof payload.workspacesVisible === "boolean") ui.workspacesVisible = payload.workspacesVisible;
    if (typeof payload.explorerVisible === "boolean")   ui.explorerVisible   = payload.explorerVisible;
    if (typeof payload.prMode === "boolean")            ui.prMode            = payload.prMode;
    if (typeof payload.workspacesWidth === "number")    ui.workspacesWidth   = payload.workspacesWidth;
    if (typeof payload.explorerWidth === "number")      ui.explorerWidth     = payload.explorerWidth;
    if (typeof payload.zenMode === "boolean")           ui.zenMode           = payload.zenMode;
    if (typeof payload.commandPaletteOpen === "boolean") ui.commandPaletteOpen = payload.commandPaletteOpen;
    if (payload.sidebarMode === "files" || payload.sidebarMode === "search" || payload.sidebarMode === "problems") {
      ui.sidebarMode = payload.sidebarMode;
    }
  }));

  // -------------------------------------------------------------------------
  // dev:resize  { width: number; height: number }
  // -------------------------------------------------------------------------
  _unlisteners.push(await listen<{ width: number; height: number }>("dev:resize", async ({ payload }) => {
    await getCurrentWindow().setSize(new LogicalSize(payload.width, payload.height));
  }));

  // -------------------------------------------------------------------------
  // dev:reset  — close all workspaces, restore default UI state
  // Uses closeWorkspaceWithCleanup so PTY sessions are killed and Rust state
  // is cleaned up (not just dropped from Svelte state).
  // -------------------------------------------------------------------------
  _unlisteners.push(await listen<null>("dev:reset", async () => {
    const ids = Object.keys(workspaceManager.workspaces);
    await Promise.all(ids.map(id => workspaceManager.closeWorkspaceWithCleanup(id)));
    for (const id of Object.keys(attentionStore.notifications)) attentionStore.clear(Number(id));
    ui.prMode = false;
    ui.workspacesVisible = true;
    ui.explorerVisible = true;
    ui.zenMode = false;
    ui.sidebarMode = "files";
  }));

  // -------------------------------------------------------------------------
  // dev:notify  { terminalId, notifType, message }
  // Inject a fake attention notification into the topbar.
  // -------------------------------------------------------------------------
  _unlisteners.push(await listen<{ terminalId: number; notifType: string; message: string }>("dev:notify", ({ payload }) => {
    attentionStore.notify({
      terminalId: payload.terminalId,
      type: payload.notifType === "idle" ? "idle" : "permission",
      message: payload.message ?? "",
      timestamp: Date.now(),
    });
  }));

  // -------------------------------------------------------------------------
  // dev:clear-notify  { terminalId? }
  // Clear one notification (by terminalId) or all (if no terminalId).
  // -------------------------------------------------------------------------
  _unlisteners.push(await listen<{ terminalId?: number }>("dev:clear-notify", ({ payload }) => {
    if (payload.terminalId != null) {
      attentionStore.clear(payload.terminalId);
    } else {
      for (const id of Object.keys(attentionStore.notifications)) attentionStore.clear(Number(id));
    }
  }));

  // -------------------------------------------------------------------------
  // dev:switch-workspace  { index: number } | { id: string }
  // Switch to workspace by zero-based position or by ID.
  // -------------------------------------------------------------------------
  _unlisteners.push(await listen<{ index?: number; id?: string }>("dev:switch-workspace", ({ payload }) => {
    if (typeof payload.id === "string") {
      workspaceManager.switchWorkspace(payload.id);
    } else {
      const list = workspaceManager.workspaceList;
      const ws = list[payload.index ?? 0];
      if (ws) workspaceManager.switchWorkspace(ws.id);
    }
  }));

  // -------------------------------------------------------------------------
  // dev:close-workspace  { index?: number; id?: string }
  // Close a workspace by zero-based index or by ID.
  // -------------------------------------------------------------------------
  _unlisteners.push(await listen<{ index?: number; id?: string }>("dev:close-workspace", ({ payload }) => {
    let id: string | undefined;
    if (typeof payload.id === "string") {
      id = payload.id;
    } else {
      const list = workspaceManager.workspaceList;
      id = list[payload.index ?? 0]?.id;
    }
    if (id) workspaceManager.closeWorkspace(id);
  }));

  // -------------------------------------------------------------------------
  // dev:expand-paths  string[]
  // Explicitly expand folders in the active workspace's file tree.
  // Call this after a settle delay so the async file-tree load has completed.
  // -------------------------------------------------------------------------
  _unlisteners.push(await listen<string[]>("dev:expand-paths", ({ payload }) => {
    const ws = workspaceManager.activeWorkspace;
    if (!ws?.expandedPaths) return;
    for (const path of payload) ws.expandedPaths.add(path);
  }));

  // -------------------------------------------------------------------------
  // dev:resize-split  { ratio: number }
  // Set the ratio of the outermost split in the active workspace layout.
  // Useful for making the terminal pane more or less prominent.
  // -------------------------------------------------------------------------
  _unlisteners.push(await listen<{ ratio: number }>("dev:resize-split", ({ payload }) => {
    const ws = workspaceManager.activeWorkspace;
    if (!ws?.layout || ws.layout.type !== "split") return;
    ws.layout.ratio = Math.max(0.1, Math.min(0.9, payload.ratio));
  }));

  // -------------------------------------------------------------------------
  // dev:split-pane  { direction: "vertical"|"horizontal" }
  // Split the active terminal pane in the active workspace.
  // -------------------------------------------------------------------------
  _unlisteners.push(await listen<{ direction: string }>("dev:split-pane", async () => {
    // spawnTerminalInWorkspace handles null layout gracefully (splitPane does not)
    await workspaceManager.spawnTerminalInWorkspace();
  }));

  // -------------------------------------------------------------------------
  // dev:kill-pane  { paneId?: string } | { terminalId?: number }
  // Close and kill a specific pane. Defaults to the active terminal pane.
  // -------------------------------------------------------------------------
  _unlisteners.push(await listen<{ paneId?: string; terminalId?: number }>("dev:kill-pane", async ({ payload }) => {
    const ws = workspaceManager.activeWorkspace;
    if (!ws) return;
    let paneId: string | undefined = payload.paneId;
    if (!paneId && typeof payload.terminalId === "number") {
      paneId = `term-${payload.terminalId}`;
    }
    if (!paneId && ws.activeTerminalId != null) {
      paneId = `term-${ws.activeTerminalId}`;
    }
    if (!paneId) return;
    await workspaceManager.closePaneInWorkspace(paneId);
  }));

  // -------------------------------------------------------------------------
  // dev:zoom-pane  { paneId?: string }
  // Toggle zoom on a specific pane, or the currently active terminal pane.
  // -------------------------------------------------------------------------
  _unlisteners.push(await listen<{ paneId?: string }>("dev:zoom-pane", ({ payload }) => {
    const ws = workspaceManager.activeWorkspace;
    if (!ws) return;
    const paneId = payload.paneId ?? (ws.activeTerminalId != null ? `term-${ws.activeTerminalId}` : null);
    if (!paneId) return;
    // Toggle: if already zoomed to this pane, unzoom; otherwise zoom it
    ui.zoomedPaneId = ui.zoomedPaneId === paneId ? null : paneId;
  }));

  // -------------------------------------------------------------------------
  // dev:activate-pane  { paneId: string } | { terminalId: number }
  // Set the active terminal by pane ID or terminal ID.
  // Only updates if the pane/terminal actually belongs to the active workspace.
  // -------------------------------------------------------------------------
  _unlisteners.push(await listen<{ paneId?: string; terminalId?: number }>("dev:activate-pane", ({ payload }) => {
    const ws = workspaceManager.activeWorkspace;
    if (!ws) return;
    let paneId: string | undefined;
    if (typeof payload.paneId === "string") {
      paneId = payload.paneId;
    } else if (typeof payload.terminalId === "number") {
      paneId = `term-${payload.terminalId}`;
    }
    if (!paneId || !ws.panes[paneId]) return; // reject if pane not in this workspace
    const pane = ws.panes[paneId];
    ws.activePaneId = paneId;
    if (pane.kind === "terminal" && pane.terminalId != null) {
      ws.activeTerminalId = pane.terminalId;
    }
  }));

  // -------------------------------------------------------------------------
  // dev:state  { requestId: string }
  // Collect full app state and resolve the HTTP waiter via Tauri IPC.
  // Includes: workspaces, panes, terminal CWD + recent output, open files,
  // attention notifications, git branches, UI state.
  // -------------------------------------------------------------------------
  _unlisteners.push(await listen<{ requestId: string }>("dev:state", async ({ payload }) => {
    // Fetch enriched terminal data in parallel for all workspaces
    const workspaces = await Promise.all(workspaceManager.workspaceList.map(async ws => {
      // Collect all terminal panes in this workspace
      const terminalPanes = ws.panes
        ? Object.values(ws.panes).filter(p => p.kind === "terminal" && p.terminalId != null)
        : [];

      // Fetch CWD + last 30 lines for each terminal in parallel
      const terminals = await Promise.all(terminalPanes.map(async p => {
        const id = p.terminalId!;
        const [cwd, recentOutput] = await Promise.allSettled([
          ipc.getTerminalCwd(id),
          ipc.getTerminalLastLines(id, 30),
        ]);
        return {
          id,
          paneId: p.id,
          cwd: cwd.status === "fulfilled" ? (cwd.value ?? null) : null,
          recentOutput: recentOutput.status === "fulfilled" ? recentOutput.value : [],
        };
      }));

      // Git branch for this workspace
      let gitBranch: string | null = null;
      if (ws.rootPath) {
        try { gitBranch = await ipc.getGitBranch(ws.rootPath); } catch { /* not a git repo */ }
      }

      return {
        id: ws.id,
        name: ws.name,
        rootPath: ws.rootPath ?? null,
        gitBranch,
        activeTerminalId: ws.activeTerminalId ?? null,
        terminals,
        openFiles: (ws.openFiles ?? []).map(f => ({
          path: f.path,
          name: f.name,
          isDirty: f.dirty ?? false,
        })),
        terminalIds: ws.terminalIds ?? [],
        layout: ws.layout,
        panes: ws.panes
          ? Object.values(ws.panes).map(p => ({
              id: p.id,
              kind: p.kind,
              title: p.title,
              terminalId: p.terminalId ?? null,
              activeFilePath: p.activeFilePath ?? null,
              filePaths: p.filePaths ?? [],
            }))
          : [],
      };
    }));

    const state = {
      ui: {
        explorerVisible: ui.explorerVisible,
        workspacesVisible: ui.workspacesVisible,
        explorerWidth: ui.explorerWidth,
        workspacesWidth: ui.workspacesWidth,
        sidebarMode: ui.sidebarMode,
        zenMode: ui.zenMode,
        prMode: ui.prMode,
        zoomedPaneId: ui.zoomedPaneId,
      },
      activeWorkspaceId: workspaceManager.activeWorkspace?.id ?? null,
      workspaces,
      notifications: Object.values(attentionStore.notifications).map(n => ({
        terminalId: n.terminalId,
        type: n.type,
        message: n.message,
        timestamp: n.timestamp,
      })),
    };

    try {
      await invoke("resolve_dev_state", {
        requestId: payload.requestId,
        stateJson: JSON.stringify(state),
      });
    } catch (e) {
      console.error("[dev] resolve_dev_state failed:", e);
    }
  }));

  // -------------------------------------------------------------------------
  // dev:keyboard  { key, meta, ctrl, shift, alt, code? }
  // Dispatch a synthetic KeyboardEvent to document — same as pressKey() in the
  // old wdio helpers but driven via the dev API instead of WebDriver.
  // -------------------------------------------------------------------------
  _unlisteners.push(await listen<{
    key: string; code?: string;
    meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean;
  }>("dev:keyboard", ({ payload }) => {
    let code = payload.code ?? payload.key;
    if (/^[a-zA-Z]$/.test(payload.key)) code = "Key" + payload.key.toUpperCase();
    else if (/^[0-9]$/.test(payload.key)) code = "Digit" + payload.key;
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: payload.key,
      code,
      metaKey:  payload.meta  ?? false,
      ctrlKey:  payload.ctrl  ?? false,
      shiftKey: payload.shift ?? false,
      altKey:   payload.alt   ?? false,
      bubbles: true,
      cancelable: true,
    }));
  }));

  // -------------------------------------------------------------------------
  // dev:set-file-content  { content: string }
  // Replace the active editor's file content in-memory (marks dirty).
  // -------------------------------------------------------------------------
  _unlisteners.push(await listen<{ content: string }>("dev:set-file-content", ({ payload }) => {
    const ws = workspaceManager.activeWorkspace;
    if (!ws) return;
    const pane = ws.activePaneId ? ws.panes[ws.activePaneId] : null;
    if (!pane || pane.kind !== "editor" || !pane.activeFilePath) return;
    workspaceManager.updateFileContent(pane.activeFilePath, payload.content);
  }));

  // -------------------------------------------------------------------------
  // dev:dom-query  { selector: string; requestId: string }
  // Query all matching DOM elements and return their key properties.
  // Each element: { tagName, id, classes, text, rect, attrs, visible }
  // -------------------------------------------------------------------------
  _unlisteners.push(await listen<{ selector: string; requestId: string }>("dev:dom-query", async ({ payload }) => {
    const elements = Array.from(document.querySelectorAll(payload.selector));
    const results = elements.map(el => {
      const rect = el.getBoundingClientRect();
      const attrs: Record<string, string> = {};
      for (const attr of Array.from(el.attributes)) {
        attrs[attr.name] = attr.value;
      }
      return {
        tagName: el.tagName.toLowerCase(),
        id: el.id || null,
        classes: Array.from(el.classList),
        text: (el as HTMLElement).innerText?.trim() ?? el.textContent?.trim() ?? "",
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        attrs,
        visible: rect.width > 0 && rect.height > 0,
      };
    });
    try {
      await invoke("resolve_dev_dom", {
        requestId: payload.requestId,
        resultsJson: JSON.stringify(results),
      });
    } catch (e) {
      console.error("[dev] resolve_dev_dom failed:", e);
    }
  }));

  // -------------------------------------------------------------------------
  // Console intercept — forward error/warn/log to the Rust log buffer so
  // `GET /dev/logs` (and the test scripts) can read them without devtools.
  // We patch the originals once and restore on HMR teardown.
  // -------------------------------------------------------------------------
  const _origError = console.error.bind(console);
  const _origWarn  = console.warn.bind(console);
  const _origLog   = console.log.bind(console);

  function fwdLog(level: string, orig: (...a: unknown[]) => void, args: unknown[]) {
    orig(...args);
    const message = args.map(a => {
      if (typeof a === "string") return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(" ");
    invoke("dev_log", { level, message }).catch(() => {});
  }

  console.error = (...args) => fwdLog("error", _origError, args);
  console.warn  = (...args) => fwdLog("warn",  _origWarn,  args);
  console.log   = (...args) => fwdLog("log",   _origLog,   args);

  // Restore originals on HMR teardown so the next setup() doesn't double-wrap
  _unlisteners.push(() => {
    console.error = _origError;
    console.warn  = _origWarn;
    console.log   = _origLog;
  });

  // Kick off font injection in the background — doesn't block listener setup.
  // Only the Vite dev server serves /node_modules; bundled (e2e) builds skip it.
  if (import.meta.env.DEV) injectIconFont();

  (window as unknown as Record<string, unknown>).__spliceDevReady = true;
  console.log("[dev] API listeners registered");
}

// Top-level await: the module doesn't finish loading until all listeners are
// registered. Combined with Vite's module cache, `await import("./dev/index")`
// in App.svelte will only re-run this when the file itself changes — not on
// every App.svelte HMR update.
await setup();
