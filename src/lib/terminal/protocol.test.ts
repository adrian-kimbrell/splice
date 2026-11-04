import { describe, it, expect } from "vitest";
import {
  HEADER_SIZE, CELL_SIZE, decodeHeader, codepointAt, cellOffset, mouseModeOf,
  MODE_BRACKETED_PASTE, MODE_APP_CURSOR_KEYS, MODE_MOUSE_SGR, MODE_FOCUS_EVENTS,
} from "./protocol";

/** Build a frame: header fields + cells given as a string per row (ASCII only). */
export function makeFrame(rows: string[], header: Partial<ReturnType<typeof decodeHeader> & object> = {}): Uint8Array {
  const cols = Math.max(...rows.map((r) => r.length));
  const buf = new Uint8Array(HEADER_SIZE + rows.length * cols * CELL_SIZE);
  const v = new DataView(buf.buffer);
  v.setUint16(0, cols, true);
  v.setUint16(2, rows.length, true);
  v.setUint16(4, header?.cursorCol ?? 0, true);
  v.setUint16(6, header?.cursorRow ?? 0, true);
  v.setUint8(8, header?.cursorVisible === false ? 0 : 1);
  v.setUint8(9, header?.cursorStyle ?? 0);
  v.setUint8(10, header?.modeFlags ?? 0);
  v.setUint8(11, header?.isScrolled ? 1 : 0);
  v.setInt32(12, header?.firstDisplayHistoryRow ?? 0, true);
  v.setUint32(16, header?.scrollbackLen ?? 0, true);
  rows.forEach((text, r) => {
    for (let c = 0; c < cols; c++) {
      const cp = c < text.length ? text.charCodeAt(c) : 32;
      v.setUint32(cellOffset(cols, r, c), cp, true);
      buf[cellOffset(cols, r, c) + 11] = 1; // width
    }
  });
  return buf;
}

describe("frame protocol", () => {
  it("decodes every header field at its documented offset", () => {
    const f = makeFrame(["ab", "cd"], {
      cursorCol: 1, cursorRow: 1, cursorVisible: false, cursorStyle: 2,
      modeFlags: MODE_BRACKETED_PASTE | MODE_MOUSE_SGR, isScrolled: true,
      firstDisplayHistoryRow: -3, scrollbackLen: 1234,
    });
    expect(decodeHeader(f)).toEqual({
      cols: 2, rows: 2, cursorCol: 1, cursorRow: 1, cursorVisible: false, cursorStyle: 2,
      modeFlags: MODE_BRACKETED_PASTE | MODE_MOUSE_SGR, isScrolled: true,
      firstDisplayHistoryRow: -3, scrollbackLen: 1234,
    });
  });

  it("rejects a buffer shorter than the header", () => {
    expect(decodeHeader(new Uint8Array(HEADER_SIZE - 1))).toBeNull();
  });

  it("reads codepoints by cell and returns null outside the frame", () => {
    const f = makeFrame(["hi", "yo"]);
    expect(codepointAt(f, 2, 2, 0, 0)).toBe("h".charCodeAt(0));
    expect(codepointAt(f, 2, 2, 1, 1)).toBe("o".charCodeAt(0));
    expect(codepointAt(f, 2, 2, 2, 0)).toBeNull();
    expect(codepointAt(f, 2, 2, 0, -1)).toBeNull();
  });

  it("extracts the mouse mode from bits 3-4 and leaves the other bits alone", () => {
    expect(mouseModeOf(0)).toBe(0);
    expect(mouseModeOf(1 << 3)).toBe(1);
    expect(mouseModeOf(2 << 3)).toBe(2);
    expect(mouseModeOf((3 << 3) | MODE_APP_CURSOR_KEYS | MODE_FOCUS_EVENTS)).toBe(3);
  });
});
