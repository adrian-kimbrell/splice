/**
 * Pure xterm keyboard encoder — no Svelte/DOM coupling.
 *
 * Maps `KeyboardEvent` + terminal mode flags → escape byte sequences for the PTY.
 * Three encoding strategies depending on key type:
 * - Arrow keys / Home / End: CSI letter (`ESC [ A`) or SS3 (`ESC O A`) depending on
 *   `appCursorKeys` mode; modified variants use `ESC [ 1 ; <mod> <letter>`
 * - Function keys F1–F4: SS3 when unmodified, CSI when modified
 * - Function keys F5+, Delete, Insert, PgUp/Dn: CSI tilde sequences (`ESC [ <n> ~`)
 * - Printable + Ctrl combos: standard ASCII / C0 control codes
 *
 * Modifier code = 1 + shift + 2*alt + 4*ctrl (xterm convention).
 * Mouse encoding is handled separately in `CanvasTerminal.svelte`.
 */

const textEncoder = new TextEncoder();

// xterm modifier param: 1 + (shift?1:0) + (alt?2:0) + (ctrl?4:0)
function modifierCode(e: KeyboardEvent): number {
  return (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);
}

// ESC [ 1 ; <1+mod> <letter>  (arrows, Home=H, End=F)
// Unmodified arrow with appCursor: ESC O <letter>
// Unmodified arrow without appCursor: ESC [ <letter>
function csiLetterKey(letter: number, mod: number, appCursor: boolean): Uint8Array {
  if (mod === 0) {
    return appCursor
      ? new Uint8Array([27, 79, letter])    // ESC O <letter>
      : new Uint8Array([27, 91, letter]);   // ESC [ <letter>
  }
  // ESC [ 1 ; <1+mod> <letter>
  const modStr = String(1 + mod);
  const bytes = [27, 91, 49, 59]; // ESC [ 1 ;
  for (let i = 0; i < modStr.length; i++) bytes.push(modStr.charCodeAt(i));
  bytes.push(letter);
  return new Uint8Array(bytes);
}

// ESC [ <numStr> ; <1+mod> ~  (Delete=3, Insert=2, PgUp=5, PgDn=6, F5+=15/17/...)
function csiTildeKey(numStr: string, mod: number): Uint8Array {
  if (mod === 0) {
    // ESC [ <numStr> ~
    const bytes = [27, 91];
    for (let i = 0; i < numStr.length; i++) bytes.push(numStr.charCodeAt(i));
    bytes.push(126); // ~
    return new Uint8Array(bytes);
  }
  // ESC [ <numStr> ; <1+mod> ~
  const modStr = String(1 + mod);
  const bytes = [27, 91];
  for (let i = 0; i < numStr.length; i++) bytes.push(numStr.charCodeAt(i));
  bytes.push(59); // ;
  for (let i = 0; i < modStr.length; i++) bytes.push(modStr.charCodeAt(i));
  bytes.push(126); // ~
  return new Uint8Array(bytes);
}

// F1-F4: unmodified=SS3 (ESC O <letter>), modified=CSI (ESC [ 1 ; <1+mod> <letter>)
function ss3OrCsi(letter: number, mod: number): Uint8Array {
  if (mod === 0) {
    return new Uint8Array([27, 79, letter]); // ESC O <letter>
  }
  const modStr = String(1 + mod);
  const bytes = [27, 91, 49, 59]; // ESC [ 1 ;
  for (let i = 0; i < modStr.length; i++) bytes.push(modStr.charCodeAt(i));
  bytes.push(letter);
  return new Uint8Array(bytes);
}

// F1-F4 SS3 letter codes
const F_KEY_SS3: Record<string, number> = { F1: 80, F2: 81, F3: 82, F4: 83 };
// F5-F12 tilde number strings
const F_KEY_TILDE: Record<string, string> = {
  F5: "15", F6: "17", F7: "18", F8: "19",
  F9: "20", F10: "21", F11: "23", F12: "24",
};

// Arrow key letter codes
const ARROW_LETTERS: Record<string, number> = {
  ArrowUp: 65, ArrowDown: 66, ArrowRight: 67, ArrowLeft: 68,
};

export function keyToBytes(e: KeyboardEvent, appCursorKeys: boolean): Uint8Array | null {
  // 1. macOS Cmd+key → terminal control sequences
  if (e.metaKey && !e.altKey && !e.shiftKey) {
    switch (e.key) {
      case "Backspace": return new Uint8Array([0x15]);       // Ctrl+U: kill to line start
      case "Delete":    return new Uint8Array([0x0b]);       // Ctrl+K: kill to line end
      case "ArrowLeft": return new Uint8Array([0x01]);       // Ctrl+A: beginning of line
      case "ArrowRight":return new Uint8Array([0x05]);       // Ctrl+E: end of line
      case "ArrowUp":   return new Uint8Array([0x10]);       // Ctrl+P: prev history entry
      case "ArrowDown": return new Uint8Array([0x0e]);       // Ctrl+N: next history entry
    }
  }

  // 2. Other Cmd combos pass through to OS
  if (e.metaKey) return null;

  // 3. Compute modifier code once
  const mod = modifierCode(e);

  // 4. Shift+Tab → ESC[Z (before general Tab handling)
  if (e.key === "Tab" && e.shiftKey) {
    return new Uint8Array([27, 91, 90]); // ESC [ Z
  }

  // 5. F-keys (F1-F4 SS3, F5-F12 tilde) — all with modifier support
  if (e.key in F_KEY_SS3) {
    return ss3OrCsi(F_KEY_SS3[e.key], mod);
  }
  if (e.key in F_KEY_TILDE) {
    return csiTildeKey(F_KEY_TILDE[e.key], mod);
  }

  // 6. Arrow keys — modified arrows always use CSI; unmodified uses appCursor
  if (e.key in ARROW_LETTERS) {
    // Alt+Left/Right → readline word navigation (ESC b / ESC f).
    // The generic CSI form \e[1;3D is not bound in most default bash/zsh configs.
    if (e.altKey && !e.ctrlKey && !e.shiftKey) {
      if (e.key === "ArrowLeft")  return new Uint8Array([0x1b, 0x62]); // ESC b = backward-word
      if (e.key === "ArrowRight") return new Uint8Array([0x1b, 0x66]); // ESC f = forward-word
    }
    return csiLetterKey(ARROW_LETTERS[e.key], mod, appCursorKeys);
  }

  // 7. Home/End — letter-terminated with modifier
  if (e.key === "Home") {
    return csiLetterKey(72, mod, false); // H
  }
  if (e.key === "End") {
    return csiLetterKey(70, mod, false); // F
  }

  // 8. Insert
  if (e.key === "Insert") {
    return csiTildeKey("2", mod);
  }

  // 9. Delete
  if (e.key === "Delete") {
    return csiTildeKey("3", mod);
  }

  // 10. PageUp/PageDown
  if (e.key === "PageUp") {
    return csiTildeKey("5", mod);
  }
  if (e.key === "PageDown") {
    return csiTildeKey("6", mod);
  }

  // 11. Alt+special keys (non-printable)
  if (e.altKey && !e.ctrlKey && !e.shiftKey) {
    if (e.key === "Backspace") return new Uint8Array([0x1b, 0x7f]); // ESC DEL: backward-kill-word
    if (e.key === "Delete")    return new Uint8Array([0x1b, 0x64]); // ESC d:   forward-kill-word
  }

  // 12. Alt+key (single char, no ctrl/shift) → ESC prefix
  if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key.length === 1) {
    const charBytes = textEncoder.encode(e.key);
    const result = new Uint8Array(1 + charBytes.length);
    result[0] = 27; // ESC
    result.set(charBytes, 1);
    return result;
  }

  // 13. Ctrl+key combinations
  if (e.ctrlKey && !e.altKey) {
    const key = e.key.toLowerCase();
    if (key.length === 1 && key >= "a" && key <= "z") {
      return new Uint8Array([key.charCodeAt(0) - 96]);
    }
    if (key === "[") return new Uint8Array([0x1b]); // Ctrl+[ = ESC
    if (key === "\\") return new Uint8Array([0x1c]); // Ctrl+\ = FS
    if (key === "]") return new Uint8Array([0x1d]);  // Ctrl+] = GS
    if (key === "@" || key === " ") return new Uint8Array([0x00]); // Ctrl+@ / Ctrl+Space = NUL
    if (key === "^" || key === "6") return new Uint8Array([0x1e]); // Ctrl+^ = RS
    if (key === "_" || key === "-") return new Uint8Array([0x1f]); // Ctrl+_ = US
    return null;
  }

  // 14. Simple keys (no modifiers)
  switch (e.key) {
    case "Enter":
      return new Uint8Array([13]);
    case "Backspace":
      return new Uint8Array([127]);
    case "Tab":
      return new Uint8Array([9]);
    case "Escape":
      return new Uint8Array([27]);
    default:
      // 15. Printable characters
      if (e.key.length === 1) {
        return textEncoder.encode(e.key);
      }
      return null;
  }
}
