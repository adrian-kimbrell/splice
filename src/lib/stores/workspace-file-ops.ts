import type { OpenFile } from "./files.svelte";
import type { Workspace } from "./workspace-types";
import { generateId, findFirstLeaf, applyFileRename, markFileSaved } from "./workspace-types";
import { isFileReferencedInAnyPane, validateLayout } from "./workspace-tab-ops";
import { findSiblingLeaf, removeNodeFromTree } from "./layout.svelte";

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
  } else {
    ws.layout = {
      type: "split",
      direction: "horizontal",
      ratio: 0.6,
      children: [
        { type: "leaf", paneId: editorPaneId },
        ws.layout,
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
      paneId = findFirstEditorPaneId(ws);
    }
  }

  // Early return: file is already active in the target pane
  const pane = paneId ? ws.panes[paneId] : null;
  if (pane?.activeFilePath === file.path) {
    const existing = ws.openFileIndex[file.path];
    if (existing) {
      // Handle preview→pin promotion if needed
      if (existing.preview && !file.preview) existing.preview = false;
      // Re-register watcher in case it was dropped (e.g. after an unwatch/reconnect)
      if (!file.path.startsWith("untitled-") && !ws.sshConfig) {
        import("../ipc/commands").then(({ watchPath }) => watchPath(file.path)).catch(() => {});
      }
      return;
    }
  }

  // Watch file for external changes (local workspaces only)
  if (!file.path.startsWith("untitled-") && !ws.sshConfig) {
    import("../ipc/commands").then(({ watchPath }) => watchPath(file.path)).catch(() => {});
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
    ws.openFiles.push(file);
    ws.openFileIndex[file.path] = file;
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
        // Remove from ws.openFiles if unreferenced by any pane
        if (!isFileReferencedInAnyPane(ws, oldPreviewPath)) {
          const fileIdx = ws.openFiles.findIndex((f) => f.path === oldPreviewPath);
          if (fileIdx !== -1) ws.openFiles.splice(fileIdx, 1);
          delete ws.openFileIndex[oldPreviewPath];
          if (!oldPreviewPath.startsWith("untitled-") && !ws.sshConfig) {
            import("../ipc/commands").then(({ unwatchPath }) => unwatchPath(oldPreviewPath)).catch(() => {});
          }
        }
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
        if (!removeResult.found) console.warn(`closeFileInWorkspace: pane "${targetPaneId}" not found in layout`);
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

  // Only remove from ws.openFiles if no other pane references it
  if (!isFileReferencedInAnyPane(ws, path)) {
    const fileIdx = ws.openFiles.findIndex((f) => f.path === path);
    if (fileIdx !== -1) ws.openFiles.splice(fileIdx, 1);
    delete ws.openFileIndex[path];
    // Unwatch file (local workspaces only)
    if (!path.startsWith("untitled-") && !ws.sshConfig) {
      import("../ipc/commands").then(({ unwatchPath }) => unwatchPath(path)).catch(() => {});
    }
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

export async function saveActiveFile(ws: Workspace): Promise<void> {
  if (!ws.activePaneId) return;
  const pane = ws.panes[ws.activePaneId];
  if (!pane || pane.kind !== "editor" || !pane.activeFilePath) return;
  const oldPath = pane.activeFilePath;
  const file = ws.openFileIndex[oldPath];
  if (!file) return;

  let savePath = oldPath;

  // Untitled files need a Save As dialog
  if (oldPath.startsWith("untitled-")) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const chosen = await save({ title: "Save File" });
      if (!chosen) return; // User cancelled
      savePath = chosen;
    } catch {
      // Not in Tauri (demo mode) — can't save untitled
      return;
    }
  }

  try {
    if (ws.sshConfig) {
      const { sftpWriteFile } = await import("../ipc/commands");
      await sftpWriteFile(ws.id, savePath, file.content);
    } else {
      const { writeFile } = await import("../ipc/commands");
      await writeFile(savePath, file.content);
    }
    // If path changed (Save As from untitled), update index + all pane references
    if (savePath !== oldPath) {
      applyFileRename(ws, file, oldPath, savePath);
    }
    markFileSaved(file);
  } catch (e) {
    console.error("Failed to save file:", e);
  }
}

/** Always show save dialog, write file, update references. */
export async function saveActiveFileAs(ws: Workspace): Promise<void> {
  if (!ws.activePaneId) return;
  const pane = ws.panes[ws.activePaneId];
  if (!pane || pane.kind !== "editor" || !pane.activeFilePath) return;
  const oldPath = pane.activeFilePath;
  const file = ws.openFileIndex[oldPath];
  if (!file) return;

  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const chosen = await save({ title: "Save As" });
    if (!chosen) return;

    const { writeFile } = await import("../ipc/commands");
    await writeFile(chosen, file.content);

    if (chosen !== oldPath) {
      applyFileRename(ws, file, oldPath, chosen);
    }
    markFileSaved(file);
  } catch {
    // Not in Tauri or user cancelled
  }
}

/** Save a specific file by path. Returns true if saved, false if cancelled/failed. */
export async function saveFile(ws: Workspace, path: string): Promise<boolean> {
  const file = ws.openFileIndex[path];
  if (!file) return false;

  let savePath = path;

  if (path.startsWith("untitled-")) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const chosen = await save({ title: "Save File" });
      if (!chosen) return false;
      savePath = chosen;
    } catch {
      return false;
    }
  }

  try {
    if (ws.sshConfig) {
      const { sftpWriteFile } = await import("../ipc/commands");
      await sftpWriteFile(ws.id, savePath, file.content);
    } else {
      const { writeFile } = await import("../ipc/commands");
      await writeFile(savePath, file.content);
    }
    if (savePath !== path) {
      applyFileRename(ws, file, path, savePath);
    }
    markFileSaved(file);
    return true;
  } catch (e) {
    console.error("Failed to save file:", e);
    return false;
  }
}

/** Silently save a file (no dialog for untitled, no toast). Used for auto-save. */
export async function saveFileQuiet(ws: Workspace, path: string): Promise<void> {
  if (path.startsWith("untitled-")) return; // Skip untitled files
  const file = ws.openFileIndex[path];
  if (!file || !file.dirty) return;
  try {
    if (ws.sshConfig) {
      const { sftpWriteFile } = await import("../ipc/commands");
      await sftpWriteFile(ws.id, path, file.content);
    } else {
      const { writeFile } = await import("../ipc/commands");
      await writeFile(path, file.content);
    }
    markFileSaved(file); // fixes Critical Issue 3: also clears file.preview
  } catch (e) {
    console.error("Auto-save failed:", e);
  }
}

/** Save all dirty files in the workspace. */
export async function saveAllDirtyFiles(ws: Workspace): Promise<void> {
  const dirtyFiles = ws.openFiles.filter((f) => f.dirty);
  for (const f of dirtyFiles) {
    await saveFile(ws, f.path);
  }
}
