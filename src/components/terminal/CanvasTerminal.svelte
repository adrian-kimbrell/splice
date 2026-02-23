<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { TerminalRenderer, HEADER_SIZE, CELL_SIZE } from "../../lib/terminal/renderer";
  import { settings } from "../../lib/stores/settings.svelte";
  import { attentionStore } from "../../lib/stores/attention.svelte";
  import { keyToBytes } from "../../lib/terminal/keyboard";

  let {
    terminalId = 0,
    active = false,
  }: {
    terminalId?: number;
    active?: boolean;
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

  // Scroll accumulator for smooth trackpad scrolling
  let scrollAccum = 0;

  // Cleanup functions for event listeners
  let cleanupFns: (() => void)[] = [];

  // RAF IDs hoisted to module scope so onDestroy can cancel pending frames
  let rafId = 0;
  let scrollRafId = 0;
  let resizeRafId = 0;

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

  onMount(async () => {
    if (!containerEl || !canvasEl || !isTauri || terminalId === 0) return;

    const { writeToTerminal, scrollTerminal, resizeTerminal } = await import(
      "../../lib/ipc/commands"
    );
    const { onTerminalGrid, onTerminalExit } = await import(
      "../../lib/ipc/events"
    );

    // Cache resizeTerminal for use in handleResize
    cachedResizeTerminal = resizeTerminal;

    renderer = new TerminalRenderer(canvasEl, settings.terminal.font_size, `${settings.terminal.font_family}, Consolas, 'Courier New', monospace`);

    // Listen for grid updates, throttle rendering to RAF
    let pendingFrame: Uint8Array | null = null;

    unlistenGrid = await onTerminalGrid(
      terminalId,
      (data: Uint8Array) => {
        if (data.length >= 12) {
          modeFlags = data[10];
        }
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

    // Initial resize
    handleResize();

    // Keyboard handler
    const onKeyDown = async (e: KeyboardEvent) => {
      // Cmd+C with selection → copy
      if (e.metaKey && e.key === "c" && renderer?.selectionStart) {
        e.preventDefault();
        const frame = renderer.currentFrame;
        if (frame) {
          const text = renderer.getSelectedText(frame);
          if (text) {
            await navigator.clipboard.writeText(text);
          }
        }
        return;
      }

      // Cmd+V → let browser fire native paste event (handled by onPaste)
      if (e.metaKey && e.key === "v") {
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

    // Paste event handler (for right-click paste, etc.)
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
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
    canvasEl.addEventListener("paste", onPaste);
    cleanupFns.push(() => canvasEl!.removeEventListener("paste", onPaste));

    // Mouse selection
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0 || !renderer) return;
      const rect = canvasEl!.getBoundingClientRect();
      const cell = renderer.pixelToCell(e.clientX - rect.left, e.clientY - rect.top);

      if (e.detail === 3) {
        // Triple-click: select line
        const cols = currentCols || 80;
        renderer.setSelection({ col: 0, row: cell.row }, { col: cols - 1, row: cell.row });
        renderer.rerender();
        return;
      }

      if (e.detail === 2) {
        // Double-click: word select
        const data = renderer.currentFrame;
        if (data) {
          const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
          const cols = view.getUint16(0, true);
          let startCol = cell.col;
          let endCol = cell.col;
          // Scan left for word boundary
          while (startCol > 0) {
            const off = HEADER_SIZE + (cell.row * cols + startCol - 1) * CELL_SIZE;
            if (off + CELL_SIZE > data.length) break;
            const cp = view.getUint32(off, true);
            if (cp <= 32) break;
            startCol--;
          }
          // Scan right for word boundary
          while (endCol < cols - 1) {
            const off = HEADER_SIZE + (cell.row * cols + endCol + 1) * CELL_SIZE;
            if (off + CELL_SIZE > data.length) break;
            const cp = view.getUint32(off, true);
            if (cp <= 32) break;
            endCol++;
          }
          renderer.setSelection(
            { col: startCol, row: cell.row },
            { col: endCol, row: cell.row },
          );
          renderer.rerender();
        }
        return;
      }

      // Single click: start selection
      isSelecting = true;
      renderer.setSelection(cell, cell);
      renderer.rerender();
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isSelecting || !renderer || !canvasEl) return;
      const rect = canvasEl.getBoundingClientRect();
      const cell = renderer.pixelToCell(e.clientX - rect.left, e.clientY - rect.top);
      renderer.selectionEnd = cell;
      renderer.rerender();
    };

    const onMouseUp = () => {
      if (!isSelecting) return;
      isSelecting = false;
      // If start === end, clear selection (was just a click)
      if (
        renderer?.selectionStart &&
        renderer?.selectionEnd &&
        renderer.selectionStart.col === renderer.selectionEnd.col &&
        renderer.selectionStart.row === renderer.selectionEnd.row
      ) {
        renderer.setSelection(null, null);
        renderer.rerender();
      } else if (settings.terminal.copy_on_select && renderer?.selectionStart && renderer?.selectionEnd) {
        const frame = renderer.currentFrame;
        if (frame) {
          const text = renderer.getSelectedText(frame);
          if (text) navigator.clipboard.writeText(text).catch(console.error);
        }
      }
    };

    canvasEl.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    cleanupFns.push(() => canvasEl!.removeEventListener("mousedown", onMouseDown));
    cleanupFns.push(() => window.removeEventListener("mousemove", onMouseMove));
    cleanupFns.push(() => window.removeEventListener("mouseup", onMouseUp));

    // Mouse wheel for scrollback — accumulate deltas, flush once per RAF
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!renderer) return;
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

    // Focus/blur
    const onFocus = () => {
      if (renderer) {
        renderer.setFocused(true);
        renderer.rerender();
      }
      resetBlinkTimer();
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
    // Null renderer first so any stale RAF callbacks that already started are no-ops
    renderer = null;
    // Remove all event listeners
    for (const fn of cleanupFns) {
      fn();
    }
    cleanupFns = [];
    unlistenGrid?.();
    unlistenExit?.();
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
