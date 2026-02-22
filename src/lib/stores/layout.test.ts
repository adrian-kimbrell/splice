import { describe, it, expect } from "vitest";
import {
  treeDepth,
  collectLeafIds,
  splitNodeInTree,
  splitNodeInTreeWithSide,
  removeNodeFromTree,
  findSiblingLeaf,
  type LayoutNode,
} from "./layout.svelte";

// --- treeDepth ---

describe("treeDepth", () => {
  it("leaf node returns 0", () => {
    const leaf: LayoutNode = { type: "leaf", paneId: "a" };
    expect(treeDepth(leaf)).toBe(0);
  });

  it("single split of two leaves returns 1", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      children: [
        { type: "leaf", paneId: "a" },
        { type: "leaf", paneId: "b" },
      ],
    };
    expect(treeDepth(tree)).toBe(1);
  });

  it("deeply nested tree returns correct depth", () => {
    // depth-3 tree: root → split → split → split → leaves
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
            {
              type: "split",
              direction: "horizontal",
              ratio: 0.5,
              children: [
                { type: "leaf", paneId: "a" },
                { type: "leaf", paneId: "b" },
              ],
            },
            { type: "leaf", paneId: "c" },
          ],
        },
        { type: "leaf", paneId: "d" },
      ],
    };
    expect(treeDepth(tree)).toBe(3);
  });
});

// --- collectLeafIds ---

describe("collectLeafIds", () => {
  it("single leaf returns set with its ID", () => {
    const leaf: LayoutNode = { type: "leaf", paneId: "only" };
    const ids = collectLeafIds(leaf);
    expect(ids.size).toBe(1);
    expect(ids.has("only")).toBe(true);
  });

  it("split with two leaves returns both IDs", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      children: [
        { type: "leaf", paneId: "left" },
        { type: "leaf", paneId: "right" },
      ],
    };
    const ids = collectLeafIds(tree);
    expect(ids.size).toBe(2);
    expect(ids.has("left")).toBe(true);
    expect(ids.has("right")).toBe(true);
  });

  it("deep tree returns all leaf IDs without duplicates", () => {
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
            { type: "leaf", paneId: "a" },
            { type: "leaf", paneId: "b" },
          ],
        },
        { type: "leaf", paneId: "c" },
      ],
    };
    const ids = collectLeafIds(tree);
    expect(ids.size).toBe(3);
    expect(ids.has("a")).toBe(true);
    expect(ids.has("b")).toBe(true);
    expect(ids.has("c")).toBe(true);
  });
});

// --- splitNodeInTree ---

describe("splitNodeInTree", () => {
  it("returns found:false when target pane not in tree", () => {
    const tree: LayoutNode = { type: "leaf", paneId: "existing" };
    const result = splitNodeInTree(tree, "missing", "new-pane", "horizontal");
    expect(result.found).toBe(false);
  });

  it("returns found:true with correct split structure when target found", () => {
    const tree: LayoutNode = { type: "leaf", paneId: "target" };
    const result = splitNodeInTree(tree, "target", "new-pane", "horizontal");
    expect(result.found).toBe(true);
    expect(result.tree.type).toBe("split");
    if (result.tree.type === "split") {
      expect(result.tree.direction).toBe("horizontal");
      expect(result.tree.ratio).toBe(0.5);
    }
  });

  it("places new pane as right child by default", () => {
    const tree: LayoutNode = { type: "leaf", paneId: "target" };
    const result = splitNodeInTree(tree, "target", "new-pane", "horizontal");
    if (result.tree.type === "split") {
      expect(result.tree.children[0]).toMatchObject({ type: "leaf", paneId: "target" });
      expect(result.tree.children[1]).toMatchObject({ type: "leaf", paneId: "new-pane" });
    } else {
      throw new Error("Expected split node");
    }
  });

  it("non-target leaves are preserved unchanged", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      children: [
        { type: "leaf", paneId: "A" },
        { type: "leaf", paneId: "B" },
      ],
    };
    const result = splitNodeInTree(tree, "A", "new-pane", "vertical");
    expect(result.found).toBe(true);
    if (result.tree.type === "split") {
      // B should be preserved as the right child of the root split
      expect(result.tree.children[1]).toMatchObject({ type: "leaf", paneId: "B" });
    }
  });

  it("returns fresh objects (not same reference as input leaf)", () => {
    const leaf: LayoutNode = { type: "leaf", paneId: "target" };
    const result = splitNodeInTree(leaf, "target", "new-pane", "horizontal");
    if (result.tree.type === "split") {
      expect(result.tree.children[0]).not.toBe(leaf);
    }
  });
});

// --- splitNodeInTreeWithSide ---

describe("splitNodeInTreeWithSide", () => {
  it("side:'before' places new pane as left child", () => {
    const tree: LayoutNode = { type: "leaf", paneId: "target" };
    const result = splitNodeInTreeWithSide(tree, "target", "new-pane", "horizontal", "before");
    expect(result.found).toBe(true);
    if (result.tree.type === "split") {
      expect(result.tree.children[0]).toMatchObject({ type: "leaf", paneId: "new-pane" });
      expect(result.tree.children[1]).toMatchObject({ type: "leaf", paneId: "target" });
    } else {
      throw new Error("Expected split node");
    }
  });

  it("side:'after' places new pane as right child", () => {
    const tree: LayoutNode = { type: "leaf", paneId: "target" };
    const result = splitNodeInTreeWithSide(tree, "target", "new-pane", "horizontal", "after");
    expect(result.found).toBe(true);
    if (result.tree.type === "split") {
      expect(result.tree.children[0]).toMatchObject({ type: "leaf", paneId: "target" });
      expect(result.tree.children[1]).toMatchObject({ type: "leaf", paneId: "new-pane" });
    } else {
      throw new Error("Expected split node");
    }
  });
});

// --- removeNodeFromTree ---

describe("removeNodeFromTree", () => {
  it("returns found:false when target not present", () => {
    const tree: LayoutNode = { type: "leaf", paneId: "existing" };
    const result = removeNodeFromTree(tree, "missing");
    expect(result.found).toBe(false);
  });

  it("removing single leaf returns tree:null", () => {
    const tree: LayoutNode = { type: "leaf", paneId: "only" };
    const result = removeNodeFromTree(tree, "only");
    expect(result.found).toBe(true);
    expect(result.tree).toBeNull();
  });

  it("removing one child of split collapses — returns sibling directly", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      children: [
        { type: "leaf", paneId: "A" },
        { type: "leaf", paneId: "B" },
      ],
    };
    const result = removeNodeFromTree(tree, "A");
    expect(result.found).toBe(true);
    expect(result.tree).toMatchObject({ type: "leaf", paneId: "B" });
  });

  it("deep tree: removing nested leaf preserves rest of structure", () => {
    // root(A, split(B, C)) — remove B → root(A, C)
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
    const result = removeNodeFromTree(tree, "B");
    expect(result.found).toBe(true);
    expect(result.tree).toMatchObject({
      type: "split",
      children: [
        { type: "leaf", paneId: "A" },
        { type: "leaf", paneId: "C" },
      ],
    });
  });
});

// --- findSiblingLeaf ---

describe("findSiblingLeaf", () => {
  it("left child target → returns first leaf of right subtree", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      children: [
        { type: "leaf", paneId: "left" },
        { type: "leaf", paneId: "right" },
      ],
    };
    expect(findSiblingLeaf(tree, "left")).toBe("right");
  });

  it("right child target → returns first leaf of left subtree", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      children: [
        { type: "leaf", paneId: "left" },
        { type: "leaf", paneId: "right" },
      ],
    };
    expect(findSiblingLeaf(tree, "right")).toBe("left");
  });

  it("target not in tree → returns null", () => {
    const tree: LayoutNode = { type: "leaf", paneId: "only" };
    expect(findSiblingLeaf(tree, "missing")).toBeNull();
  });

  it("nested target: returns sibling at outermost enclosing split", () => {
    // root(A, split(B, C))
    // B and C are both in root's right subtree, so their "sibling" at root
    // level is A (first leaf of root's left subtree).
    // A's sibling is B (first leaf of root's right subtree).
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
    expect(findSiblingLeaf(tree, "B")).toBe("A");
    expect(findSiblingLeaf(tree, "C")).toBe("A");
    expect(findSiblingLeaf(tree, "A")).toBe("B");
  });
});
