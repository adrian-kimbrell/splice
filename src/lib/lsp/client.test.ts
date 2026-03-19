import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../ipc/commands", () => ({
  lspStart: vi.fn().mockResolvedValue(undefined),
  lspRequest: vi.fn().mockResolvedValue(null),
  lspNotify: vi.fn().mockResolvedValue(undefined),
  lspCheck: vi.fn().mockResolvedValue(true),
  lspInstall: vi.fn().mockResolvedValue(undefined),
}));

import { LspClient } from "./client";
import * as commands from "../ipc/commands";

const mockLspStart = vi.mocked(commands.lspStart);
const mockLspRequest = vi.mocked(commands.lspRequest);
const mockLspNotify = vi.mocked(commands.lspNotify);

// ─── getLanguageId ────────────────────────────────────────────────────────────

describe("getLanguageId", () => {
  const client = new LspClient();

  it.each([
    ["/a.ts", "typescript"],
    ["/a.tsx", "typescript"],
    ["/a.js", "javascript"],
    ["/a.jsx", "javascript"],
    ["/a.rs", "rust"],
    ["/a.py", "python"],
    ["/a.html", "html"],
    ["/a.svelte", "html"],
    ["/a.css", "css"],
    ["/a.json", "json"],
  ])("%s → %s", (path, expected) => {
    expect(client.getLanguageId(path)).toBe(expected);
  });

  it("returns null for unknown extension", () => {
    expect(client.getLanguageId("/a.xyz")).toBeNull();
  });

  it("returns null for no extension", () => {
    expect(client.getLanguageId("/Makefile")).toBeNull();
  });
});

// ─── fileUri / uriToPath ──────────────────────────────────────────────────────

describe("fileUri / uriToPath", () => {
  const client = new LspClient();

  it("fileUri prepends file://", () => {
    expect(client.fileUri("/home/user/a.ts")).toBe("file:///home/user/a.ts");
  });

  it("uriToPath strips file://", () => {
    expect(client.uriToPath("file:///home/user/a.ts")).toBe("/home/user/a.ts");
  });

  it("round-trip identity", () => {
    const path = "/workspace/src/main.rs";
    expect(client.uriToPath(client.fileUri(path))).toBe(path);
  });

  it("non-file:// URI passes through unchanged", () => {
    expect(client.uriToPath("untitled:///new-file")).toBe("untitled:///new-file");
  });
});

// ─── hasSession + ensureStarted ───────────────────────────────────────────────

describe("hasSession + ensureStarted", () => {
  let client: LspClient;

  beforeEach(() => {
    client = new LspClient();
    vi.clearAllMocks();
  });

  it("hasSession returns false before any start", () => {
    expect(client.hasSession("/a.ts")).toBe(false);
  });

  it("hasSession returns true after ensureStarted resolves", async () => {
    await client.ensureStarted("typescript", "/root");
    expect(client.hasSession("/a.ts")).toBe(true);
  });

  it("concurrent ensureStarted calls deduplicate: lspStart invoked once", async () => {
    await Promise.all([
      client.ensureStarted("typescript", "/root"),
      client.ensureStarted("typescript", "/root"),
      client.ensureStarted("typescript", "/root"),
    ]);
    expect(mockLspStart).toHaveBeenCalledTimes(1);
  });

  it("second call after server is running skips lspStart entirely", async () => {
    await client.ensureStarted("typescript", "/root");
    await client.ensureStarted("typescript", "/root");
    expect(mockLspStart).toHaveBeenCalledTimes(1);
  });
});

// ─── didOpen / didChange / didClose ──────────────────────────────────────────

describe("didOpen / didChange / didClose", () => {
  let client: LspClient;

  beforeEach(async () => {
    client = new LspClient();
    vi.clearAllMocks();
    // Pre-start the server so didOpen/didChange tests don't need to worry about startup
    await client.ensureStarted("typescript", "/root");
    vi.clearAllMocks();
  });

  it("didOpen sends textDocument/didOpen with version 1", async () => {
    await client.didOpen("/src/a.ts", "hello", "/root");
    expect(mockLspNotify).toHaveBeenCalledWith(
      "typescript",
      "textDocument/didOpen",
      expect.objectContaining({
        textDocument: expect.objectContaining({ version: 1, text: "hello" }),
      }),
    );
  });

  it("didChange increments version on each call", async () => {
    await client.didOpen("/src/a.ts", "v1", "/root");
    vi.clearAllMocks();

    await client.didChange("/src/a.ts", "v2");
    expect(mockLspNotify).toHaveBeenCalledWith(
      "typescript",
      "textDocument/didChange",
      expect.objectContaining({
        textDocument: expect.objectContaining({ version: 2 }),
      }),
    );

    await client.didChange("/src/a.ts", "v3");
    expect(mockLspNotify).toHaveBeenLastCalledWith(
      "typescript",
      "textDocument/didChange",
      expect.objectContaining({
        textDocument: expect.objectContaining({ version: 3 }),
      }),
    );
  });

  it("didChange is a no-op after didClose", async () => {
    await client.didOpen("/src/a.ts", "content", "/root");
    await client.didClose("/src/a.ts");
    vi.clearAllMocks();

    await client.didChange("/src/a.ts", "new content");
    expect(mockLspNotify).not.toHaveBeenCalled();
  });

  it("didChange is a no-op before didOpen", async () => {
    await client.didChange("/src/never-opened.ts", "content");
    expect(mockLspNotify).not.toHaveBeenCalled();
  });

  it("concurrent didOpen for same file deduplicates: lspNotify called once", async () => {
    await Promise.all([
      client.didOpen("/src/a.ts", "content", "/root"),
      client.didOpen("/src/a.ts", "content", "/root"),
      client.didOpen("/src/a.ts", "content", "/root"),
    ]);
    expect(mockLspNotify).toHaveBeenCalledTimes(1);
    expect(mockLspNotify).toHaveBeenCalledWith("typescript", "textDocument/didOpen", expect.any(Object));
  });
});

// ─── gotoDefinition ──────────────────────────────────────────────────────────

describe("gotoDefinition", () => {
  let client: LspClient;

  beforeEach(() => {
    client = new LspClient();
    vi.clearAllMocks();
  });

  it("standard Location { uri, range } → LspLocation[]", async () => {
    const loc = { uri: "file:///a.ts", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } };
    mockLspRequest.mockResolvedValueOnce(loc);
    const result = await client.gotoDefinition("/src/a.ts", 0, 0);
    expect(result).toEqual([loc]);
  });

  it("LocationLink { targetUri, targetSelectionRange } → normalized LspLocation[]", async () => {
    const link = {
      targetUri: "file:///b.ts",
      targetSelectionRange: { start: { line: 5, character: 2 }, end: { line: 5, character: 10 } },
      targetRange: { start: { line: 4, character: 0 }, end: { line: 6, character: 0 } },
    };
    mockLspRequest.mockResolvedValueOnce(link);
    const result = await client.gotoDefinition("/src/a.ts", 0, 0);
    expect(result).toEqual([{ uri: "file:///b.ts", range: link.targetSelectionRange }]);
  });

  it("mixed array of Location and LocationLink → both normalized", async () => {
    const loc = { uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
    const link = {
      targetUri: "file:///b.ts",
      targetSelectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
    };
    mockLspRequest.mockResolvedValueOnce([loc, link]);
    const result = await client.gotoDefinition("/src/a.ts", 0, 0);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(loc);
    expect(result[1]).toEqual({ uri: "file:///b.ts", range: link.targetSelectionRange });
  });

  it("null result → []", async () => {
    mockLspRequest.mockResolvedValueOnce(null);
    expect(await client.gotoDefinition("/src/a.ts", 0, 0)).toEqual([]);
  });

  it("lspRequest throws → returns [] without rethrowing", async () => {
    mockLspRequest.mockRejectedValueOnce(new Error("timeout"));
    await expect(client.gotoDefinition("/src/a.ts", 0, 0)).resolves.toEqual([]);
  });
});

// ─── findReferences ───────────────────────────────────────────────────────────

describe("findReferences", () => {
  let client: LspClient;

  beforeEach(() => {
    client = new LspClient();
    vi.clearAllMocks();
  });

  it("sends context: { includeDeclaration: true }", async () => {
    mockLspRequest.mockResolvedValueOnce([]);
    await client.findReferences("/src/a.ts", 3, 5);
    expect(mockLspRequest).toHaveBeenCalledWith(
      "typescript",
      "textDocument/references",
      expect.objectContaining({ context: { includeDeclaration: true } }),
    );
  });

  it("empty result → []", async () => {
    mockLspRequest.mockResolvedValueOnce([]);
    expect(await client.findReferences("/src/a.ts", 0, 0)).toEqual([]);
  });

  it("lspRequest throws → []", async () => {
    mockLspRequest.mockRejectedValueOnce(new Error("server error"));
    await expect(client.findReferences("/src/a.ts", 0, 0)).resolves.toEqual([]);
  });
});

// ─── hover ────────────────────────────────────────────────────────────────────

describe("hover", () => {
  let client: LspClient;

  beforeEach(() => {
    client = new LspClient();
    vi.clearAllMocks();
  });

  it("plain string contents → returned as-is", async () => {
    mockLspRequest.mockResolvedValueOnce({ contents: "let x: number" });
    expect(await client.hover("/src/a.ts", { line: 0, character: 0 })).toBe("let x: number");
  });

  it("MarkupContent { kind, value } → returns .value", async () => {
    mockLspRequest.mockResolvedValueOnce({ contents: { kind: "markdown", value: "**number**" } });
    expect(await client.hover("/src/a.ts", { line: 0, character: 0 })).toBe("**number**");
  });

  it("MarkedString[] → joined with \\n---\\n", async () => {
    mockLspRequest.mockResolvedValueOnce({ contents: ["type A", { value: "type B" }] });
    expect(await client.hover("/src/a.ts", { line: 0, character: 0 })).toBe("type A\n---\ntype B");
  });

  it("null result → null", async () => {
    mockLspRequest.mockResolvedValueOnce(null);
    expect(await client.hover("/src/a.ts", { line: 0, character: 0 })).toBeNull();
  });

  it("result without .contents → null", async () => {
    mockLspRequest.mockResolvedValueOnce({});
    expect(await client.hover("/src/a.ts", { line: 0, character: 0 })).toBeNull();
  });

  it("lspRequest throws → null", async () => {
    mockLspRequest.mockRejectedValueOnce(new Error("not supported"));
    await expect(client.hover("/src/a.ts", { line: 0, character: 0 })).resolves.toBeNull();
  });
});

// ─── complete ─────────────────────────────────────────────────────────────────

describe("complete", () => {
  let client: LspClient;

  beforeEach(() => {
    client = new LspClient();
    vi.clearAllMocks();
  });

  it("array result → items returned directly", async () => {
    const items = [{ label: "foo" }, { label: "bar" }];
    mockLspRequest.mockResolvedValueOnce(items);
    expect(await client.complete("/src/a.ts", { line: 0, character: 0 })).toEqual(items);
  });

  it("CompletionList { items } → unwraps .items", async () => {
    const items = [{ label: "baz" }];
    mockLspRequest.mockResolvedValueOnce({ items });
    expect(await client.complete("/src/a.ts", { line: 0, character: 0 })).toEqual(items);
  });

  it("null result → []", async () => {
    mockLspRequest.mockResolvedValueOnce(null);
    expect(await client.complete("/src/a.ts", { line: 0, character: 0 })).toEqual([]);
  });

  it("lspRequest throws → []", async () => {
    mockLspRequest.mockRejectedValueOnce(new Error("timeout"));
    await expect(client.complete("/src/a.ts", { line: 0, character: 0 })).resolves.toEqual([]);
  });
});

// ─── prepareRename ────────────────────────────────────────────────────────────

describe("prepareRename", () => {
  let client: LspClient;

  beforeEach(() => {
    client = new LspClient();
    vi.clearAllMocks();
  });

  it("{ placeholder: 'foo' } → { placeholder: 'foo' }", async () => {
    mockLspRequest.mockResolvedValueOnce({ placeholder: "myVar" });
    expect(await client.prepareRename("/src/a.ts", 0, 0)).toEqual({ placeholder: "myVar" });
  });

  it("{ defaultBehavior: true } → { placeholder: '' }", async () => {
    mockLspRequest.mockResolvedValueOnce({ defaultBehavior: true });
    expect(await client.prepareRename("/src/a.ts", 0, 0)).toEqual({ placeholder: "" });
  });

  it("null result → null", async () => {
    mockLspRequest.mockResolvedValueOnce(null);
    expect(await client.prepareRename("/src/a.ts", 0, 0)).toBeNull();
  });

  it("lspRequest throws → null", async () => {
    mockLspRequest.mockRejectedValueOnce(new Error("not supported"));
    await expect(client.prepareRename("/src/a.ts", 0, 0)).resolves.toBeNull();
  });
});

// ─── rename ───────────────────────────────────────────────────────────────────

describe("rename", () => {
  let client: LspClient;

  beforeEach(() => {
    client = new LspClient();
    vi.clearAllMocks();
  });

  it("valid WorkspaceEdit → returned as-is", async () => {
    const edit = { changes: { "file:///a.ts": [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "newName" }] } };
    mockLspRequest.mockResolvedValueOnce(edit);
    expect(await client.rename("/src/a.ts", 0, 0, "newName")).toEqual(edit);
  });

  it("null result → null", async () => {
    mockLspRequest.mockResolvedValueOnce(null);
    expect(await client.rename("/src/a.ts", 0, 0, "newName")).toBeNull();
  });

  it("lspRequest throws → null", async () => {
    mockLspRequest.mockRejectedValueOnce(new Error("failed"));
    await expect(client.rename("/src/a.ts", 0, 0, "newName")).resolves.toBeNull();
  });
});
