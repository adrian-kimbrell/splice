<script lang="ts">
  import { log } from "../../lib/utils/log";
  /**
   * CanvasTerminal.svelte -- HTML5 Canvas-based terminal emulator frontend.
   *
   * Receives binary frames from the Rust backend via the onTerminalGrid event. Each frame
   * has a 20-byte header (cols, rows, cursor pos, mode flags, scroll metadata) followed by
   * a flat array of cells (CELL_SIZE bytes each: codepoint + fg/bg/attrs). Frames are
   * rendered at most once per requestAnimationFrame via TerminalRenderer.
   *
   * Font/DPI: TerminalRenderer handles devicePixelRatio scaling and font measurement.
   * Font family and size come from settings.terminal.*. The canvas CSS size uses
   * offsetWidth/offsetHeight (not getBoundingClientRect) to stay correct under UI zoom.
   *
   * Resize: A ResizeObserver (RAF-batched) calls handleResize(), which updates the canvas
   * dimensions and sends a PTY resize IPC when cols/rows change. Extra $effects force
   * remeasure on UI zoom change and pane zoom toggle (ResizeObserver misses those).
   *
   * Selection: mousedown starts tracking, mousemove extends, mouseup finalizes. Double-click
   * selects a word (scanning across soft-wrapped rows via frame cell data). Triple-click
   * selects the full line. Shift+click extends. Drag past edges auto-scrolls.
   * extractSelectionText() fetches the actual text from Rust for clipboard copy.
   *
   * Mouse protocol: When the running program enables mouse reporting (mode flags bits 3-4),
   * mouse events are forwarded as SGR or X10 escape sequences instead of doing selection.
   *
   * Scroll: Wheel events accumulate fractional deltas and flush whole-line scrolls per RAF.
   * In mouse-protocol mode, wheel events become button 64/65 sequences.
   */
  import { onMount, onDestroy, untrack } from "svelte";
  import { TerminalRenderer } from "../../lib/terminal/renderer";
  import { decodeHeader, mouseModeOf, MODE_APP_CURSOR_KEYS, MODE_BRACKETED_PASTE, MODE_MOUSE_SGR, MODE_FOCUS_EVENTS } from "../../lib/terminal/protocol";
  import { encodeMouseButton, heldButton, cellToReport, encodeMouseEvent, MOUSE_MOTION, MOUSE_NO_BUTTON, MOUSE_WHEEL_UP, MOUSE_WHEEL_DOWN } from "../../lib/terminal/mouse";
  import { wordRangeAt, joinSelectedLines } from "../../lib/terminal/selection";
  import { encodePaste } from "../../lib/terminal/paste";
  import type { TerminalSearchMatch } from "../../lib/ipc/commands";
  import { effectiveSettings } from "../../lib/stores/settings.svelte";
  import { ui } from "../../lib/stores/ui.svelte";
  import { attentionStore } from "../../lib/stores/attention.svelte";
  import { keyToBytes } from "../../lib/terminal/keyboard";
  import { workspaceManager } from "../../lib/stores/workspace.svelte";
  import { showContextMenu } from "../../lib/utils/context-menu";
  import { clientToLayoutOffset } from "../../lib/utils/zoom";
  import { savedPrompts } from "../../lib/stores/prompts.svelte";

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
  let unlistenClipboard: (() => void) | null = null;
  // Set true in onDestroy. Async listener registrations check this after their
  // await resolves; if destroyed before resolution, they immediately unlisten the
  // newly-registered handler. Without this, the unlisten in onDestroy fires before
  // the Promise resolves (unlistenGrid still null), and the listener orphans —
  // resulting in duplicate frames after a remount (e.g. layout shape change).
  let destroyed = false;
  let modeFlags = 0;
  let currentCols = 0;
  let currentRows = 0;

  // Cached IPC functions from dynamic import
  let cachedResizeTerminal: ((id: number, cols: number, rows: number) => Promise<void>) | null = null;
  let cachedRefreshTerminal: ((id: number) => Promise<void>) | null = null;
  // True once at least one grid frame has arrived. Until then the canvas is blank,
  // so we keep asking the backend to re-emit (see requestFrameUntilReceived).
  let hasReceivedFrame = false;
  let frameRetryTimer: ReturnType<typeof setTimeout> | null = null;

  // The emitter only sends a frame when the grid version changes. If the first
  // frame was emitted before our listener finished registering (listen() is an
  // IPC round-trip and can take hundreds of ms when the machine is under heavy
  // load), it is lost and nothing re-sends it until the shell prints again — the
  // pane just sits blank. So after registering, request a re-emit and keep
  // retrying with backoff until a frame lands. refresh_terminal only bumps the
  // grid version; it does not resize the PTY or signal the shell.
  const FRAME_RETRY_DELAYS_MS = [150, 400, 1000, 2000, 4000, 8000];
  function requestFrameUntilReceived(attempt = 0) {
    // A retry chain is already running when frameRetryTimer is set (the chain
    // clears it right before each recursive call).
    if (destroyed || hasReceivedFrame || !cachedRefreshTerminal || frameRetryTimer) return;
    cachedRefreshTerminal(terminalId).catch(() => {});
    if (attempt >= FRAME_RETRY_DELAYS_MS.length) return;
    frameRetryTimer = setTimeout(() => {
      frameRetryTimer = null;
      requestFrameUntilReceived(attempt + 1);
    }, FRAME_RETRY_DELAYS_MS[attempt]);
  }

  // Cursor blink state. Only the focused terminal blinks; unfocused panes show a
  // steady (hollow) cursor, so switching workspaces doesn't leave every terminal flashing.
  let blinkInterval: ReturnType<typeof setInterval> | null = null;
  let blinkVisible = true;
  let focused = false;

  // Selection state
  let isSelecting = false;
  let dragScrollInterval: ReturnType<typeof setInterval> | null = null;
  // Clicking an inactive Splice window to bring it back (after a link opened the
  // browser, say) must not act on the terminal: it would re-open the still-hovered
  // URL. Two signals cover both event orders WebKit produces: `focusClickPending`
  // is set by the window `focus` event and consumed by the next mousedown, and
  // `windowFocused` is false from `blur` until `focus`, for the case where the
  // activating mousedown is delivered before the focus event.
  let focusClickPending = false;
  let windowFocused = document.hasFocus();

  // Frame metadata (updated each time a frame arrives)
  let frameFirstDisplayHistoryRow = 0;
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
  // Set when a resize is skipped because a sidebar drag is in progress; flushed once
  // the drag ends (see the $effect below) so the terminal ends at the correct size.
  let pendingResize = false;

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

  // Re-fit terminal when its workspace becomes visible after a workspace/tab switch.
  // (`active` here means "this terminal's workspace is active", not the active pane —
  // pane focus on switch is handled centrally in App.svelte.)
  $effect(() => {
    if (active && renderer && containerEl) {
      requestAnimationFrame(() => {
        handleResize();
        // Still blank (never got a frame while hidden)? Ask again now that the
        // user is looking at it.
        if (!hasReceivedFrame) requestFrameUntilReceived();
      });
    }
  });

  // Update terminal font when settings change. Only the two font settings are
  // dependencies: handleResize reads ui.sidebarResizing, and tracking that here
  // re-ran the font update on every sidebar drag.
  $effect(() => {
    if (!renderer) return;
    const fs = effectiveSettings.terminal.font_size;
    const ff = `${effectiveSettings.terminal.font_family}, Consolas, 'Courier New', monospace`;
    untrack(() => {
      renderer!.updateFont(fs, ff);
      handleResize();
      renderer!.rerender();
    });
  });

  // Re-fit after layout changes the ResizeObserver cannot see:
  // - UI zoom: ResizeObserver reports CSS content-box sizes, which do not change
  //   when only document.documentElement.style.zoom changes.
  // - Pane zoom: the overlay mounts a second instance that resizes the PTY; when
  //   zoom is dismissed the original (hidden via visibility:hidden) never saw its
  //   container change.
  // Double-RAF: WebKit needs two frames before offsetWidth reflects the new zoom.
  // currentCols/currentRows are reset so the PTY gets a SIGWINCH even when the
  // computed size happens to match. The first run only records the state: the
  // mount-time handleResize has already fitted the PTY.
  let refitKey: string | null = null;
  $effect(() => {
    const key = `${effectiveSettings.appearance.ui_scale}|${ui.zoomedPaneId ?? ""}`;
    if (!renderer || !containerEl) return;
    if (refitKey === key) return;
    const first = refitKey === null;
    refitKey = key;
    if (first) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      currentCols = 0;
      currentRows = 0;
      handleResize();
    }));
  });

  // Toggle cursor blink based on settings
  $effect(() => {
    if (!renderer) return;
    if (effectiveSettings.terminal.cursor_blink) {
      resetBlinkTimer();
    } else {
      if (blinkInterval) { clearInterval(blinkInterval); blinkInterval = null; }
      renderer.setCursorBlink(true);
      renderer.rerender();
    }
  });

  /**
   * Map a mouse/wheel event to a terminal cell, correcting for root CSS zoom
   * (`document.documentElement.style.zoom`, driven by appearance.ui_scale).
   *
   * Under zoom, getBoundingClientRect() and clientX/Y are in zoom-scaled
   * viewport pixels, but the canvas CSS size and the renderer's cell metrics
   * are in unzoomed layout pixels. Scale the in-rect offset by
   * offsetSize/rectSize (= 1/zoom) so dividing by cell size lands on the
   * correct row/col. When zoom is 1 the scale is 1 and this is a no-op.
   */
  function eventToCell(e: MouseEvent | WheelEvent): { col: number; row: number } {
    // Layout-px offset within the canvas (zoom-correct at any ui_scale), then map
    // to a cell via the renderer's layout-px metrics. See [[zoom-coords]].
    const { x, y } = clientToLayoutOffset(e.clientX, e.clientY, canvasEl!);
    return renderer!.pixelToCell(x, y);
  }

  // Padding applied to the container (must match CSS: 0 8px 4px 8px)
  const CANVAS_PAD_X = 16; // 8px left + 8px right
  const CANVAS_PAD_Y = 4;  // 4px bottom

  function handleResize() {
    if (!containerEl || !canvasEl || !renderer || !cachedResizeTerminal) return;
    // While a sidebar divider is being dragged, defer the expensive refit (a
    // resizeTerminal IPC / PTY round-trip). The canvas just visually stretches;
    // the real refit runs once when the drag ends. Without this, dragging the
    // sidebar fired a PTY resize per terminal per frame.
    if (ui.sidebarResizing) { pendingResize = true; return; }
    // Use offsetWidth/offsetHeight (CSS layout dimensions) rather than
    // getBoundingClientRect() (viewport coordinates). getBCR is scaled by
    // document.documentElement.style.zoom, but canvas.style.width is set in
    // CSS element coordinates — using getBCR here causes the canvas to be
    // incorrectly sized and the PTY to get wrong col/row counts when zoomed.
    const w = Math.max(1, containerEl.offsetWidth - CANVAS_PAD_X);
    const h = Math.max(1, containerEl.offsetHeight - CANVAS_PAD_Y);
    if (w <= 1 || h <= 1) return;

    renderer.updateCanvasSize(w, h);
    const { cols, rows } = renderer.calculateGridSize(w, h);
    if (cols > 0 && rows > 0 && (cols !== currentCols || rows !== currentRows)) {
      currentCols = cols;
      currentRows = rows;
      cachedResizeTerminal(terminalId, cols, rows).catch(log.error);
    }
  }

  // Flush the deferred refit once a sidebar drag ends. Only re-runs when
  // ui.sidebarResizing toggles (pendingResize is intentionally non-reactive).
  $effect(() => {
    if (!ui.sidebarResizing && pendingResize) {
      pendingResize = false;
      handleResize();
    }
  });

  function resetBlinkTimer() {
    if (blinkInterval) { clearInterval(blinkInterval); blinkInterval = null; }
    if (renderer) {
      blinkVisible = true;
      renderer.setCursorBlink(true);
      renderer.rerender();
    }
    // Only blink when this terminal is focused and blinking is enabled. Without the
    // focus guard, every visible terminal blinks (the settings effect / mount both
    // call this), which is the "all terminals flashing on workspace switch" bug.
    if (!focused || !effectiveSettings.terminal.cursor_blink) return;
    blinkInterval = setInterval(() => {
      if (renderer && focused && containerEl?.offsetParent !== null) {
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

    const { writeToTerminal, scrollTerminal, resizeTerminal, refreshTerminal, saveTempImage, writeToClipboard } = await import(
      "../../lib/ipc/commands"
    );
    const { onTerminalGrid, onTerminalClipboard } = await import(
      "../../lib/ipc/events"
    );

    // Cache IPC fns for use in handleResize / requestFrameUntilReceived
    cachedResizeTerminal = resizeTerminal;
    cachedRefreshTerminal = refreshTerminal;

    renderer = new TerminalRenderer(canvasEl, effectiveSettings.terminal.font_size, `${effectiveSettings.terminal.font_family}, Consolas, 'Courier New', monospace`);

    // Install resize handlers EARLY — before any awaits — so window resizes during
    // listener-registration init aren't missed. handleResize() guards on
    // !renderer || !cachedResizeTerminal, so calls before setup completes are no-ops.
    // The window.resize listener is a belt-and-suspenders backup: ResizeObserver can
    // miss the initial fire when the element starts at 0,0 size during HMR/init,
    // but window.resize fires unconditionally on every window dimension change.
    resizeObserver = new ResizeObserver(() => {
      if (!resizeRafId) {
        resizeRafId = requestAnimationFrame(() => {
          resizeRafId = 0;
          handleResize();
        });
      }
    });
    resizeObserver.observe(containerEl);
    const onWindowResize = () => {
      if (!resizeRafId) {
        resizeRafId = requestAnimationFrame(() => {
          resizeRafId = 0;
          handleResize();
        });
      }
    };
    window.addEventListener("resize", onWindowResize);
    cleanupFns.push(() => window.removeEventListener("resize", onWindowResize));

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
    // Also set focusClickPending so the first click after refocus doesn't trigger
    // a stale URL open (hoveredUrl may still point at the link from before blur).
    const onWindowFocus = () => {
      if (renderer) renderer.rerender();
      windowFocused = true;
      focusClickPending = true;
      // A refocus by keyboard (⌘Tab) has no click to consume; don't swallow a
      // later, deliberate click.
      setTimeout(() => { focusClickPending = false; }, 500);
    };
    const onWindowBlur = () => {
      windowFocused = false;
      focusClickPending = false;
      // The pointer may still sit on the link when the browser comes to the front.
      if (renderer?.hoveredUrl) {
        renderer.hoveredUrl = null;
        renderer.rerender();
      }
    };
    window.addEventListener('focus', onWindowFocus);
    window.addEventListener('blur', onWindowBlur);
    cleanupFns.push(() => window.removeEventListener('focus', onWindowFocus));
    cleanupFns.push(() => window.removeEventListener('blur', onWindowBlur));

    // Listen for grid updates, throttle rendering to RAF
    let pendingFrame: Uint8Array | null = null;

    const gridUnlisten = await onTerminalGrid(
      terminalId,
      (data: Uint8Array) => {
        const header = decodeHeader(data);
        if (header) {
          frameCols = header.cols;
          frameRows = header.rows;
          modeFlags = header.modeFlags;
          frameFirstDisplayHistoryRow = header.firstDisplayHistoryRow;
        }
        // Update renderer metadata immediately (before RAF) so that rerender()
        // called from mouse events uses the correct history coordinates in isSelected().
        hasReceivedFrame = true;
        if (frameRetryTimer) { clearTimeout(frameRetryTimer); frameRetryTimer = null; }
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
    if (destroyed) { gridUnlisten(); return; }
    unlistenGrid = gridUnlisten;
    // Listener is live on both sides now — ask for the frame we may have missed.
    requestFrameUntilReceived();

    // OSC 52: remote clipboard writes (e.g. from tmux, vim over SSH)
    const clipUnlisten = await onTerminalClipboard(terminalId, (text: string) => {
      navigator.clipboard.writeText(text).catch(log.error);
    });
    if (destroyed) { clipUnlisten(); return; }
    unlistenClipboard = clipUnlisten;

    // Initial resize
    handleResize();

    // (The old 500ms "force a resize" safeguard was a no-op: handleResize only
    // issues the IPC when cols/rows changed, and they had not. Replaced by
    // requestFrameUntilReceived above.)
    cleanupFns.push(() => { if (frameRetryTimer) { clearTimeout(frameRetryTimer); frameRetryTimer = null; } });

    /** Extract selected text via the Rust backend (supports cross-scroll selections). */
    async function extractSelectionText(): Promise<string> {
      if (!renderer?.selectionStart || !renderer?.selectionEnd) return "";
      const a = renderer.selectionStart;
      const b = renderer.selectionEnd;
      // lo = smaller historyRow = top/older, hi = larger = bottom/newer
      const [lo, hi] = a.historyRow <= b.historyRow ? [a, b] : [b, a];
      const { getTerminalTextRange } = await import("../../lib/ipc/commands");
      const lines = await getTerminalTextRange(terminalId, lo.historyRow, hi.historyRow);
      return joinSelectedLines(lines, lo.col, hi.col);
    }

    /** Encode and send a mouse report to the terminal PTY (SGR when the app enabled it, else X10). */
    function sendMouseEvent(button: number, cx: number, cy: number, press: boolean) {
      writeToTerminal(terminalId, encodeMouseEvent(button, cx, cy, press, (modeFlags & MODE_MOUSE_SGR) !== 0));
    }

    // Keyboard handler
    const onKeyDown = async (e: KeyboardEvent) => {
      // Cmd+C with selection → copy
      if (e.metaKey && e.key.toLowerCase() === "c" && renderer?.selectionStart) {
        e.preventDefault();
        const text = await extractSelectionText();
        if (text) {
          writeToClipboard(text).catch(log.error);
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

      const bytes = keyToBytes(e, (modeFlags & MODE_APP_CURSOR_KEYS) !== 0);
      if (bytes) {
        e.preventDefault();
        // A key the shell consumed (Escape in vim, Ctrl+key) is not also a Splice
        // shortcut; ⌘ combos return null above and still reach the global handler.
        e.stopPropagation();
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
              }).catch(log.error);
            }
            return;
          }
        }
      }

      const text = e.clipboardData?.getData("text");
      if (!text) return;
      writeToTerminal(terminalId, encodePaste(text, (modeFlags & MODE_BRACKETED_PASTE) !== 0));
    };
    document.addEventListener("paste", onPaste, { capture: true });
    cleanupFns.push(() => document.removeEventListener("paste", onPaste, { capture: true }));

    // Mouse selection and protocol forwarding
    // True between a mouse-protocol press on this canvas and its release. Move and
    // release listeners live on `window` (so a drag that leaves the canvas still
    // ends), so without this every terminal in mouse mode received every release.
    let protocolPressActive = false;

    const onMouseDown = (e: MouseEvent) => {
      if (!renderer) return;
      // Explicitly focus the canvas so Cmd+C keydown fires here (WKWebView doesn't
      // always auto-focus non-input elements on click even with tabindex="0").
      canvasEl!.focus();

      // Consume the focus-regain click: when the user clicks to bring this window
      // back to the front the click-through would otherwise open a stale hoveredUrl.
      if (focusClickPending || !windowFocused) {
        focusClickPending = false;
        windowFocused = true;
        return;
      }

      const mouseMode = mouseModeOf(modeFlags);

      // When mouse protocol is active, forward button press to terminal — except
      // right-click (button 2), which always opens Splice's context menu (matches
      // Terminal.app). Without this, a TUI app in mouse mode (e.g. Claude Code
      // fullscreen) eats every right-click and the menu never appears.
      if (mouseMode > 0 && e.button !== 2) {
        const { cx, cy } = cellToReport(eventToCell(e));
        protocolPressActive = true;
        sendMouseEvent(encodeMouseButton(e), cx, cy, true);
        return;
      }

      // Only handle left button for selection
      if (e.button !== 0) return;

      const cell = eventToCell(e);
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
        const range = renderer.currentFrame ? wordRangeAt(renderer.currentFrame, cell.row, cell.col) : null;
        if (range) {
          renderer.setSelection(
            { historyRow: renderer.displayToHistoryRow(range.startRow, frameFirstDisplayHistoryRow), col: range.startCol },
            { historyRow: renderer.displayToHistoryRow(range.endRow, frameFirstDisplayHistoryRow), col: range.endCol },
          );
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
      const mouseMode = mouseModeOf(modeFlags);

      // Mouse protocol motion events. Button-drag motion (mode 2) is forwarded
      // only for a press that started on this canvas; any-motion (mode 3) only
      // while the pointer is over it (see onCanvasMouseMove).
      if (mouseMode > 0) {
        if (!renderer) return;
        if (mouseMode === 2 && protocolPressActive && e.buttons !== 0) {
          const { cx, cy } = cellToReport(eventToCell(e));
          sendMouseEvent(MOUSE_MOTION + heldButton(e.buttons), cx, cy, true);
        }
        return;
      }

      if (!isSelecting || !renderer || !canvasEl) return;
      const rect = canvasEl.getBoundingClientRect();
      const cell = eventToCell(e);
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
      const mouseMode = mouseModeOf(modeFlags);

      // Mouse protocol: forward the release of a press that started here (right-click
      // never sends a press, see mousedown; a release elsewhere is not ours).
      if (mouseMode > 0 && e.button !== 2) {
        if (!renderer || !protocolPressActive) return;
        protocolPressActive = false;
        const { cx, cy } = cellToReport(eventToCell(e));
        sendMouseEvent(encodeMouseButton(e), cx, cy, false);
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
      } else if (effectiveSettings.terminal.copy_on_select && renderer?.selectionStart && renderer?.selectionEnd) {
        const text = await extractSelectionText();
        if (text) writeToClipboard(text).catch(log.error);
      }
    };

    canvasEl.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    cleanupFns.push(() => canvasEl!.removeEventListener("mousedown", onMouseDown));
    cleanupFns.push(() => window.removeEventListener("mousemove", onMouseMove));
    cleanupFns.push(() => window.removeEventListener("mouseup", onMouseUp));

    // Canvas-level hover: URL detection, and any-motion (mode 3) mouse reporting,
    // both of which only make sense while the pointer is over this canvas.
    const onCanvasMouseMove = (e: MouseEvent) => {
      if (!renderer || isSelecting) return;
      const mouseMode = mouseModeOf(modeFlags);
      if (mouseMode !== 0) {
        if (mouseMode === 3 && !protocolPressActive) {
          const { cx, cy } = cellToReport(eventToCell(e));
          sendMouseEvent(MOUSE_MOTION + MOUSE_NO_BUTTON, cx, cy, true);
        }
        return;
      }
      const cell = eventToCell(e);
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

    // Mouse wheel — accumulate pixel deltas and flush once per RAF. This throttling
    // applies to BOTH local scrollback AND mouse-protocol forwarding: a single
    // trackpad flick fires dozens of tiny momentum `wheel` events on macOS, so
    // emitting one scroll per event makes a TUI app in mouse mode (e.g. Claude Code
    // fullscreen) scroll at light speed. Dividing accumulated pixels by cell height
    // maps a flick to a sane number of lines, matching iTerm/Terminal.app.
    let wheelForward = false;
    let wheelCol = 1, wheelRow = 1;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!renderer) return;

      const mouseMode = mouseModeOf(modeFlags);
      // Shift bypasses mouse mode to reach the terminal's own scrollback (iTerm,
      // Terminal.app, Kitty, Alacritty, WezTerm convention) — lets the user read
      // what scrolled past during a TUI app's continuous redraw.
      wheelForward = mouseMode > 0 && !e.shiftKey;
      if (wheelForward) ({ cx: wheelCol, cy: wheelRow } = cellToReport(eventToCell(e)));

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
          if (lines === 0) return;
          scrollAccum -= lines * ch;
          if (wheelForward) {
            const wheelBtn = lines < 0 ? MOUSE_WHEEL_UP : MOUSE_WHEEL_DOWN;
            for (let i = 0; i < Math.abs(lines); i++) sendMouseEvent(wheelBtn, wheelCol, wheelRow, true);
          } else {
            scrollTerminal(terminalId, -lines).catch(log.error);
          }
        });
      }
    };
    canvasEl.addEventListener("wheel", onWheel, { passive: false });
    cleanupFns.push(() => canvasEl!.removeEventListener("wheel", onWheel));

    // Focus/blur — send CSI I / CSI O when application requests focus events (mode 1004)
    const onFocus = () => {
      focused = true;
      if (renderer) {
        renderer.setFocused(true);
        renderer.rerender();
      }
      resetBlinkTimer();
      if ((modeFlags & MODE_FOCUS_EVENTS) !== 0) {
        writeToTerminal(terminalId, textEncoder.encode("\x1b[I"));
      }
    };
    const onBlur = () => {
      focused = false;
      if (renderer) {
        renderer.setFocused(false);
        renderer.setCursorBlink(true); // Show cursor when blurred
        renderer.rerender();
      }
      if (blinkInterval) {
        clearInterval(blinkInterval);
        blinkInterval = null;
      }
      if ((modeFlags & MODE_FOCUS_EVENTS) !== 0) {
        writeToTerminal(terminalId, textEncoder.encode("\x1b[O"));
      }
    };
    canvasEl.addEventListener("focus", onFocus);
    canvasEl.addEventListener("blur", onBlur);
    cleanupFns.push(() => canvasEl!.removeEventListener("focus", onFocus));
    cleanupFns.push(() => canvasEl!.removeEventListener("blur", onBlur));

    // Initialize cursor blink/focus state. The focused terminal (set by the
    // focus-on-mount rAF below, or a prior click) blinks; others render a steady
    // hollow cursor. resetBlinkTimer self-gates on `focused`.
    focused = document.activeElement === canvasEl;
    renderer.setFocused(focused);
    resetBlinkTimer();

    // Context menu
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const hasSelection = !!(renderer?.selectionStart && renderer?.selectionEnd);

      showContextMenu([
        {
          label: "Prompts",
          submenu: [
            ...savedPrompts.map(p => ({
              label: p.name,
              action: () => writeToTerminal(terminalId, textEncoder.encode(p.text)),
            })),
            ...(savedPrompts.length > 0 ? ["sep" as const] : []),
            { label: "Add Prompt...", action: () => { ui.addPromptModal = true; } },
          ],
        },
        "sep",
        { label: "New Terminal", shortcut: "⌘N", action: () =>
            workspaceManager.spawnTerminalInWorkspace()
        },
        "sep",
        { label: "Copy",       shortcut: "⌘C", disabled: !hasSelection, action: async () => {
            const text = await extractSelectionText();
            if (text) writeToClipboard(text).catch(log.error);
        }},
        { label: "Paste",      shortcut: "⌘V", action: async () => {
            const text = await navigator.clipboard.readText().catch(() => "");
            if (text) writeToTerminal(terminalId, textEncoder.encode(text));
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

    // Focus on mount only if this terminal is the active pane — otherwise a
    // non-active terminal (e.g. the last one to mount on restore) would steal focus
    // from the selected pane, leaving the border on one pane and typing on another.
    // PaneGrid marks the active pane's leaf with `.pane-leaf--active`.
    requestAnimationFrame(() => {
      if (canvasEl?.closest(".pane-leaf--active")) canvasEl.focus();
    });
  });

  onDestroy(() => {
    // Mark destroyed BEFORE anything else — async listener registrations in onMount
    // check this flag after their await resolves and unlisten themselves if set.
    destroyed = true;
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
    padding: 0 8px 4px 8px;
  }
  .terminal-canvas {
    width: 100%;
    height: 100%;
    display: block;
    outline: none;
  }
</style>
