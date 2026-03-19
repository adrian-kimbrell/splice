import { describe, it, expect } from "vitest";
import { keyToBytes } from "./keyboard";

// Helper to build a minimal KeyboardEvent-like object
function key(
  k: string,
  opts: {
    metaKey?: boolean;
    altKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
  } = {},
): KeyboardEvent {
  return {
    key: k,
    metaKey: opts.metaKey ?? false,
    altKey: opts.altKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
  } as KeyboardEvent;
}

// ─── Arrow keys ───────────────────────────────────────────────────────────────

describe("arrow keys", () => {
  it("unmodified Left → ESC [ D (appCursor off)", () => {
    expect(keyToBytes(key("ArrowLeft"), false)).toEqual(new Uint8Array([27, 91, 68]));
  });

  it("unmodified Right → ESC [ C (appCursor off)", () => {
    expect(keyToBytes(key("ArrowRight"), false)).toEqual(new Uint8Array([27, 91, 67]));
  });

  it("unmodified Up → ESC O A (appCursor on)", () => {
    expect(keyToBytes(key("ArrowUp"), true)).toEqual(new Uint8Array([27, 79, 65]));
  });

  it("unmodified Down → ESC O B (appCursor on)", () => {
    expect(keyToBytes(key("ArrowDown"), true)).toEqual(new Uint8Array([27, 79, 66]));
  });

  it("Shift+Left → ESC [ 1 ; 2 D", () => {
    expect(keyToBytes(key("ArrowLeft", { shiftKey: true }), false)).toEqual(
      new Uint8Array([27, 91, 49, 59, 50, 68]),
    );
  });

  it("Ctrl+Left → ESC [ 1 ; 5 D", () => {
    expect(keyToBytes(key("ArrowLeft", { ctrlKey: true }), false)).toEqual(
      new Uint8Array([27, 91, 49, 59, 53, 68]),
    );
  });
});

// ─── Alt+Arrow word navigation (the bug fix) ─────────────────────────────────

describe("Alt+Arrow word navigation", () => {
  it("Alt+Left → ESC b (backward-word, not \\e[1;3D garbage)", () => {
    expect(keyToBytes(key("ArrowLeft", { altKey: true }), false)).toEqual(
      new Uint8Array([0x1b, 0x62]),
    );
  });

  it("Alt+Right → ESC f (forward-word, not \\e[1;3C garbage)", () => {
    expect(keyToBytes(key("ArrowRight", { altKey: true }), false)).toEqual(
      new Uint8Array([0x1b, 0x66]),
    );
  });

  it("Alt+Up still uses CSI modifier form (no special mapping)", () => {
    // mod=2 → 1+2=3 → ESC [ 1 ; 3 A
    expect(keyToBytes(key("ArrowUp", { altKey: true }), false)).toEqual(
      new Uint8Array([27, 91, 49, 59, 51, 65]),
    );
  });

  it("Alt+Shift+Left still uses CSI modifier form (not word-nav)", () => {
    // mod = shift(1)+alt(2) = 3 → 1+3=4 → ESC [ 1 ; 4 D
    expect(keyToBytes(key("ArrowLeft", { altKey: true, shiftKey: true }), false)).toEqual(
      new Uint8Array([27, 91, 49, 59, 52, 68]),
    );
  });

  it("Alt+Ctrl+Left still uses CSI modifier form (not word-nav)", () => {
    // mod = alt(2)+ctrl(4) = 6 → 1+6=7 → ESC [ 1 ; 7 D
    expect(keyToBytes(key("ArrowLeft", { altKey: true, ctrlKey: true }), false)).toEqual(
      new Uint8Array([27, 91, 49, 59, 55, 68]),
    );
  });
});

// ─── Cmd+Arrow (macOS line navigation) ───────────────────────────────────────

describe("Cmd+Arrow (macOS)", () => {
  it("Cmd+Left → Ctrl+A (beginning of line)", () => {
    expect(keyToBytes(key("ArrowLeft", { metaKey: true }), false)).toEqual(
      new Uint8Array([0x01]),
    );
  });

  it("Cmd+Right → Ctrl+E (end of line)", () => {
    expect(keyToBytes(key("ArrowRight", { metaKey: true }), false)).toEqual(
      new Uint8Array([0x05]),
    );
  });

  it("Cmd+Up → Ctrl+P (prev history)", () => {
    expect(keyToBytes(key("ArrowUp", { metaKey: true }), false)).toEqual(
      new Uint8Array([0x10]),
    );
  });

  it("Cmd+Down → Ctrl+N (next history)", () => {
    expect(keyToBytes(key("ArrowDown", { metaKey: true }), false)).toEqual(
      new Uint8Array([0x0e]),
    );
  });
});

// ─── Common control sequences ─────────────────────────────────────────────────

describe("control sequences", () => {
  it("Enter → CR", () => {
    expect(keyToBytes(key("Enter"), false)).toEqual(new Uint8Array([13]));
  });

  it("Backspace → DEL", () => {
    expect(keyToBytes(key("Backspace"), false)).toEqual(new Uint8Array([127]));
  });

  it("Tab → HT", () => {
    expect(keyToBytes(key("Tab"), false)).toEqual(new Uint8Array([9]));
  });

  it("Shift+Tab → ESC [ Z", () => {
    expect(keyToBytes(key("Tab", { shiftKey: true }), false)).toEqual(
      new Uint8Array([27, 91, 90]),
    );
  });

  it("Escape → ESC", () => {
    expect(keyToBytes(key("Escape"), false)).toEqual(new Uint8Array([27]));
  });

  it("Ctrl+C → ETX", () => {
    expect(keyToBytes(key("c", { ctrlKey: true }), false)).toEqual(new Uint8Array([3]));
  });

  it("Ctrl+D → EOT", () => {
    expect(keyToBytes(key("d", { ctrlKey: true }), false)).toEqual(new Uint8Array([4]));
  });

  it("Alt+Backspace → ESC DEL (backward-kill-word)", () => {
    expect(keyToBytes(key("Backspace", { altKey: true }), false)).toEqual(
      new Uint8Array([0x1b, 0x7f]),
    );
  });

  it("printable char → UTF-8 bytes", () => {
    expect(keyToBytes(key("a"), false)).toEqual(new Uint8Array([97]));
  });

  it("unknown key with no modifier → null", () => {
    expect(keyToBytes(key("F13"), false)).toBeNull();
  });
});

// ─── Home / End ───────────────────────────────────────────────────────────────

describe("Home / End", () => {
  it("Home → ESC [ H", () => {
    expect(keyToBytes(key("Home"), false)).toEqual(new Uint8Array([27, 91, 72]));
  });

  it("End → ESC [ F", () => {
    expect(keyToBytes(key("End"), false)).toEqual(new Uint8Array([27, 91, 70]));
  });

  it("Shift+Home → ESC [ 1 ; 2 H", () => {
    expect(keyToBytes(key("Home", { shiftKey: true }), false)).toEqual(
      new Uint8Array([27, 91, 49, 59, 50, 72]),
    );
  });
});
