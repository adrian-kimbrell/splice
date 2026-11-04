import { describe, it, expect } from "vitest";
import { encodePaste } from "./paste";

describe("encodePaste", () => {
  const dec = new TextDecoder();
  it("passes text through when bracketed paste is off", () => {
    expect(dec.decode(encodePaste("ls -la\n", false))).toBe("ls -la\n");
  });
  it("wraps text in the bracketed-paste markers when on", () => {
    expect(dec.decode(encodePaste("ls", true))).toBe("\x1b[200~ls\x1b[201~");
  });
  it("keeps multi-byte characters intact", () => {
    expect(dec.decode(encodePaste("héllo →", true))).toBe("\x1b[200~héllo →\x1b[201~");
  });
});
