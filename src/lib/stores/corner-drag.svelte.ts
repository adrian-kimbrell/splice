/**
 * Corner-drag system for resizing the pane grid at split intersections.
 *
 * When the user drags a corner where two or more resize handles meet,
 * {@link beginCornerDrag} snapshots the container rects of all affected
 * handles and adjusts their split ratios simultaneously on `mousemove`.
 * This avoids feedback loops from layout reflows during the drag.
 *
 * Exposes reactive {@link isCornerDragActive} for cursor styling.
 */
import type { HandleSegment, Intersection, Rect } from "../utils/handle-geometry";
import { clientToRectSpace } from "../utils/zoom";

interface HandleContext {
  segment: HandleSegment;
  containerRect: Rect;
}

// --- Reactive state ---
let active = $state(false);

// --- Non-reactive bookkeeping ---
let handleContexts: HandleContext[] = [];
// Stable element used only to read the document-wide rect↔client scale under
// ui_scale zoom. The snapshotted containerRects are in getBoundingClientRect
// space (layout px in WKWebView), so incoming clientX/Y must be mapped into the
// same space before comparing — otherwise the anchor lands offset from the
// cursor, growing with distance from the origin. [[zoom-coords]]
let scaleRefEl: HTMLElement | null = null;

// --- Public reactive getters ---
export function isCornerDragActive(): boolean { return active; }

// --- Drag logic ---
export function beginCornerDrag(inter: Intersection, e: MouseEvent, scaleRef?: HTMLElement) {
  active = true;
  // Any on-screen element works: the rect↔client scale is document-wide. The
  // target (a resize hotspot) is stable for the whole drag.
  scaleRefEl = scaleRef ?? (e.currentTarget as HTMLElement) ?? (e.target as HTMLElement) ?? null;

  // Snapshot container rects at drag start to prevent feedback loops
  handleContexts = inter.handles.map(segment => ({
    segment,
    containerRect: {
      left: segment.containerRect.left,
      top: segment.containerRect.top,
      width: segment.containerRect.width,
      height: segment.containerRect.height,
    },
  }));

  document.body.classList.add("corner-dragging");
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
}

function onMouseMove(e: MouseEvent) {
  // Map the visual client coord into the same space as the snapshotted rects
  // (getBoundingClientRect space) so the ratio is correct at any ui_scale.
  const ref = scaleRefEl ?? document.body;
  const p = clientToRectSpace(e.clientX, e.clientY, ref);
  for (const ctx of handleContexts) {
    const { segment, containerRect } = ctx;
    let ratio: number;

    if (segment.orientation === "vertical") {
      ratio = (p.x - containerRect.left) / containerRect.width;
    } else {
      ratio = (p.y - containerRect.top) / containerRect.height;
    }

    segment.node.ratio = Math.max(0.1, Math.min(0.9, ratio));
  }
}

function onMouseUp() {
  endCornerDrag();
}

export function endCornerDrag() {
  active = false;
  handleContexts = [];
  scaleRefEl = null;
  document.body.classList.remove("corner-dragging");
  document.removeEventListener("mousemove", onMouseMove);
  document.removeEventListener("mouseup", onMouseUp);
}
