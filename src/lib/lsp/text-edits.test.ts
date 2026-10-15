import { describe, it, expect } from "vitest";
import { applyTextEdits } from "./text-edits";

const edit = (sl: number, sc: number, el: number, ec: number, newText: string) => ({
  range: { start: { line: sl, character: sc }, end: { line: el, character: ec } },
  newText,
});

describe("applyTextEdits", () => {
  it("renames_two_occurrences_on_the_same_line", () => {
    // Applying in document order would shift the second edit's offsets.
    const out = applyTextEdits("foo(foo);\n", [edit(0, 0, 0, 3, "bar"), edit(0, 4, 0, 7, "bar")]);
    expect(out).toBe("bar(bar);\n");
  });

  it("handles_a_multi_line_range", () => {
    const src = "a\nb\nc\nd";
    expect(applyTextEdits(src, [edit(1, 0, 2, 1, "X")])).toBe("a\nX\nd");
  });

  it("applies_edits_on_different_lines_regardless_of_order", () => {
    const src = "one\ntwo\nthree";
    const out = applyTextEdits(src, [edit(0, 0, 0, 3, "1"), edit(2, 0, 2, 5, "3"), edit(1, 0, 1, 3, "2")]);
    expect(out).toBe("1\n2\n3");
  });

  it("inserts_at_a_point", () => {
    expect(applyTextEdits("ab", [edit(0, 1, 0, 1, "-")])).toBe("a-b");
  });

  it("clamps_positions_past_the_end_of_line_or_document", () => {
    expect(applyTextEdits("ab\ncd", [edit(0, 10, 0, 20, "!")])).toBe("ab!\ncd");
    expect(applyTextEdits("ab", [edit(5, 0, 9, 0, "!")])).toBe("ab!");
  });

  it("counts_characters_in_utf16_code_units_like_lsp", () => {
    const src = "\u{1F600}x"; // emoji is 2 code units
    expect(applyTextEdits(src, [edit(0, 2, 0, 3, "y")])).toBe("\u{1F600}y");
  });

  it("no_edits_returns_the_input", () => {
    expect(applyTextEdits("same", [])).toBe("same");
  });
});
