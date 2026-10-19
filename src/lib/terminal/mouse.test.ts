import { describe, it, expect } from "vitest";
import { encodeMouseButton, heldButton, cellToReport, encodeMouseEvent, X10_MAX_COORD, MOUSE_NO_BUTTON } from "./mouse";

const ev = (button: number, mods: Partial<{ shiftKey: boolean; altKey: boolean; ctrlKey: boolean }> = {}) =>
  ({ button, shiftKey: false, altKey: false, ctrlKey: false, ...mods });

describe("mouse encoder", () => {
  it("maps DOM buttons and modifiers to xterm button numbers", () => {
    expect(encodeMouseButton(ev(0))).toBe(0);
    expect(encodeMouseButton(ev(1))).toBe(1);
    expect(encodeMouseButton(ev(2))).toBe(2);
    expect(encodeMouseButton(ev(0, { shiftKey: true }))).toBe(4);
    expect(encodeMouseButton(ev(0, { altKey: true }))).toBe(8);
    expect(encodeMouseButton(ev(2, { ctrlKey: true }))).toBe(18);
  });

  it("derives the held button from the buttons bitmask", () => {
    expect(heldButton(1)).toBe(0);
    expect(heldButton(4)).toBe(1);
    expect(heldButton(2)).toBe(2);
    expect(heldButton(0)).toBe(MOUSE_NO_BUTTON);
  });

  it("reports cells 1-based and clamped for X10", () => {
    expect(cellToReport({ row: 0, col: 0 })).toEqual({ cx: 1, cy: 1 });
    expect(cellToReport({ row: -5, col: 500 })).toEqual({ cx: X10_MAX_COORD, cy: 1 });
  });

  it("encodes SGR press/release and X10 bytes", () => {
    const dec = new TextDecoder();
    expect(dec.decode(encodeMouseEvent(0, 5, 7, true, true))).toBe("\x1b[<0;5;7M");
    expect(dec.decode(encodeMouseEvent(2, 5, 7, false, true))).toBe("\x1b[<2;5;7m");
    expect([...encodeMouseEvent(0, 5, 7, true, false)]).toEqual([0x1b, 0x5b, 0x4d, 32, 37, 39]);
    expect([...encodeMouseEvent(0, 300, 300, true, false)].slice(4)).toEqual([255, 255]);
  });
});
