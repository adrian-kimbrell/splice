/** Bytes to write for pasted text; wrapped in `ESC [ 200~ … ESC [ 201~` when bracketed paste is on. */
const textEncoder = new TextEncoder();
const BRACKET_OPEN = textEncoder.encode("\x1b[200~");
const BRACKET_CLOSE = textEncoder.encode("\x1b[201~");

export function encodePaste(text: string, bracketed: boolean): Uint8Array {
  const content = textEncoder.encode(text);
  if (!bracketed) return content;
  const bytes = new Uint8Array(BRACKET_OPEN.length + content.length + BRACKET_CLOSE.length);
  bytes.set(BRACKET_OPEN, 0);
  bytes.set(content, BRACKET_OPEN.length);
  bytes.set(BRACKET_CLOSE, BRACKET_OPEN.length + content.length);
  return bytes;
}
