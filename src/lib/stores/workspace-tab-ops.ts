import type { Workspace } from "./workspace-types";
import type { SplitDirection } from "./layout.svelte";
import {
  splitNodeInTreeWithSide,
  removeNodeFromTree,
  collectLeafIds,
  treeDepth,
  MAX_SPLIT_DEPTH,
} from "./layout.svelte";
import { findFirstLeaf, generateId } from "./workspace-types";

/** Remove filePath from the given pane and update its activeFilePath. */
function removeFileFromPane(ws: Workspace, paneId: string, filePath: string): void {
  const pane = ws.panes[paneId];
  if (!pane?.filePaths) return;
  const idx = pane.filePaths.indexOf(filePath);
  if (idx !== -1) pane.filePaths.splice(idx, 1);
  if (pane.activeFilePath === filePath) {
    pane.activeFilePath = pane.filePaths.length > 0 ? pane.filePaths[0] : null;
  }
}

/** If the source editor pane is now empty, delete it and remove its leaf from the layout tree. */
function collapseEmptySourcePane(ws: Workspace, paneId: string): void {
  const pane = ws.panes[paneId];
  if (pane?.kind !== "editor" || (pane.filePaths?.length ?? 0) > 0) return;
  delete ws.panes[paneId];
  if (ws.layout) {
    const result = removeNodeFromTree(ws.layout, paneId);
    if (!result.found) console.warn(`collapseEmptySourcePane: "${paneId}" not found in layout`);
    ws.layout = result.tree;
  }
}

/** Returns true if any editor pane currently has `path` in its filePaths. */
export function isFileReferencedInAnyPane(ws: Workspace, path: string): boolean {
  return Object.values(ws.panes).some(
    (p) => p.kind === "editor" && p.filePaths?.includes(path),
  );
}

export function validateLayout(ws: Workspace): void {
  if (!ws.layout) return;

  const leafIds = collectLeafIds(ws.layout);
  const paneIds = new Set(Object.keys(ws.panes));

  // Delete orphaned pane configs (in panes but not in layout)
  for (const paneId of paneIds) {
    if (!leafIds.has(paneId)) {
      console.warn(`validateLayout: orphaned pane config "${paneId}" — removing`);
      delete ws.panes[paneId];
    }
  }

  // Warn about dangling layout leaves (in layout but not in panes)
  for (const leafId of leafIds) {
    if (!paneIds.has(leafId)) {
      console.warn(`validateLayout: layout leaf "${leafId}" has no pane config`);
    }
  }

  // Fix activePaneId if it points to a removed pane
  if (ws.activePaneId && !ws.panes[ws.activePaneId]) {
    const remaining = Object.keys(ws.panes);
    ws.activePaneId = remaining.length > 0 ? findFirstLeaf(ws.layout) : null;
  }
}

export function toggleFilePinned(ws: Workspace, path: string): void {
  const file = ws.openFileIndex[path];
  if (!file) return;
  file.pinned = !file.pinned;
  if (file.pinned) {
    // Promote from preview so it won't get replaced
    if (file.preview) file.preview = false;
    // Move after last pinned tab in every pane that contains this file
    for (const pane of Object.values(ws.panes)) {
      if (pane.kind !== "editor" || !pane.filePaths) continue;
      const idx = pane.filePaths.indexOf(path);
      if (idx === -1) continue;
      // Find insert position: after the last already-pinned tab
      let insertAt = 0;
      for (let i = 0; i < pane.filePaths.length; i++) {
        if (i === idx) continue;
        if (ws.openFileIndex[pane.filePaths[i]]?.pinned) insertAt = i + 1;
      }
      if (idx !== insertAt) {
        pane.filePaths.splice(idx, 1);
        // Adjust insertAt if we removed before it
        if (idx < insertAt) insertAt--;
        pane.filePaths.splice(insertAt, 0, path);
      }
    }
  }
}

export function toggleFileReadOnly(ws: Workspace, path: string): void {
  const file = ws.openFileIndex[path];
  if (!file) return;
  file.readOnly = !file.readOnly;
}

export function reorderTabInPane(ws: Workspace, paneId: string, fromIndex: number, toIndex: number): void {
  const pane = ws.panes[paneId];
  if (!pane?.filePaths || pane.kind !== "editor") return;
  if (fromIndex === toIndex) return;
  if (fromIndex < 0 || fromIndex >= pane.filePaths.length) return;
  if (toIndex < 0 || toIndex >= pane.filePaths.length) return;
  const [item] = pane.filePaths.splice(fromIndex, 1);
  pane.filePaths.splice(toIndex, 0, item);
}

export function moveTabToNewPane(
  ws: Workspace,
  filePath: string,
  sourcePaneId: string,
  targetPaneId: string,
  direction: SplitDirection,
  side: "before" | "after",
): void {
  if (!ws.layout) return;

  const sourcePane = ws.panes[sourcePaneId];

  // Optimisation: if this is the only tab in the source pane, just move the
  // whole pane in the layout tree instead of create-then-collapse. This avoids
  // double layout mutations and component remounts.
  const isLastTab = sourcePane?.kind === "editor"
    && sourcePane.filePaths?.length === 1
    && sourcePane.filePaths[0] === filePath
    && sourcePaneId !== targetPaneId;

  if (isLastTab) {
    const removeResult = removeNodeFromTree(ws.layout, sourcePaneId);
    if (!removeResult.found || !removeResult.tree) return;
    if (treeDepth(removeResult.tree) >= MAX_SPLIT_DEPTH) return;
    const insertResult = splitNodeInTreeWithSide(removeResult.tree, targetPaneId, sourcePaneId, direction, side);
    if (!insertResult.found) return;
    ws.layout = insertResult.tree;
    ws.activePaneId = sourcePaneId;
    validateLayout(ws);
    return;
  }

  // Multiple tabs — extract one to a new pane
  if (treeDepth(ws.layout) >= MAX_SPLIT_DEPTH) {
    console.warn("Split depth limit reached, cannot create new pane from tab drop");
    return;
  }

  removeFileFromPane(ws, sourcePaneId, filePath);

  const newPaneId = `editor-${generateId().slice(0, 8)}`;
  ws.panes[newPaneId] = {
    id: newPaneId,
    kind: "editor",
    title: "Editor",
    filePaths: [filePath],
    activeFilePath: filePath,
  };

  const splitResult = splitNodeInTreeWithSide(ws.layout, targetPaneId, newPaneId, direction, side);
  if (!splitResult.found) console.warn(`splitNodeInTreeWithSide: target "${targetPaneId}" not found in layout`);
  ws.layout = splitResult.tree;

  collapseEmptySourcePane(ws, sourcePaneId);

  ws.activePaneId = newPaneId;
  validateLayout(ws);
}

export function moveTabToExistingPane(
  ws: Workspace,
  filePath: string,
  sourcePaneId: string,
  targetPaneId: string,
): void {
  // Only merge into editor panes — terminal panes can't accept tabs
  if (ws.panes[targetPaneId]?.kind !== "editor") return;

  // Remove from source
  removeFileFromPane(ws, sourcePaneId, filePath);

  // Add to target
  const targetPaneConfig = ws.panes[targetPaneId];
  if (targetPaneConfig?.kind === "editor") {
    if (!targetPaneConfig.filePaths) targetPaneConfig.filePaths = [];
    if (!targetPaneConfig.filePaths.includes(filePath)) {
      targetPaneConfig.filePaths.push(filePath);
    }
    targetPaneConfig.activeFilePath = filePath;
  }

  // If source pane is now empty, remove it
  collapseEmptySourcePane(ws, sourcePaneId);

  ws.activePaneId = targetPaneId;
  validateLayout(ws);
}

/** Returns paths to close for "close other tabs" (excludes given path and pinned). */
export function getFilesToCloseOther(ws: Workspace, path: string, paneId: string): string[] {
  const pane = ws.panes[paneId];
  if (!pane?.filePaths || pane.kind !== "editor") return [];
  return pane.filePaths.filter(p => p !== path && !ws.openFileIndex[p]?.pinned);
}

/** Returns paths to close for "close tabs to the left" (excludes pinned). */
export function getFilesToCloseLeft(ws: Workspace, path: string, paneId: string): string[] {
  const pane = ws.panes[paneId];
  if (!pane?.filePaths || pane.kind !== "editor") return [];
  const idx = pane.filePaths.indexOf(path);
  if (idx <= 0) return [];
  return pane.filePaths.slice(0, idx).filter(p => !ws.openFileIndex[p]?.pinned);
}

/** Returns paths to close for "close tabs to the right" (excludes pinned). */
export function getFilesToCloseRight(ws: Workspace, path: string, paneId: string): string[] {
  const pane = ws.panes[paneId];
  if (!pane?.filePaths || pane.kind !== "editor") return [];
  const idx = pane.filePaths.indexOf(path);
  if (idx === -1 || idx >= pane.filePaths.length - 1) return [];
  return pane.filePaths.slice(idx + 1).filter(p => !ws.openFileIndex[p]?.pinned);
}

/** Returns paths to close for "close clean tabs" (non-dirty, non-pinned). */
export function getFilesToCloseClean(ws: Workspace, paneId: string): string[] {
  const pane = ws.panes[paneId];
  if (!pane?.filePaths || pane.kind !== "editor") return [];
  return pane.filePaths.filter(p => {
    const f = ws.openFileIndex[p];
    return !f?.pinned && !f?.dirty;
  });
}
