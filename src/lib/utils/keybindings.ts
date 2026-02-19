import { ui } from "../stores/ui.svelte";
import { workspaceManager } from "../stores/workspace.svelte";
import type { LayoutNode } from "../stores/layout.svelte";

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

/** Walk into a subtree, picking the leaf nearest to the edge we're coming from. */
function nearestLeaf(node: LayoutNode, dir: NavDirection): string {
  if (node.type === "leaf") return node.paneId;
  const isHoriz = dir === "left" || dir === "right";
  const splitIsAligned = (isHoriz && node.direction === "horizontal") ||
                          (!isHoriz && node.direction === "vertical");
  if (splitIsAligned) {
    // Pick the near side: entering from right→take children[1], from left→take children[0], etc.
    const nearChild = (dir === "right" || dir === "down") ? 0 : 1;
    return nearestLeaf(node.children[nearChild], dir);
  }
  // Perpendicular split — pick first child (consistent default)
  return nearestLeaf(node.children[0], dir);
}

/** Find the spatial neighbor of a pane in the given direction. */
function findNeighbor(root: LayoutNode, paneId: string, dir: NavDirection): string | null {
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
      return nearestLeaf(split.children[1 - fromChild], dir);
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

export function initKeybindings() {
  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;

    // Cmd/Ctrl + N: New File
    if (mod && e.key === "n") {
      e.preventDefault();
      workspaceManager.newUntitledFile();
    }

    // Cmd/Ctrl + K: Command Palette
    if (mod && e.key === "k") {
      e.preventDefault();
      ui.commandPaletteOpen = !ui.commandPaletteOpen;
    }

    // Escape: Close overlays, then unzoom
    if (e.key === "Escape") {
      if (ui.settingsOpen) {
        ui.settingsOpen = false;
      } else if (ui.commandPaletteOpen) {
        ui.commandPaletteOpen = false;
      } else if (ui.zoomedPaneId) {
        ui.zoomedPaneId = null;
      }
    }

    // Cmd/Ctrl + ,: Settings
    if (mod && e.key === ",") {
      e.preventDefault();
      ui.settingsOpen = !ui.settingsOpen;
    }

    // Cmd/Ctrl + B: Toggle left sidebar
    if (mod && e.key === "b") {
      e.preventDefault();
      ui.leftSidebarVisible = !ui.leftSidebarVisible;
    }

    // Cmd/Ctrl + Z: Toggle pane zoom
    if (mod && e.code === "KeyZ") {
      e.preventDefault();
      if (ui.zoomedPaneId) {
        ui.zoomedPaneId = null;
      } else {
        const wsId = workspaceManager.activeWorkspaceId;
        if (wsId) {
          const ws = workspaceManager.workspaces[wsId];
          const paneId = ws?.activePaneId ?? (ws ? firstLeaf(ws.layout) : null);
          if (paneId) {
            ui.zoomedPaneId = paneId;
          }
        }
      }
    }

    // Cmd/Ctrl + 1-9: Switch to pane by index
    if (mod && !e.shiftKey && e.code >= "Digit1" && e.code <= "Digit9") {
      const ws = workspaceManager.activeWorkspace;
      if (ws) {
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
    if (mod && e.altKey && !e.shiftKey &&
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

    // Cmd/Ctrl + Option/Alt + Shift + Left/Right: Switch workspace prev/next
    if (mod && e.altKey && e.shiftKey &&
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
  });
}
