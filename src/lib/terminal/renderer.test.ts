import { describe, it, expect, beforeEach } from "vitest";
import { TerminalRenderer, HEADER_SIZE, CELL_SIZE } from "./renderer";

// Unit tests for the canvas terminal renderer, driven by hand-built binary
// frames (format: src-tauri/src/terminal/emitter.rs) against a recording 2D
// context. happy-dom has no real canvas, so the context is a stub that logs
// every draw call; the assertions are about *what* gets painted and when the
// dirty-rect optimisation skips work, not about pixels.

// ---- Recording 2D context -------------------------------------------------

type Call = { op: string; args: unknown[]; fillStyle: string; font: string };

class FakeCtx {
  calls: Call[] = [];
  fillStyle = "";
  strokeStyle = "";
  font = "";
  textBaseline = "";
  globalAlpha = 1;
  lineWidth = 1;
  private rec(op: string, ...args: unknown[]) {
    this.calls.push({ op, args, fillStyle: this.fillStyle, font: this.font });
  }
  setTransform(..._a: unknown[]) {}
  measureText(s: string) {
    // "W" → cell width 8; descender probe → modest descent so cellHeight = ceil(1.2 * fontSize)
    return { width: s === "W" ? 8 : 8 * s.length, actualBoundingBoxDescent: 3 } as TextMetrics;
  }
  fillRect(x: number, y: number, w: number, h: number) { this.rec("fillRect", x, y, w, h); }
  fillText(t: string, x: number, y: number) { this.rec("fillText", t, x, y); }
  strokeRect(x: number, y: number, w: number, h: number) { this.rec("strokeRect", x, y, w, h); }
  ops(op: string) { return this.calls.filter(c => c.op === op); }
  reset() { this.calls = []; }
}

function makeCanvas(ctx: FakeCtx): HTMLCanvasElement {
  return {
    width: 0,
    height: 0,
    style: {} as CSSStyleDeclaration,
    getContext: () => ctx as unknown as CanvasRenderingContext2D,
  } as unknown as HTMLCanvasElement;
}

// ---- Frame builder --------------------------------------------------------

interface CellSpec {
  ch?: string;
  fg?: [number, number, number];
  bg?: [number, number, number];
  flags?: number;
  width?: number;
}

interface FrameOpts {
  cols: number;
  rows: number;
  cursorCol?: number;
  cursorRow?: number;
  cursorVisible?: boolean;
  isScrolled?: boolean;
  fdhr?: number;
  scrollbackLen?: number;
  cells?: Record<string, CellSpec>; // key "row,col"
  text?: Record<number, string>; // row → text starting at col 0
}

const SENTINEL_BG: [number, number, number] = [0x1e, 0x1e, 0x1e];

function buildFrame(o: FrameOpts): Uint8Array {
  const buf = new Uint8Array(HEADER_SIZE + o.cols * o.rows * CELL_SIZE);
  const v = new DataView(buf.buffer);
  v.setUint16(0, o.cols, true);
  v.setUint16(2, o.rows, true);
  v.setUint16(4, o.cursorCol ?? 0, true);
  v.setUint16(6, o.cursorRow ?? 0, true);
  v.setUint8(8, o.cursorVisible === false ? 0 : 1);
  v.setUint8(9, 2); // steady block
  v.setUint8(10, 0);
  v.setUint8(11, o.isScrolled ? 1 : 0);
  v.setInt32(12, o.fdhr ?? 0, true);
  v.setUint32(16, o.scrollbackLen ?? 0, true);

  const cells: Record<string, CellSpec> = { ...(o.cells ?? {}) };
  for (const [rowStr, text] of Object.entries(o.text ?? {})) {
    for (let i = 0; i < text.length; i++) {
      cells[`${rowStr},${i}`] = { ...(cells[`${rowStr},${i}`] ?? {}), ch: text[i] };
    }
  }
  for (let r = 0; r < o.rows; r++) {
    for (let c = 0; c < o.cols; c++) {
      const spec = cells[`${r},${c}`] ?? {};
      const off = HEADER_SIZE + (r * o.cols + c) * CELL_SIZE;
      v.setUint32(off, (spec.ch ?? " ").codePointAt(0)!, true);
      const fg = spec.fg ?? [200, 200, 200];
      const bg = spec.bg ?? SENTINEL_BG;
      buf[off + 4] = fg[0]; buf[off + 5] = fg[1]; buf[off + 6] = fg[2];
      buf[off + 7] = bg[0]; buf[off + 8] = bg[1]; buf[off + 9] = bg[2];
      buf[off + 10] = spec.flags ?? 0;
      buf[off + 11] = spec.width ?? 1;
    }
  }
  return buf;
}

// ---- Tests ----------------------------------------------------------------

describe("TerminalRenderer", () => {
  let ctx: FakeCtx;
  let r: TerminalRenderer;

  beforeEach(() => {
    ctx = new FakeCtx();
    r = new TerminalRenderer(makeCanvas(ctx), 10, "monospace");
    r.updateCanvasSize(80, 60); // 10 cols × 5 rows at 8×12 cells
    ctx.reset();
  });

  it("measures_cells_from_the_font", () => {
    expect(r.cellWidth).toBe(8);
    expect(r.cellHeight).toBe(12); // ceil(10 * 1.2)
    expect(r.calculateGridSize(80, 60)).toEqual({ cols: 10, rows: 5 });
    expect(r.calculateGridSize(3, 3)).toEqual({ cols: 1, rows: 1 }); // never 0
  });

  it("decodes_header_metadata_on_setLatestFrame", () => {
    r.setLatestFrame(buildFrame({ cols: 10, rows: 5, fdhr: 42, scrollbackLen: 99 }));
    expect(r.currentRows).toBe(5);
    expect(r.currentFirstDisplayHistoryRow).toBe(42);
    expect(r.currentScrollbackLen).toBe(99);
    expect(r.currentFrame).not.toBeNull();
  });

  it("ignores_frames_shorter_than_the_header", () => {
    r.render(new Uint8Array(5));
    expect(ctx.calls.length).toBe(0);
    expect(r.currentFrame).toBeNull();
  });

  it("first_render_paints_every_cell_background_plus_clear", () => {
    r.render(buildFrame({ cols: 10, rows: 5 }));
    // 1 full-canvas clear + 50 cell backgrounds + cursor block
    expect(ctx.ops("fillRect").length).toBe(1 + 50 + 1);
  });

  it("draws_text_only_for_printable_cells", () => {
    r.render(buildFrame({ cols: 10, rows: 5, text: { 1: "Hi" } }));
    const texts = ctx.ops("fillText").map(c => c.args[0]);
    expect(texts).toEqual(["H", "i"]);
    // positioned at col*cellWidth, row*cellHeight (+ vertical text offset)
    const h = ctx.ops("fillText")[0];
    expect(h.args[1]).toBe(0);
    expect(h.args[2]).toBe(1 * 12 + Math.round((12 - 10) / 2));
  });

  it("dirty_rect_skips_unchanged_cells_on_second_render", () => {
    // Cursor parked away from the text: cursor cells are always repainted.
    const frame = buildFrame({ cols: 10, rows: 5, text: { 0: "hello" }, cursorCol: 9, cursorRow: 4 });
    r.render(frame);
    ctx.reset();
    r.render(new Uint8Array(frame)); // identical content
    // Only the cursor cell (old == new position) is repainted, plus the cursor itself.
    const rects = ctx.ops("fillRect");
    expect(rects.length).toBeLessThanOrEqual(2);
    expect(ctx.ops("fillText").length).toBe(0);
  });

  it("dirty_rect_repaints_exactly_the_changed_cell", () => {
    r.render(buildFrame({ cols: 10, rows: 5, text: { 2: "abc" }, cursorCol: 9, cursorRow: 4 }));
    ctx.reset();
    r.render(buildFrame({ cols: 10, rows: 5, text: { 2: "abX" }, cursorCol: 9, cursorRow: 4 }));
    const texts = ctx.ops("fillText").map(c => c.args[0]);
    expect(texts).toEqual(["X"]);
  });

  it("unfocused_renders_are_always_full_repaints", () => {
    const frame = buildFrame({ cols: 10, rows: 5 });
    r.render(frame);
    r.setFocused(false);
    ctx.reset();
    r.render(new Uint8Array(frame));
    expect(ctx.ops("fillRect").length).toBeGreaterThanOrEqual(1 + 50);
    // hollow cursor when unfocused
    expect(ctx.ops("strokeRect").length).toBe(1);
  });

  it("rerender_forces_a_full_repaint_from_the_cached_frame", () => {
    r.render(buildFrame({ cols: 10, rows: 5 }));
    ctx.reset();
    r.rerender();
    expect(ctx.ops("fillRect").length).toBeGreaterThanOrEqual(1 + 50);
  });

  it("updateCanvasSize_scales_by_dpr_and_repaints_last_frame", () => {
    r.render(buildFrame({ cols: 10, rows: 5 }));
    ctx.reset();
    const canvas = (r as unknown as { canvas: HTMLCanvasElement }).canvas;
    r.updateCanvasSize(160, 120);
    expect(canvas.width).toBe(160 * (window.devicePixelRatio || 1));
    expect(canvas.style.width).toBe("160px");
    expect(ctx.ops("fillRect").length).toBeGreaterThanOrEqual(1 + 50); // full repaint
  });

  it("substitutes_theme_background_for_the_rust_sentinel", () => {
    r.setThemeColors(1, 2, 3, 9, 9, 9);
    r.render(buildFrame({ cols: 10, rows: 5 }));
    const cellBg = ctx.ops("fillRect")[1]; // first cell after the clear
    expect(cellBg.fillStyle).toBe("rgb(1,2,3)");
  });

  it("inverse_flag_swaps_foreground_and_background", () => {
    r.render(buildFrame({
      cols: 10, rows: 5,
      cells: { "0,0": { ch: "x", fg: [10, 20, 30], bg: [40, 50, 60], flags: 0x10 } },
    }));
    const firstCellBg = ctx.ops("fillRect")[1];
    expect(firstCellBg.fillStyle).toBe("rgb(10,20,30)");
    const text = ctx.ops("fillText")[0];
    expect(text.fillStyle).toBe("rgb(40,50,60)");
  });

  it("wide_characters_span_two_columns_and_skip_the_placeholder", () => {
    r.render(buildFrame({
      cols: 10, rows: 5,
      cells: { "0,0": { ch: "漢", width: 2 }, "0,1": { ch: " ", width: 0 } },
    }));
    const firstCellBg = ctx.ops("fillRect")[1];
    expect(firstCellBg.args[2]).toBe(16); // 2 × cellWidth
    // 50 cells minus the skipped placeholder, plus clear and cursor
    expect(ctx.ops("fillRect").length).toBe(1 + 49 + 1);
  });

  it("scrolled_frames_draw_the_top_indicator_and_hide_the_cursor", () => {
    r.render(buildFrame({ cols: 10, rows: 5, isScrolled: true, cursorVisible: false }));
    const indicator = ctx.ops("fillRect").find(c => c.args[0] === 0 && c.args[1] === 0 && c.args[3] === 2);
    expect(indicator).toBeDefined();
    // no block cursor: every other fillRect is a full-height cell or the clear
    const blocks = ctx.ops("fillRect").filter(c => c.args[3] === 12 && c.args[2] === 8);
    expect(blocks.length).toBe(50);
  });

  it("getSelectedText_extracts_the_selected_range", () => {
    const frame = buildFrame({ cols: 10, rows: 5, text: { 1: "hello wor", 2: "ld" }, fdhr: 0 });
    r.render(frame);
    r.setSelection({ historyRow: 1, col: 6 }, { historyRow: 2, col: 1 });
    expect(r.getSelectedText(frame)).toBe("wor\nld");
    r.setSelection(null, null);
    expect(r.getSelectedText(frame)).toBe("");
  });

  it("getSelectedText_skips_wide_char_placeholders", () => {
    const frame = buildFrame({
      cols: 10, rows: 2, fdhr: 0,
      cells: { "0,0": { ch: "漢", width: 2 }, "0,1": { ch: " ", width: 0 }, "0,2": { ch: "字", width: 2 }, "0,3": { ch: " ", width: 0 }, "0,4": { ch: "x" } },
    });
    r.render(frame);
    r.setSelection({ historyRow: 0, col: 0 }, { historyRow: 0, col: 4 });
    expect(r.getSelectedText(frame)).toBe("漢字x");
  });

  it("selection_uses_history_rows_so_it_survives_scrollback_growth", () => {
    // Same selection (historyRow 7) lands on a different display row once fdhr moves.
    r.setSelection({ historyRow: 7, col: 0 }, { historyRow: 7, col: 2 });
    let frame = buildFrame({ cols: 10, rows: 5, text: { 2: "abc" }, fdhr: 5 });
    r.render(frame);
    expect(r.getSelectedText(frame)).toBe("abc");
    frame = buildFrame({ cols: 10, rows: 5, text: { 1: "abc" }, fdhr: 6 });
    r.render(frame);
    expect(r.getSelectedText(frame)).toBe("abc");
  });

  it("detects_urls_in_rendered_rows", () => {
    r.setLatestFrame(buildFrame({ cols: 40, rows: 2, text: { 1: "see https://example.com/x now" }, fdhr: 3 }));
    r.updateCanvasSize(320, 24);
    expect(r.detectedUrls).toHaveLength(1);
    expect(r.detectedUrls[0]).toMatchObject({ historyRow: 4, colStart: 4, url: "https://example.com/x" });
  });

  it("pixelToCell_and_displayToHistoryRow_round_trip", () => {
    expect(r.pixelToCell(17, 25)).toEqual({ col: 2, row: 2 });
    expect(r.displayToHistoryRow(3, 10)).toBe(13);
  });
});
