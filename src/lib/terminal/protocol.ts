/**
 * The binary frame protocol shared with `src-tauri/src/terminal/emitter.rs`.
 *
 * Header (20 bytes, little-endian):
 *   0  u16 cols            2  u16 rows
 *   4  u16 cursorCol       6  u16 cursorRow
 *   8  u8  cursorVisible   9  u8  cursorStyle
 *   10 u8  modeFlags       11 u8  isScrolled
 *   12 i32 firstDisplayHistoryRow
 *   16 u32 scrollbackLen
 * Then `rows * cols` cells of 12 bytes: u32 codepoint, fg rgb, bg rgb, u8 flags, u8 width.
 *
 * Everything that reads a frame goes through this module so the layout is
 * written down once.
 */

export const HEADER_SIZE = 20;
export const CELL_SIZE = 12;

/** Byte offsets inside a cell. */
export const CELL_FG = 4;
export const CELL_BG = 7;
export const CELL_FLAGS = 10;
export const CELL_WIDTH = 11;

/** Bits of the header's modeFlags byte. */
export const MODE_BRACKETED_PASTE = 0x01;
export const MODE_APP_CURSOR_KEYS = 0x02;
/** Bits 3-4: mouse reporting mode (0 off, 1 click, 2 button-drag, 3 any-motion). */
export const MODE_MOUSE_SHIFT = 3;
export const MODE_MOUSE_MASK = 0x3;
export const MODE_MOUSE_SGR = 0x20;
export const MODE_FOCUS_EVENTS = 0x40;

export type MouseMode = 0 | 1 | 2 | 3;

export function mouseModeOf(modeFlags: number): MouseMode {
  return ((modeFlags >> MODE_MOUSE_SHIFT) & MODE_MOUSE_MASK) as MouseMode;
}

export interface FrameHeader {
  cols: number;
  rows: number;
  cursorCol: number;
  cursorRow: number;
  cursorVisible: boolean;
  cursorStyle: number;
  modeFlags: number;
  isScrolled: boolean;
  firstDisplayHistoryRow: number;
  scrollbackLen: number;
}

/** Decode the header, or null when the buffer is too short to hold one. */
export function decodeHeader(data: Uint8Array): FrameHeader | null {
  if (data.length < HEADER_SIZE) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    cols: v.getUint16(0, true),
    rows: v.getUint16(2, true),
    cursorCol: v.getUint16(4, true),
    cursorRow: v.getUint16(6, true),
    cursorVisible: v.getUint8(8) !== 0,
    cursorStyle: v.getUint8(9),
    modeFlags: v.getUint8(10),
    isScrolled: v.getUint8(11) !== 0,
    firstDisplayHistoryRow: v.getInt32(12, true),
    scrollbackLen: v.getUint32(16, true),
  };
}

/** Byte offset of the cell at (row, col) in a frame with `cols` columns. */
export function cellOffset(cols: number, row: number, col: number): number {
  return HEADER_SIZE + (row * cols + col) * CELL_SIZE;
}

/** The codepoint at (row, col), or null when outside the frame. */
export function codepointAt(data: Uint8Array, cols: number, rows: number, row: number, col: number): number | null {
  if (row < 0 || row >= rows || col < 0 || col >= cols) return null;
  const off = cellOffset(cols, row, col);
  if (off + CELL_SIZE > data.length) return null;
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(off, true);
}
