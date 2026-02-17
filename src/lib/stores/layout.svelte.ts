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
): LayoutNode {
  if (tree.type === "leaf") {
    const fresh: LayoutNode = { type: "leaf", paneId: tree.paneId };
    if (tree.paneId === targetPaneId) {
      return {
        type: "split",
        direction,
        ratio: 0.5,
        children: [fresh, { type: "leaf", paneId: newPaneId }],
      };
    }
    return fresh;
  }

  return {
    type: "split",
    direction: tree.direction,
    ratio: tree.ratio,
    children: [
      splitNodeInTree(tree.children[0], targetPaneId, newPaneId, direction),
      splitNodeInTree(tree.children[1], targetPaneId, newPaneId, direction),
    ],
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
): LayoutNode {
  if (tree.type === "leaf") {
    const fresh: LayoutNode = { type: "leaf", paneId: tree.paneId };
    if (tree.paneId === targetPaneId) {
      const newLeaf: LayoutNode = { type: "leaf", paneId: newPaneId };
      const children: [LayoutNode, LayoutNode] =
        side === "before" ? [newLeaf, fresh] : [fresh, newLeaf];
      return { type: "split", direction, ratio: 0.5, children };
    }
    return fresh;
  }

  return {
    type: "split",
    direction: tree.direction,
    ratio: tree.ratio,
    children: [
      splitNodeInTreeWithSide(tree.children[0], targetPaneId, newPaneId, direction, side),
      splitNodeInTreeWithSide(tree.children[1], targetPaneId, newPaneId, direction, side),
    ],
  };
}

/** Remove a leaf from the tree. Single-child splits collapse. Returns null if empty.
 *  Always returns fresh plain objects to avoid Svelte 5 proxy reparenting issues. */
export function removeNodeFromTree(
  tree: LayoutNode,
  targetPaneId: string,
): LayoutNode | null {
  if (tree.type === "leaf") {
    return tree.paneId === targetPaneId ? null : { type: "leaf", paneId: tree.paneId };
  }

  const left = removeNodeFromTree(tree.children[0], targetPaneId);
  const right = removeNodeFromTree(tree.children[1], targetPaneId);

  if (!left && !right) return null;
  if (!left) return right;
  if (!right) return left;

  return { type: "split", direction: tree.direction, ratio: tree.ratio, children: [left, right] };
}
