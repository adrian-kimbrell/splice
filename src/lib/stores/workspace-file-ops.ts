import { log } from "../utils/log";
import type { OpenFile } from "./files.svelte";
import type { Workspace } from "./workspace-types";
import { generateId, findFirstLeaf, applyFileRename, markFileSaved, addOpenFile } from "./workspace-types";
import { isFileReferencedInAnyPane, validateLayout } from "./workspace-tab-ops";
import { cloneLayout, findSiblingLeaf, removeNodeFromTree, treeDepth, findShallowestLeaf, splitNodeInTree, MAX_SPLIT_DEPTH } from "./layout.svelte";
import { markSelfWrite } from "./self-writes";
// Static on purpose: watch/unwatch must be counted reliably (the Rust watcher is
// reference counted) and `commands.ts` has no import-time side effects.
import { watchPath, unwatchPath } from "../ipc/commands";

// --- Query helpers ---

export function findFirstEditorPaneId(ws: Workspace): string | null {
  for (const [id, config] of Object.entries(ws.panes)) {
    if (config.kind === "editor") return id;
  }
  return null;
}

export function hasDirtyFilesByPane(ws: Workspace, paneId: string): boolean {
  const pane = ws.panes[paneId];
  if (!pane || pane.kind !== "editor") return false;
  const paths = pane.filePaths ?? [];
  return paths.some((p) => ws.openFileIndex[p]?.dirty);
}

export function isFileDirty(ws: Workspace, path: string): boolean {
  return ws.openFileIndex[path]?.dirty ?? false;
}

// --- Pane management ---

export function ensureEditorPane(ws: Workspace, paneId?: string, filePaths?: string[]): string {
  const editorPaneId = paneId ?? `editor-${generateId().slice(0, 8)}`;

  // Already exists?
  if (ws.panes[editorPaneId]) return editorPaneId;

  ws.panes[editorPaneId] = {
    id: editorPaneId,
    kind: "editor",
    title: "Editor",
    filePaths: filePaths ?? [],
    activeFilePath: filePaths?.[0] ?? null,
  };

  // Check if layout is empty (no panes)
  if (!ws.layout) {
    ws.layout = { type: "leaf", paneId: editorPaneId };
  } else if (treeDepth(ws.layout) >= MAX_SPLIT_DEPTH) {
    // Wrapping the whole tree would exceed the depth cap; split the shallowest leaf.
    const result = splitNodeInTree(ws.layout, findShallowestLeaf(ws.layout), editorPaneId, "horizontal");
    if (result.found) ws.layout = result.tree;
  } else {
    // Deep-clone the existing tree to avoid reparenting a Svelte $state proxy node —
    // see layout.svelte.ts: structural mutations must return fresh plain objects.
    ws.layout = {
      type: "split",
      direction: "horizontal",
      ratio: 0.6,
      children: [
        { type: "leaf", paneId: editorPaneId },
        cloneLayout(ws.layout),
      ],
    };
  }

  ws.activePaneId = editorPaneId;
  validateLayout(ws);
  return editorPaneId;
}

// --- File mutations ---

export function openFileInWorkspace(ws: Workspace, file: OpenFile, targetPaneId?: string): void {
  // Determine target pane early for early-return check
  let paneId = targetPaneId;
  if (!paneId) {
    if (ws.activePaneId && ws.panes[ws.activePaneId]?.kind === "editor") {
      paneId = ws.activePaneId;
    } else {
      paneId = findFirstEditorPaneId(ws) ?? undefined;
    }
  }

  // Early return: file is already active in the target pane
  const pane = paneId ? ws.panes[paneId] : null;
  if (pane?.activeFilePath === file.path) {
    const existing = ws.openFileIndex[file.path];
    if (existing) {
      // Handle preview→pin promotion if needed
      if (existing.preview && !file.preview) existing.preview = false;
      return;
    }
  }

  // Add to workspace-level openFiles (content source of truth)
  const existing = ws.openFileIndex[file.path];
  if (existing) {
    // If already open as pinned, don't downgrade to preview — just activate
    if (!existing.preview && file.preview) {
      file.preview = false;
    } else if (existing.preview && !file.preview) {
      // Promoting from preview to pinned
      existing.preview = false;
    }
  } else {
    addOpenFile(ws, file);
    // Exactly one watch per index entry: the Rust watcher is reference counted
    // and release happens once, when the last pane drops the file. Watching on
    // every open (re-click, preview→pin, second pane) leaked a reference each time.
    if (isWatchable(ws, file.path)) {
      watchPath(file.path).catch((e) => log.warn("Failed to watch file:", file.path, e));
    }
  }

  if (paneId && ws.panes[paneId]) {
    const p = ws.panes[paneId];
    if (!p.filePaths) p.filePaths = [];

    // If incoming file is preview, replace any existing preview tab in this pane (skip pinned)
    if (file.preview && !p.filePaths.includes(file.path)) {
      const existingPreviewIdx = p.filePaths.findIndex((path) => {
        const f = ws.openFileIndex[path];
        return f?.preview && !f?.pinned;
      });
      if (existingPreviewIdx !== -1) {
        const oldPreviewPath = p.filePaths[existingPreviewIdx];
        p.filePaths.splice(existingPreviewIdx, 1);
        releaseOpenFile(ws, oldPreviewPath);
      }
    }

    if (!p.filePaths.includes(file.path)) {
      p.filePaths.push(file.path);
    }
    p.activeFilePath = file.path;
    ws.activePaneId = paneId;
  } else {
    // No editor pane exists — create one
    ensureEditorPane(ws, undefined, [file.path]);
  }
}

export function closeFileInWorkspace(ws: Workspace, path: string, paneId?: string): void {
  // Determine which pane to close the file from
  const targetPaneId = paneId ?? ws.activePaneId;
  const pane = targetPaneId ? ws.panes[targetPaneId] : null;

  if (pane?.kind === "editor" && pane.filePaths) {
    const idx = pane.filePaths.indexOf(path);
    if (idx !== -1) {
      pane.filePaths.splice(idx, 1);
      if (pane.activeFilePath === path) {
        pane.activeFilePath =
          pane.filePaths.length > 0
            ? pane.filePaths[Math.max(0, idx - 1)]
            : null;
      }
    }

    // If pane is now empty, close it (editor panes need no async terminal cleanup)
    if (pane.filePaths.length === 0) {
      const siblingLeafId = ws.layout ? findSiblingLeaf(ws.layout, targetPaneId!) : null;
      delete ws.panes[targetPaneId!];

      if (ws.layout) {
        const removeResult = removeNodeFromTree(ws.layout, targetPaneId!);
        if (!removeResult.found) log.warn(`closeFileInWorkspace: pane "${targetPaneId}" not found in layout`);
        ws.layout = removeResult.tree;
      }

      const remainingPaneIds = Object.keys(ws.panes);
      if (remainingPaneIds.length === 0) {
        ws.layout = null;
        ws.activePaneId = null;
      } else if (ws.activePaneId === targetPaneId || !ws.panes[ws.activePaneId!]) {
        ws.activePaneId = (siblingLeafId && ws.panes[siblingLeafId])
          ? siblingLeafId
          : findFirstLeaf(ws.layout);
      }
    }
  }

  releaseOpenFile(ws, path);
}

/** Local, on-disk files get a watcher; untitled buffers and SSH files do not. */
function isWatchable(ws: Workspace, path: string): boolean {
  return !path.startsWith("untitled-") && !ws.sshConfig;
}

/**
 * Drop a file from `openFiles`/`openFileIndex` and release its watcher, but only
 * once no pane references it. Safe to call for paths that are still in use.
 */
export function releaseOpenFile(ws: Workspace, path: string): void {
  if (isFileReferencedInAnyPane(ws, path)) return;
  const fileIdx = ws.openFiles.findIndex((f) => f.path === path);
  if (fileIdx !== -1) ws.openFiles.splice(fileIdx, 1);
  if (!(path in ws.openFileIndex)) return; // never opened, or already released
  delete ws.openFileIndex[path];
  if (isWatchable(ws, path)) {
    unwatchPath(path).catch((e) => log.warn("Failed to unwatch file:", path, e));
  }
}

export function setActiveFileInWorkspace(ws: Workspace, path: string, paneId?: string): void {
  const targetPaneId = paneId ?? ws.activePaneId;
  const pane = targetPaneId ? ws.panes[targetPaneId] : null;
  if (pane?.kind === "editor") {
    pane.activeFilePath = path;
  }
}

export function updateFileContent(ws: Workspace, path: string, content: string): void {
  const file = ws.openFileIndex[path];
  if (file) {
    if (file.originalContent === undefined) {
      file.originalContent = file.content;
    }
    file.content = content;
    file.dirty = content !== file.originalContent;
    // Editing a preview file promotes it to pinned
    if (file.preview) {
      file.preview = false;
    }
  }
}

// --- Save operations ---

/** The active editor pane's current file path, or null when there is none. */
function activeEditorFilePath(ws: Workspace): string | null {
  if (!ws.activePaneId) return null;
  const pane = ws.panes[ws.activePaneId];
  if (!pane || pane.kind !== "editor" || !pane.activeFilePath) return null;
  return pane.activeFilePath;
}

/** Ask the user for a destination. Null when cancelled or outside Tauri. */
async function pickSavePath(title: string): Promise<string | null> {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    return (await save({ title })) ?? null;
  } catch {
    return null; // Not in Tauri (demo mode)
  }
}

/**
 * Write a buffer to disk (SFTP for SSH workspaces). Local writes are marked as
 * self-writes first so the file watcher does not report our own save as an
 * external change.
 */
async function writeBuffer(ws: Workspace, path: string, content: string): Promise<void> {
  if (ws.sshConfig) {
    const { sftpWriteFile } = await import("../ipc/commands");
    await sftpWriteFile(ws.id, path, content);
  } else {
    const { writeFile } = await import("../ipc/commands");
    markSelfWrite(path);
    await writeFile(path, content);
  }
}

/** Save the active pane's file (Save As dialog for untitled buffers). */
export async function saveActiveFile(ws: Workspace): Promise<void> {
  const path = activeEditorFilePath(ws);
  if (path) await saveFile(ws, path);
}

/** Always show the save dialog, write the file, and update references. */
export async function saveActiveFileAs(ws: Workspace): Promise<void> {
  const oldPath = activeEditorFilePath(ws);
  if (!oldPath) return;
  const chosen = await pickSavePath("Save As");
  if (!chosen) return;
  await saveFileTo(ws, oldPath, chosen);
}

/** Save a specific file by path. Returns true if saved, false if cancelled/failed. */
export async function saveFile(ws: Workspace, path: string): Promise<boolean> {
  if (!ws.openFileIndex[path]) return false;
  let savePath = path;
  if (path.startsWith("untitled-")) {
    const chosen = await pickSavePath("Save File");
    if (!chosen) return false;
    savePath = chosen;
  }
  return saveFileTo(ws, path, savePath);
}

/** Write the buffer open under `path` to `savePath`, renaming the tab if they differ. */
async function saveFileTo(ws: Workspace, path: string, savePath: string): Promise<boolean> {
  const file = ws.openFileIndex[path];
  if (!file) return false;
  try {
    await writeBuffer(ws, savePath, file.content);
    if (savePath !== path) applyFileRename(ws, file, path, savePath);
    markFileSaved(file);
    return true;
  } catch (e) {
    log.error("Failed to save file:", e);
    return false;
  }
}

/** Silently save a file (no dialog for untitled, no toast). Used for auto-save. */
export async function saveFileQuiet(ws: Workspace, path: string): Promise<void> {
  if (path.startsWith("untitled-")) return; // Skip untitled files
  const file = ws.openFileIndex[path];
  if (!file || !file.dirty) return;
  try {
    await writeBuffer(ws, path, file.content);
    markFileSaved(file); // also clears file.preview
  } catch (e) {
    log.error("Auto-save failed:", e);
  }
}

/** Save all dirty files in the workspace. */
export async function saveAllDirtyFiles(ws: Workspace): Promise<void> {
  const dirtyFiles = ws.openFiles.filter((f) => f.dirty);
  for (const f of dirtyFiles) {
    await saveFile(ws, f.path);
  }
}
