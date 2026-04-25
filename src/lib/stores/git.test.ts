import { describe, it, expect } from "vitest";

// We can't import the reactive store directly (needs Svelte runes runtime),
// so we test the pure logic functions by extracting and testing them inline.
// The git store exports charToStatus, higherPriority, buildDirStatusMap indirectly.
// We'll replicate the logic here and test it.

type GitStatusKind = "modified" | "added" | "deleted" | "untracked" | "renamed" | "conflict" | "clean";

const STATUS_PRIORITY: Record<GitStatusKind, number> = {
  clean: 0,
  untracked: 1,
  added: 2,
  renamed: 3,
  modified: 4,
  deleted: 5,
  conflict: 6,
};

function charToStatus(c: string): GitStatusKind {
  switch (c) {
    case "M": return "modified";
    case "A": return "added";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "added";
    case "U": return "conflict";
    case "?": return "untracked";
    default: return "clean";
  }
}

function higherPriority(a: GitStatusKind, b: GitStatusKind): GitStatusKind {
  return STATUS_PRIORITY[a] >= STATUS_PRIORITY[b] ? a : b;
}

function buildDirStatusMap(statusMap: Map<string, GitStatusKind>, rootPath: string): Map<string, GitStatusKind> {
  const dirMap = new Map<string, GitStatusKind>();
  for (const [filePath, status] of statusMap) {
    let dir = filePath.substring(0, filePath.lastIndexOf("/"));
    while (dir.length >= rootPath.length) {
      const existing = dirMap.get(dir);
      if (existing) {
        dirMap.set(dir, higherPriority(existing, status));
      } else {
        dirMap.set(dir, status);
      }
      const nextSlash = dir.lastIndexOf("/");
      if (nextSlash < 0) break;
      dir = dir.substring(0, nextSlash);
    }
  }
  return dirMap;
}

// ---------------------------------------------------------------------------
// charToStatus
// ---------------------------------------------------------------------------

describe("charToStatus", () => {
  it("maps M to modified", () => {
    expect(charToStatus("M")).toBe("modified");
  });

  it("maps A to added", () => {
    expect(charToStatus("A")).toBe("added");
  });

  it("maps D to deleted", () => {
    expect(charToStatus("D")).toBe("deleted");
  });

  it("maps R to renamed", () => {
    expect(charToStatus("R")).toBe("renamed");
  });

  it("maps C (copied) to added", () => {
    expect(charToStatus("C")).toBe("added");
  });

  it("maps U to conflict", () => {
    expect(charToStatus("U")).toBe("conflict");
  });

  it("maps ? to untracked", () => {
    expect(charToStatus("?")).toBe("untracked");
  });

  it("maps space to clean", () => {
    expect(charToStatus(" ")).toBe("clean");
  });

  it("maps unknown characters to clean", () => {
    expect(charToStatus("X")).toBe("clean");
    expect(charToStatus("!")).toBe("clean");
  });
});

// ---------------------------------------------------------------------------
// higherPriority
// ---------------------------------------------------------------------------

describe("higherPriority", () => {
  it("conflict beats everything", () => {
    expect(higherPriority("conflict", "modified")).toBe("conflict");
    expect(higherPriority("conflict", "deleted")).toBe("conflict");
    expect(higherPriority("modified", "conflict")).toBe("conflict");
  });

  it("deleted beats modified", () => {
    expect(higherPriority("deleted", "modified")).toBe("deleted");
    expect(higherPriority("modified", "deleted")).toBe("deleted");
  });

  it("modified beats added", () => {
    expect(higherPriority("modified", "added")).toBe("modified");
    expect(higherPriority("added", "modified")).toBe("modified");
  });

  it("added beats untracked", () => {
    expect(higherPriority("added", "untracked")).toBe("added");
    expect(higherPriority("untracked", "added")).toBe("added");
  });

  it("untracked beats clean", () => {
    expect(higherPriority("untracked", "clean")).toBe("untracked");
    expect(higherPriority("clean", "untracked")).toBe("untracked");
  });

  it("same status returns itself", () => {
    expect(higherPriority("modified", "modified")).toBe("modified");
    expect(higherPriority("clean", "clean")).toBe("clean");
  });
});

// ---------------------------------------------------------------------------
// buildDirStatusMap
// ---------------------------------------------------------------------------

describe("buildDirStatusMap", () => {
  const ROOT = "/home/user/project";

  it("returns empty map for empty input", () => {
    const statusMap = new Map<string, GitStatusKind>();
    const result = buildDirStatusMap(statusMap, ROOT);
    expect(result.size).toBe(0);
  });

  it("assigns status to parent directory", () => {
    const statusMap = new Map<string, GitStatusKind>([
      ["/home/user/project/src/main.rs", "modified"],
    ]);
    const result = buildDirStatusMap(statusMap, ROOT);
    expect(result.get("/home/user/project/src")).toBe("modified");
    expect(result.get("/home/user/project")).toBe("modified");
  });

  it("propagates to all ancestor directories up to root", () => {
    const statusMap = new Map<string, GitStatusKind>([
      ["/home/user/project/src/lib/utils.ts", "added"],
    ]);
    const result = buildDirStatusMap(statusMap, ROOT);
    expect(result.get("/home/user/project/src/lib")).toBe("added");
    expect(result.get("/home/user/project/src")).toBe("added");
    expect(result.get("/home/user/project")).toBe("added");
  });

  it("does not propagate above root", () => {
    const statusMap = new Map<string, GitStatusKind>([
      ["/home/user/project/file.txt", "modified"],
    ]);
    const result = buildDirStatusMap(statusMap, ROOT);
    expect(result.has("/home/user")).toBe(false);
    expect(result.has("/home")).toBe(false);
  });

  it("merges multiple children using highest priority", () => {
    const statusMap = new Map<string, GitStatusKind>([
      ["/home/user/project/src/a.ts", "untracked"],
      ["/home/user/project/src/b.ts", "modified"],
    ]);
    const result = buildDirStatusMap(statusMap, ROOT);
    expect(result.get("/home/user/project/src")).toBe("modified");
  });

  it("handles files in different subdirectories", () => {
    const statusMap = new Map<string, GitStatusKind>([
      ["/home/user/project/src/a.ts", "added"],
      ["/home/user/project/test/b.ts", "deleted"],
    ]);
    const result = buildDirStatusMap(statusMap, ROOT);
    expect(result.get("/home/user/project/src")).toBe("added");
    expect(result.get("/home/user/project/test")).toBe("deleted");
    // Root gets the highest: deleted > added
    expect(result.get("/home/user/project")).toBe("deleted");
  });

  it("deeply nested file propagates through all levels", () => {
    const statusMap = new Map<string, GitStatusKind>([
      ["/home/user/project/a/b/c/d/file.rs", "conflict"],
    ]);
    const result = buildDirStatusMap(statusMap, ROOT);
    expect(result.get("/home/user/project/a/b/c/d")).toBe("conflict");
    expect(result.get("/home/user/project/a/b/c")).toBe("conflict");
    expect(result.get("/home/user/project/a/b")).toBe("conflict");
    expect(result.get("/home/user/project/a")).toBe("conflict");
    expect(result.get("/home/user/project")).toBe("conflict");
  });
});

// ---------------------------------------------------------------------------
// Porcelain v1 status parsing (integration logic)
// ---------------------------------------------------------------------------

describe("git status porcelain parsing", () => {
  // Simulate the parse logic from git.rs / git.svelte.ts
  interface GitFileStatus {
    path: string;
    index_status: string;
    worktree_status: string;
  }

  function parseGitStatusLine(line: string): GitFileStatus | null {
    if (line.length < 4) return null;
    const index_status = line[0];
    const worktree_status = line[1];
    let filePath = line.slice(3);
    // Handle renames
    const arrowPos = filePath.indexOf(" -> ");
    if (arrowPos !== -1) {
      filePath = filePath.slice(arrowPos + 4);
    }
    return { path: filePath, index_status, worktree_status };
  }

  function categorize(files: GitFileStatus[]) {
    const staged: GitFileStatus[] = [];
    const unstaged: GitFileStatus[] = [];
    const untracked: GitFileStatus[] = [];
    for (const file of files) {
      if (file.index_status === "?" && file.worktree_status === "?") {
        untracked.push(file);
      } else {
        if (file.index_status !== " " && file.index_status !== "?") staged.push(file);
        if (file.worktree_status !== " " && file.worktree_status !== "?") unstaged.push(file);
      }
    }
    return { staged, unstaged, untracked };
  }

  it("parses modified file in working tree", () => {
    const result = parseGitStatusLine(" M src/main.rs");
    expect(result).toEqual({ path: "src/main.rs", index_status: " ", worktree_status: "M" });
  });

  it("parses staged added file", () => {
    const result = parseGitStatusLine("A  new_file.txt");
    expect(result).toEqual({ path: "new_file.txt", index_status: "A", worktree_status: " " });
  });

  it("parses untracked file", () => {
    const result = parseGitStatusLine("?? untracked.txt");
    expect(result).toEqual({ path: "untracked.txt", index_status: "?", worktree_status: "?" });
  });

  it("parses staged and modified file (both columns)", () => {
    const result = parseGitStatusLine("MM both.ts");
    expect(result).toEqual({ path: "both.ts", index_status: "M", worktree_status: "M" });
  });

  it("parses deleted file in working tree", () => {
    const result = parseGitStatusLine(" D gone.txt");
    expect(result).toEqual({ path: "gone.txt", index_status: " ", worktree_status: "D" });
  });

  it("parses renamed file (extracts new path)", () => {
    const result = parseGitStatusLine("R  old.txt -> new.txt");
    expect(result).toEqual({ path: "new.txt", index_status: "R", worktree_status: " " });
  });

  it("handles file path with spaces", () => {
    const result = parseGitStatusLine(" M src/my file.ts");
    expect(result).toEqual({ path: "src/my file.ts", index_status: " ", worktree_status: "M" });
  });

  it("skips short lines", () => {
    expect(parseGitStatusLine("")).toBeNull();
    expect(parseGitStatusLine("AB")).toBeNull();
    expect(parseGitStatusLine("ABC")).toBeNull();
  });

  it("correctly categorizes staged files", () => {
    const files: GitFileStatus[] = [
      { path: "staged.ts", index_status: "M", worktree_status: " " },
    ];
    const { staged, unstaged, untracked } = categorize(files);
    expect(staged).toHaveLength(1);
    expect(unstaged).toHaveLength(0);
    expect(untracked).toHaveLength(0);
  });

  it("correctly categorizes unstaged files", () => {
    const files: GitFileStatus[] = [
      { path: "dirty.ts", index_status: " ", worktree_status: "M" },
    ];
    const { staged, unstaged, untracked } = categorize(files);
    expect(staged).toHaveLength(0);
    expect(unstaged).toHaveLength(1);
    expect(untracked).toHaveLength(0);
  });

  it("correctly categorizes untracked files", () => {
    const files: GitFileStatus[] = [
      { path: "new.txt", index_status: "?", worktree_status: "?" },
    ];
    const { staged, unstaged, untracked } = categorize(files);
    expect(staged).toHaveLength(0);
    expect(unstaged).toHaveLength(0);
    expect(untracked).toHaveLength(1);
  });

  it("file can appear in both staged and unstaged", () => {
    const files: GitFileStatus[] = [
      { path: "both.ts", index_status: "M", worktree_status: "M" },
    ];
    const { staged, unstaged, untracked } = categorize(files);
    expect(staged).toHaveLength(1);
    expect(unstaged).toHaveLength(1);
    expect(untracked).toHaveLength(0);
  });

  it("categorizes a mixed set correctly", () => {
    const files: GitFileStatus[] = [
      { path: "staged.ts", index_status: "A", worktree_status: " " },
      { path: "dirty.ts", index_status: " ", worktree_status: "M" },
      { path: "both.ts", index_status: "M", worktree_status: "M" },
      { path: "new.txt", index_status: "?", worktree_status: "?" },
      { path: "deleted.rs", index_status: "D", worktree_status: " " },
    ];
    const { staged, unstaged, untracked } = categorize(files);
    expect(staged).toHaveLength(3); // A, M, D in index
    expect(unstaged).toHaveLength(2); // M, M in worktree
    expect(untracked).toHaveLength(1); // ??
  });
});
