import { describe, it, expect } from "vitest";
import { isUnderRoot } from "./path-utils";

describe("isUnderRoot", () => {
  // --- basic matches ---
  it("exact match returns true", () => {
    expect(isUnderRoot("/a/b", "/a/b")).toBe(true);
  });

  it("file inside root returns true", () => {
    expect(isUnderRoot("/a/b/file.ts", "/a/b")).toBe(true);
  });

  it("nested dir inside root returns true", () => {
    expect(isUnderRoot("/a/b/c/d/file.ts", "/a/b")).toBe(true);
  });

  it("root with trailing slash still matches", () => {
    expect(isUnderRoot("/a/b/file.ts", "/a/b/")).toBe(true);
  });

  // --- critical: sibling-prefix false-positive ---
  it("sibling dir sharing prefix does NOT match", () => {
    // /a/bc is NOT inside /a/b — this was the bug with plain startsWith
    expect(isUnderRoot("/a/bc/file.ts", "/a/b")).toBe(false);
  });

  it("parent dir does not match child root", () => {
    expect(isUnderRoot("/a", "/a/b")).toBe(false);
  });

  it("unrelated path does not match", () => {
    expect(isUnderRoot("/x/y/z", "/a/b")).toBe(false);
  });

  it("empty string changedPath does not match non-empty root", () => {
    expect(isUnderRoot("", "/a/b")).toBe(false);
  });

  // --- real-world workspace paths ---
  it("matches typical workspace file change", () => {
    expect(
      isUnderRoot(
        "/Users/dev/projects/myapp/src/index.ts",
        "/Users/dev/projects/myapp"
      )
    ).toBe(true);
  });

  it("does not match workspace with same name prefix", () => {
    expect(
      isUnderRoot(
        "/Users/dev/projects/myapp-v2/src/index.ts",
        "/Users/dev/projects/myapp"
      )
    ).toBe(false);
  });
});
