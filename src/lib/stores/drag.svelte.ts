export interface TabDragData {
  filePath: string;
  fileName: string;
  sourcePaneId: string;
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
let startX = 0;
let startY = 0;
const DRAG_THRESHOLD = 4;

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

// --- Hit testing ---
function findPaneAt(x: number, y: number): RegisteredPane | null {
  for (const pane of panes) {
    const rect = pane.el.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return pane;
    }
  }
  return null;
}

function computeZone(x: number, y: number, el: HTMLElement): DropZone {
  const rect = el.getBoundingClientRect();
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
  hoverZone = computeZone(e.clientX, e.clientY, pane.el);
}

function onMouseUp() {
  if (!active) { cleanup(); return; }

  if (dragging && hoverPaneId && hoverZone) {
    document.dispatchEvent(new CustomEvent("tab-drop"));
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
