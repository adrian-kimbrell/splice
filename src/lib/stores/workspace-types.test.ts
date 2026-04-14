import { describe, it, expect } from "vitest";
import {
  findFirstLeaf,
  remapLayout,
  nextUntitledPath,
  frontendToRustLayout,
  applyFileRename,
  markFileSaved,
} from "./workspace-types";
import type { LayoutNode } from "./layout.svelte";
import type { Workspace } from "./workspace-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOpenFile(path: string, opts: { dirty?: boolean; preview?: boolean } = {}) {
  return {
    name: path.split("/").pop()!,
    path,
    content: "hello",
    originalContent: "hello",
    dirty: opts.dirty ?? false,
    preview: opts.preview ?? false,
  };
}

function makeWs(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1",
    name: "test",
    rootPath: "/tmp",
    fileTree: [],
    openFiles: [],
    openFileIndex: {},
    terminalIds: [],
    activeTerminalId: null,
    layout: null,
    panes: {},
    activePaneId: null,
    gitBranch: "",
    explorerVisible: true,
    expandedPaths: new Set(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// findFirstLeaf
// ---------------------------------------------------------------------------

describe("findFirstLeaf", () => {
  it("returns null for null input", () => {
    expect(findFirstLeaf(null)).toBeNull();
  });

  it("returns paneId for a leaf node", () => {
    expect(findFirstLeaf({ type: "leaf", paneId: "p1" })).toBe("p1");
  });

  it("returns leftmost leaf in a split", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      children: [
        { type: "leaf", paneId: "left" },
        { type: "leaf", paneId: "right" },
      ],
    };
    expect(findFirstLeaf(tree)).toBe("left");
  });

  it("recurses into nested splits to find leftmost leaf", () => {
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
            { type: "leaf", paneId: "deep-left" },
            { type: "leaf", paneId: "deep-right" },
          ],
        },
        { type: "leaf", paneId: "outer-right" },
      ],
    };
    expect(findFirstLeaf(tree)).toBe("deep-left");
  });
});

// ---------------------------------------------------------------------------
// remapLayout
// ---------------------------------------------------------------------------

describe("remapLayout", () => {
  it("converts a Leaf node (snake_case)", () => {
    const idMap = new Map([["saved-p1", "frontend-p1"]]);
    const result = remapLayout({ type: "Leaf", pane_id: "saved-p1" }, idMap);
    expect(result).toEqual({ type: "leaf", paneId: "frontend-p1" });
  });

  it("uses original pane_id when not in idMap", () => {
    const result = remapLayout({ type: "Leaf", pane_id: "unknown" }, new Map());
    expect(result).toEqual({ type: "leaf", paneId: "unknown" });
  });

  it("converts a Split node", () => {
    const idMap = new Map([["a", "pa"], ["b", "pb"]]);
    const raw = {
      type: "Split",
      direction: "Horizontal",
      ratio: 0.6,
      children: [
        { type: "Leaf", pane_id: "a" },
        { type: "Leaf", pane_id: "b" },
      ],
    };
    const result = remapLayout(raw, idMap);
    expect(result.type).toBe("split");
    if (result.type === "split") {
      expect(result.direction).toBe("horizontal");
      expect(result.ratio).toBe(0.6);
      expect(result.children[0]).toEqual({ type: "leaf", paneId: "pa" });
      expect(result.children[1]).toEqual({ type: "leaf", paneId: "pb" });
    }
  });

  it("converts Vertical direction", () => {
    const raw = {
      type: "Split",
      direction: "Vertical",
      ratio: 0.5,
      children: [
        { type: "Leaf", pane_id: "a" },
        { type: "Leaf", pane_id: "b" },
      ],
    };
    const result = remapLayout(raw, new Map());
    if (result.type === "split") {
      expect(result.direction).toBe("vertical");
    }
  });

  it("throws when depth exceeds MAX_SPLIT_DEPTH", () => {
    // Build a 11-level deep raw object
    let node: unknown = { type: "Leaf", pane_id: "p" };
    for (let i = 0; i < 11; i++) {
      node = { type: "Split", direction: "Horizontal", ratio: 0.5, children: [node, { type: "Leaf", pane_id: "q" }] };
    }
    expect(() => remapLayout(node, new Map())).toThrow("Layout depth exceeds maximum");
  });

  it("handles malformed split (missing children) gracefully", () => {
    const idMap = new Map([["a", "pa"]]);
    const raw = { type: "Split", direction: "Horizontal", ratio: 0.5, children: [{ type: "Leaf", pane_id: "a" }] };
    // Only 1 child — should fall back to a leaf
    const result = remapLayout(raw, idMap);
    expect(result.type).toBe("leaf");
  });
});

// ---------------------------------------------------------------------------
// frontendToRustLayout
// ---------------------------------------------------------------------------

describe("frontendToRustLayout", () => {
  it("serializes a leaf", () => {
    const result = frontendToRustLayout({ type: "leaf", paneId: "p1" });
    expect(result).toEqual({ type: "Leaf", pane_id: "p1" });
  });

  it("serializes a horizontal split", () => {
    const node: LayoutNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.4,
      children: [
        { type: "leaf", paneId: "A" },
        { type: "leaf", paneId: "B" },
      ],
    };
    expect(frontendToRustLayout(node)).toEqual({
      type: "Split",
      direction: "Horizontal",
      ratio: 0.4,
      children: [
        { type: "Leaf", pane_id: "A" },
        { type: "Leaf", pane_id: "B" },
      ],
    });
  });

  it("serializes a vertical split", () => {
    const node: LayoutNode = {
      type: "split",
      direction: "vertical",
      ratio: 0.5,
      children: [
        { type: "leaf", paneId: "A" },
        { type: "leaf", paneId: "B" },
      ],
    };
    const result = frontendToRustLayout(node) as { direction: string };
    expect(result.direction).toBe("Vertical");
  });

  it("round-trips through remapLayout", () => {
    const original: LayoutNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      children: [
        { type: "leaf", paneId: "p1" },
        { type: "leaf", paneId: "p2" },
      ],
    };
    const rust = frontendToRustLayout(original);
    const idMap = new Map([["p1", "p1"], ["p2", "p2"]]);
    const roundTripped = remapLayout(rust, idMap);
    expect(roundTripped).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// nextUntitledPath
// ---------------------------------------------------------------------------

describe("nextUntitledPath", () => {
  it("returns untitled-1 when no open files", () => {
    const ws = makeWs();
    expect(nextUntitledPath(ws)).toBe("untitled-1");
  });

  it("returns untitled-2 when untitled-1 is open", () => {
    const f = makeOpenFile("untitled-1");
    const ws = makeWs({ openFiles: [f], openFileIndex: { "untitled-1": f } });
    expect(nextUntitledPath(ws)).toBe("untitled-2");
  });

  it("returns max+1 for non-contiguous numbers", () => {
    const files = [makeOpenFile("untitled-1"), makeOpenFile("untitled-3")];
    const ws = makeWs({
      openFiles: files,
      openFileIndex: Object.fromEntries(files.map(f => [f.path, f])),
    });
    expect(nextUntitledPath(ws)).toBe("untitled-4");
  });

  it("ignores non-untitled files", () => {
    const files = [makeOpenFile("main.ts"), makeOpenFile("untitled-2")];
    const ws = makeWs({
      openFiles: files,
      openFileIndex: Object.fromEntries(files.map(f => [f.path, f])),
    });
    expect(nextUntitledPath(ws)).toBe("untitled-3");
  });
});

// ---------------------------------------------------------------------------
// applyFileRename
// ---------------------------------------------------------------------------

describe("applyFileRename", () => {
  it("updates path and name on the file object", () => {
    const file = makeOpenFile("/tmp/old.ts");
    const ws = makeWs({
      openFiles: [file],
      openFileIndex: { "/tmp/old.ts": file },
      panes: {},
    });
    applyFileRename(ws, file, "/tmp/old.ts", "/tmp/new.ts");
    expect(file.path).toBe("/tmp/new.ts");
    expect(file.name).toBe("new.ts");
  });

  it("re-keys openFileIndex", () => {
    const file = makeOpenFile("/tmp/old.ts");
    const ws = makeWs({
      openFiles: [file],
      openFileIndex: { "/tmp/old.ts": file },
      panes: {},
    });
    applyFileRename(ws, file, "/tmp/old.ts", "/tmp/new.ts");
    expect(ws.openFileIndex["/tmp/old.ts"]).toBeUndefined();
    expect(ws.openFileIndex["/tmp/new.ts"]).toBe(file);
  });

  it("updates filePaths in editor panes", () => {
    const file = makeOpenFile("/tmp/old.ts");
    const ws = makeWs({
      openFiles: [file],
      openFileIndex: { "/tmp/old.ts": file },
      panes: {
        p1: { id: "p1", kind: "editor", title: "Editor", filePaths: ["/tmp/old.ts", "/tmp/other.ts"], activeFilePath: "/tmp/old.ts" },
      },
    });
    applyFileRename(ws, file, "/tmp/old.ts", "/tmp/new.ts");
    expect(ws.panes["p1"].filePaths).toContain("/tmp/new.ts");
    expect(ws.panes["p1"].filePaths).not.toContain("/tmp/old.ts");
    expect(ws.panes["p1"].activeFilePath).toBe("/tmp/new.ts");
  });

  it("leaves unrelated pane files untouched", () => {
    const file = makeOpenFile("/tmp/old.ts");
    const ws = makeWs({
      openFiles: [file],
      openFileIndex: { "/tmp/old.ts": file },
      panes: {
        p1: { id: "p1", kind: "editor", title: "Editor", filePaths: ["/tmp/other.ts"], activeFilePath: "/tmp/other.ts" },
      },
    });
    applyFileRename(ws, file, "/tmp/old.ts", "/tmp/new.ts");
    expect(ws.panes["p1"].filePaths).toEqual(["/tmp/other.ts"]);
  });
});

// ---------------------------------------------------------------------------
// markFileSaved
// ---------------------------------------------------------------------------

describe("markFileSaved", () => {
  it("clears dirty flag", () => {
    const file = { ...makeOpenFile("a.ts"), dirty: true, content: "new", originalContent: "old" };
    markFileSaved(file);
    expect(file.dirty).toBe(false);
  });

  it("sets originalContent to current content", () => {
    const file = { ...makeOpenFile("a.ts"), content: "new content", originalContent: "old content" };
    markFileSaved(file);
    expect(file.originalContent).toBe("new content");
  });

  it("clears preview flag", () => {
    const file = { ...makeOpenFile("a.ts"), preview: true };
    markFileSaved(file);
    expect(file.preview).toBe(false);
  });

  it("no-ops preview when already false", () => {
    const file = { ...makeOpenFile("a.ts"), preview: false };
    markFileSaved(file);
    expect(file.preview).toBe(false);
  });
});
