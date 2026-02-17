<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { Snippet } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import { WebglAddon } from "@xterm/addon-webgl";
  import "@xterm/xterm/css/xterm.css";

  let {
    terminalId = 0,
    children,
    active = false,
  }: {
    terminalId?: number;
    children?: Snippet;
    active?: boolean;
  } = $props();

  const isTauri = "__TAURI_INTERNALS__" in window;

  let containerEl = $state<HTMLDivElement>();
  let term: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let unlisten: (() => void) | null = null;

  // Re-fit terminal when becoming visible after workspace switch
  $effect(() => {
    if (active && fitAddon && term) {
      requestAnimationFrame(() => {
        fitAddon!.fit();
        import("../../lib/ipc/commands").then(({ resizeTerminal }) => {
          resizeTerminal(terminalId, term!.cols, term!.rows);
        });
      });
    }
  });

  onMount(async () => {
    if (!containerEl || !isTauri || terminalId === 0) return;

    const { writeToTerminal, resizeTerminal, getTerminalBuffer } = await import("../../lib/ipc/commands");
    const { onTerminalOutput, onTerminalExit } = await import("../../lib/ipc/events");

    // Get CSS custom properties for theming
    const style = getComputedStyle(document.documentElement);

    term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontSize: 12,
      fontFamily: "Menlo, Consolas, 'Courier New', monospace",
      theme: {
        background: "#1e1e1e",
        foreground: "#cccccc",
        cursor: "#ffffff",
        selectionBackground: "#37373d",
        black: "#282c34",
        red: "#e06c75",
        green: "#98c379",
        yellow: "#e5c07b",
        blue: "#61afef",
        magenta: "#c678dd",
        cyan: "#56b6c2",
        white: "#abb2bf",
        brightBlack: "#5c6370",
        brightRed: "#e06c75",
        brightGreen: "#98c379",
        brightYellow: "#e5c07b",
        brightBlue: "#61afef",
        brightMagenta: "#c678dd",
        brightCyan: "#56b6c2",
        brightWhite: "#d7dae0",
      },
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(containerEl);

    // GPU-accelerated rendering (WebGL), same as VS Code
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (e) {
      console.warn("WebGL renderer unavailable, using DOM renderer:", e);
    }

    // Let app-level shortcuts pass through the terminal
    term.attachCustomKeyEventHandler((e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.altKey && e.code === "KeyZ") return false;
      if (mod && e.key === "n") return false;
      if (mod && e.code >= "Digit1" && e.code <= "Digit9") return false;
      if (mod && e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) return false;
      return true;
    });

    // Send keystrokes to PTY (register early — no dependency on buffer)
    term.onData((data) => {
      const encoder = new TextEncoder();
      const bytes = Array.from(encoder.encode(data));
      writeToTerminal(terminalId, bytes);
    });

    // Register live PTY listener BEFORE buffer replay so we don't miss
    // events emitted while the async getTerminalBuffer round-trip is in flight.
    // Any events that arrived before this point were lost (fire-and-forget),
    // but the buffer snapshot below covers that gap.
    const unlistenOutput = await onTerminalOutput(
      terminalId,
      (data: Uint8Array) => {
        term?.write(data);
      },
    );

    const unlistenExit = await onTerminalExit(terminalId, (code: number) => {
      term?.write(`\r\n[Process exited with code ${code}]\r\n`);
    });

    unlisten = () => {
      unlistenOutput();
      unlistenExit();
    };

    // Replay scrollback buffer to fill the gap (data emitted before listener was registered).
    // fit() is deferred until after replay so the WebGL renderer doesn't paint a cursor
    // at (0,0) that becomes a ghost artifact when the buffer moves it.
    try {
      const buffer = await getTerminalBuffer(terminalId);
      if (buffer.length > 0) {
        term.write(buffer);
      }
    } catch (e) {
      console.warn("Failed to replay terminal buffer:", e);
    }

    // Now fit and notify the PTY of the real dimensions
    fitAddon.fit();
    resizeTerminal(terminalId, term.cols, term.rows);

    // Force a full viewport repaint to clear any WebGL ghost pixels
    requestAnimationFrame(() => {
      if (term) term.refresh(0, term.rows - 1);
    });

    // Auto-resize — guard against feedback loops where fit() changes
    // the container size, re-triggering the observer endlessly.
    let lastW = 0;
    let lastH = 0;
    resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      const { width, height } = entry.contentRect;
      const w = Math.round(width);
      const h = Math.round(height);
      if (w === 0 || h === 0) return; // hidden elements report zero
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      if (fitAddon && term) {
        fitAddon.fit();
        resizeTerminal(terminalId, term.cols, term.rows);
      }
    });
    resizeObserver.observe(containerEl);
  });

  onDestroy(() => {
    unlisten?.();
    resizeObserver?.disconnect();
    term?.dispose();
  });
</script>

{#if isTauri && terminalId > 0}
  <div bind:this={containerEl} class="flex-1 overflow-hidden min-w-0 min-h-0 xterm-container"></div>
{:else}
  <div
    class="flex-1 overflow-auto px-2.5 py-1.5 text-xs leading-[1.45] text-txt whitespace-pre-wrap break-all"
    style="font-family: var(--font-family)"
  >
    {#if children}
      {@render children()}
    {/if}
  </div>
{/if}

<style>
  .xterm-container,
  .xterm-container :global(.xterm),
  .xterm-container :global(.xterm-viewport),
  .xterm-container :global(.xterm-screen) {
    background-color: var(--bg-editor) !important;
  }
  .xterm-container :global(.xterm) {
    width: 100%;
    height: 100%;
    overflow: hidden;
    padding: 4px 0 0 4px;
  }
  .xterm-container :global(.xterm-viewport) {
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  .xterm-container :global(.xterm-viewport::-webkit-scrollbar) {
    display: none;
  }
</style>
