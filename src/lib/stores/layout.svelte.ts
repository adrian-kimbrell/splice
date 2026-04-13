/**
 * Binary tree layout model for the pane grid.
 *
 * A `LayoutNode` is either a `leaf` (holds a pane ID) or a `split`
 * (two children, a direction, and a 0–1 ratio). Mirrors `LayoutNode` in
 * `src-tauri/src/workspace/layout.rs` — keep both in sync when adding fields.
 *
 * Two mutation strategies — intentionally inconsistent:
 * - Resize (ratio): mutate in place on the Svelte proxy node (O(1), preserves identity)
 * - Structural (split/remove/swap): return a fresh tree of plain objects to avoid
 *   Svelte 5 proxy reparenting issues (a proxy node must not be moved between parents)
 *
 * `MAX_SPLIT_DEPTH = 5` caps tree depth. `collectLeafIds` is used to garbage-collect
 * pane configs that are no longer referenced by the tree after a structural change.
 *
 * Layout tree contract:
 * - Ratio changes (resize): in-place mutation on the proxy node (node.ratio = ...)
 * - Structural changes (split/remove): return a fresh tree of plain objects
 *
 * These two strategies are intentionally inconsistent: resize is O(1) and preserves
 * the Svelte proxy identity, while structural ops must rebuild to avoid reparenting
 * proxy nodes. Never perform structural ops while a resize drag is active — the fresh
 * tree would discard the proxy node being mutated.
 */

export type SplitDirection = "horizontal" | "vertical";

export type LayoutNode =
  | { type: "leaf"; paneId: string }
  | {
      type: "split";
      direction: SplitDirection;
      ratio: number;
      children: [LayoutNode, LayoutNode];
    };

export interface PaneConfig {
  id: string;
  kind: "editor" | "terminal";
  title: string;
  terminalId?: number;
  filePaths?: string[];
  activeFilePath?: string | null;
  claudeSessionId?: string | null;
  claudePid?: number | null;
}

export const MAX_SPLIT_DEPTH = 5;

export function treeDepth(node: LayoutNode): number {
  if (node.type === "leaf") return 0;
  return 1 + Math.max(treeDepth(node.children[0]), treeDepth(node.children[1]));
}

export function collectLeafIds(node: LayoutNode): Set<string> {
  if (node.type === "leaf") return new Set([node.paneId]);
  const left = collectLeafIds(node.children[0]);
  const right = collectLeafIds(node.children[1]);
  for (const id of right) left.add(id);
  return left;
}

// Default layout: single terminal pane
export function defaultLayout(): LayoutNode {
  return { type: "leaf", paneId: "term-1" };
}

/** Wrap a target leaf in a split node, placing a new pane beside it.
 *  Always returns fresh plain objects to avoid Svelte 5 proxy reparenting issues. */
export function splitNodeInTree(
  tree: LayoutNode,
  targetPaneId: string,
  newPaneId: string,
  direction: SplitDirection,
): { tree: LayoutNode; found: boolean } {
  if (tree.type === "leaf") {
    const fresh: LayoutNode = { type: "leaf", paneId: tree.paneId };
    if (tree.paneId === targetPaneId) {
      return {
        tree: { type: "split", direction, ratio: 0.5, children: [fresh, { type: "leaf", paneId: newPaneId }] },
        found: true,
      };
    }
    return { tree: fresh, found: false };
  }

  const left = splitNodeInTree(tree.children[0], targetPaneId, newPaneId, direction);
  if (left.found) {
    return {
      tree: { type: "split", direction: tree.direction, ratio: tree.ratio, children: [left.tree, tree.children[1]] },
      found: true,
    };
  }
  const right = splitNodeInTree(tree.children[1], targetPaneId, newPaneId, direction);
  return {
    tree: { type: "split", direction: tree.direction, ratio: tree.ratio, children: [left.tree, right.tree] },
    found: right.found,
  };
}

/** Like splitNodeInTree but accepts a side param to control insertion order.
 *  Always returns fresh plain objects to avoid Svelte 5 proxy reparenting issues. */
export function splitNodeInTreeWithSide(
  tree: LayoutNode,
  targetPaneId: string,
  newPaneId: string,
  direction: SplitDirection,
  side: "before" | "after",
): { tree: LayoutNode; found: boolean } {
  if (tree.type === "leaf") {
    const fresh: LayoutNode = { type: "leaf", paneId: tree.paneId };
    if (tree.paneId === targetPaneId) {
      const newLeaf: LayoutNode = { type: "leaf", paneId: newPaneId };
      const children: [LayoutNode, LayoutNode] =
        side === "before" ? [newLeaf, fresh] : [fresh, newLeaf];
      return { tree: { type: "split", direction, ratio: 0.5, children }, found: true };
    }
    return { tree: fresh, found: false };
  }

  const left = splitNodeInTreeWithSide(tree.children[0], targetPaneId, newPaneId, direction, side);
  if (left.found) {
    return {
      tree: { type: "split", direction: tree.direction, ratio: tree.ratio, children: [left.tree, tree.children[1]] },
      found: true,
    };
  }
  const right = splitNodeInTreeWithSide(tree.children[1], targetPaneId, newPaneId, direction, side);
  return {
    tree: { type: "split", direction: tree.direction, ratio: tree.ratio, children: [left.tree, right.tree] },
    found: right.found,
  };
}

/** Find the first leaf in the sibling subtree of the target pane.
 *  Walks up to the parent split, then descends into the other child. */
export function findSiblingLeaf(tree: LayoutNode, targetPaneId: string): string | null {
  function walk(node: LayoutNode): { found: boolean; siblingLeaf: string | null } {
    if (node.type === "leaf") {
      return { found: node.paneId === targetPaneId, siblingLeaf: null };
    }
    const leftResult = walk(node.children[0]);
    if (leftResult.found) {
      return { found: true, siblingLeaf: findFirstLeafInNode(node.children[1]) };
    }
    const rightResult = walk(node.children[1]);
    if (rightResult.found) {
      return { found: true, siblingLeaf: findFirstLeafInNode(node.children[0]) };
    }
    return { found: false, siblingLeaf: null };
  }
  return walk(tree).siblingLeaf;
}

function findFirstLeafInNode(node: LayoutNode): string {
  if (node.type === "leaf") return node.paneId;
  return findFirstLeafInNode(node.children[0]);
}

/** Remove a leaf from the tree. Single-child splits collapse. Returns null tree if empty.
 *  Always returns fresh plain objects to avoid Svelte 5 proxy reparenting issues. */
export function removeNodeFromTree(
  tree: LayoutNode,
  targetPaneId: string,
): { tree: LayoutNode | null; found: boolean } {
  if (tree.type === "leaf") {
    if (tree.paneId === targetPaneId) return { tree: null, found: true };
    return { tree: { type: "leaf", paneId: tree.paneId }, found: false };
  }

  const left = removeNodeFromTree(tree.children[0], targetPaneId);
  const right = removeNodeFromTree(tree.children[1], targetPaneId);
  const found = left.found || right.found;

  if (!left.tree && !right.tree) return { tree: null, found };
  if (!left.tree) return { tree: right.tree, found };
  if (!right.tree) return { tree: left.tree, found };

  return {
    tree: { type: "split", direction: tree.direction, ratio: tree.ratio, children: [left.tree, right.tree] },
    found,
  };
}

/** Swap two leaves in the tree by exchanging their paneIds.
 *  Returns a fresh tree (plain objects). */
export function swapLeavesInTree(
  tree: LayoutNode,
  paneIdA: string,
  paneIdB: string,
): LayoutNode {
  if (tree.type === "leaf") {
    if (tree.paneId === paneIdA) return { type: "leaf", paneId: paneIdB };
    if (tree.paneId === paneIdB) return { type: "leaf", paneId: paneIdA };
    return { type: "leaf", paneId: tree.paneId };
  }
  return {
    type: "split",
    direction: tree.direction,
    ratio: tree.ratio,
    children: [
      swapLeavesInTree(tree.children[0], paneIdA, paneIdB),
      swapLeavesInTree(tree.children[1], paneIdA, paneIdB),
    ],
  };
}
