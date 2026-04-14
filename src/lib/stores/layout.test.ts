import { describe, it, expect } from "vitest";
import {
  treeDepth,
  collectLeafIds,
  splitNodeInTree,
  splitNodeInTreeWithSide,
  removeNodeFromTree,
  findSiblingLeaf,
  findShallowestLeaf,
  swapLeavesInTree,
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

// --- findShallowestLeaf ---

describe("findShallowestLeaf", () => {
  it("returns paneId for a leaf node", () => {
    const leaf: LayoutNode = { type: "leaf", paneId: "only" };
    expect(findShallowestLeaf(leaf)).toBe("only");
  });

  it("returns the shallower side of an unbalanced tree", () => {
    // root(A, split(B, C)) — right side has depth 1, left has depth 0
    // shallowest leaf is on the left (A)
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
    expect(findShallowestLeaf(tree)).toBe("A");
  });

  it("returns left leaf when both sides have equal depth", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      children: [
        { type: "leaf", paneId: "left" },
        { type: "leaf", paneId: "right" },
      ],
    };
    expect(findShallowestLeaf(tree)).toBe("left");
  });

  it("picks the shallowest across deeply nested tree", () => {
    // root(split(A,B), split(split(C,D), E))
    // Left subtree depth = 1, right subtree depth = 2
    // Shallowest is on the left → A
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
                { type: "leaf", paneId: "C" },
                { type: "leaf", paneId: "D" },
              ],
            },
            { type: "leaf", paneId: "E" },
          ],
        },
      ],
    };
    expect(findShallowestLeaf(tree)).toBe("A");
  });
});

// --- swapLeavesInTree ---

describe("swapLeavesInTree", () => {
  it("swaps two sibling leaves", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      children: [
        { type: "leaf", paneId: "A" },
        { type: "leaf", paneId: "B" },
      ],
    };
    const result = swapLeavesInTree(tree, "A", "B");
    expect(result.type).toBe("split");
    if (result.type === "split") {
      expect(result.children[0]).toMatchObject({ type: "leaf", paneId: "B" });
      expect(result.children[1]).toMatchObject({ type: "leaf", paneId: "A" });
    }
  });

  it("swaps leaves in different subtrees", () => {
    // root(A, split(B, C)) — swap A and C
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
    const result = swapLeavesInTree(tree, "A", "C");
    if (result.type === "split") {
      expect(result.children[0]).toMatchObject({ type: "leaf", paneId: "C" });
      const right = result.children[1];
      if (right.type === "split") {
        expect(right.children[1]).toMatchObject({ type: "leaf", paneId: "A" });
        expect(right.children[0]).toMatchObject({ type: "leaf", paneId: "B" });
      }
    }
  });

  it("is a no-op when neither paneId is in the tree", () => {
    const tree: LayoutNode = { type: "leaf", paneId: "A" };
    const result = swapLeavesInTree(tree, "X", "Y");
    expect(result).toMatchObject({ type: "leaf", paneId: "A" });
  });

  it("returns fresh objects (no shared references with input)", () => {
    const leaf: LayoutNode = { type: "leaf", paneId: "A" };
    const result = swapLeavesInTree(leaf, "A", "B");
    expect(result).not.toBe(leaf);
  });

  it("preserves split direction and ratio", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "vertical",
      ratio: 0.3,
      children: [
        { type: "leaf", paneId: "A" },
        { type: "leaf", paneId: "B" },
      ],
    };
    const result = swapLeavesInTree(tree, "A", "B");
    if (result.type === "split") {
      expect(result.direction).toBe("vertical");
      expect(result.ratio).toBe(0.3);
    }
  });
});
