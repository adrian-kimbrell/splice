<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { TerminalRenderer, HEADER_SIZE, CELL_SIZE } from "../../lib/terminal/renderer";
  import type { TerminalSearchMatch } from "../../lib/ipc/commands";
  import { settings } from "../../lib/stores/settings.svelte";
  import { attentionStore } from "../../lib/stores/attention.svelte";
  import { keyToBytes } from "../../lib/terminal/keyboard";
  import { workspaceManager } from "../../lib/stores/workspace.svelte";
  import { showContextMenu } from "../../lib/utils/context-menu";

  function parseHexColor(hex: string): [number, number, number] | null {
    const h = hex.trim().replace('#', '');
    if (h.length !== 6) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  let {
    terminalId = 0,
    active = false,
    searchMatches = [] as TerminalSearchMatch[],
    searchActiveIndex = -1,
  }: {
    terminalId?: number;
    active?: boolean;
    searchMatches?: TerminalSearchMatch[];
    searchActiveIndex?: number;
  } = $props();

  const isTauri = "__TAURI_INTERNALS__" in window;

  // Hoisted TextEncoder — shared across all keystroke/paste calls
  const textEncoder = new TextEncoder();

  let containerEl = $state<HTMLDivElement>();
  let canvasEl = $state<HTMLCanvasElement>();
  let renderer = $state<TerminalRenderer | null>(null);
  let resizeObserver: ResizeObserver | null = null;
  let unlistenGrid: (() => void) | null = null;
  let unlistenExit: (() => void) | null = null;
  let unlistenClipboard: (() => void) | null = null;
  let modeFlags = 0;
  let currentCols = 0;
  let currentRows = 0;

  // Cached IPC function from dynamic import
  let cachedResizeTerminal: ((id: number, cols: number, rows: number) => Promise<void>) | null = null;

  // Cursor blink state
  let blinkInterval: ReturnType<typeof setInterval> | null = null;
  let blinkVisible = true;

  // Selection state
  let isSelecting = false;
  let dragScrollInterval: ReturnType<typeof setInterval> | null = null;

  // Frame metadata (updated each time a frame arrives)
  let frameFirstDisplayHistoryRow = 0;
  let frameScrollbackLen = 0;
  let frameRows = 0;
  let frameCols = 0;

  // Scroll accumulator for smooth trackpad scrolling
  let scrollAccum = 0;

  // Cleanup functions for event listeners
  let cleanupFns: (() => void)[] = [];

  // RAF IDs hoisted to module scope so onDestroy can cancel pending frames
  let rafId = 0;
  let scrollRafId = 0;
  let resizeRafId = 0;

  // Convert TerminalSearchMatch[] → SearchMatch[] and push to renderer.
  // Uses renderer.currentScrollbackLen for the historyRow conversion.
  $effect(() => {
    if (!renderer) return;
    const sbLen = renderer.currentScrollbackLen;
    const converted = searchMatches.map(m => ({
      historyRow: sbLen + m.row,
      colStart: m.col_start,
      colEnd: m.col_end,
    }));
    renderer.setSearchMatches(converted, searchActiveIndex);
  });

  // Re-fit terminal when becoming visible after workspace/tab switch
  $effect(() => {
    if (active && renderer && containerEl) {
      requestAnimationFrame(() => {
        handleResize();
      });
    }
  });

  // Update terminal font when settings change
  $effect(() => {
    if (!renderer) return;
    const fs = settings.terminal.font_size;
    const ff = `${settings.terminal.font_family}, Consolas, 'Courier New', monospace`;
    renderer.updateFont(fs, ff);
    handleResize();
    renderer.rerender();
  });

  // Re-fit terminal when UI zoom changes.
  // ResizeObserver uses CSS content-box coordinates which don't change when only
  // document.documentElement.style.zoom changes, so it won't fire on zoom.
  // We have to re-measure explicitly.
  $effect(() => {
    const _scale = settings.appearance.ui_scale; // subscribe
    if (!renderer || !containerEl) return;
    requestAnimationFrame(() => handleResize());
  });

  // Toggle cursor blink based on settings
  $effect(() => {
    if (!renderer) return;
    if (settings.terminal.cursor_blink) {
      resetBlinkTimer();
    } else {
      if (blinkInterval) { clearInterval(blinkInterval); blinkInterval = null; }
      renderer.setCursorBlink(true);
      renderer.rerender();
    }
  });

  /** Returns true if codepoint is a word boundary (for double-click selection). */
  function isWordBreak(cp: number): boolean {
    if (cp <= 32) return true;
    return '"\'()[]{}|<>'.includes(String.fromCodePoint(cp));
  }

  function handleResize() {
    if (!containerEl || !canvasEl || !renderer || !cachedResizeTerminal) return;
    const rect = containerEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    renderer.updateCanvasSize(rect.width, rect.height);
    const { cols, rows } = renderer.calculateGridSize(rect.width, rect.height);
    if (cols > 0 && rows > 0 && (cols !== currentCols || rows !== currentRows)) {
      currentCols = cols;
      currentRows = rows;
      cachedResizeTerminal(terminalId, cols, rows).catch(console.error);
    }
  }

  function resetBlinkTimer() {
    if (renderer) {
      blinkVisible = true;
      renderer.setCursorBlink(true);
      renderer.rerender();
    }
    if (blinkInterval) clearInterval(blinkInterval);
    blinkInterval = setInterval(() => {
      if (renderer && containerEl?.offsetParent !== null) {
        blinkVisible = !blinkVisible;
        renderer.setCursorBlink(blinkVisible);
        renderer.rerender();
      }
    }, 530);
  }

  function applyTerminalTheme(bg: string, accent: string) {
    if (!renderer) return;
    const bgRgb = parseHexColor(bg);
    const accentRgb = parseHexColor(accent);
    if (!bgRgb || !accentRgb) return;
    renderer.setThemeColors(...bgRgb, ...accentRgb);
    renderer.rerender();
  }

  onMount(async () => {
    if (!containerEl || !canvasEl || !isTauri || terminalId === 0) return;

    const { writeToTerminal, scrollTerminal, resizeTerminal, saveTempImage, writeToClipboard } = await import(
      "../../lib/ipc/commands"
    );
    const { onTerminalGrid, onTerminalExit, onTerminalClipboard } = await import(
      "../../lib/ipc/events"
    );

    // Cache resizeTerminal for use in handleResize
    cachedResizeTerminal = resizeTerminal;

    renderer = new TerminalRenderer(canvasEl, settings.terminal.font_size, `${settings.terminal.font_family}, Consolas, 'Courier New', monospace`);

    // Apply current theme immediately
    {
      const style = getComputedStyle(document.documentElement);
      applyTerminalTheme(
        style.getPropertyValue('--bg-editor').trim(),
        style.getPropertyValue('--accent').trim(),
      );
    }

    // Listen for theme changes
    const onThemeApplied = (e: Event) => {
      const { bg, accent } = (e as CustomEvent).detail;
      applyTerminalTheme(bg, accent);
    };
    window.addEventListener('splice:theme-applied', onThemeApplied);
    cleanupFns.push(() => window.removeEventListener('splice:theme-applied', onThemeApplied));

    // Force full repaint when the app window regains OS focus — the GPU compositor
    // may have cleared the canvas backing store while the window was backgrounded.
    const onWindowFocus = () => { if (renderer) renderer.rerender(); };
    window.addEventListener('focus', onWindowFocus);
    cleanupFns.push(() => window.removeEventListener('focus', onWindowFocus));

    // Listen for grid updates, throttle rendering to RAF
    let pendingFrame: Uint8Array | null = null;

    unlistenGrid = await onTerminalGrid(
      terminalId,
      (data: Uint8Array) => {
        if (data.length >= HEADER_SIZE) {
          const hv = new DataView(data.buffer, data.byteOffset);
          frameCols = hv.getUint16(0, true);
          frameRows = hv.getUint16(2, true);
          modeFlags = data[10];
          frameFirstDisplayHistoryRow = hv.getInt32(12, true);
          frameScrollbackLen = hv.getUint32(16, true);
        }
        // Update renderer metadata immediately (before RAF) so that rerender()
        // called from mouse events uses the correct history coordinates in isSelected().
        if (renderer) renderer.setLatestFrame(data);
        pendingFrame = data;
        if (!rafId) {
          rafId = requestAnimationFrame(() => {
            rafId = 0;
            if (pendingFrame && renderer) {
              renderer.render(pendingFrame);
              pendingFrame = null;
            }
          });
        }
      },
    );

    unlistenExit = await onTerminalExit(terminalId, (_code: number) => {
      // Could show exit message
    });

    // OSC 52: remote clipboard writes (e.g. from tmux, vim over SSH)
    unlistenClipboard = await onTerminalClipboard(terminalId, (text: string) => {
      navigator.clipboard.writeText(text).catch(console.error);
    });

    // Initial resize
    handleResize();

    /** Extract selected text via the Rust backend (supports cross-scroll selections). */
    async function extractSelectionText(): Promise<string> {
      if (!renderer?.selectionStart || !renderer?.selectionEnd) return "";
      const a = renderer.selectionStart;
      const b = renderer.selectionEnd;
      // lo = smaller historyRow = top/older, hi = larger = bottom/newer
      const [lo, hi] = a.historyRow <= b.historyRow ? [a, b] : [b, a];
      const { getTerminalTextRange } = await import("../../lib/ipc/commands");
      const lines = await getTerminalTextRange(terminalId, lo.historyRow, hi.historyRow);
      if (lines.length === 0) return "";
      if (lines.length === 1) {
        const minCol = Math.min(lo.col, hi.col);
        const maxCol = Math.max(lo.col, hi.col);
        return lines[0].substring(minCol, maxCol + 1).trimEnd();
      }
      const segments = [
        lines[0].substring(lo.col).trimEnd(),
        ...lines.slice(1, -1).map(l => l.trimEnd()),
        lines[lines.length - 1].substring(0, hi.col + 1).trimEnd(),
      ];
      let result = "";
      for (let i = 0; i < segments.length; i++) {
        result += segments[i];
        if (i < segments.length - 1) {
          // Soft-wrap: raw line's last char is non-space → join without newline
          const rawLastChar = lines[i][lines[i].length - 1];
          result += (rawLastChar !== ' ' && rawLastChar !== '\0') ? "" : "\n";
        }
      }
      return result.replace(/\n+$/, "");
    }

    /** Encode and send a mouse event to the terminal PTY. */
    function sendMouseEvent(button: number, cx: number, cy: number, press: boolean) {
      const mouseSgr = (modeFlags & 0x20) !== 0;
      if (mouseSgr) {
        // SGR extended: ESC[<button;cx;cyM (press) / ESC[<button;cx;cym (release)
        writeToTerminal(terminalId, textEncoder.encode(
          `\x1b[<${button};${cx};${cy}${press ? "M" : "m"}`
        ));
      } else {
        // X10 fallback: ESC[M<b><x><y> (3 bytes, clamped to 32-255)
        const b = Math.min(32 + button, 255);
        const x = Math.min(32 + cx, 255);
        const y = Math.min(32 + cy, 255);
        writeToTerminal(terminalId, new Uint8Array([0x1b, 0x5b, 0x4d, b, x, y]));
      }
    }

    // Keyboard handler
    const onKeyDown = async (e: KeyboardEvent) => {
      // Cmd+C with selection → copy
      if (e.metaKey && e.key.toLowerCase() === "c" && renderer?.selectionStart) {
        e.preventDefault();
        const text = await extractSelectionText();
        if (text) {
          writeToClipboard(text).catch(console.error);
        }
        return;
      }

      // Cmd+V → flag this terminal as the paste target, then let the browser fire
      // the paste event (intercepted at document capture level by onPaste below).
      if (e.metaKey && e.key === "v") {
        pendingPaste = true;
        setTimeout(() => { pendingPaste = false; }, 100);
        return;
      }

      const bytes = keyToBytes(e, (modeFlags & 2) !== 0);
      if (bytes) {
        e.preventDefault();
        // Clear selection on typing
        if (renderer?.selectionStart) {
          renderer.setSelection(null, null);
          renderer.rerender();
        }
        resetBlinkTimer();
        attentionStore.clear(terminalId);
        writeToTerminal(terminalId, bytes);
      }
    };
    canvasEl.addEventListener("keydown", onKeyDown);
    cleanupFns.push(() => canvasEl!.removeEventListener("keydown", onKeyDown));

    // Paste handler — registered at document capture level so it fires before
    // CodeMirror's contenteditable receives the event. On macOS/WKWebView the
    // browser routes paste to the nearest editable element (CodeMirror) even
    // when the canvas has keyboard focus, bypassing canvas-level listeners.
    // pendingPaste (set in onKeyDown above) identifies this terminal as the
    // intended paste target.
    let pendingPaste = false;
    const onPaste = (e: ClipboardEvent) => {
      if (!pendingPaste) return;
      pendingPaste = false;
      e.preventDefault();
      e.stopImmediatePropagation();

      // Image paste: save to a temp file and type the path into the terminal.
      if (e.clipboardData?.items) {
        for (const item of Array.from(e.clipboardData.items)) {
          if (item.type.startsWith("image/")) {
            const blob = item.getAsFile();
            if (blob) {
              const ext = item.type.split("/")[1].replace("jpeg", "jpg");
              blob.arrayBuffer().then(async (buf) => {
                const path = await saveTempImage(new Uint8Array(buf), ext);
                writeToTerminal(terminalId, textEncoder.encode(path));
              }).catch(console.error);
            }
            return;
          }
        }
      }

      const text = e.clipboardData?.getData("text");
      if (!text) return;
      const bracketed = (modeFlags & 1) !== 0;
      let bytes: Uint8Array;
      if (bracketed) {
        const prefix = textEncoder.encode("\x1b[200~");
        const content = textEncoder.encode(text);
        const suffix = textEncoder.encode("\x1b[201~");
        bytes = new Uint8Array(
          prefix.length + content.length + suffix.length,
        );
        bytes.set(prefix, 0);
        bytes.set(content, prefix.length);
        bytes.set(suffix, prefix.length + content.length);
      } else {
        bytes = textEncoder.encode(text);
      }
      writeToTerminal(terminalId, bytes);
    };
    document.addEventListener("paste", onPaste, { capture: true });
    cleanupFns.push(() => document.removeEventListener("paste", onPaste, { capture: true }));

    // Mouse selection and protocol forwarding
    const onMouseDown = (e: MouseEvent) => {
      if (!renderer) return;
      // Explicitly focus the canvas so Cmd+C keydown fires here (WKWebView doesn't
      // always auto-focus non-input elements on click even with tabindex="0").
      canvasEl!.focus();

      const mouseMode = (modeFlags >> 3) & 0x3;

      // When mouse protocol is active, forward button press to terminal
      if (mouseMode > 0) {
        let btn = e.button === 0 ? 0 : e.button === 1 ? 1 : 2;
        if (e.shiftKey) btn |= 4;
        if (e.altKey) btn |= 8;
        if (e.ctrlKey) btn |= 16;
        const rect = canvasEl!.getBoundingClientRect();
        const cell = renderer.pixelToCell(e.clientX - rect.left, e.clientY - rect.top);
        const cx = Math.min(Math.max(1, cell.col + 1), 223); // 1-based, clamped for X10
        const cy = Math.min(Math.max(1, cell.row + 1), 223);
        sendMouseEvent(btn, cx, cy, true);
        return;
      }

      // Only handle left button for selection
      if (e.button !== 0) return;

      const rect = canvasEl!.getBoundingClientRect();
      const cell = renderer.pixelToCell(e.clientX - rect.left, e.clientY - rect.top);
      const historyRow = renderer.displayToHistoryRow(cell.row, frameFirstDisplayHistoryRow);

      // Shift+click: extend existing selection
      if (e.shiftKey && renderer.selectionStart) {
        renderer.selectionEnd = { historyRow, col: cell.col };
        renderer.rerender();
        return;
      }

      if (e.detail === 3) {
        // Triple-click: select entire line
        const cols = frameCols || currentCols || 80;
        renderer.setSelection({ historyRow, col: 0 }, { historyRow, col: cols - 1 });
        renderer.rerender();
        return;
      }

      if (e.detail === 2) {
        // Double-click: word select across soft-wrapped rows
        const data = renderer.currentFrame;
        if (data) {
          const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
          const cols = view.getUint16(0, true);
          const rows = view.getUint16(2, true);

          function cpAt(r: number, c: number): number | null {
            if (r < 0 || r >= rows || c < 0 || c >= cols) return null;
            const off = HEADER_SIZE + (r * cols + c) * CELL_SIZE;
            if (off + CELL_SIZE > data!.length) return null;
            return view.getUint32(off, true);
          }

          let startRow = cell.row;
          let startCol = cell.col;
          let endRow = cell.row;
          let endCol = cell.col;

          // Scan left; wrap to previous row when at left edge and that row's
          // last char is non-break (indicates the row was soft-wrapped).
          outer_left: while (true) {
            while (startCol > 0) {
              const cp = cpAt(startRow, startCol - 1);
              if (cp === null || isWordBreak(cp)) break outer_left;
              startCol--;
            }
            if (startRow === 0) break;
            const prevLast = cpAt(startRow - 1, cols - 1);
            if (prevLast === null || isWordBreak(prevLast)) break;
            startRow--;
            startCol = cols - 1;
          }

          // Scan right; wrap to next row when at right edge and the next
          // row's first char is non-break.
          outer_right: while (true) {
            while (endCol < cols - 1) {
              const cp = cpAt(endRow, endCol + 1);
              if (cp === null || isWordBreak(cp)) break outer_right;
              endCol++;
            }
            if (endRow >= rows - 1) break;
            const nextFirst = cpAt(endRow + 1, 0);
            if (nextFirst === null || isWordBreak(nextFirst)) break;
            endRow++;
            endCol = 0;
          }

          const selStart = {
            historyRow: renderer.displayToHistoryRow(startRow, frameFirstDisplayHistoryRow),
            col: startCol,
          };
          const selEnd = {
            historyRow: renderer.displayToHistoryRow(endRow, frameFirstDisplayHistoryRow),
            col: endCol,
          };
          renderer.setSelection(selStart, selEnd);
          renderer.rerender();
        }
        return;
      }

      // Single click: start selection
      isSelecting = true;
      renderer.setSelection({ historyRow, col: cell.col }, { historyRow, col: cell.col });
      renderer.rerender();
    };

    const onMouseMove = (e: MouseEvent) => {
      const mouseMode = (modeFlags >> 3) & 0x3;

      // Mouse protocol motion events
      if (mouseMode > 0) {
        if (!renderer) return;
        const isButtonHeld = e.buttons !== 0;
        if (mouseMode === 3 || (mouseMode === 2 && isButtonHeld)) {
          const rect = canvasEl!.getBoundingClientRect();
          const cell = renderer.pixelToCell(e.clientX - rect.left, e.clientY - rect.top);
          const cx = Math.min(Math.max(1, cell.col + 1), 223);
          const cy = Math.min(Math.max(1, cell.row + 1), 223);
          // Derive held button from e.buttons bitmask
          const btn = (e.buttons & 1) ? 0 : (e.buttons & 4) ? 1 : (e.buttons & 2) ? 2 : 0;
          sendMouseEvent(32 + btn, cx, cy, true);
        }
        return;
      }

      if (!isSelecting || !renderer || !canvasEl) return;
      const rect = canvasEl.getBoundingClientRect();
      const cell = renderer.pixelToCell(e.clientX - rect.left, e.clientY - rect.top);
      const historyRow = renderer.displayToHistoryRow(cell.row, frameFirstDisplayHistoryRow);
      renderer.selectionEnd = { historyRow, col: cell.col };
      renderer.rerender();

      // Drag autoscroll: when pointer leaves canvas edges, scroll while dragging
      if (dragScrollInterval) { clearInterval(dragScrollInterval); dragScrollInterval = null; }
      const overTop = e.clientY < rect.top;
      const overBottom = e.clientY > rect.bottom;
      if (overTop || overBottom) {
        dragScrollInterval = setInterval(() => {
          scrollTerminal(terminalId, overTop ? 1 : -1).catch(() => {});
        }, 80);
      }
    };

    const onMouseUp = async (e: MouseEvent) => {
      const mouseMode = (modeFlags >> 3) & 0x3;

      // Mouse protocol: forward button release
      if (mouseMode > 0) {
        if (!renderer) return;
        let btn = e.button === 0 ? 0 : e.button === 1 ? 1 : 2;
        if (e.shiftKey) btn |= 4;
        if (e.altKey) btn |= 8;
        if (e.ctrlKey) btn |= 16;
        const rect = canvasEl!.getBoundingClientRect();
        const cell = renderer.pixelToCell(e.clientX - rect.left, e.clientY - rect.top);
        const cx = Math.min(Math.max(1, cell.col + 1), 223);
        const cy = Math.min(Math.max(1, cell.row + 1), 223);
        sendMouseEvent(btn, cx, cy, false);
        return;
      }

      if (dragScrollInterval) { clearInterval(dragScrollInterval); dragScrollInterval = null; }
      if (!isSelecting) return;
      isSelecting = false;
      // If start === end cell, clear selection (was just a click, not a drag)
      if (
        renderer?.selectionStart &&
        renderer?.selectionEnd &&
        renderer.selectionStart.col === renderer.selectionEnd.col &&
        renderer.selectionStart.historyRow === renderer.selectionEnd.historyRow
      ) {
        renderer.setSelection(null, null);
        renderer.rerender();
        // URL click: if a URL was hovered at click time, open it
        if (renderer?.hoveredUrl) {
          const url = renderer.hoveredUrl.url;
          import("@tauri-apps/plugin-shell").then(({ open }) => open(url)).catch(() => {});
        }
      } else if (settings.terminal.copy_on_select && renderer?.selectionStart && renderer?.selectionEnd) {
        const text = await extractSelectionText();
        if (text) writeToClipboard(text).catch(console.error);
      }
    };

    canvasEl.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    cleanupFns.push(() => canvasEl!.removeEventListener("mousedown", onMouseDown));
    cleanupFns.push(() => window.removeEventListener("mousemove", onMouseMove));
    cleanupFns.push(() => window.removeEventListener("mouseup", onMouseUp));

    // Canvas-level hover: URL detection (only fires when pointer is over the canvas)
    const onCanvasMouseMove = (e: MouseEvent) => {
      if (!renderer || isSelecting || ((modeFlags >> 3) & 0x3) !== 0) return;
      const rect = canvasEl!.getBoundingClientRect();
      const cell = renderer.pixelToCell(e.clientX - rect.left, e.clientY - rect.top);
      const historyRow = renderer.displayToHistoryRow(cell.row, frameFirstDisplayHistoryRow);
      const url = renderer.detectedUrls.find(u =>
        u.historyRow === historyRow && cell.col >= u.colStart && cell.col < u.colEnd
      );
      const prevHovered = renderer.hoveredUrl;
      renderer.hoveredUrl = url ?? null;
      if (prevHovered !== renderer.hoveredUrl) {
        canvasEl!.style.cursor = url ? "pointer" : "";
        renderer.rerender();
      }
    };
    const onMouseLeave = () => {
      if (renderer && renderer.hoveredUrl !== null) {
        renderer.hoveredUrl = null;
        canvasEl!.style.cursor = "";
        renderer.rerender();
      }
    };
    canvasEl.addEventListener("mousemove", onCanvasMouseMove);
    canvasEl.addEventListener("mouseleave", onMouseLeave);
    cleanupFns.push(() => canvasEl!.removeEventListener("mousemove", onCanvasMouseMove));
    cleanupFns.push(() => canvasEl!.removeEventListener("mouseleave", onMouseLeave));

    // Mouse wheel for scrollback — accumulate deltas, flush once per RAF
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!renderer) return;

      const mouseMode = (modeFlags >> 3) & 0x3;

      // When mouse protocol is active, forward wheel events as button 64/65
      if (mouseMode > 0) {
        const rect = canvasEl!.getBoundingClientRect();
        const cell = renderer.pixelToCell(e.clientX - rect.left, e.clientY - rect.top);
        const cx = Math.min(Math.max(1, cell.col + 1), 223);
        const cy = Math.min(Math.max(1, cell.row + 1), 223);
        const wheelBtn = e.deltaY < 0 ? 64 : 65; // 64=scroll-up, 65=scroll-down
        sendMouseEvent(wheelBtn, cx, cy, true);
        return;
      }

      // Reset accumulator on direction change to avoid stickiness
      if ((e.deltaY > 0 && scrollAccum < 0) || (e.deltaY < 0 && scrollAccum > 0)) {
        scrollAccum = 0;
      }
      scrollAccum += e.deltaY;
      if (!scrollRafId) {
        scrollRafId = requestAnimationFrame(() => {
          scrollRafId = 0;
          const ch = renderer!.cellHeight;
          const lines = Math.trunc(scrollAccum / ch);
          if (lines !== 0) {
            scrollAccum -= lines * ch;
            scrollTerminal(terminalId, -lines).catch(console.error);
          }
        });
      }
    };
    canvasEl.addEventListener("wheel", onWheel, { passive: false });
    cleanupFns.push(() => canvasEl!.removeEventListener("wheel", onWheel));

    // Focus/blur — send CSI I / CSI O when application requests focus events (mode 1004)
    const onFocus = () => {
      if (renderer) {
        renderer.setFocused(true);
        renderer.rerender();
      }
      resetBlinkTimer();
      if ((modeFlags & 0x40) !== 0) {
        writeToTerminal(terminalId, textEncoder.encode("\x1b[I"));
      }
    };
    const onBlur = () => {
      if (renderer) {
        renderer.setFocused(false);
        renderer.setCursorBlink(true); // Show cursor when blurred
        renderer.rerender();
      }
      if (blinkInterval) {
        clearInterval(blinkInterval);
        blinkInterval = null;
      }
      if ((modeFlags & 0x40) !== 0) {
        writeToTerminal(terminalId, textEncoder.encode("\x1b[O"));
      }
    };
    canvasEl.addEventListener("focus", onFocus);
    canvasEl.addEventListener("blur", onBlur);
    cleanupFns.push(() => canvasEl!.removeEventListener("focus", onFocus));
    cleanupFns.push(() => canvasEl!.removeEventListener("blur", onBlur));

    // Start cursor blink
    resetBlinkTimer();

    // Resize observer, RAF-batched
    resizeObserver = new ResizeObserver(() => {
      if (!resizeRafId) {
        resizeRafId = requestAnimationFrame(() => {
          resizeRafId = 0;
          handleResize();
        });
      }
    });
    resizeObserver.observe(containerEl);

    // Context menu
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // When mouse protocol is active, suppress context menu (right-click was forwarded as mouse event)
      if (((modeFlags >> 3) & 0x3) !== 0) return;

      const hasSelection = !!(renderer?.selectionStart && renderer?.selectionEnd);

      showContextMenu([
        { label: "New Terminal", shortcut: "⌘N", action: () =>
            workspaceManager.spawnTerminalInWorkspace()
        },
        "sep",
        { label: "Copy",       shortcut: "⌘C", disabled: !hasSelection, action: async () => {
            const text = await extractSelectionText();
            if (text) writeToClipboard(text).catch(console.error);
        }},
        { label: "Paste",      shortcut: "⌘V", action: async () => {
            const text = await navigator.clipboard.readText().catch(() => "");
            if (text) writeToTerminal(terminalId, new TextEncoder().encode(text));
        }},
        { label: "Select All", shortcut: "⌘A", action: () => {
            if (!renderer) return;
            const rows = frameRows || currentRows || 24;
            const cols = frameCols || currentCols || 80;
            const sbLen = renderer.currentScrollbackLen;
            renderer.selectionStart = { historyRow: 0, col: 0 };
            renderer.selectionEnd   = { historyRow: sbLen + rows - 1, col: cols - 1 };
            renderer.rerender();
        }},
        { label: "Clear",      shortcut: "⌘K", action: () =>
            writeToTerminal(terminalId, new Uint8Array([0x0c]))
        },
        "sep",
        { label: "Close Terminal Tab", action: () => {
            const ws = workspaceManager.activeWorkspace;
            const entry = ws ? Object.entries(ws.panes).find(([_, p]) => p.kind === "terminal" && p.terminalId === terminalId) : undefined;
            const paneIdToClose = entry?.[0];
            if (paneIdToClose) workspaceManager.closePaneInWorkspace(paneIdToClose);
        }},
      ], e.clientX, e.clientY);
    };
    canvasEl.addEventListener("contextmenu", onContextMenu);
    cleanupFns.push(() => canvasEl!.removeEventListener("contextmenu", onContextMenu));

    // Focus on mount
    requestAnimationFrame(() => canvasEl?.focus());
  });

  onDestroy(() => {
    // Cancel any pending animation frames before tearing down so RAF callbacks
    // don't fire on a detached canvas or make IPC calls to a killed terminal.
    cancelAnimationFrame(rafId);
    cancelAnimationFrame(scrollRafId);
    cancelAnimationFrame(resizeRafId);
    rafId = 0;
    scrollRafId = 0;
    resizeRafId = 0;
    // Clear drag autoscroll interval
    if (dragScrollInterval) { clearInterval(dragScrollInterval); dragScrollInterval = null; }
    // Null renderer first so any stale RAF callbacks that already started are no-ops
    renderer = null;
    // Remove all event listeners
    for (const fn of cleanupFns) {
      fn();
    }
    cleanupFns = [];
    unlistenGrid?.();
    unlistenExit?.();
    unlistenClipboard?.();
    resizeObserver?.disconnect();
    if (blinkInterval) clearInterval(blinkInterval);
  });
</script>

{#if isTauri && terminalId > 0}
  <div bind:this={containerEl} class="canvas-terminal-container">
    <canvas bind:this={canvasEl} class="terminal-canvas" tabindex="0"
    ></canvas>
  </div>
{:else}
  <div
    class="flex-1 overflow-auto px-2.5 py-1.5 text-xs leading-[1.45] text-txt whitespace-pre-wrap break-all"
    style="font-family: var(--font-family)"
  ></div>
{/if}

<style>
  .canvas-terminal-container {
    flex: 1;
    overflow: hidden;
    min-width: 0;
    min-height: 0;
    contain: strict;
    background-color: var(--bg-editor, #1e1e1e);
  }
  .terminal-canvas {
    width: 100%;
    height: 100%;
    display: block;
    outline: none;
  }
</style>
