/**
 * Pure xterm mouse-reporting encoder, the counterpart of `keyboard.ts`.
 *
 * Cells are reported 1-based. X10 encoding adds 32 to each value and stores it
 * in one byte, so coordinates are clamped to 223 (255 - 32); SGR encoding has
 * no such limit but the clamp is applied uniformly so a 300-column terminal
 * behaves the same under both.
 */

export const X10_MAX_COORD = 223;

/** Wheel buttons: 64 = scroll up, 65 = scroll down. */
export const MOUSE_WHEEL_UP = 64;
export const MOUSE_WHEEL_DOWN = 65;
/** Added to a button for motion reports (`ESC [ < 32+btn ; x ; y M`). */
export const MOUSE_MOTION = 32;
/** Button value meaning "no button held" in a motion report. */
export const MOUSE_NO_BUTTON = 3;

const textEncoder = new TextEncoder();

/** xterm button number for a press/release: 0 left, 1 middle, 2 right, plus modifier bits. */
export function encodeMouseButton(e: { button: number; shiftKey: boolean; altKey: boolean; ctrlKey: boolean }): number {
  let btn = e.button === 0 ? 0 : e.button === 1 ? 1 : 2;
  if (e.shiftKey) btn |= 4;
  if (e.altKey) btn |= 8;
  if (e.ctrlKey) btn |= 16;
  return btn;
}

/** The button held during a drag, from `MouseEvent.buttons` (bit 1 left, 4 middle, 2 right). */
export function heldButton(buttons: number): number {
  return buttons & 1 ? 0 : buttons & 4 ? 1 : buttons & 2 ? 2 : MOUSE_NO_BUTTON;
}

/** 0-based cell → 1-based, clamped report coordinates. */
export function cellToReport(cell: { row: number; col: number }): { cx: number; cy: number } {
  return {
    cx: Math.min(Math.max(1, cell.col + 1), X10_MAX_COORD),
    cy: Math.min(Math.max(1, cell.row + 1), X10_MAX_COORD),
  };
}

/** Bytes for one mouse report. SGR: `ESC [ < b ; x ; y M|m`; X10: `ESC [ M` + three bytes offset by 32. */
export function encodeMouseEvent(button: number, cx: number, cy: number, press: boolean, sgr: boolean): Uint8Array {
  if (sgr) return textEncoder.encode(`\x1b[<${button};${cx};${cy}${press ? "M" : "m"}`);
  return new Uint8Array([0x1b, 0x5b, 0x4d, Math.min(32 + button, 255), Math.min(32 + cx, 255), Math.min(32 + cy, 255)]);
}
