const DEFAULT_BG_R = 0x1e;
const DEFAULT_BG_G = 0x1e;
const DEFAULT_BG_B = 0x1e;

export const HEADER_SIZE = 12;
export const CELL_SIZE = 12;

// Cell flag constants (must match Rust grid::flags)
const FLAG_BOLD = 0x01;
const FLAG_ITALIC = 0x02;
const FLAG_UNDERLINE = 0x04;
const FLAG_DIM = 0x08;
const FLAG_INVERSE = 0x10;
const FLAG_STRIKETHROUGH = 0x20;
const FLAG_BLINK = 0x40;
const FLAG_HIDDEN = 0x80;

// Module-level color string cache: key = (r<<16)|(g<<8)|b → "rgb(r,g,b)"
const colorCache = new Map<number, string>();
function rgbString(r: number, g: number, b: number): string {
  const key = (r << 16) | (g << 8) | b;
  let s = colorCache.get(key);
  if (s === undefined) {
    s = `rgb(${r},${g},${b})`;
    colorCache.set(key, s);
  }
  return s;
}

// Module-level ASCII char cache: pre-computed String.fromCodePoint for 32-127
const asciiChars: string[] = new Array(128);
for (let i = 32; i < 128; i++) {
  asciiChars[i] = String.fromCodePoint(i);
}

export class TerminalRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private _cellWidth = 0;
  private _cellHeight = 0;
  private fontSize: number;
  private fontFamily: string;
  private dpr = 1;
  private lastFrame: Uint8Array | null = null;
  private previousFrame: Uint8Array | null = null;
  private lastFont = "";
  private lastFillStyle = "";
  private forceFullRedraw = true;
  private prevCursorCol = -1;
  private prevCursorRow = -1;

  // Selection state
  selectionStart: { col: number; row: number } | null = null;
  selectionEnd: { col: number; row: number } | null = null;

  // Cursor blink
  private cursorBlinkVisible = true;

  // Focus
  private _isFocused = true;

  constructor(
    canvas: HTMLCanvasElement,
    fontSize = 12,
    fontFamily = "Menlo, Consolas, 'Courier New', monospace",
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.fontSize = fontSize;
    this.fontFamily = fontFamily;
    this.dpr = window.devicePixelRatio || 1;
    this.measureFont();
  }

  get cellWidth() {
    return this._cellWidth;
  }

  get cellHeight() {
    return this._cellHeight;
  }

  get currentFrame(): Uint8Array | null {
    return this.lastFrame;
  }

  measureFont() {
    this.ctx.font = `${this.fontSize}px ${this.fontFamily}`;
    const metrics = this.ctx.measureText("W");
    this._cellWidth = Math.round(metrics.width);
    this._cellHeight = Math.ceil(this.fontSize * 1.2);
  }

  calculateGridSize(
    width: number,
    height: number,
  ): { cols: number; rows: number } {
    return {
      cols: Math.max(1, Math.floor(width / this._cellWidth)),
      rows: Math.max(1, Math.floor(height / this._cellHeight)),
    };
  }

  updateCanvasSize(width: number, height: number) {
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.measureFont();
    this.lastFont = "";
    this.lastFillStyle = "";
    this.forceFullRedraw = true;
    if (this.lastFrame) {
      this.render(this.lastFrame);
    }
  }

  setCursorBlink(visible: boolean) {
    this.cursorBlinkVisible = visible;
  }

  setFocused(focused: boolean) {
    this._isFocused = focused;
  }

  setSelection(
    start: { col: number; row: number } | null,
    end: { col: number; row: number } | null,
  ) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  pixelToCell(x: number, y: number): { col: number; row: number } {
    return {
      col: Math.floor(x / this._cellWidth),
      row: Math.floor(y / this._cellHeight),
    };
  }

  private isSelected(col: number, row: number): boolean {
    if (!this.selectionStart || !this.selectionEnd) return false;
    let s = this.selectionStart;
    let e = this.selectionEnd;
    // Normalize so s is before e
    if (s.row > e.row || (s.row === e.row && s.col > e.col)) {
      [s, e] = [e, s];
    }
    if (row < s.row || row > e.row) return false;
    if (row === s.row && row === e.row) return col >= s.col && col <= e.col;
    if (row === s.row) return col >= s.col;
    if (row === e.row) return col <= e.col;
    return true;
  }

  getSelectedText(data: Uint8Array): string {
    if (!this.selectionStart || !this.selectionEnd || data.length < HEADER_SIZE)
      return "";
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const cols = view.getUint16(0, true);
    const rows = view.getUint16(2, true);
    const lines: string[] = [];

    for (let row = 0; row < rows; row++) {
      let line = "";
      let hasSelection = false;
      for (let col = 0; col < cols; col++) {
        if (this.isSelected(col, row)) {
          hasSelection = true;
          const offset = HEADER_SIZE + (row * cols + col) * CELL_SIZE;
          if (offset + CELL_SIZE <= data.length) {
            const cp = view.getUint32(offset, true);
            line += cp > 0 ? String.fromCodePoint(cp) : " ";
          }
        }
      }
      if (hasSelection) {
        lines.push(line.trimEnd());
      }
    }
    return lines.join("\n");
  }

  rerender() {
    if (this.lastFrame) {
      this.forceFullRedraw = true;
      this.render(this.lastFrame);
    }
  }

  private setFill(style: string) {
    if (style !== this.lastFillStyle) {
      this.ctx.fillStyle = style;
      this.lastFillStyle = style;
    }
  }

  render(data: Uint8Array) {
    if (data.length < HEADER_SIZE) return;
    this.lastFrame = data;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const cols = view.getUint16(0, true);
    const rows = view.getUint16(2, true);
    const cursorCol = view.getUint16(4, true);
    const cursorRow = view.getUint16(6, true);
    const cursorVisible = view.getUint8(8) !== 0;
    const cursorStyle = view.getUint8(9);
    // byte 10: modeFlags (read by CanvasTerminal)
    const isScrolled = view.getUint8(11) !== 0;

    const ctx = this.ctx;
    const cw = this._cellWidth;
    const ch = this._cellHeight;
    const canvasW = this.canvas.width / this.dpr;
    const canvasH = this.canvas.height / this.dpr;

    const prev = this.previousFrame;
    const fullRedraw = this.forceFullRedraw || !prev || prev.length !== data.length;
    this.forceFullRedraw = false;

    // Extract previous cursor position for redraw
    const oldCursorCol = this.prevCursorCol;
    const oldCursorRow = this.prevCursorRow;
    this.prevCursorCol = cursorVisible ? cursorCol : -1;
    this.prevCursorRow = cursorVisible ? cursorRow : -1;

    if (fullRedraw) {
      // Clear entire canvas
      this.setFill(rgbString(DEFAULT_BG_R, DEFAULT_BG_G, DEFAULT_BG_B));
      ctx.fillRect(0, 0, canvasW, canvasH);
    }

    const baseFont = `${this.fontSize}px ${this.fontFamily}`;
    ctx.textBaseline = "top";
    const textYOffset = Math.round((ch - this.fontSize) / 2);
    const hasSelection = this.selectionStart !== null && this.selectionEnd !== null;

    // Draw cells
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const offset = HEADER_SIZE + (row * cols + col) * CELL_SIZE;
        if (offset + CELL_SIZE > data.length) break;

        // Dirty-region check: skip cells where all 12 bytes match previous frame
        // Always redraw cursor cells (old and new position) and selected cells
        if (!fullRedraw) {
          const isCursorCell = (col === cursorCol && row === cursorRow) ||
                               (col === oldCursorCol && row === oldCursorRow);
          const isSelectedCell = hasSelection && this.isSelected(col, row);
          if (!isCursorCell && !isSelectedCell) {
            let same = true;
            for (let b = 0; b < CELL_SIZE; b++) {
              if (data[offset + b] !== prev![offset + b]) {
                same = false;
                break;
              }
            }
            if (same) continue;
          }
        }

        const codepoint = view.getUint32(offset, true);
        let fgR = data[offset + 4];
        let fgG = data[offset + 5];
        let fgB = data[offset + 6];
        let bgR = data[offset + 7];
        let bgG = data[offset + 8];
        let bgB = data[offset + 9];
        const flags = data[offset + 10];

        const x = col * cw;
        const y = row * ch;

        // Handle INVERSE: swap fg/bg
        if (flags & FLAG_INVERSE) {
          [fgR, bgR] = [bgR, fgR];
          [fgG, bgG] = [bgG, fgG];
          [fgB, bgB] = [bgB, fgB];
        }

        // Always draw background (needed for inverse correctness)
        this.setFill(rgbString(bgR, bgG, bgB));
        ctx.fillRect(x, y, cw, ch);

        // Draw character if printable (skip hidden text)
        if (codepoint > 32 && !(flags & FLAG_HIDDEN)) {
          // Build font string based on flags
          let fontStr = "";
          if (flags & FLAG_BOLD) fontStr += "bold ";
          if (flags & FLAG_ITALIC) fontStr += "italic ";
          fontStr += baseFont;

          if (fontStr !== this.lastFont) {
            ctx.font = fontStr;
            this.lastFont = fontStr;
          }

          // DIM: reduce alpha
          if (flags & FLAG_DIM) {
            ctx.globalAlpha = 0.5;
          }

          // Use ASCII cache for common characters, fallback for non-ASCII
          const char = codepoint >= 32 && codepoint < 128
            ? asciiChars[codepoint]
            : String.fromCodePoint(codepoint);
          this.setFill(rgbString(fgR, fgG, fgB));
          ctx.fillText(char, x, y + textYOffset);

          if (flags & FLAG_DIM) {
            ctx.globalAlpha = 1.0;
          }
        }

        // UNDERLINE decoration
        if (flags & FLAG_UNDERLINE) {
          this.setFill(rgbString(fgR, fgG, fgB));
          ctx.fillRect(x, y + ch - 1, cw, 1);
        }

        // STRIKETHROUGH decoration
        if (flags & FLAG_STRIKETHROUGH) {
          this.setFill(rgbString(fgR, fgG, fgB));
          ctx.fillRect(x, y + Math.round(ch / 2), cw, 1);
        }

        // Selection overlay
        if (hasSelection && this.isSelected(col, row)) {
          ctx.fillStyle = "rgba(100, 150, 255, 0.3)";
          this.lastFillStyle = "";
          ctx.fillRect(x, y, cw, ch);
        }
      }
    }

    // Scrolled indicator
    if (isScrolled) {
      ctx.fillStyle = "rgba(97, 175, 239, 0.7)";
      this.lastFillStyle = "";
      ctx.fillRect(0, 0, canvasW, 2);
    }

    // Draw cursor
    const showCursor =
      cursorVisible &&
      cursorCol < cols &&
      cursorRow < rows &&
      this.cursorBlinkVisible;

    if (showCursor) {
      const cx = cursorCol * cw;
      const cy = cursorRow * ch;

      if (!this._isFocused) {
        // Hollow rectangle when unfocused
        ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
        ctx.lineWidth = 1;
        ctx.strokeRect(cx + 0.5, cy + 0.5, cw - 1, ch - 1);
      } else {
        switch (cursorStyle) {
          case 0: // block
          case 1: // blinking block
          case 2: // steady block
            ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
            this.lastFillStyle = "";
            ctx.fillRect(cx, cy, cw, ch);
            break;
          case 3: // blinking underline
          case 4: // steady underline
            ctx.fillStyle = "#ffffff";
            this.lastFillStyle = "";
            ctx.fillRect(cx, cy + ch - 2, cw, 2);
            break;
          case 5: // blinking bar
          case 6: // steady bar
            ctx.fillStyle = "#ffffff";
            this.lastFillStyle = "";
            ctx.fillRect(cx, cy, 2, ch);
            break;
          default:
            ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
            this.lastFillStyle = "";
            ctx.fillRect(cx, cy, cw, ch);
        }
      }
    }

    // Save frame for dirty-region comparison on next render
    this.previousFrame = new Uint8Array(data);
  }
}
