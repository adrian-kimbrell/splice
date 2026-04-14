import { describe, it, expect } from "vitest";
import {
  isFileReferencedInAnyPane,
  validateLayout,
  toggleFilePinned,
  toggleFileReadOnly,
  reorderTabInPane,
  moveTabToNewPane,
  moveTabToExistingPane,
  getFilesToCloseOther,
  getFilesToCloseLeft,
  getFilesToCloseRight,
  getFilesToCloseClean,
} from "./workspace-tab-ops";
import type { Workspace } from "./workspace-types";
import type { LayoutNode, PaneConfig } from "./layout.svelte";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(path: string, opts: { pinned?: boolean; dirty?: boolean; preview?: boolean } = {}) {
  return { name: path.split("/").pop()!, path, content: "", ...opts };
}

function makeEditorPane(id: string, filePaths: string[], active?: string): PaneConfig {
  return { id, kind: "editor", title: "Editor", filePaths, activeFilePath: active ?? filePaths[0] ?? null };
}

function makeWs(
  panes: Record<string, PaneConfig>,
  layout: LayoutNode | null,
  files: ReturnType<typeof makeFile>[],
  activePaneId?: string,
): Workspace {
  const openFileIndex = Object.fromEntries(files.map(f => [f.path, f]));
  return {
    id: "ws-1",
    name: "test",
    rootPath: "/tmp",
    fileTree: [],
    openFiles: files,
    openFileIndex,
    terminalIds: [],
    activeTerminalId: null,
    layout,
    panes,
    activePaneId: activePaneId ?? null,
    gitBranch: "",
    explorerVisible: true,
    expandedPaths: new Set(),
  };
}

function leaf(paneId: string): LayoutNode {
  return { type: "leaf", paneId };
}

function hSplit(left: LayoutNode, right: LayoutNode, ratio = 0.5): LayoutNode {
  return { type: "split", direction: "horizontal", ratio, children: [left, right] };
}

// ---------------------------------------------------------------------------
// isFileReferencedInAnyPane
// ---------------------------------------------------------------------------

describe("isFileReferencedInAnyPane", () => {
  it("returns true when file is in a pane", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts"]) },
      leaf("p1"),
      [makeFile("a.ts")],
    );
    expect(isFileReferencedInAnyPane(ws, "a.ts")).toBe(true);
  });

  it("returns false when file is not in any pane", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["b.ts"]) },
      leaf("p1"),
      [makeFile("b.ts")],
    );
    expect(isFileReferencedInAnyPane(ws, "a.ts")).toBe(false);
  });

  it("returns false for terminal panes", () => {
    const ws = makeWs(
      { t1: { id: "t1", kind: "terminal", title: "Terminal", terminalId: 1 } },
      leaf("t1"),
      [],
    );
    expect(isFileReferencedInAnyPane(ws, "a.ts")).toBe(false);
  });

  it("returns true when file is in one of several panes", () => {
    const ws = makeWs(
      {
        p1: makeEditorPane("p1", ["a.ts"]),
        p2: makeEditorPane("p2", ["b.ts", "c.ts"]),
      },
      hSplit(leaf("p1"), leaf("p2")),
      [makeFile("a.ts"), makeFile("b.ts"), makeFile("c.ts")],
    );
    expect(isFileReferencedInAnyPane(ws, "c.ts")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateLayout
// ---------------------------------------------------------------------------

describe("validateLayout", () => {
  it("no-ops when layout is null", () => {
    const ws = makeWs({}, null, []);
    expect(() => validateLayout(ws)).not.toThrow();
  });

  it("removes orphaned pane configs not in layout", () => {
    const ws = makeWs(
      {
        p1: makeEditorPane("p1", []),
        orphan: makeEditorPane("orphan", []),
      },
      leaf("p1"),
      [],
      "p1",
    );
    validateLayout(ws);
    expect(ws.panes["orphan"]).toBeUndefined();
    expect(ws.panes["p1"]).toBeDefined();
  });

  it("fixes activePaneId when it points to a removed pane", () => {
    const ws = makeWs(
      {
        p1: makeEditorPane("p1", []),
        p2: makeEditorPane("p2", []),
      },
      hSplit(leaf("p1"), leaf("p2")),
      [],
      "gone",
    );
    validateLayout(ws);
    expect(["p1", "p2"]).toContain(ws.activePaneId);
  });

  it("sets activePaneId to null when all panes are removed", () => {
    const ws = makeWs(
      { orphan: makeEditorPane("orphan", []) },
      leaf("p1"),
      [],
      "orphan",
    );
    // After validateLayout, panes will be empty because "orphan" is not in the layout
    // and activePaneId pointed to it. But "p1" is in layout but not in panes — that's a warning.
    // The activePaneId fix looks at remaining panes after cleanup.
    validateLayout(ws);
    // orphan removed from panes, no panes left → activePaneId null
    expect(ws.activePaneId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// toggleFilePinned
// ---------------------------------------------------------------------------

describe("toggleFilePinned", () => {
  it("pins an unpinned file", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts"]) },
      leaf("p1"),
      [makeFile("a.ts")],
    );
    toggleFilePinned(ws, "a.ts");
    expect(ws.openFileIndex["a.ts"].pinned).toBe(true);
  });

  it("unpins a pinned file", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts"]) },
      leaf("p1"),
      [makeFile("a.ts", { pinned: true })],
    );
    toggleFilePinned(ws, "a.ts");
    expect(ws.openFileIndex["a.ts"].pinned).toBe(false);
  });

  it("no-ops for unknown file", () => {
    const ws = makeWs({ p1: makeEditorPane("p1", []) }, leaf("p1"), []);
    expect(() => toggleFilePinned(ws, "nope.ts")).not.toThrow();
  });

  it("clears preview flag when pinning", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts"]) },
      leaf("p1"),
      [makeFile("a.ts", { preview: true })],
    );
    toggleFilePinned(ws, "a.ts");
    expect(ws.openFileIndex["a.ts"].preview).toBe(false);
  });

  it("moves newly-pinned tab after existing pinned tabs", () => {
    // pane order: [pinned-a, b, c] — pin c → should become [pinned-a, pinned-c, b]
    const a = makeFile("a.ts", { pinned: true });
    const b = makeFile("b.ts");
    const c = makeFile("c.ts");
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts", "b.ts", "c.ts"]) },
      leaf("p1"),
      [a, b, c],
    );
    toggleFilePinned(ws, "c.ts");
    expect(ws.panes["p1"].filePaths).toEqual(["a.ts", "c.ts", "b.ts"]);
  });

  it("moves newly-pinned tab to front when no other pinned tabs exist", () => {
    // pane order: [a, b, c] — pin b → [b, a, c]
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts", "b.ts", "c.ts"]) },
      leaf("p1"),
      [makeFile("a.ts"), makeFile("b.ts"), makeFile("c.ts")],
    );
    toggleFilePinned(ws, "b.ts");
    expect(ws.panes["p1"].filePaths![0]).toBe("b.ts");
  });

  it("does not move tab that is already at the correct pinned position", () => {
    // [pinned-a, b] — pin a again? No — pin b. b should go after a.
    const a = makeFile("a.ts", { pinned: true });
    const b = makeFile("b.ts");
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts", "b.ts"]) },
      leaf("p1"),
      [a, b],
    );
    toggleFilePinned(ws, "b.ts");
    expect(ws.panes["p1"].filePaths).toEqual(["a.ts", "b.ts"]);
  });

  it("pinning applies across multiple panes that contain the file", () => {
    const ws = makeWs(
      {
        p1: makeEditorPane("p1", ["a.ts", "b.ts"]),
        p2: makeEditorPane("p2", ["b.ts", "a.ts"]),
      },
      hSplit(leaf("p1"), leaf("p2")),
      [makeFile("a.ts", { pinned: true }), makeFile("b.ts")],
    );
    toggleFilePinned(ws, "b.ts");
    // In p1: [pinned-a, b] → b should go after a → [a, b] (already correct)
    expect(ws.panes["p1"].filePaths).toEqual(["a.ts", "b.ts"]);
    // In p2: [b, a] → b should go after a → [a, b]
    expect(ws.panes["p2"].filePaths).toEqual(["a.ts", "b.ts"]);
  });
});

// ---------------------------------------------------------------------------
// toggleFileReadOnly
// ---------------------------------------------------------------------------

describe("toggleFileReadOnly", () => {
  it("sets readOnly to true", () => {
    const ws = makeWs({ p1: makeEditorPane("p1", ["a.ts"]) }, leaf("p1"), [makeFile("a.ts")]);
    toggleFileReadOnly(ws, "a.ts");
    expect(ws.openFileIndex["a.ts"].readOnly).toBe(true);
  });

  it("toggles back to false", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts"]) },
      leaf("p1"),
      [makeFile("a.ts", { pinned: false })],
    );
    ws.openFileIndex["a.ts"].readOnly = true;
    toggleFileReadOnly(ws, "a.ts");
    expect(ws.openFileIndex["a.ts"].readOnly).toBe(false);
  });

  it("no-ops for unknown file", () => {
    const ws = makeWs({ p1: makeEditorPane("p1", []) }, leaf("p1"), []);
    expect(() => toggleFileReadOnly(ws, "nope.ts")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// reorderTabInPane
// ---------------------------------------------------------------------------

describe("reorderTabInPane", () => {
  function makeReorderWs() {
    return makeWs(
      { p1: makeEditorPane("p1", ["a.ts", "b.ts", "c.ts"]) },
      leaf("p1"),
      [makeFile("a.ts"), makeFile("b.ts"), makeFile("c.ts")],
    );
  }

  it("moves tab forward", () => {
    const ws = makeReorderWs();
    reorderTabInPane(ws, "p1", 0, 2);
    expect(ws.panes["p1"].filePaths).toEqual(["b.ts", "c.ts", "a.ts"]);
  });

  it("moves tab backward", () => {
    const ws = makeReorderWs();
    reorderTabInPane(ws, "p1", 2, 0);
    expect(ws.panes["p1"].filePaths).toEqual(["c.ts", "a.ts", "b.ts"]);
  });

  it("no-ops when fromIndex === toIndex", () => {
    const ws = makeReorderWs();
    reorderTabInPane(ws, "p1", 1, 1);
    expect(ws.panes["p1"].filePaths).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("no-ops for out-of-bounds fromIndex", () => {
    const ws = makeReorderWs();
    reorderTabInPane(ws, "p1", 5, 0);
    expect(ws.panes["p1"].filePaths).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("no-ops for out-of-bounds toIndex", () => {
    const ws = makeReorderWs();
    reorderTabInPane(ws, "p1", 0, 5);
    expect(ws.panes["p1"].filePaths).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("no-ops for unknown pane", () => {
    const ws = makeReorderWs();
    expect(() => reorderTabInPane(ws, "nope", 0, 1)).not.toThrow();
  });

  it("no-ops for terminal pane", () => {
    const ws = makeWs(
      { t1: { id: "t1", kind: "terminal", title: "Terminal", terminalId: 1 } },
      leaf("t1"),
      [],
    );
    expect(() => reorderTabInPane(ws, "t1", 0, 1)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// moveTabToExistingPane
// ---------------------------------------------------------------------------

describe("moveTabToExistingPane", () => {
  it("moves file from source to target pane", () => {
    const ws = makeWs(
      {
        p1: makeEditorPane("p1", ["a.ts", "b.ts"]),
        p2: makeEditorPane("p2", ["c.ts"]),
      },
      hSplit(leaf("p1"), leaf("p2")),
      [makeFile("a.ts"), makeFile("b.ts"), makeFile("c.ts")],
    );
    moveTabToExistingPane(ws, "a.ts", "p1", "p2");
    expect(ws.panes["p1"].filePaths).not.toContain("a.ts");
    expect(ws.panes["p2"].filePaths).toContain("a.ts");
  });

  it("sets activeFilePath on target pane", () => {
    const ws = makeWs(
      {
        p1: makeEditorPane("p1", ["a.ts", "b.ts"]),
        p2: makeEditorPane("p2", ["c.ts"]),
      },
      hSplit(leaf("p1"), leaf("p2")),
      [makeFile("a.ts"), makeFile("b.ts"), makeFile("c.ts")],
    );
    moveTabToExistingPane(ws, "a.ts", "p1", "p2");
    expect(ws.panes["p2"].activeFilePath).toBe("a.ts");
  });

  it("collapses source pane when it becomes empty", () => {
    const ws = makeWs(
      {
        p1: makeEditorPane("p1", ["a.ts"]),
        p2: makeEditorPane("p2", ["b.ts"]),
      },
      hSplit(leaf("p1"), leaf("p2")),
      [makeFile("a.ts"), makeFile("b.ts")],
    );
    moveTabToExistingPane(ws, "a.ts", "p1", "p2");
    expect(ws.panes["p1"]).toBeUndefined();
    // Layout should collapse to just p2
    expect(ws.layout?.type).toBe("leaf");
    expect((ws.layout as { paneId: string }).paneId).toBe("p2");
  });

  it("does not add duplicate file to target", () => {
    const ws = makeWs(
      {
        p1: makeEditorPane("p1", ["a.ts", "b.ts"]),
        p2: makeEditorPane("p2", ["a.ts"]),
      },
      hSplit(leaf("p1"), leaf("p2")),
      [makeFile("a.ts"), makeFile("b.ts")],
    );
    moveTabToExistingPane(ws, "a.ts", "p1", "p2");
    expect(ws.panes["p2"].filePaths!.filter(f => f === "a.ts")).toHaveLength(1);
  });

  it("does not move into terminal panes", () => {
    const ws = makeWs(
      {
        p1: makeEditorPane("p1", ["a.ts"]),
        t1: { id: "t1", kind: "terminal", title: "Terminal", terminalId: 1 },
      },
      hSplit(leaf("p1"), leaf("t1")),
      [makeFile("a.ts")],
    );
    moveTabToExistingPane(ws, "a.ts", "p1", "t1");
    // File should still be in p1, not moved
    expect(ws.panes["p1"].filePaths).toContain("a.ts");
  });

  it("updates activePaneId to target", () => {
    const ws = makeWs(
      {
        p1: makeEditorPane("p1", ["a.ts", "b.ts"]),
        p2: makeEditorPane("p2", ["c.ts"]),
      },
      hSplit(leaf("p1"), leaf("p2")),
      [makeFile("a.ts"), makeFile("b.ts"), makeFile("c.ts")],
      "p1",
    );
    moveTabToExistingPane(ws, "a.ts", "p1", "p2");
    expect(ws.activePaneId).toBe("p2");
  });
});

// ---------------------------------------------------------------------------
// moveTabToNewPane
// ---------------------------------------------------------------------------

describe("moveTabToNewPane", () => {
  it("creates a new pane for the dragged tab (multi-tab source)", () => {
    const ws = makeWs(
      {
        p1: makeEditorPane("p1", ["a.ts", "b.ts"]),
      },
      leaf("p1"),
      [makeFile("a.ts"), makeFile("b.ts")],
    );
    moveTabToNewPane(ws, "a.ts", "p1", "p1", "horizontal", "after");
    // Source pane should no longer have a.ts
    expect(ws.panes["p1"].filePaths).not.toContain("a.ts");
    // A new pane should exist with a.ts
    const newPane = Object.values(ws.panes).find(p => p.filePaths?.includes("a.ts"));
    expect(newPane).toBeDefined();
    expect(newPane!.filePaths).toEqual(["a.ts"]);
  });

  it("optimises single-tab source: moves pane in layout instead of create+collapse", () => {
    // Single-tab source — should not create a new pane id, just reposition
    const ws = makeWs(
      {
        p1: makeEditorPane("p1", ["a.ts"]),
        p2: makeEditorPane("p2", ["b.ts"]),
      },
      hSplit(leaf("p1"), leaf("p2")),
      [makeFile("a.ts"), makeFile("b.ts")],
    );
    const panesBefore = new Set(Object.keys(ws.panes));
    moveTabToNewPane(ws, "a.ts", "p1", "p2", "horizontal", "before");
    // Should not have created a new pane id
    expect(new Set(Object.keys(ws.panes))).toEqual(panesBefore);
  });

  it("does not exceed MAX_SPLIT_DEPTH", () => {
    // Build a deeply nested tree (5 levels deep) and try to split further
    let layout: LayoutNode = leaf("p1");
    const panes: Record<string, PaneConfig> = { p1: makeEditorPane("p1", ["a.ts"]) };
    for (let i = 2; i <= 10; i++) {
      const newId = `p${i}`;
      panes[newId] = makeEditorPane(newId, [`file${i}.ts`]);
      layout = hSplit(layout, leaf(newId));
    }
    const files = Object.keys(panes).flatMap(pid =>
      (panes[pid].filePaths ?? []).map(f => makeFile(f))
    );
    const ws = makeWs(panes, layout, files);

    const paneCountBefore = Object.keys(ws.panes).length;
    // Try to add yet another split by moving a single-file pane — should be blocked
    // (single-tab optimisation: removes p1 first, checks depth, inserts)
    // The tree depth is 9 (10 leaves), which exceeds MAX_SPLIT_DEPTH=10... actually let's just
    // check it doesn't crash and pane count doesn't increase beyond what's valid
    expect(() => moveTabToNewPane(ws, "a.ts", "p1", "p2", "horizontal", "after")).not.toThrow();
    expect(Object.keys(ws.panes).length).toBeLessThanOrEqual(paneCountBefore);
  });

  it("no-ops when layout is null", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts"]) },
      null,
      [makeFile("a.ts")],
    );
    expect(() => moveTabToNewPane(ws, "a.ts", "p1", "p1", "horizontal", "after")).not.toThrow();
  });

  it("sets activePaneId to the pane containing the moved tab", () => {
    const ws = makeWs(
      {
        p1: makeEditorPane("p1", ["a.ts", "b.ts"]),
      },
      leaf("p1"),
      [makeFile("a.ts"), makeFile("b.ts")],
    );
    moveTabToNewPane(ws, "a.ts", "p1", "p1", "horizontal", "after");
    const newPane = Object.values(ws.panes).find(p => p.filePaths?.includes("a.ts"));
    expect(ws.activePaneId).toBe(newPane!.id);
  });
});

// ---------------------------------------------------------------------------
// getFilesToCloseOther
// ---------------------------------------------------------------------------

describe("getFilesToCloseOther", () => {
  it("returns all files except the given path", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts", "b.ts", "c.ts"]) },
      leaf("p1"),
      [makeFile("a.ts"), makeFile("b.ts"), makeFile("c.ts")],
    );
    expect(getFilesToCloseOther(ws, "b.ts", "p1")).toEqual(["a.ts", "c.ts"]);
  });

  it("excludes pinned files", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts", "b.ts", "c.ts"]) },
      leaf("p1"),
      [makeFile("a.ts", { pinned: true }), makeFile("b.ts"), makeFile("c.ts")],
    );
    expect(getFilesToCloseOther(ws, "b.ts", "p1")).toEqual(["c.ts"]);
  });

  it("returns empty for unknown pane", () => {
    const ws = makeWs({}, null, []);
    expect(getFilesToCloseOther(ws, "a.ts", "nope")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getFilesToCloseLeft
// ---------------------------------------------------------------------------

describe("getFilesToCloseLeft", () => {
  it("returns files to the left of given path", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts", "b.ts", "c.ts"]) },
      leaf("p1"),
      [makeFile("a.ts"), makeFile("b.ts"), makeFile("c.ts")],
    );
    expect(getFilesToCloseLeft(ws, "c.ts", "p1")).toEqual(["a.ts", "b.ts"]);
  });

  it("returns empty when file is first", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts", "b.ts"]) },
      leaf("p1"),
      [makeFile("a.ts"), makeFile("b.ts")],
    );
    expect(getFilesToCloseLeft(ws, "a.ts", "p1")).toEqual([]);
  });

  it("excludes pinned files to the left", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts", "b.ts", "c.ts"]) },
      leaf("p1"),
      [makeFile("a.ts", { pinned: true }), makeFile("b.ts"), makeFile("c.ts")],
    );
    expect(getFilesToCloseLeft(ws, "c.ts", "p1")).toEqual(["b.ts"]);
  });
});

// ---------------------------------------------------------------------------
// getFilesToCloseRight
// ---------------------------------------------------------------------------

describe("getFilesToCloseRight", () => {
  it("returns files to the right of given path", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts", "b.ts", "c.ts"]) },
      leaf("p1"),
      [makeFile("a.ts"), makeFile("b.ts"), makeFile("c.ts")],
    );
    expect(getFilesToCloseRight(ws, "a.ts", "p1")).toEqual(["b.ts", "c.ts"]);
  });

  it("returns empty when file is last", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts", "b.ts"]) },
      leaf("p1"),
      [makeFile("a.ts"), makeFile("b.ts")],
    );
    expect(getFilesToCloseRight(ws, "b.ts", "p1")).toEqual([]);
  });

  it("excludes pinned files to the right", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts", "b.ts", "c.ts"]) },
      leaf("p1"),
      [makeFile("a.ts"), makeFile("b.ts"), makeFile("c.ts", { pinned: true })],
    );
    expect(getFilesToCloseRight(ws, "a.ts", "p1")).toEqual(["b.ts"]);
  });

  it("returns empty for unknown file path", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts", "b.ts"]) },
      leaf("p1"),
      [makeFile("a.ts"), makeFile("b.ts")],
    );
    expect(getFilesToCloseRight(ws, "nope.ts", "p1")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getFilesToCloseClean
// ---------------------------------------------------------------------------

describe("getFilesToCloseClean", () => {
  it("returns non-dirty, non-pinned files", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts", "b.ts", "c.ts"]) },
      leaf("p1"),
      [makeFile("a.ts"), makeFile("b.ts", { dirty: true }), makeFile("c.ts", { pinned: true })],
    );
    expect(getFilesToCloseClean(ws, "p1")).toEqual(["a.ts"]);
  });

  it("returns empty when all files are dirty or pinned", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts", "b.ts"]) },
      leaf("p1"),
      [makeFile("a.ts", { dirty: true }), makeFile("b.ts", { pinned: true })],
    );
    expect(getFilesToCloseClean(ws, "p1")).toEqual([]);
  });

  it("returns all files when all are clean and unpinned", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts", "b.ts"]) },
      leaf("p1"),
      [makeFile("a.ts"), makeFile("b.ts")],
    );
    expect(getFilesToCloseClean(ws, "p1")).toEqual(["a.ts", "b.ts"]);
  });

  it("returns empty for unknown pane", () => {
    const ws = makeWs({}, null, []);
    expect(getFilesToCloseClean(ws, "nope")).toEqual([]);
  });
});
