/**
 * Canvas-based terminal renderer.
 *
 * Reads binary frames produced by `src-tauri/src/terminal/emitter.rs`:
 *   - 20-byte header: cols, rows, cursor col/row/visibility/style, mode flags,
 *     is_scrolled, first_display_history_row, scrollback_len
 *   - 12 bytes per cell, row-major: codepoint (u32 LE), fg RGB, bg RGB, flags, width
 *
 * Performance:
 * - Dirty-rect: only cells that changed between `lastFrame` and the new frame are repainted
 * - Color string cache: maps packed RGB integer → "rgb(r,g,b)" string
 * - ASCII char cache: pre-computed String.fromCodePoint for codepoints 32–127
 *
 * Coordinate system: selection and search matches use `historyRow` — an index into the
 * combined [scrollback[0..n], live[0..rows]] array. historyRow=0 is the oldest row
 * (oldest scrollback entry, or live[0] if there is no scrollback). This keeps coordinates
 * stable as new output is appended and scrollback grows.
 *
 * `forceFullRedraw` is set on font or size change; otherwise only dirty cells are repainted.
 */

export const HEADER_SIZE = 20;
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

// URL detection regex
const URL_REGEX = /https?:\/\/[^\s"'>)\]]{3,}/g;

export interface SearchMatch {
  historyRow: number;
  colStart: number;
  colEnd: number;
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

  // Selection state — coordinates use historyRow: index into combined
  // [scrollback[0..n], live[0..rows]] array.
  // historyRow=0 = oldest scrollback row; increases toward bottom/newer.
  selectionStart: { historyRow: number; col: number } | null = null;
  selectionEnd: { historyRow: number; col: number } | null = null;

  // Current frame metadata (updated at the top of render())
  private _currentFirstDisplayHistoryRow = 0;
  private _currentRows = 0;
  private _currentScrollbackLen = 0;

  get currentFirstDisplayHistoryRow() { return this._currentFirstDisplayHistoryRow; }
  get currentRows() { return this._currentRows; }
  get currentScrollbackLen() { return this._currentScrollbackLen; }

  // Cursor blink
  private cursorBlinkVisible = true;

  // Focus
  private _isFocused = true;

  // Search highlighting
  private searchMatches: SearchMatch[] = [];
  private searchActiveIndex = -1;
  private searchMatchByRow = new Map<number, Array<{ colStart: number; colEnd: number; idx: number }>>();

  // Theme-derived colors — updated via setThemeColors()
  private themeBgR = 0x1e;
  private themeBgG = 0x1e;
  private themeBgB = 0x1e;
  private cursorR = 0xff;
  private cursorG = 0xff;
  private cursorB = 0xff;
  private selectionColor = "rgba(100, 150, 255, 0.3)";
  private scrolledColor  = "rgba(97, 175, 239, 0.7)";

  // URL detection
  detectedUrls: Array<{ historyRow: number; colStart: number; colEnd: number; url: string }> = [];
  hoveredUrl: { historyRow: number; colStart: number; colEnd: number; url: string } | null = null;
  private urlsNeedUpdate = false;

  constructor(
    canvas: HTMLCanvasElement,
    fontSize = 15,
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
    this.ctx.textBaseline = "top";
    const metrics = this.ctx.measureText("W");
    this._cellWidth = Math.round(metrics.width);

    // Measure actual glyph descent for characters with descenders.
    // With textBaseline="top", actualBoundingBoxDescent is the distance from
    // the draw Y position (em-square top) down to the bottom of the glyph.
    // For fonts like Menlo whose ascender+descender > 1em, this exceeds fontSize.
    // textYOffset = Math.round((ch - fontSize)/2) centers the em square in the cell.
    // For the full glyph to fit: textYOffset + glyphBottom ≤ ch
    //   => ch ≥ 2*glyphBottom - fontSize
    // Add 2px safety margin for sub-pixel rendering on Retina displays.
    const descMetrics = this.ctx.measureText("gjpqy");
    const glyphBottom = descMetrics.actualBoundingBoxDescent;
    this._cellHeight = Math.max(
      Math.ceil(this.fontSize * 1.2),
      Math.ceil(2 * glyphBottom - this.fontSize) + 2,
    );
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
    start: { historyRow: number; col: number } | null,
    end: { historyRow: number; col: number } | null,
  ) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  setSearchMatches(matches: SearchMatch[], activeIndex: number) {
    this.searchMatches = matches;
    this.searchActiveIndex = activeIndex;
    // Build a row-indexed map for O(1) lookup during render
    this.searchMatchByRow = new Map();
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      let rowList = this.searchMatchByRow.get(m.historyRow);
      if (!rowList) {
        rowList = [];
        this.searchMatchByRow.set(m.historyRow, rowList);
      }
      rowList.push({ colStart: m.colStart, colEnd: m.colEnd, idx: i });
    }
    this.forceFullRedraw = true;
  }

  /** Convert a display row to a historyRow (index into combined [scrollback, live] array). */
  displayToHistoryRow(displayRow: number, fdhr: number): number {
    return fdhr + displayRow;
  }

  updateFont(fontSize: number, fontFamily: string) {
    this.fontSize = fontSize;
    this.fontFamily = fontFamily;
    this.measureFont();
    this.forceFullRedraw = true;
    this.lastFont = "";
    this.lastFillStyle = "";
  }

  setThemeColors(bgR: number, bgG: number, bgB: number,
                 accentR: number, accentG: number, accentB: number) {
    this.themeBgR = bgR; this.themeBgG = bgG; this.themeBgB = bgB;
    this.cursorR = accentR; this.cursorG = accentG; this.cursorB = accentB;
    this.selectionColor = `rgba(${accentR},${accentG},${accentB},0.25)`;
    this.scrolledColor  = `rgba(${accentR},${accentG},${accentB},0.7)`;
    this.forceFullRedraw = true;
  }

  pixelToCell(x: number, y: number): { col: number; row: number } {
    return {
      col: Math.floor(x / this._cellWidth),
      row: Math.floor(y / this._cellHeight),
    };
  }

  private isSelected(col: number, displayRow: number): boolean {
    if (!this.selectionStart || !this.selectionEnd) return false;
    const historyRow = this._currentFirstDisplayHistoryRow + displayRow;
    // Normalize: lo = smaller historyRow (top/older), hi = larger (bottom/newer)
    let lo = this.selectionStart;
    let hi = this.selectionEnd;
    if (lo.historyRow > hi.historyRow) { [lo, hi] = [hi, lo]; }

    if (historyRow < lo.historyRow || historyRow > hi.historyRow) return false;
    if (historyRow === lo.historyRow && historyRow === hi.historyRow) {
      // Single row — column range between start and end
      const minCol = Math.min(lo.col, hi.col);
      const maxCol = Math.max(lo.col, hi.col);
      return col >= minCol && col <= maxCol;
    }
    // Multi-row:
    // lo = top row (older historyRow): selection from lo.col to end-of-line
    // hi = bottom row (newer historyRow): selection from 0 to hi.col
    if (historyRow === lo.historyRow) return col >= lo.col;
    if (historyRow === hi.historyRow) return col <= hi.col;
    return true; // middle rows: entire row selected
  }

  /** Update the stored latest frame and metadata without rendering.
   *  Call this when frame data arrives so rerender() from mouse events always
   *  uses up-to-date history coordinates in isSelected(). */
  setLatestFrame(data: Uint8Array) {
    if (data.length < HEADER_SIZE) return;
    this.lastFrame = data;
    const view = new DataView(data.buffer, data.byteOffset);
    this._currentFirstDisplayHistoryRow = view.getInt32(12, true);
    this._currentRows = view.getUint16(2, true);
    this._currentScrollbackLen = view.getUint32(16, true);
    this.urlsNeedUpdate = true;
  }

  /** Extract selected text from the current frame (visible rows only).
   *  For cross-scroll selections, use the Rust get_terminal_text_range command. */
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

  private detectUrls(data: Uint8Array, view: DataView, rows: number, cols: number) {
    this.detectedUrls = [];
    const fdhr = this._currentFirstDisplayHistoryRow;
    for (let row = 0; row < rows; row++) {
      // Reconstruct row text from cell codepoints
      let rowText = "";
      for (let col = 0; col < cols; col++) {
        const off = HEADER_SIZE + (row * cols + col) * CELL_SIZE;
        if (off + 4 > data.length) break;
        const cp = view.getUint32(off, true);
        const width = data[off + 11];
        if (width === 0) {
          // Right-half placeholder: contribute a space to text (position it correctly)
          rowText += " ";
        } else {
          rowText += cp > 32 ? String.fromCodePoint(cp) : " ";
        }
      }
      // Find URLs in row text
      URL_REGEX.lastIndex = 0;
      let match;
      while ((match = URL_REGEX.exec(rowText)) !== null) {
        this.detectedUrls.push({
          historyRow: fdhr + row,
          colStart: match.index,
          colEnd: match.index + match[0].length,
          url: match[0],
        });
      }
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
    // bytes 12-15: first_display_history_row
    const firstDisplayHistoryRow = view.getInt32(12, true);
    // bytes 16-19: scrollback_len
    const scrollbackLen = view.getUint32(16, true);
    this._currentFirstDisplayHistoryRow = firstDisplayHistoryRow;
    this._currentRows = rows;
    this._currentScrollbackLen = scrollbackLen;

    const ctx = this.ctx;
    const cw = this._cellWidth;
    const ch = this._cellHeight;
    const canvasW = this.canvas.width / this.dpr;
    const canvasH = this.canvas.height / this.dpr;

    const prev = this.previousFrame;
    // Always do a full repaint when unfocused — prevents dirty-region artifacts from
    // accumulating when the GPU compositor invalidates the canvas backing store.
    const fullRedraw = this.forceFullRedraw || !prev || prev.length !== data.length || !this._isFocused;
    this.forceFullRedraw = false;

    // Extract previous cursor position for redraw
    const oldCursorCol = this.prevCursorCol;
    const oldCursorRow = this.prevCursorRow;
    this.prevCursorCol = cursorVisible ? cursorCol : -1;
    this.prevCursorRow = cursorVisible ? cursorRow : -1;

    if (fullRedraw) {
      // Clear entire canvas
      this.setFill(rgbString(this.themeBgR, this.themeBgG, this.themeBgB));
      ctx.fillRect(0, 0, canvasW, canvasH);
    }

    const baseFont = `${this.fontSize}px ${this.fontFamily}`;
    ctx.textBaseline = "top";
    const textYOffset = Math.round((ch - this.fontSize) / 2);
    const hasSelection = this.selectionStart !== null && this.selectionEnd !== null;
    const hasSearchMatches = this.searchMatchByRow.size > 0;
    const hasHoveredUrl = this.hoveredUrl !== null;

    // Draw cells
    for (let row = 0; row < rows; row++) {
      const rowHistoryRow = firstDisplayHistoryRow + row;
      const rowSearchMatches = hasSearchMatches ? this.searchMatchByRow.get(rowHistoryRow) : undefined;
      const hovUrl = hasHoveredUrl ? this.hoveredUrl : null;

      for (let col = 0; col < cols; col++) {
        const offset = HEADER_SIZE + (row * cols + col) * CELL_SIZE;
        if (offset + CELL_SIZE > data.length) break;

        const cellWidth = data[offset + 11]; // 0=right-half placeholder, 1=normal, 2=wide left
        // Right-half placeholder: background was drawn by the wide char cell; skip entirely
        if (cellWidth === 0) continue;

        const drawW = cellWidth === 2 ? cw * 2 : cw; // wide cells span 2 columns

        // Dirty-region check: skip cells where all 12 bytes match previous frame
        // Always redraw cursor cells (old and new position) and selected/search cells
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
            // For wide chars also check right-half cell
            if (same && cellWidth === 2 && col + 1 < cols) {
              const nextOffset = HEADER_SIZE + (row * cols + col + 1) * CELL_SIZE;
              if (nextOffset + CELL_SIZE <= data.length) {
                for (let b = 0; b < CELL_SIZE; b++) {
                  if (data[nextOffset + b] !== prev![nextOffset + b]) {
                    same = false;
                    break;
                  }
                }
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

        // Always draw background (needed for inverse correctness; wide cells cover 2 cols)
        // Substitute the Rust default bg sentinel (0x1e1e1e) with the current theme bg
        const isSentinel = bgR === 0x1e && bgG === 0x1e && bgB === 0x1e;
        const drawBgR = isSentinel ? this.themeBgR : bgR;
        const drawBgG = isSentinel ? this.themeBgG : bgG;
        const drawBgB = isSentinel ? this.themeBgB : bgB;
        this.setFill(rgbString(drawBgR, drawBgG, drawBgB));
        ctx.fillRect(x, y, drawW, ch);

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
          ctx.fillRect(x, y + ch - 1, drawW, 1);
        }

        // STRIKETHROUGH decoration
        if (flags & FLAG_STRIKETHROUGH) {
          this.setFill(rgbString(fgR, fgG, fgB));
          ctx.fillRect(x, y + Math.round(ch / 2), drawW, 1);
        }

        // Hovered URL underline
        if (hovUrl && hovUrl.historyRow === rowHistoryRow && col >= hovUrl.colStart && col < hovUrl.colEnd) {
          this.setFill(rgbString(fgR, fgG, fgB));
          ctx.fillRect(x, y + ch - 1, cw, 1);
          this.lastFillStyle = "";
        }

        // Selection overlay (wide cells get overlay on left half; right-half is skipped above)
        if (hasSelection && this.isSelected(col, row)) {
          ctx.fillStyle = this.selectionColor;
          this.lastFillStyle = "";
          ctx.fillRect(x, y, drawW, ch);
        }

        // Search match overlay
        if (rowSearchMatches) {
          for (const m of rowSearchMatches) {
            if (col >= m.colStart && col < m.colEnd) {
              ctx.fillStyle = m.idx === this.searchActiveIndex
                ? "rgba(255, 200, 0, 0.6)"
                : "rgba(200, 150, 0, 0.35)";
              this.lastFillStyle = "";
              ctx.fillRect(x, y, cw, ch);
              break;
            }
          }
        }
      }
    }

    // Scrolled indicator
    if (isScrolled) {
      ctx.fillStyle = this.scrolledColor;
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
        ctx.strokeStyle = `rgba(${this.cursorR},${this.cursorG},${this.cursorB},0.7)`;
        ctx.lineWidth = 1;
        ctx.strokeRect(cx + 0.5, cy + 0.5, cw - 1, ch - 1);
      } else {
        switch (cursorStyle) {
          case 0: // block
          case 1: // blinking block
          case 2: // steady block
            ctx.fillStyle = `rgba(${this.cursorR},${this.cursorG},${this.cursorB},0.5)`;
            this.lastFillStyle = "";
            ctx.fillRect(cx, cy, cw, ch);
            break;
          case 3: // blinking underline
          case 4: // steady underline
            ctx.fillStyle = `rgb(${this.cursorR},${this.cursorG},${this.cursorB})`;
            this.lastFillStyle = "";
            ctx.fillRect(cx, cy + ch - 2, cw, 2);
            break;
          case 5: // blinking bar
          case 6: // steady bar
            ctx.fillStyle = `rgb(${this.cursorR},${this.cursorG},${this.cursorB})`;
            this.lastFillStyle = "";
            ctx.fillRect(cx, cy, 2, ch);
            break;
          default:
            ctx.fillStyle = `rgba(${this.cursorR},${this.cursorG},${this.cursorB},0.5)`;
            this.lastFillStyle = "";
            ctx.fillRect(cx, cy, cw, ch);
        }
      }
    }

    // URL detection (only when frame content has changed)
    if (this.urlsNeedUpdate) {
      this.detectUrls(data, view, rows, cols);
      this.urlsNeedUpdate = false;
    }

    // Save frame for dirty-region comparison on next render
    this.previousFrame = new Uint8Array(data);
  }
}
