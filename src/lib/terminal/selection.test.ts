import { describe, it, expect } from "vitest";
import { isWordBreak, wordRangeAt, joinSelectedLines } from "./selection";
import { makeFrame } from "./protocol.test";

describe("word selection", () => {
  it("treats whitespace, controls and delimiters as breaks", () => {
    expect(isWordBreak(32)).toBe(true);
    expect(isWordBreak(0)).toBe(true);
    expect(isWordBreak("(".charCodeAt(0))).toBe(true);
    expect(isWordBreak("a".charCodeAt(0))).toBe(false);
    expect(isWordBreak("-".charCodeAt(0))).toBe(false);
  });

  it("selects the word around the cell on one row", () => {
    const f = makeFrame(["foo bar baz"]);
    expect(wordRangeAt(f, 0, 5)).toEqual({ startRow: 0, startCol: 4, endRow: 0, endCol: 6 });
  });

  it("follows a soft-wrapped word onto the neighbouring rows", () => {
    // Row 0 ends mid-word (no trailing blank) and row 1 starts with its tail.
    const f = makeFrame(["xx long", "word yy"]);
    expect(wordRangeAt(f, 0, 4)).toEqual({ startRow: 0, startCol: 3, endRow: 1, endCol: 3 });
    expect(wordRangeAt(f, 1, 1)).toEqual({ startRow: 0, startCol: 3, endRow: 1, endCol: 3 });
  });

  it("stops at a row edge that is a break", () => {
    const f = makeFrame(["abc    ", "def    "]);
    expect(wordRangeAt(f, 1, 0)).toEqual({ startRow: 1, startCol: 0, endRow: 1, endCol: 2 });
  });

  it("returns null for a buffer with no header", () => {
    expect(wordRangeAt(new Uint8Array(3), 0, 0)).toBeNull();
  });
});

describe("joinSelectedLines", () => {
  it("slices a single line by column and trims the end", () => {
    expect(joinSelectedLines(["hello world   "], 6, 10)).toBe("world");
    expect(joinSelectedLines(["hello world"], 10, 6)).toBe("world"); // reversed drag
  });

  it("joins soft-wrapped lines without a newline and hard-wrapped ones with", () => {
    const lines = ["first line wraps-", "here and ends   ", "last"];
    expect(joinSelectedLines(lines, 6, 1)).toBe("line wraps-here and ends\nla");
  });

  it("drops trailing newlines", () => {
    expect(joinSelectedLines(["a ", "  "], 0, 1)).toBe("a");
  });
});
