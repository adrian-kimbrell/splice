/**
 * Pure helpers for terminal text selection: word boundaries that follow
 * soft-wrapped rows, and joining the lines Rust returns for a selection.
 */
import { codepointAt, decodeHeader } from "./protocol";

/** True for whitespace, control characters and common delimiters. */
export function isWordBreak(cp: number): boolean {
  if (cp <= 32) return true;
  return "\"'()[]{}|<>".includes(String.fromCodePoint(cp));
}

export interface CellRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/**
 * The word under (row, col) in the frame, extended across row boundaries when
 * the neighbouring row's edge cell is not a break (the row was soft-wrapped).
 * Returns null when the frame cannot be decoded.
 */
export function wordRangeAt(data: Uint8Array, row: number, col: number): CellRange | null {
  const header = decodeHeader(data);
  if (!header) return null;
  const { cols, rows } = header;
  const cp = (r: number, c: number) => codepointAt(data, cols, rows, r, c);

  let startRow = row, startCol = col, endRow = row, endCol = col;

  // Scan left; wrap to the previous row when at the left edge and that row's
  // last char is not a break.
  left: for (;;) {
    while (startCol > 0) {
      const v = cp(startRow, startCol - 1);
      if (v === null || isWordBreak(v)) break left;
      startCol--;
    }
    if (startRow === 0) break;
    const prevLast = cp(startRow - 1, cols - 1);
    if (prevLast === null || isWordBreak(prevLast)) break;
    startRow--;
    startCol = cols - 1;
  }

  // Scan right; wrap to the next row when at the right edge and its first
  // char is not a break.
  right: for (;;) {
    while (endCol < cols - 1) {
      const v = cp(endRow, endCol + 1);
      if (v === null || isWordBreak(v)) break right;
      endCol++;
    }
    if (endRow >= rows - 1) break;
    const nextFirst = cp(endRow + 1, 0);
    if (nextFirst === null || isWordBreak(nextFirst)) break;
    endRow++;
    endCol = 0;
  }

  return { startRow, startCol, endRow, endCol };
}

/**
 * Join the raw lines of a selection into clipboard text. `loCol`/`hiCol` are
 * the selection's columns on the first and last line. A line whose last cell
 * is non-blank was soft-wrapped, so it joins the next line without a newline.
 */
export function joinSelectedLines(lines: string[], loCol: number, hiCol: number): string {
  if (lines.length === 0) return "";
  if (lines.length === 1) {
    const minCol = Math.min(loCol, hiCol);
    const maxCol = Math.max(loCol, hiCol);
    return lines[0].substring(minCol, maxCol + 1).trimEnd();
  }
  const segments = [
    lines[0].substring(loCol).trimEnd(),
    ...lines.slice(1, -1).map((l) => l.trimEnd()),
    lines[lines.length - 1].substring(0, hiCol + 1).trimEnd(),
  ];
  let result = "";
  for (let i = 0; i < segments.length; i++) {
    result += segments[i];
    if (i < segments.length - 1) {
      const rawLastChar = lines[i][lines[i].length - 1];
      result += rawLastChar !== " " && rawLastChar !== "\0" ? "" : "\n";
    }
  }
  return result.replace(/\n+$/, "");
}
