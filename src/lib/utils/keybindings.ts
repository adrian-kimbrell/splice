/**
 * Global keyboard shortcut handler for the Splice editor.
 *
 * Registers a single `keydown` listener on `document` that routes shortcuts
 * to workspace, UI, and editor actions. Supports chord bindings (Cmd+K -> X),
 * spatial pane navigation via a tree-walking algorithm ({@link findNeighbor},
 * {@link nearestLeaf}), zen mode with fullscreen toggle, pane zoom, tab
 * cycling by index, UI scale adjustment, and dev-only screenshot utilities.
 *
 * Inside terminal panes `Ctrl+key` must pass through to the shell, so shortcuts
 * there need a different modifier: `Cmd` on macOS, `Ctrl+Shift` on Windows/Linux
 * (which have no spare Cmd). Because Shift is then part of the modifier itself, the
 * shifted shortcuts (Save As, Find in Files, …) are reachable outside terminals only.
 *
 * {@link initKeybindings} returns a cleanup function that removes the listener.
 */
import { ui } from "../stores/ui.svelte";
import { workspaceManager } from "../stores/workspace.svelte";
import { settings, debouncedSaveSettings } from "../stores/settings.svelte";
import { isMac } from "./platform";
import type { LayoutNode } from "../stores/layout.svelte";

function isInsideCodeMirror(el: Element | null): boolean {
  return !!el?.closest(".cm-editor");
}

function isInsideTerminal(el: Element | null): boolean {
  return el?.tagName === "CANVAS";
}

const FONT_MIN = 8;
const FONT_MAX = 32;
const FONT_DEFAULT = 15;

/** Bump the focused pane's font size. Terminal panes adjust
 * `settings.terminal.font_size`; everything else (editor / diff /
 * markdown preview / settings — all of which read `settings.editor.font_size`
 * via the `--font-size` CSS variable) adjusts `settings.editor.font_size`. */
export function bumpFocusedPaneFont(delta: number) {
  if (isInsideTerminal(document.activeElement)) {
    settings.terminal.font_size = Math.min(FONT_MAX, Math.max(FONT_MIN, settings.terminal.font_size + delta));
  } else {
    settings.editor.font_size = Math.min(FONT_MAX, Math.max(FONT_MIN, settings.editor.font_size + delta));
  }
  debouncedSaveSettings();
}

/** Reset the focused pane's font size to the default. */
export function resetFocusedPaneFont() {
  if (isInsideTerminal(document.activeElement)) {
    settings.terminal.font_size = FONT_DEFAULT;
  } else {
    settings.editor.font_size = FONT_DEFAULT;
  }
  debouncedSaveSettings();
}

function firstLeaf(node: LayoutNode): string {
  if (node.type === "leaf") return node.paneId;
  return firstLeaf(node.children[0]);
}

/** Find the nth leaf (0-indexed) in the tree without allocating arrays. */
function nthLeaf(node: LayoutNode, target: number): { id: string | null; count: number } {
  if (node.type === "leaf") {
    return target === 0 ? { id: node.paneId, count: 1 } : { id: null, count: 1 };
  }
  const left = nthLeaf(node.children[0], target);
  if (left.id) return left;
  if (!node.children[1]) return { id: null, count: left.count };
  const right = nthLeaf(node.children[1], target - left.count);
  return { id: right.id, count: left.count + right.count };
}

// --- Spatial pane navigation ---

type NavDirection = "left" | "right" | "up" | "down";

/** Build the path from root to a leaf (list of child indices). Returns null if not found. */
function buildPath(node: LayoutNode, paneId: string, path: number[]): boolean {
  if (node.type === "leaf") return node.paneId === paneId;
  for (let i = 0; i < 2; i++) {
    path.push(i);
    if (buildPath(node.children[i], paneId, path)) return true;
    path.pop();
  }
  return false;
}

/** Walk into a subtree, picking the leaf nearest to the edge we're coming from.
 *  `hint` provides the source pane's remaining path indices so perpendicular
 *  splits prefer the child at the same vertical/horizontal level as the source. */
export function nearestLeaf(node: LayoutNode, dir: NavDirection, hint?: number[]): string {
  if (node.type === "leaf") return node.paneId;
  const isHoriz = dir === "left" || dir === "right";
  const splitIsAligned = (isHoriz && node.direction === "horizontal") ||
                          (!isHoriz && node.direction === "vertical");
  if (splitIsAligned) {
    // Pick the near side: entering from right→take children[1], from left→take children[0], etc.
    const nearChild = (dir === "right" || dir === "down") ? 0 : 1;
    return nearestLeaf(node.children[nearChild], dir, hint);
  }
  // Perpendicular split — use hint to stay at the same level as the source pane
  const pick = hint?.length ? hint.shift()! : 0;
  const child = Math.min(pick, 1);
  return nearestLeaf(node.children[child], dir, hint);
}

/** Find the spatial neighbor of a pane in the given direction. */
export function findNeighbor(root: LayoutNode, paneId: string, dir: NavDirection): string | null {
  const path: number[] = [];
  if (!buildPath(root, paneId, path)) return null;

  const isHoriz = dir === "left" || dir === "right";
  const splitDir = isHoriz ? "horizontal" : "vertical";
  // Which child index we must be coming FROM to have a neighbor in this direction
  const fromChild = (dir === "right" || dir === "down") ? 0 : 1;

  // Walk ancestors from deepest to root
  let node = root;
  const ancestors: { node: LayoutNode & { type: "split" }; childIdx: number }[] = [];
  for (const idx of path) {
    if (node.type === "split") {
      ancestors.push({ node, childIdx: idx });
      node = node.children[idx];
    }
  }

  for (let i = ancestors.length - 1; i >= 0; i--) {
    const { node: split, childIdx } = ancestors[i];
    if (split.direction === splitDir && childIdx === fromChild) {
      const hint = path.slice(i + 1);
      return nearestLeaf(split.children[1 - fromChild], dir, hint);
    }
  }

  return null; // No neighbor in that direction
}

/** Move DOM focus to the focusable element inside a pane (terminal canvas, editor, etc.) */
function focusPane(paneId: string) {
  requestAnimationFrame(() => {
    const container = document.querySelector(`[data-pane-id="${paneId}"]`);
    if (!container) return;
    // Try terminal canvas first, then CodeMirror editor, then any focusable
    const target =
      container.querySelector<HTMLElement>("canvas[tabindex]") ??
      container.querySelector<HTMLElement>(".cm-content") ??
      container.querySelector<HTMLElement>("[tabindex]");
    target?.focus();
  });
}

export async function enterZenMode() {
  ui.zenSnapshot = {
    explorerVisible: ui.explorerVisible,
    workspacesVisible: ui.workspacesVisible,
  };
  ui.explorerVisible = false;
  ui.workspacesVisible = false;
  ui.zenMode = true;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setFullscreen(true);
  } catch {
    // Not in Tauri
  }
}

export async function exitZenMode() {
  if (ui.zenSnapshot) {
    ui.explorerVisible = ui.zenSnapshot.explorerVisible;
    ui.workspacesVisible = ui.zenSnapshot.workspacesVisible;
    ui.zenSnapshot = null;
  }
  ui.zenMode = false;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setFullscreen(false);
  } catch {
    // Not in Tauri
  }
}

// --- Chord keybinding state ---
let chordPending = false;
let chordTimeout: ReturnType<typeof setTimeout> | null = null;
const CHORD_TIMEOUT = 1500;

function resetChord() {
  chordPending = false;
  if (chordTimeout) {
    clearTimeout(chordTimeout);
    chordTimeout = null;
  }
}

function handleChordSecondKey(e: KeyboardEvent): boolean {
  if (!chordPending) return false;
  resetChord();

  if (e.key === "Escape") {
    e.preventDefault();
    return true;
  }

  const ws = workspaceManager.activeWorkspace;
  if (!ws?.activePaneId) return true;
  const pane = ws.panes[ws.activePaneId];
  const activePath = pane?.kind === "editor" ? pane.activeFilePath : null;

  // ⌘K → E: Close Left
  if (e.code === "KeyE" && !e.shiftKey) {
    e.preventDefault();
    if (activePath) workspaceManager.closeFilesToLeftInPane(activePath, ws.activePaneId);
    return true;
  }
  // ⌘K → T: Close Right
  if (e.code === "KeyT" && !e.shiftKey) {
    e.preventDefault();
    if (activePath) workspaceManager.closeFilesToRightInPane(activePath, ws.activePaneId);
    return true;
  }
  // ⌘K → U: Close Clean
  if (e.code === "KeyU" && !e.shiftKey) {
    e.preventDefault();
    workspaceManager.closeCleanFilesInPane(ws.activePaneId);
    return true;
  }
  // ⌘K → W: Close All
  if (e.code === "KeyW" && !e.shiftKey) {
    e.preventDefault();
    workspaceManager.closeAllFilesInPane(ws.activePaneId);
    return true;
  }
  // ⌘K → Shift+Enter: Toggle Pin
  if (e.key === "Enter" && e.shiftKey) {
    e.preventDefault();
    if (activePath) workspaceManager.toggleFilePinned(activePath);
    return true;
  }

  // Unrecognized second key — cancel chord
  return true;
}

export function initKeybindings(): () => void {
  const handler = (e: KeyboardEvent) => {
    // Handle chord second key first
    if (chordPending) {
      handleChordSecondKey(e);
      return;
    }

    // Splice's shortcut modifier depends on where focus is, because plain Ctrl+key
    // must pass through to the terminal (Claude Code / readline / shell):
    //   outside a terminal  — Cmd or Ctrl
    //   terminal, macOS     — Cmd (Ctrl stays free for the shell)
    //   terminal, Win/Linux — Ctrl+Shift (no Cmd to spare; keyboard.ts drops these
    //                         so they don't also reach the shell)
    const inTerminal = isInsideTerminal(document.activeElement);
    const ctrlShiftMod = inTerminal && !isMac;
    const mod = inTerminal
      ? (isMac ? e.metaKey : e.ctrlKey && e.shiftKey)
      : (e.metaKey || e.ctrlKey);
    // Where Ctrl+Shift *is* the modifier, Shift is spent — it can't also distinguish
    // shifted shortcuts, so those (Save As, Find in Files, …) are editor-side only.
    const shift = e.shiftKey && !ctrlShiftMod;
    // Shift uppercases e.key, so match on a normalized key and use `shift` explicitly.
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    // Block reload (Cmd+R, Cmd+Shift+R) and devtools (Cmd+Option+I, F12)
    if (mod && key === "r") { e.preventDefault(); return; }
    if (mod && e.altKey && key === "i") { e.preventDefault(); return; }
    if (e.key === "F12") { e.preventDefault(); return; }

    // Numpad 3 — take a screenshot and save to docs/screenshots/
    if (e.code === "Numpad3" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      (async () => {
        try {
          const { toPng } = await import("html-to-image");
          const { saveScreenshot } = await import("../ipc/commands");
          await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
          const dataUrl = await toPng(document.documentElement, {
            pixelRatio: window.devicePixelRatio || 1,
            skipFonts: true,
          });
          const base64 = dataUrl.split(",")[1];
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          // Save to docs/screenshots/
          await saveScreenshot(Array.from(bytes));
          // Also copy to clipboard
          const res = await fetch(dataUrl);
          const blob = await res.blob();
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        } catch (err) {
          console.error("[screenshot] failed:", err);
        }
      })();
      return;
    }

    // Cmd/Ctrl + S: Save Active File
    if (mod && !shift && key === "s") {
      e.preventDefault();
      workspaceManager.saveActiveFile();
    }

    // Cmd/Ctrl + N: New File
    if (mod && key === "n") {
      e.preventDefault();
      workspaceManager.newUntitledFile();
    }

    // Cmd/Ctrl + K: Chord prefix
    if (mod && !shift && !e.altKey && key === "k") {
      e.preventDefault();
      chordPending = true;
      chordTimeout = setTimeout(() => resetChord(), CHORD_TIMEOUT);
      return;
    }

    // Cmd/Ctrl + P: Command Palette
    if (mod && key === "p") {
      e.preventDefault();
      ui.commandPaletteOpen = !ui.commandPaletteOpen;
    }

    // Alt/Option + Cmd/Ctrl + T: Close Others
    if (mod && e.altKey && !shift && e.code === "KeyT") {
      e.preventDefault();
      const ws = workspaceManager.activeWorkspace;
      if (ws?.activePaneId) {
        const pane = ws.panes[ws.activePaneId];
        const activePath = pane?.kind === "editor" ? pane.activeFilePath : null;
        if (activePath) workspaceManager.closeOtherFilesInPane(activePath, ws.activePaneId);
      }
    }

    // Escape: Close overlays, exit zen mode, then unzoom
    if (e.key === "Escape") {
      if (ui.settingsDrawerOpen) {
        ui.settingsDrawerOpen = false;
      } else if (ui.commandPaletteOpen) {
        ui.commandPaletteOpen = false;
      } else if (ui.zenMode) {
        exitZenMode();
      } else if (ui.zoomedPaneId) {
        ui.zoomedPaneId = null;
      }
    }

    // Cmd/Ctrl + Shift + Enter: Toggle zen mode
    if (mod && shift && key === "Enter") {
      e.preventDefault();
      if (ui.zenMode) {
        exitZenMode();
      } else {
        enterZenMode();
      }
    }

    // Cmd/Ctrl + B: Toggle explorer
    if (mod && key === "b") {
      e.preventDefault();
      ui.explorerVisible = !ui.explorerVisible;
    }

    // Cmd/Ctrl + ,: Toggle the settings drawer
    if (mod && !shift && e.code === "Comma") {
      e.preventDefault();
      ui.settingsDrawerOpen = !ui.settingsDrawerOpen;
    }

    // Cmd/Ctrl + Shift + ,: Open workspace settings (.splice/settings.json)
    if (mod && shift && e.code === "Comma") {
      e.preventDefault();
      void (async () => {
        const ws = workspaceManager.activeWorkspace;
        if (!ws?.rootPath) return;
        const { ensureWorkspaceSettingsFile } = await import("../stores/settings.svelte");
        const path = await ensureWorkspaceSettingsFile(ws.rootPath);
        if (!path) return;
        const { readFile } = await import("../ipc/commands");
        const content = await readFile(path).catch(() => "{\n  \n}\n");
        workspaceManager.openFileInWorkspace({
          name: "settings.json",
          path,
          content,
        });
      })();
    }

    // Cmd/Ctrl + Shift + \: Toggle single-view mode for the active workspace
    // (renders one pane at a time with a switcher strip; the tree is preserved).
    if (mod && shift && e.code === "Backslash") {
      e.preventDefault();
      ui.zoomedPaneId = null; // single view supersedes transient zoom
      workspaceManager.toggleViewMode();
      return;
    }

    // Cmd/Ctrl + Z: Toggle pane zoom (only when NOT inside a CodeMirror editor, where it means Undo)
    // Cmd/Ctrl + \: Toggle pane zoom (works everywhere — no Undo conflict)
    if (mod && !shift && (
      (e.code === "KeyZ" && !isInsideCodeMirror(document.activeElement)) ||
      e.code === "Backslash"
    )) {
      e.preventDefault();
      if (ui.zoomedPaneId) {
        ui.zoomedPaneId = null;
      } else {
        const wsId = workspaceManager.activeWorkspaceId;
        if (wsId) {
          const ws = workspaceManager.workspaces[wsId];
          const paneId = ws?.activePaneId ?? (ws?.layout ? firstLeaf(ws.layout) : null);
          if (paneId) {
            ui.zoomedPaneId = paneId;
          }
        }
      }
    }

    // Cmd/Ctrl + W: Close active tab
    if (mod && !shift && key === "w") {
      e.preventDefault();
      document.dispatchEvent(new CustomEvent("splice:close-active-tab"));
    }

    // Cmd/Ctrl + Shift + S: Save As
    if (mod && shift && !e.altKey && key === "s") {
      e.preventDefault();
      workspaceManager.saveActiveFileAs();
    }

    // Cmd/Ctrl + Alt + S: Save All
    if (mod && e.altKey && !shift && key === "s") {
      e.preventDefault();
      workspaceManager.saveAllDirtyFiles();
    }

    // Cmd/Ctrl + Shift + F: Find in Files
    if (mod && shift && key === "f") {
      e.preventDefault();
      ui.sidebarMode = "search";
      ui.explorerVisible = true;
    }

    // Cmd/Ctrl + Shift + M: Problems panel
    if (mod && shift && key === "m") {
      e.preventDefault();
      ui.sidebarMode = ui.sidebarMode === "problems" ? "files" : "problems";
      ui.explorerVisible = true;
    }

    // Cmd/Ctrl + Shift + H: Find & Replace
    if (mod && shift && key === "h") {
      e.preventDefault();
      ui.sidebarMode = "search";
      ui.explorerVisible = true;
      document.dispatchEvent(new CustomEvent("splice:open-replace"));
    }

    // Cmd/Ctrl + 1-9: Switch to pane by index
    if (mod && !shift && e.code >= "Digit1" && e.code <= "Digit9") {
      const ws = workspaceManager.activeWorkspace;
      if (ws?.layout) {
        const index = parseInt(e.code.charAt(5)) - 1;
        const { id } = nthLeaf(ws.layout, index);
        if (id) {
          e.preventDefault();
          workspaceManager.setActivePaneId(id);
          focusPane(id);
          if (ui.zoomedPaneId) {
            ui.zoomedPaneId = id;
          }
        }
      }
    }

    // Cmd/Ctrl + Option/Alt + Arrow: Spatial pane navigation
    if (mod && e.altKey && !shift &&
        (e.code === "ArrowLeft" || e.code === "ArrowRight" ||
         e.code === "ArrowUp" || e.code === "ArrowDown")) {
      const ws = workspaceManager.activeWorkspace;
      if (ws?.layout && ws.activePaneId) {
        const dirMap: Record<string, NavDirection> = {
          ArrowLeft: "left", ArrowRight: "right",
          ArrowUp: "up", ArrowDown: "down",
        };
        const neighbor = findNeighbor(ws.layout, ws.activePaneId, dirMap[e.code]);
        if (neighbor) {
          e.preventDefault();
          workspaceManager.setActivePaneId(neighbor);
          focusPane(neighbor);
          if (ui.zoomedPaneId) {
            ui.zoomedPaneId = neighbor;
          }
        }
      }
    }

    // Cmd/Ctrl + =: Zoom in the focused pane's font
    if (mod && (key === "=" || key === "+")) {
      e.preventDefault();
      bumpFocusedPaneFont(1);
    }

    // Cmd/Ctrl + -: Zoom out the focused pane's font
    if (mod && key === "-") {
      e.preventDefault();
      bumpFocusedPaneFont(-1);
    }

    // Cmd/Ctrl + 0: Reset focused pane's font
    if (mod && key === "0") {
      e.preventDefault();
      resetFocusedPaneFont();
    }

    // Cmd/Ctrl + Option/Alt + Shift + Left/Right: Switch workspace prev/next
    if (mod && e.altKey && shift &&
        (e.code === "ArrowLeft" || e.code === "ArrowRight")) {
      const list = workspaceManager.workspaceList;
      if (list.length > 1) {
        e.preventDefault();
        const currentIdx = list.findIndex(w => w.id === workspaceManager.activeWorkspaceId);
        let nextIdx: number;
        if (e.code === "ArrowLeft") {
          nextIdx = currentIdx <= 0 ? list.length - 1 : currentIdx - 1;
        } else {
          nextIdx = currentIdx >= list.length - 1 ? 0 : currentIdx + 1;
        }
        workspaceManager.switchWorkspace(list[nextIdx].id);
        ui.zoomedPaneId = null;
      }
    }

    // Dev only — Cmd+Shift+P: toggle PR mode (hides recent files for clean screenshots)
    if (import.meta.env.DEV && e.metaKey && e.shiftKey && e.code === "KeyP") {
      e.preventDefault();
      ui.prMode = !ui.prMode;
      console.log("[dev] PR mode:", ui.prMode);
    }

  };
  document.addEventListener("keydown", handler);
  return () => {
    resetChord();
    document.removeEventListener("keydown", handler);
  };
}
