import type { HandleSegment, Intersection, Rect } from "../utils/handle-geometry";

interface HandleContext {
  segment: HandleSegment;
  containerRect: Rect;
}

// --- Reactive state ---
let active = $state(false);

// --- Non-reactive bookkeeping ---
let handleContexts: HandleContext[] = [];

// --- Public reactive getters ---
export function isCornerDragActive(): boolean { return active; }

// --- Drag logic ---
export function beginCornerDrag(inter: Intersection, e: MouseEvent) {
  active = true;

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
  for (const ctx of handleContexts) {
    const { segment, containerRect } = ctx;
    let ratio: number;

    if (segment.orientation === "vertical") {
      ratio = (e.clientX - containerRect.left) / containerRect.width;
    } else {
      ratio = (e.clientY - containerRect.top) / containerRect.height;
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
  document.body.classList.remove("corner-dragging");
  document.removeEventListener("mousemove", onMouseMove);
  document.removeEventListener("mouseup", onMouseUp);
}
