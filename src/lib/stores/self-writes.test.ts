import { describe, it, expect } from "vitest";
import { markSelfWrite, wasRecentlyWrittenBySplice } from "./self-writes";

describe("self-writes", () => {
  it("a_path_written_moments_ago_is_recognised", () => {
    markSelfWrite("/a.ts", 1000);
    expect(wasRecentlyWrittenBySplice("/a.ts", 1500)).toBe(true);
  });

  it("the_mark_expires_after_the_window", () => {
    markSelfWrite("/b.ts", 1000);
    expect(wasRecentlyWrittenBySplice("/b.ts", 3001)).toBe(false);
    expect(wasRecentlyWrittenBySplice("/b.ts", 1200)).toBe(false); // expired entries are dropped
  });

  it("unknown_paths_are_external", () => {
    expect(wasRecentlyWrittenBySplice("/never.ts", 1000)).toBe(false);
  });

  it("the_table_is_bounded", () => {
    for (let i = 0; i < 600; i++) markSelfWrite(`/f${i}.ts`, 1000);
    expect(wasRecentlyWrittenBySplice("/f0.ts", 1001)).toBe(false);
    expect(wasRecentlyWrittenBySplice("/f599.ts", 1001)).toBe(true);
  });
});
