import type { LayoutNode } from "../stores/layout.svelte";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface HandleSegment {
  node: LayoutNode & { type: "split" };
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  orientation: "vertical" | "horizontal";
  containerRect: Rect;
}

export interface Intersection {
  x: number;
  y: number;
  handles: HandleSegment[];
}

/**
 * Walk the layout tree and produce one handle line segment per split node,
 * in screen coordinates derived from the given container rect.
 *
 * Child rects split exactly at the split point (no gap subtraction) so that
 * nested handle segments extend to the parent boundary and can intersect.
 */
export function computeHandleSegments(
  node: LayoutNode,
  rect: Rect,
): HandleSegment[] {
  if (node.type === "leaf") return [];

  const segments: HandleSegment[] = [];
  const containerRect: Rect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };

  if (node.direction === "horizontal") {
    const splitX = rect.left + node.ratio * rect.width;
    segments.push({
      node,
      x1: splitX, y1: rect.top,
      x2: splitX, y2: rect.top + rect.height,
      orientation: "vertical",
      containerRect,
    });

    segments.push(...computeHandleSegments(node.children[0], {
      left: rect.left, top: rect.top, width: node.ratio * rect.width, height: rect.height,
    }));
    segments.push(...computeHandleSegments(node.children[1], {
      left: splitX, top: rect.top, width: (1 - node.ratio) * rect.width, height: rect.height,
    }));
  } else {
    const splitY = rect.top + node.ratio * rect.height;
    segments.push({
      node,
      x1: rect.left, y1: splitY,
      x2: rect.left + rect.width, y2: splitY,
      orientation: "horizontal",
      containerRect,
    });

    segments.push(...computeHandleSegments(node.children[0], {
      left: rect.left, top: rect.top, width: rect.width, height: node.ratio * rect.height,
    }));
    segments.push(...computeHandleSegments(node.children[1], {
      left: rect.left, top: splitY, width: rect.width, height: (1 - node.ratio) * rect.height,
    }));
  }

  return segments;
}

/**
 * Find points where vertical and horizontal handle segments cross.
 * Merge nearby intersections (within 4px) into one, collecting all handles.
 */
export function findIntersections(segments: HandleSegment[]): Intersection[] {
  const verticals = segments.filter(s => s.orientation === "vertical");
  const horizontals = segments.filter(s => s.orientation === "horizontal");

  const raw: Intersection[] = [];

  for (const v of verticals) {
    for (const h of horizontals) {
      const vx = v.x1;
      const hy = h.y1;
      const hMinX = Math.min(h.x1, h.x2);
      const hMaxX = Math.max(h.x1, h.x2);
      const vMinY = Math.min(v.y1, v.y2);
      const vMaxY = Math.max(v.y1, v.y2);

      if (vx >= hMinX && vx <= hMaxX && hy >= vMinY && hy <= vMaxY) {
        raw.push({ x: vx, y: hy, handles: [v, h] });
      }
    }
  }

  // Merge intersections within 4px of each other
  const merged: Intersection[] = [];
  const used = new Set<number>();

  for (let i = 0; i < raw.length; i++) {
    if (used.has(i)) continue;
    const group = [raw[i]];
    used.add(i);

    for (let j = i + 1; j < raw.length; j++) {
      if (used.has(j)) continue;
      if (Math.abs(raw[i].x - raw[j].x) <= 4 && Math.abs(raw[i].y - raw[j].y) <= 4) {
        group.push(raw[j]);
        used.add(j);
      }
    }

    const avgX = group.reduce((s, g) => s + g.x, 0) / group.length;
    const avgY = group.reduce((s, g) => s + g.y, 0) / group.length;

    // Deduplicate handles by node identity
    const allHandles: HandleSegment[] = [];
    const seen = new Set<LayoutNode>();
    for (const g of group) {
      for (const h of g.handles) {
        if (!seen.has(h.node)) {
          seen.add(h.node);
          allHandles.push(h);
        }
      }
    }

    merged.push({ x: avgX, y: avgY, handles: allHandles });
  }

  return merged;
}
