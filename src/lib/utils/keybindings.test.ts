import { describe, it, expect, vi } from "vitest";

// Mock all side-effectful module imports so the pure functions can be tested
// without triggering Svelte stores or Tauri APIs.
vi.mock("../stores/ui.svelte", () => ({ ui: {} }));
vi.mock("../stores/workspace.svelte", () => ({ workspaceManager: {} }));
vi.mock("../stores/settings.svelte", () => ({
  settings: { appearance: { ui_scale: 100 } },
  debouncedSaveSettings: () => {},
}));
vi.mock("./settings-window", () => ({ openSettingsWindow: () => {} }));
vi.mock("../stores/editor-actions.svelte", () => ({ dispatchEditorAction: () => {} }));

import { nearestLeaf, findNeighbor } from "./keybindings";
import type { LayoutNode } from "../stores/layout.svelte";

// --- nearestLeaf ---

describe("nearestLeaf", () => {
  it("leaf node returns its own paneId", () => {
    const leaf: LayoutNode = { type: "leaf", paneId: "solo" };
    expect(nearestLeaf(leaf, "right")).toBe("solo");
  });

  it("horizontal split + right direction returns first leaf of left child", () => {
    // Going right → entering from left side → nearChild = 0 (left child)
    const tree: LayoutNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      children: [
        { type: "leaf", paneId: "left-pane" },
        { type: "leaf", paneId: "right-pane" },
      ],
    };
    expect(nearestLeaf(tree, "right")).toBe("left-pane");
  });

  it("horizontal split + left direction returns first leaf of right child", () => {
    // Going left → entering from right side → nearChild = 1 (right child)
    const tree: LayoutNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      children: [
        { type: "leaf", paneId: "left-pane" },
        { type: "leaf", paneId: "right-pane" },
      ],
    };
    expect(nearestLeaf(tree, "left")).toBe("right-pane");
  });

  it("perpendicular split always returns first leaf of left child", () => {
    // Vertical split is perpendicular to horizontal direction → picks children[0]
    const tree: LayoutNode = {
      type: "split",
      direction: "vertical",
      ratio: 0.5,
      children: [
        { type: "leaf", paneId: "top-pane" },
        { type: "leaf", paneId: "bottom-pane" },
      ],
    };
    expect(nearestLeaf(tree, "right")).toBe("top-pane");
  });
});

// --- findNeighbor ---

describe("findNeighbor", () => {
  it("returns null for single-leaf tree", () => {
    const tree: LayoutNode = { type: "leaf", paneId: "only" };
    expect(findNeighbor(tree, "only", "right")).toBeNull();
  });

  it("right-of left child → returns leftmost leaf of right subtree", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      children: [
        { type: "leaf", paneId: "A" },
        { type: "leaf", paneId: "B" },
      ],
    };
    expect(findNeighbor(tree, "A", "right")).toBe("B");
  });

  it("left-of right child → returns leftmost leaf of left subtree", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      children: [
        { type: "leaf", paneId: "A" },
        { type: "leaf", paneId: "B" },
      ],
    };
    expect(findNeighbor(tree, "B", "left")).toBe("A");
  });

  it("direction mismatch: no horizontal neighbor in vertical-only split → null", () => {
    // Only a vertical split exists; asking for "right" (horizontal) neighbor → no match
    const tree: LayoutNode = {
      type: "split",
      direction: "vertical",
      ratio: 0.5,
      children: [
        { type: "leaf", paneId: "A" },
        { type: "leaf", paneId: "B" },
      ],
    };
    expect(findNeighbor(tree, "A", "right")).toBeNull();
  });

  it("navigates through nested splits to find correct neighbor", () => {
    // root(horizontal): [split(vertical): [A, B], C]
    // A's right neighbor is C (root's right child)
    const tree: LayoutNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      children: [
        {
          type: "split",
          direction: "vertical",
          ratio: 0.5,
          children: [
            { type: "leaf", paneId: "A" },
            { type: "leaf", paneId: "B" },
          ],
        },
        { type: "leaf", paneId: "C" },
      ],
    };
    expect(findNeighbor(tree, "A", "right")).toBe("C");
    expect(findNeighbor(tree, "B", "right")).toBe("C");
  });
});
