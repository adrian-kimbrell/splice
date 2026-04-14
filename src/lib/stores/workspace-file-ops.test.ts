import { describe, it, expect } from "vitest";
import {
  findFirstEditorPaneId,
  hasDirtyFilesByPane,
  isFileDirty,
  ensureEditorPane,
  openFileInWorkspace,
  closeFileInWorkspace,
  setActiveFileInWorkspace,
  updateFileContent,
} from "./workspace-file-ops";
import type { Workspace } from "./workspace-types";
import type { LayoutNode, PaneConfig } from "./layout.svelte";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(path: string, opts: { dirty?: boolean; preview?: boolean; pinned?: boolean } = {}) {
  return {
    name: path.split("/").pop()!,
    path,
    content: "hello",
    originalContent: "hello",
    dirty: opts.dirty ?? false,
    preview: opts.preview ?? false,
    pinned: opts.pinned ?? false,
  };
}

function makeEditorPane(id: string, filePaths: string[], active?: string): PaneConfig {
  return { id, kind: "editor", title: "Editor", filePaths: [...filePaths], activeFilePath: active ?? filePaths[0] ?? null };
}

function makeWs(
  panes: Record<string, PaneConfig> = {},
  layout: LayoutNode | null = null,
  files: ReturnType<typeof makeFile>[] = [],
  activePaneId?: string,
): Workspace {
  const openFileIndex = Object.fromEntries(files.map(f => [f.path, f]));
  return {
    id: "ws-1",
    name: "test",
    rootPath: "/tmp",
    fileTree: [],
    openFiles: [...files],
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

function hSplit(left: LayoutNode, right: LayoutNode): LayoutNode {
  return { type: "split", direction: "horizontal", ratio: 0.5, children: [left, right] };
}

// ---------------------------------------------------------------------------
// findFirstEditorPaneId
// ---------------------------------------------------------------------------

describe("findFirstEditorPaneId", () => {
  it("returns null when no panes", () => {
    expect(findFirstEditorPaneId(makeWs())).toBeNull();
  });

  it("returns the editor pane id", () => {
    const ws = makeWs({ p1: makeEditorPane("p1", []) }, leaf("p1"));
    expect(findFirstEditorPaneId(ws)).toBe("p1");
  });

  it("skips terminal panes", () => {
    const ws = makeWs({
      t1: { id: "t1", kind: "terminal", title: "Terminal", terminalId: 1 },
      p1: makeEditorPane("p1", []),
    }, hSplit(leaf("t1"), leaf("p1")));
    expect(findFirstEditorPaneId(ws)).toBe("p1");
  });

  it("returns null when only terminal panes exist", () => {
    const ws = makeWs({
      t1: { id: "t1", kind: "terminal", title: "Terminal", terminalId: 1 },
    }, leaf("t1"));
    expect(findFirstEditorPaneId(ws)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hasDirtyFilesByPane
// ---------------------------------------------------------------------------

describe("hasDirtyFilesByPane", () => {
  it("returns false for unknown pane", () => {
    expect(hasDirtyFilesByPane(makeWs(), "nope")).toBe(false);
  });

  it("returns false when no files are dirty", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts"]) },
      leaf("p1"),
      [makeFile("a.ts")],
    );
    expect(hasDirtyFilesByPane(ws, "p1")).toBe(false);
  });

  it("returns true when at least one file is dirty", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts", "b.ts"]) },
      leaf("p1"),
      [makeFile("a.ts"), makeFile("b.ts", { dirty: true })],
    );
    expect(hasDirtyFilesByPane(ws, "p1")).toBe(true);
  });

  it("returns false for terminal pane", () => {
    const ws = makeWs({
      t1: { id: "t1", kind: "terminal", title: "Terminal", terminalId: 1 },
    }, leaf("t1"));
    expect(hasDirtyFilesByPane(ws, "t1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isFileDirty
// ---------------------------------------------------------------------------

describe("isFileDirty", () => {
  it("returns false for unknown file", () => {
    expect(isFileDirty(makeWs(), "nope.ts")).toBe(false);
  });

  it("returns false for clean file", () => {
    const f = makeFile("a.ts");
    const ws = makeWs({}, null, [f]);
    expect(isFileDirty(ws, "a.ts")).toBe(false);
  });

  it("returns true for dirty file", () => {
    const f = makeFile("a.ts", { dirty: true });
    const ws = makeWs({}, null, [f]);
    expect(isFileDirty(ws, "a.ts")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ensureEditorPane
// ---------------------------------------------------------------------------

describe("ensureEditorPane", () => {
  it("creates a new editor pane when none exists", () => {
    const ws = makeWs();
    const id = ensureEditorPane(ws);
    expect(ws.panes[id]).toBeDefined();
    expect(ws.panes[id].kind).toBe("editor");
  });

  it("returns existing pane id without mutation", () => {
    const ws = makeWs({ p1: makeEditorPane("p1", ["a.ts"]) }, leaf("p1"));
    const id = ensureEditorPane(ws, "p1");
    expect(id).toBe("p1");
    expect(ws.panes["p1"].filePaths).toEqual(["a.ts"]); // unchanged
  });

  it("sets layout to a leaf when no layout exists", () => {
    const ws = makeWs();
    ensureEditorPane(ws, "new-pane");
    expect(ws.layout).toEqual({ type: "leaf", paneId: "new-pane" });
  });

  it("wraps existing layout in a split when layout already exists", () => {
    const ws = makeWs(
      { t1: { id: "t1", kind: "terminal", title: "Terminal", terminalId: 1 } },
      leaf("t1"),
    );
    ensureEditorPane(ws, "p1");
    expect(ws.layout?.type).toBe("split");
  });

  it("initialises filePaths from argument", () => {
    const ws = makeWs();
    const id = ensureEditorPane(ws, "p1", ["a.ts", "b.ts"]);
    expect(ws.panes[id].filePaths).toEqual(["a.ts", "b.ts"]);
    expect(ws.panes[id].activeFilePath).toBe("a.ts");
  });

  it("sets activePaneId to newly created pane", () => {
    const ws = makeWs();
    const id = ensureEditorPane(ws, "p1");
    expect(ws.activePaneId).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// openFileInWorkspace
// ---------------------------------------------------------------------------

describe("openFileInWorkspace — basic open", () => {
  it("adds file to openFiles and index", () => {
    const ws = makeWs({ p1: makeEditorPane("p1", []) }, leaf("p1"), [], "p1");
    const f = makeFile("a.ts");
    openFileInWorkspace(ws, f);
    expect(ws.openFileIndex["a.ts"]).toBeDefined();
    expect(ws.openFiles.some(f => f.path === "a.ts")).toBe(true);
  });

  it("adds file path to the active pane", () => {
    const ws = makeWs({ p1: makeEditorPane("p1", []) }, leaf("p1"), [], "p1");
    openFileInWorkspace(ws, makeFile("a.ts"));
    expect(ws.panes["p1"].filePaths).toContain("a.ts");
  });

  it("sets activeFilePath on pane", () => {
    const ws = makeWs({ p1: makeEditorPane("p1", ["b.ts"]) }, leaf("p1"), [makeFile("b.ts")], "p1");
    openFileInWorkspace(ws, makeFile("a.ts"));
    expect(ws.panes["p1"].activeFilePath).toBe("a.ts");
  });

  it("creates editor pane when none exists", () => {
    const ws = makeWs();
    openFileInWorkspace(ws, makeFile("a.ts"));
    expect(Object.keys(ws.panes).length).toBeGreaterThan(0);
    const pane = Object.values(ws.panes).find(p => p.kind === "editor");
    expect(pane?.filePaths).toContain("a.ts");
  });

  it("opens into specified targetPaneId", () => {
    const ws = makeWs(
      {
        p1: makeEditorPane("p1", []),
        p2: makeEditorPane("p2", []),
      },
      hSplit(leaf("p1"), leaf("p2")),
      [],
      "p1",
    );
    openFileInWorkspace(ws, makeFile("a.ts"), "p2");
    expect(ws.panes["p2"].filePaths).toContain("a.ts");
    expect(ws.panes["p1"].filePaths).not.toContain("a.ts");
  });
});

describe("openFileInWorkspace — early return (already active)", () => {
  it("does not duplicate file when it is already active in target pane", () => {
    const f = makeFile("a.ts");
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts"], "a.ts") },
      leaf("p1"),
      [f],
      "p1",
    );
    openFileInWorkspace(ws, f);
    expect(ws.panes["p1"].filePaths!.filter(p => p === "a.ts")).toHaveLength(1);
  });

  it("promotes preview to pinned when already active but opening as non-preview", () => {
    const f = makeFile("a.ts", { preview: true });
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts"], "a.ts") },
      leaf("p1"),
      [f],
      "p1",
    );
    openFileInWorkspace(ws, { ...f, preview: false });
    expect(ws.openFileIndex["a.ts"].preview).toBe(false);
  });
});

describe("openFileInWorkspace — already open, not active", () => {
  it("does not add a second copy to openFiles", () => {
    const f = makeFile("a.ts");
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts", "b.ts"], "b.ts") },
      leaf("p1"),
      [f, makeFile("b.ts")],
      "p1",
    );
    openFileInWorkspace(ws, f);
    expect(ws.openFiles.filter(x => x.path === "a.ts")).toHaveLength(1);
  });

  it("does not downgrade pinned file to preview", () => {
    const f = makeFile("a.ts", { pinned: true });
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts", "b.ts"], "b.ts") },
      leaf("p1"),
      [f, makeFile("b.ts")],
      "p1",
    );
    // Try opening as preview — should not downgrade
    openFileInWorkspace(ws, { ...f, preview: true });
    expect(ws.openFileIndex["a.ts"].preview).toBe(false);
  });

  it("promotes existing preview to pinned when opening as non-preview", () => {
    const f = makeFile("a.ts", { preview: true });
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts", "b.ts"], "b.ts") },
      leaf("p1"),
      [f, makeFile("b.ts")],
      "p1",
    );
    openFileInWorkspace(ws, { ...f, preview: false });
    expect(ws.openFileIndex["a.ts"].preview).toBe(false);
  });
});

describe("openFileInWorkspace — preview replacement", () => {
  it("replaces existing preview tab with new preview", () => {
    const existing = makeFile("old.ts", { preview: true });
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["old.ts"], "old.ts") },
      leaf("p1"),
      [existing],
      "p1",
    );
    openFileInWorkspace(ws, makeFile("new.ts", { preview: true }));
    expect(ws.panes["p1"].filePaths).not.toContain("old.ts");
    expect(ws.panes["p1"].filePaths).toContain("new.ts");
  });

  it("removes replaced preview from openFiles when no other pane references it", () => {
    const existing = makeFile("old.ts", { preview: true });
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["old.ts"], "old.ts") },
      leaf("p1"),
      [existing],
      "p1",
    );
    openFileInWorkspace(ws, makeFile("new.ts", { preview: true }));
    expect(ws.openFiles.some(f => f.path === "old.ts")).toBe(false);
    expect(ws.openFileIndex["old.ts"]).toBeUndefined();
  });

  it("does NOT replace pinned tab with incoming preview", () => {
    const pinned = makeFile("pinned.ts", { pinned: true });
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["pinned.ts"], "pinned.ts") },
      leaf("p1"),
      [pinned],
      "p1",
    );
    openFileInWorkspace(ws, makeFile("new.ts", { preview: true }));
    // pinned.ts should still be there; new.ts appended
    expect(ws.panes["p1"].filePaths).toContain("pinned.ts");
    expect(ws.panes["p1"].filePaths).toContain("new.ts");
  });

  it("keeps replaced preview in openFiles if still referenced by another pane", () => {
    const existing = makeFile("old.ts", { preview: true });
    const ws = makeWs(
      {
        p1: makeEditorPane("p1", ["old.ts"], "old.ts"),
        p2: makeEditorPane("p2", ["old.ts"], "old.ts"),
      },
      hSplit(leaf("p1"), leaf("p2")),
      [existing],
      "p1",
    );
    openFileInWorkspace(ws, makeFile("new.ts", { preview: true }), "p1");
    // p2 still has old.ts, so it should NOT be removed from openFiles
    expect(ws.openFileIndex["old.ts"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// closeFileInWorkspace
// ---------------------------------------------------------------------------

describe("closeFileInWorkspace — basic close", () => {
  it("removes file from pane", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts", "b.ts"]) },
      leaf("p1"),
      [makeFile("a.ts"), makeFile("b.ts")],
      "p1",
    );
    closeFileInWorkspace(ws, "a.ts", "p1");
    expect(ws.panes["p1"].filePaths).not.toContain("a.ts");
  });

  it("removes file from openFiles and index when not in any other pane", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts", "b.ts"]) },
      leaf("p1"),
      [makeFile("a.ts"), makeFile("b.ts")],
      "p1",
    );
    closeFileInWorkspace(ws, "a.ts", "p1");
    expect(ws.openFileIndex["a.ts"]).toBeUndefined();
    expect(ws.openFiles.some(f => f.path === "a.ts")).toBe(false);
  });

  it("keeps file in openFiles when another pane still references it", () => {
    const ws = makeWs(
      {
        p1: makeEditorPane("p1", ["a.ts"]),
        p2: makeEditorPane("p2", ["a.ts"]),
      },
      hSplit(leaf("p1"), leaf("p2")),
      [makeFile("a.ts")],
      "p1",
    );
    closeFileInWorkspace(ws, "a.ts", "p1");
    expect(ws.openFileIndex["a.ts"]).toBeDefined();
  });
});

describe("closeFileInWorkspace — active file fallback", () => {
  it("sets activeFilePath to previous tab when closing active file", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts", "b.ts", "c.ts"], "c.ts") },
      leaf("p1"),
      [makeFile("a.ts"), makeFile("b.ts"), makeFile("c.ts")],
      "p1",
    );
    closeFileInWorkspace(ws, "c.ts", "p1");
    expect(ws.panes["p1"].activeFilePath).toBe("b.ts");
  });

  it("sets activeFilePath to first tab when closing first file", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts", "b.ts"], "a.ts") },
      leaf("p1"),
      [makeFile("a.ts"), makeFile("b.ts")],
      "p1",
    );
    closeFileInWorkspace(ws, "a.ts", "p1");
    expect(ws.panes["p1"].activeFilePath).toBe("b.ts");
  });

  it("sets activeFilePath to null when last file closed", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts"], "a.ts") },
      leaf("p1"),
      [makeFile("a.ts")],
      "p1",
    );
    closeFileInWorkspace(ws, "a.ts", "p1");
    // Pane is now empty and should be removed
    expect(ws.panes["p1"]).toBeUndefined();
  });
});

describe("closeFileInWorkspace — pane collapse", () => {
  it("removes empty pane and updates layout", () => {
    const ws = makeWs(
      {
        p1: makeEditorPane("p1", ["a.ts"]),
        p2: makeEditorPane("p2", ["b.ts"]),
      },
      hSplit(leaf("p1"), leaf("p2")),
      [makeFile("a.ts"), makeFile("b.ts")],
      "p1",
    );
    closeFileInWorkspace(ws, "a.ts", "p1");
    expect(ws.panes["p1"]).toBeUndefined();
    expect(ws.layout?.type).toBe("leaf");
    expect((ws.layout as { paneId: string }).paneId).toBe("p2");
  });

  it("sets activePaneId to sibling when active pane collapses", () => {
    const ws = makeWs(
      {
        p1: makeEditorPane("p1", ["a.ts"]),
        p2: makeEditorPane("p2", ["b.ts"]),
      },
      hSplit(leaf("p1"), leaf("p2")),
      [makeFile("a.ts"), makeFile("b.ts")],
      "p1",
    );
    closeFileInWorkspace(ws, "a.ts", "p1");
    expect(ws.activePaneId).toBe("p2");
  });

  it("sets layout and activePaneId to null when last pane closed", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts"]) },
      leaf("p1"),
      [makeFile("a.ts")],
      "p1",
    );
    closeFileInWorkspace(ws, "a.ts", "p1");
    expect(ws.layout).toBeNull();
    expect(ws.activePaneId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setActiveFileInWorkspace
// ---------------------------------------------------------------------------

describe("setActiveFileInWorkspace", () => {
  it("sets activeFilePath on active pane", () => {
    const ws = makeWs(
      { p1: makeEditorPane("p1", ["a.ts", "b.ts"], "a.ts") },
      leaf("p1"),
      [makeFile("a.ts"), makeFile("b.ts")],
      "p1",
    );
    setActiveFileInWorkspace(ws, "b.ts");
    expect(ws.panes["p1"].activeFilePath).toBe("b.ts");
  });

  it("sets activeFilePath on specified pane", () => {
    const ws = makeWs(
      {
        p1: makeEditorPane("p1", ["a.ts"], "a.ts"),
        p2: makeEditorPane("p2", ["b.ts", "c.ts"], "b.ts"),
      },
      hSplit(leaf("p1"), leaf("p2")),
      [makeFile("a.ts"), makeFile("b.ts"), makeFile("c.ts")],
      "p1",
    );
    setActiveFileInWorkspace(ws, "c.ts", "p2");
    expect(ws.panes["p2"].activeFilePath).toBe("c.ts");
    expect(ws.panes["p1"].activeFilePath).toBe("a.ts"); // unchanged
  });

  it("no-ops when activePaneId is null and no paneId given", () => {
    const ws = makeWs();
    expect(() => setActiveFileInWorkspace(ws, "a.ts")).not.toThrow();
  });

  it("no-ops for terminal pane", () => {
    const ws = makeWs(
      { t1: { id: "t1", kind: "terminal", title: "Terminal", terminalId: 1 } },
      leaf("t1"),
      [],
      "t1",
    );
    // Should not throw, and terminal pane has no activeFilePath to set
    expect(() => setActiveFileInWorkspace(ws, "a.ts", "t1")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// updateFileContent
// ---------------------------------------------------------------------------

describe("updateFileContent", () => {
  it("updates content", () => {
    const f = makeFile("a.ts");
    const ws = makeWs({}, null, [f]);
    updateFileContent(ws, "a.ts", "new content");
    expect(ws.openFileIndex["a.ts"].content).toBe("new content");
  });

  it("marks file dirty when content differs from original", () => {
    const f = makeFile("a.ts");
    const ws = makeWs({}, null, [f]);
    updateFileContent(ws, "a.ts", "changed");
    expect(ws.openFileIndex["a.ts"].dirty).toBe(true);
  });

  it("marks file clean when content restored to original", () => {
    const f = { ...makeFile("a.ts"), dirty: true, content: "changed" };
    const ws = makeWs({}, null, [f]);
    updateFileContent(ws, "a.ts", "hello"); // "hello" is originalContent from makeFile
    expect(ws.openFileIndex["a.ts"].dirty).toBe(false);
  });

  it("sets originalContent on first edit if undefined", () => {
    const f = makeFile("a.ts");
    delete (f as Record<string, unknown>)["originalContent"];
    const ws = makeWs({}, null, [f]);
    updateFileContent(ws, "a.ts", "new");
    expect(ws.openFileIndex["a.ts"].originalContent).toBe("hello");
  });

  it("promotes preview file to pinned on content change", () => {
    const f = makeFile("a.ts", { preview: true });
    const ws = makeWs({}, null, [f]);
    updateFileContent(ws, "a.ts", "edited");
    expect(ws.openFileIndex["a.ts"].preview).toBe(false);
  });

  it("no-ops for unknown file path", () => {
    const ws = makeWs();
    expect(() => updateFileContent(ws, "nope.ts", "content")).not.toThrow();
  });
});
