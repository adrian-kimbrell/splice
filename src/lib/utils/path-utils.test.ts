import { describe, it, expect } from "vitest";
import { isUnderRoot, toUiPath } from "./path-utils";

describe("toUiPath", () => {
  it("leaves a posix path untouched", () => {
    expect(toUiPath("/Users/dev/proj/src/index.ts")).toBe("/Users/dev/proj/src/index.ts");
  });

  it("converts a Windows path to forward slashes", () => {
    expect(toUiPath("C:\\Users\\dev\\proj\\src\\index.ts")).toBe(
      "C:/Users/dev/proj/src/index.ts",
    );
  });

  it("strips the extended-length prefix canonicalize adds", () => {
    expect(toUiPath("\\\\?\\C:\\Users\\dev\\proj")).toBe("C:/Users/dev/proj");
  });

  it("restores a UNC path's leading slashes", () => {
    expect(toUiPath("\\\\?\\UNC\\server\\share\\file.ts")).toBe("//server/share/file.ts");
  });
});

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

  // --- Windows: a backslash path must still match its own root ---
  it("matches a Windows file against its Windows root", () => {
    expect(isUnderRoot("C:\\dev\\myapp\\src\\index.ts", "C:\\dev\\myapp")).toBe(true);
  });

  it("matches across separator styles (dialog path vs normalized root)", () => {
    expect(isUnderRoot("C:\\dev\\myapp\\src\\index.ts", "C:/dev/myapp")).toBe(true);
  });

  it("still rejects a Windows sibling sharing a prefix", () => {
    expect(isUnderRoot("C:\\dev\\myapp-v2\\src\\index.ts", "C:\\dev\\myapp")).toBe(false);
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
