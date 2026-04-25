import { describe, it, expect } from "vitest";

// Replicate the pure findConflicts logic for testing without importing
// the full CodeMirror extension (which needs a DOM environment).

interface ConflictRegion {
  oursStart: number;
  separator: number;
  theirsEnd: number;
}

interface DocLike {
  lines: number;
  line(n: number): { text: string; from: number; to: number };
}

function findConflicts(doc: DocLike): ConflictRegion[] {
  const conflicts: ConflictRegion[] = [];
  let oursStart: number | null = null;
  let separator: number | null = null;

  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text;
    if (text.startsWith("<<<<<<<")) {
      oursStart = i;
      separator = null;
    } else if (text.startsWith("=======") && oursStart !== null) {
      separator = i;
    } else if (text.startsWith(">>>>>>>") && oursStart !== null && separator !== null) {
      conflicts.push({ oursStart, separator, theirsEnd: i });
      oursStart = null;
      separator = null;
    }
  }
  return conflicts;
}

/** Create a fake document from lines of text (1-indexed line access like CodeMirror). */
function makeDoc(text: string): DocLike {
  const lines = text.split("\n");
  let offset = 0;
  const lineInfos = lines.map((line) => {
    const from = offset;
    const to = offset + line.length;
    offset = to + 1; // +1 for newline
    return { text: line, from, to };
  });
  return {
    lines: lines.length,
    line: (n: number) => lineInfos[n - 1],
  };
}

// ---------------------------------------------------------------------------
// findConflicts
// ---------------------------------------------------------------------------

describe("findConflicts", () => {
  it("returns empty for text with no conflict markers", () => {
    const doc = makeDoc("hello\nworld\nno conflicts here");
    expect(findConflicts(doc)).toEqual([]);
  });

  it("detects a single complete conflict", () => {
    const doc = makeDoc([
      "some code",
      "<<<<<<< HEAD",
      "our version",
      "=======",
      "their version",
      ">>>>>>> branch",
      "more code",
    ].join("\n"));

    const result = findConflicts(doc);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ oursStart: 2, separator: 4, theirsEnd: 6 });
  });

  it("detects multiple conflicts", () => {
    const doc = makeDoc([
      "<<<<<<< HEAD",
      "ours1",
      "=======",
      "theirs1",
      ">>>>>>> branch",
      "gap",
      "<<<<<<< HEAD",
      "ours2",
      "=======",
      "theirs2",
      ">>>>>>> branch",
    ].join("\n"));

    const result = findConflicts(doc);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ oursStart: 1, separator: 3, theirsEnd: 5 });
    expect(result[1]).toEqual({ oursStart: 7, separator: 9, theirsEnd: 11 });
  });

  it("ignores incomplete conflict (missing >>>>>>>)", () => {
    const doc = makeDoc([
      "<<<<<<< HEAD",
      "ours",
      "=======",
      "theirs",
      "no end marker",
    ].join("\n"));

    expect(findConflicts(doc)).toEqual([]);
  });

  it("ignores incomplete conflict (missing =======)", () => {
    const doc = makeDoc([
      "<<<<<<< HEAD",
      "ours",
      ">>>>>>> branch",
    ].join("\n"));

    expect(findConflicts(doc)).toEqual([]);
  });

  it("ignores ======= without preceding <<<<<<<", () => {
    const doc = makeDoc([
      "some text",
      "=======",
      "more text",
      ">>>>>>> branch",
    ].join("\n"));

    expect(findConflicts(doc)).toEqual([]);
  });

  it("handles conflict with empty ours section", () => {
    const doc = makeDoc([
      "<<<<<<< HEAD",
      "=======",
      "their content",
      ">>>>>>> branch",
    ].join("\n"));

    const result = findConflicts(doc);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ oursStart: 1, separator: 2, theirsEnd: 4 });
  });

  it("handles conflict with empty theirs section", () => {
    const doc = makeDoc([
      "<<<<<<< HEAD",
      "our content",
      "=======",
      ">>>>>>> branch",
    ].join("\n"));

    const result = findConflicts(doc);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ oursStart: 1, separator: 3, theirsEnd: 4 });
  });

  it("handles conflict with both sections empty", () => {
    const doc = makeDoc([
      "<<<<<<< HEAD",
      "=======",
      ">>>>>>> branch",
    ].join("\n"));

    const result = findConflicts(doc);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ oursStart: 1, separator: 2, theirsEnd: 3 });
  });

  it("handles markers with extra text after them", () => {
    const doc = makeDoc([
      "<<<<<<< HEAD (some info)",
      "our content",
      "======= separator text",
      "their content",
      ">>>>>>> feature/branch-name",
    ].join("\n"));

    const result = findConflicts(doc);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ oursStart: 1, separator: 3, theirsEnd: 5 });
  });

  it("handles multi-line ours and theirs sections", () => {
    const doc = makeDoc([
      "<<<<<<< HEAD",
      "line 1 ours",
      "line 2 ours",
      "line 3 ours",
      "=======",
      "line 1 theirs",
      "line 2 theirs",
      ">>>>>>> branch",
    ].join("\n"));

    const result = findConflicts(doc);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ oursStart: 1, separator: 5, theirsEnd: 8 });
  });

  it("resets state if a new <<<<<<< appears before closing the previous one", () => {
    const doc = makeDoc([
      "<<<<<<< HEAD",
      "ours1",
      "<<<<<<< HEAD",
      "ours2",
      "=======",
      "theirs2",
      ">>>>>>> branch",
    ].join("\n"));

    const result = findConflicts(doc);
    // The second <<<<<<< resets, so only the second conflict is detected
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ oursStart: 3, separator: 5, theirsEnd: 7 });
  });
});
