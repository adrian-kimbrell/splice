import { describe, it, expect } from "vitest";
import { computeHandleSegments, findIntersections } from "./handle-geometry";
import type { LayoutNode } from "../stores/layout.svelte";

const RECT = { left: 0, top: 0, width: 1000, height: 600 };

// ---------------------------------------------------------------------------
// computeHandleSegments
// ---------------------------------------------------------------------------

describe("computeHandleSegments — leaf", () => {
  it("returns empty array for a leaf node", () => {
    const leaf: LayoutNode = { type: "leaf", paneId: "p1" };
    expect(computeHandleSegments(leaf, RECT)).toEqual([]);
  });
});

describe("computeHandleSegments — single horizontal split", () => {
  // horizontal split → two side-by-side panes → handle is a vertical line at splitX
  const split: LayoutNode = {
    type: "split",
    direction: "horizontal",
    ratio: 0.5,
    children: [
      { type: "leaf", paneId: "left" },
      { type: "leaf", paneId: "right" },
    ],
  };

  it("produces exactly one segment", () => {
    const segs = computeHandleSegments(split, RECT);
    expect(segs).toHaveLength(1);
  });

  it("segment is vertical", () => {
    const [seg] = computeHandleSegments(split, RECT);
    expect(seg.orientation).toBe("vertical");
  });

  it("segment x position matches ratio * width", () => {
    const [seg] = computeHandleSegments(split, RECT);
    expect(seg.x1).toBe(500);
    expect(seg.x2).toBe(500);
  });

  it("segment spans full height", () => {
    const [seg] = computeHandleSegments(split, RECT);
    expect(seg.y1).toBe(0);
    expect(seg.y2).toBe(600);
  });

  it("respects non-default ratio", () => {
    const splitAt30: LayoutNode = { ...split, ratio: 0.3 };
    const [seg] = computeHandleSegments(splitAt30, RECT);
    expect(seg.x1).toBeCloseTo(300);
  });

  it("respects non-zero container origin", () => {
    const offset = { left: 100, top: 50, width: 800, height: 400 };
    const [seg] = computeHandleSegments(split, offset);
    expect(seg.x1).toBe(100 + 0.5 * 800); // 500
    expect(seg.y1).toBe(50);
    expect(seg.y2).toBe(50 + 400); // 450
  });
});

describe("computeHandleSegments — single vertical split", () => {
  // vertical split → top/bottom panes → handle is a horizontal line at splitY
  const split: LayoutNode = {
    type: "split",
    direction: "vertical",
    ratio: 0.4,
    children: [
      { type: "leaf", paneId: "top" },
      { type: "leaf", paneId: "bottom" },
    ],
  };

  it("produces exactly one segment", () => {
    expect(computeHandleSegments(split, RECT)).toHaveLength(1);
  });

  it("segment is horizontal", () => {
    const [seg] = computeHandleSegments(split, RECT);
    expect(seg.orientation).toBe("horizontal");
  });

  it("segment y position matches ratio * height", () => {
    const [seg] = computeHandleSegments(split, RECT);
    expect(seg.y1).toBeCloseTo(0.4 * 600);
    expect(seg.y2).toBeCloseTo(0.4 * 600);
  });

  it("segment spans full width", () => {
    const [seg] = computeHandleSegments(split, RECT);
    expect(seg.x1).toBe(0);
    expect(seg.x2).toBe(1000);
  });
});

describe("computeHandleSegments — nested splits", () => {
  // Layout:
  //   horizontal split at 50%
  //     left:  leaf "A"
  //     right: vertical split at 50%
  //              top: "B", bottom: "C"
  const tree: LayoutNode = {
    type: "split",
    direction: "horizontal",
    ratio: 0.5,
    children: [
      { type: "leaf", paneId: "A" },
      {
        type: "split",
        direction: "vertical",
        ratio: 0.5,
        children: [
          { type: "leaf", paneId: "B" },
          { type: "leaf", paneId: "C" },
        ],
      },
    ],
  };

  it("produces two segments total", () => {
    expect(computeHandleSegments(tree, RECT)).toHaveLength(2);
  });

  it("outer handle is vertical at x=500", () => {
    const segs = computeHandleSegments(tree, RECT);
    const outer = segs.find(s => s.orientation === "vertical");
    expect(outer).toBeDefined();
    expect(outer!.x1).toBe(500);
  });

  it("inner handle is horizontal at y=300 (right half only)", () => {
    const segs = computeHandleSegments(tree, RECT);
    const inner = segs.find(s => s.orientation === "horizontal");
    expect(inner).toBeDefined();
    // The right half spans x=500–1000, y=0–600
    // Vertical split at 50% → y = 0 + 0.5 * 600 = 300
    expect(inner!.y1).toBe(300);
    // Inner segment only spans the right half in x
    expect(inner!.x1).toBe(500);
    expect(inner!.x2).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// findIntersections
// ---------------------------------------------------------------------------

describe("findIntersections — no segments", () => {
  it("returns empty array", () => {
    expect(findIntersections([])).toEqual([]);
  });
});

describe("findIntersections — no cross", () => {
  it("two parallel verticals produce no intersections", () => {
    // No horizontals → no crossings
    const segs = computeHandleSegments(
      {
        type: "split",
        direction: "horizontal",
        ratio: 0.5,
        children: [
          { type: "leaf", paneId: "A" },
          { type: "leaf", paneId: "B" },
        ],
      },
      RECT
    );
    expect(findIntersections(segs)).toEqual([]);
  });
});

describe("findIntersections — single cross", () => {
  // Layout: horizontal split (vertical handle) inside vertical split (horizontal handle)
  // Produces exactly one intersection where they cross.
  const tree: LayoutNode = {
    type: "split",
    direction: "vertical",
    ratio: 0.5,
    children: [
      {
        type: "split",
        direction: "horizontal",
        ratio: 0.5,
        children: [
          { type: "leaf", paneId: "A" },
          { type: "leaf", paneId: "B" },
        ],
      },
      { type: "leaf", paneId: "C" },
    ],
  };

  it("produces one intersection", () => {
    const segs = computeHandleSegments(tree, RECT);
    const intersections = findIntersections(segs);
    expect(intersections).toHaveLength(1);
  });

  it("intersection is at the crossing point", () => {
    // horizontal split → vertical handle at x=500 spanning y=0–300 (top half)
    // vertical split → horizontal handle at y=300 spanning x=0–1000
    const segs = computeHandleSegments(tree, RECT);
    const [ix] = findIntersections(segs);
    expect(ix.x).toBeCloseTo(500);
    expect(ix.y).toBeCloseTo(300);
  });

  it("intersection collects both handle segments", () => {
    const segs = computeHandleSegments(tree, RECT);
    const [ix] = findIntersections(segs);
    expect(ix.handles).toHaveLength(2);
  });
});

describe("findIntersections — merge nearby", () => {
  it("intersections within 4px are merged into one", () => {
    // Manufacture two raw intersections 3px apart (within merge threshold)
    const baseNode = { node: {} as never, containerRect: RECT };
    const v1 = { ...baseNode, x1: 100, y1: 0, x2: 100, y2: 600, orientation: "vertical" as const };
    const v2 = { ...baseNode, x1: 103, y1: 0, x2: 103, y2: 600, orientation: "vertical" as const };
    const h = { ...baseNode, x1: 0, y1: 300, x2: 1000, y2: 300, orientation: "horizontal" as const };

    const result = findIntersections([v1, v2, h]);
    expect(result).toHaveLength(1);
    // Averaged x = (100 + 103) / 2 = 101.5
    expect(result[0].x).toBeCloseTo(101.5);
    expect(result[0].y).toBeCloseTo(300);
  });

  it("intersections more than 4px apart are NOT merged", () => {
    const baseNode = { node: {} as never, containerRect: RECT };
    const v1 = { ...baseNode, x1: 100, y1: 0, x2: 100, y2: 600, orientation: "vertical" as const };
    const v2 = { ...baseNode, x1: 106, y1: 0, x2: 106, y2: 600, orientation: "vertical" as const };
    const h = { ...baseNode, x1: 0, y1: 300, x2: 1000, y2: 300, orientation: "horizontal" as const };

    const result = findIntersections([v1, v2, h]);
    expect(result).toHaveLength(2);
  });
});

describe("findIntersections — handle deduplication", () => {
  it("same node handle is not duplicated when multiple intersections merge", () => {
    // Craft a scenario where the same handle segment appears in two raw intersections
    // that get merged. The deduplicated result should only include it once.
    const baseNode = { node: {} as never, containerRect: RECT };
    const sharedH = { ...baseNode, x1: 0, y1: 300, x2: 1000, y2: 300, orientation: "horizontal" as const };
    const v1 = { ...baseNode, x1: 100, y1: 0, x2: 100, y2: 600, orientation: "vertical" as const };
    const v2 = { ...baseNode, x1: 102, y1: 0, x2: 102, y2: 600, orientation: "vertical" as const };

    // Give v1 and v2 different node identities but share sharedH
    const seg1 = { ...v1, node: { id: 1 } as never };
    const seg2 = { ...v2, node: { id: 2 } as never };
    const segH = { ...sharedH, node: { id: 3 } as never };

    const result = findIntersections([seg1, seg2, segH]);
    expect(result).toHaveLength(1);
    // All three distinct nodes should be present
    expect(result[0].handles).toHaveLength(3);
  });
});
