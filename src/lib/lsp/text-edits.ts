/**
 * Apply LSP TextEdits to a whole document string.
 *
 * Used for files that are not open in a CodeMirror view (rename across files,
 * code actions touching other modules). Positions are LSP line/character, with
 * character counted in UTF-16 code units like JS strings, so string indexing is
 * exact. Edits are applied back to front so earlier offsets stay valid; the
 * previous line-splice implementation ignored multi-line ranges and applied
 * same-line edits in arbitrary order, corrupting the file.
 */
import type { TextEdit } from "./client";

/** Offset of (line, character) in `text`, clamped to the document. */
function offsetOf(lineStarts: number[], text: string, line: number, character: number): number {
  if (line < 0) return 0;
  if (line >= lineStarts.length) return text.length;
  const start = lineStarts[line];
  const end = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : text.length;
  return Math.min(start + Math.max(0, character), Math.max(start, end));
}

export function applyTextEdits(text: string, edits: TextEdit[]): string {
  if (edits.length === 0) return text;
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const resolved = edits.map((e) => ({
    from: offsetOf(lineStarts, text, e.range.start.line, e.range.start.character),
    to: offsetOf(lineStarts, text, e.range.end.line, e.range.end.character),
    insert: e.newText,
  }));
  // Back to front; for equal starts keep the server's order (stable sort) so
  // adjacent insertions land in the sequence the server produced them.
  resolved.sort((a, b) => b.from - a.from || b.to - a.to);
  let out = text;
  for (const e of resolved) {
    const from = Math.min(e.from, e.to);
    const to = Math.max(e.from, e.to);
    out = out.slice(0, from) + e.insert + out.slice(to);
  }
  return out;
}
