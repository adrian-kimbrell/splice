/**
 * Drag-and-drop system for editor tabs and terminal panes across split panes.
 *
 * Lifecycle: `beginDrag(data, mouseEvent)` captures the drag payload and installs
 * global mousemove/mouseup listeners. Movement beyond a 4px threshold activates
 * the visual drag ghost. During the drag, `findPaneAt` hit-tests registered pane
 * elements and `computeZone` divides each pane into five drop zones:
 * - left/right/top/bottom (outer 25% margins) -- split the target pane
 * - center -- move the tab into the target pane without splitting
 *
 * On mouseup, the registered `dropCallback` fires with the drag data, target pane
 * ID, and computed zone. The callback (set via `setDropCallback`) is responsible
 * for performing the actual pane/tab rearrangement in the layout store.
 *
 * Panes self-register via `registerPane`/`unregisterPane` on mount/destroy.
 * An optional content element (`registerPaneContent`) allows hit-testing against
 * the editor area only, excluding the tab bar.
 *
 * @exports beginDrag, endDrag - Start/cancel a drag operation
 * @exports setDropCallback - Register the handler for completed drops
 * @exports registerPane, unregisterPane - Pane lifecycle for hit testing
 * @exports getDragActive, getHoverZone, isDragging - Reactive getters for UI overlay rendering
 */

export interface TabDragData {
  filePath: string;
  fileName: string;
  sourcePaneId: string;
  kind?: "editor" | "terminal";
}

export type DropZone = "left" | "right" | "top" | "bottom" | "center" | null;

interface RegisteredPane {
  el: HTMLElement;
  paneId: string;
}

// --- Reactive state ---
let active = $state<TabDragData | null>(null);
let hoverPaneId = $state<string | null>(null);
let hoverZone = $state<DropZone>(null);
let ghostX = $state(0);
let ghostY = $state(0);
let dragging = $state(false);

// --- Non-reactive bookkeeping ---
let panes: RegisteredPane[] = [];
let contentElements = new Map<string, HTMLElement>();
let startX = 0;
let startY = 0;
const DRAG_THRESHOLD = 4;

// --- Drop callback ---
type DropCallback = (data: TabDragData, targetPaneId: string, zone: DropZone) => void;
let dropCallback: DropCallback | null = null;

export function setDropCallback(cb: DropCallback | null) {
  dropCallback = cb;
}

// --- Public reactive getters ---
export function getDragActive(): TabDragData | null { return active; }
export function getHoverPaneId(): string | null { return hoverPaneId; }
export function getHoverZone(): DropZone { return hoverZone; }
export function getGhostX(): number { return ghostX; }
export function getGhostY(): number { return ghostY; }
export function isDragging(): boolean { return dragging; }

// --- Pane registration ---
export function registerPane(paneId: string, el: HTMLElement) {
  panes = panes.filter((p) => p.paneId !== paneId);
  panes.push({ paneId, el });
}

export function unregisterPane(paneId: string, el: HTMLElement) {
  panes = panes.filter((p) => !(p.paneId === paneId && p.el === el));
}

export function registerPaneContent(paneId: string, el: HTMLElement) {
  contentElements.set(paneId, el);
}

export function unregisterPaneContent(paneId: string) {
  contentElements.delete(paneId);
}

// --- Hit testing ---
function findPaneAt(x: number, y: number): RegisteredPane | null {
  for (const pane of panes) {
    // Prefer content element (excludes tab bar) for tighter zone calculation,
    // but fall back to outer pane element so the tab bar region still matches.
    const contentEl = contentElements.get(pane.paneId);
    const el = contentEl ?? pane.el;
    const rect = el.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return pane;
    }
    if (contentEl) {
      const outerRect = pane.el.getBoundingClientRect();
      if (x >= outerRect.left && x <= outerRect.right && y >= outerRect.top && y <= outerRect.bottom) {
        return pane;
      }
    }
  }
  return null;
}

function computeZone(x: number, y: number, el: HTMLElement, paneId: string): DropZone {
  // Use content element for zone calculation when available
  const target = contentElements.get(paneId) ?? el;
  const rect = target.getBoundingClientRect();
  const rx = (x - rect.left) / rect.width;
  const ry = (y - rect.top) / rect.height;
  const margin = 0.25;
  if (rx < margin) return "left";
  if (rx > 1 - margin) return "right";
  if (ry < margin) return "top";
  if (ry > 1 - margin) return "bottom";
  return "center";
}

// --- Mouse event handlers ---
function onMouseMove(e: MouseEvent) {
  if (!active) return;

  if (!dragging) {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
    dragging = true;
    document.body.classList.add("tab-dragging");
  }

  ghostX = e.clientX;
  ghostY = e.clientY;

  const pane = findPaneAt(e.clientX, e.clientY);
  if (!pane) {
    hoverPaneId = null;
    hoverZone = null;
    return;
  }
  hoverPaneId = pane.paneId;
  hoverZone = computeZone(e.clientX, e.clientY, pane.el, pane.paneId);
}

function onMouseUp() {
  if (!active) { cleanup(); return; }

  if (dragging && hoverPaneId && hoverZone && dropCallback) {
    const data = active;
    const targetId = hoverPaneId;
    const zone = hoverZone;
    cleanup();
    dropCallback(data, targetId, zone);
    return;
  }

  cleanup();
}

function cleanup() {
  document.body.classList.remove("tab-dragging");
  active = null;
  hoverPaneId = null;
  hoverZone = null;
  dragging = false;
  document.removeEventListener("mousemove", onMouseMove);
  document.removeEventListener("mouseup", onMouseUp);
}

// --- Public API ---
export function beginDrag(data: TabDragData, e: MouseEvent) {
  // Clean up any stale state from a prior drag
  cleanup();

  active = data;
  hoverPaneId = null;
  hoverZone = null;
  startX = e.clientX;
  startY = e.clientY;
  ghostX = e.clientX;
  ghostY = e.clientY;
  dragging = false;

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
}

export function endDrag() {
  cleanup();
}
