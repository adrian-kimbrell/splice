/**
 * Remembers which files Splice itself wrote recently.
 *
 * The file watcher cannot tell our own saves from external edits, and with
 * auto-save a keystroke that lands between the save and the (debounced) watcher
 * event made the file dirty again, so the user saw "File changed externally" for
 * their own save. Writers call `markSelfWrite` right before writing; the
 * file:changed handler consults `wasRecentlyWrittenBySplice` before warning.
 */

const WINDOW_MS = 2000;
const MAX_ENTRIES = 512;
const recent = new Map<string, number>();

export function markSelfWrite(path: string, now: number = Date.now()): void {
  recent.delete(path); // re-insert so the Map stays in insertion (= age) order
  recent.set(path, now);
  if (recent.size > MAX_ENTRIES) {
    const oldest = recent.keys().next().value;
    if (oldest !== undefined) recent.delete(oldest);
  }
}

export function wasRecentlyWrittenBySplice(path: string, now: number = Date.now(), windowMs: number = WINDOW_MS): boolean {
  const at = recent.get(path);
  if (at === undefined) return false;
  if (now - at > windowMs) {
    recent.delete(path);
    return false;
  }
  return true;
}
