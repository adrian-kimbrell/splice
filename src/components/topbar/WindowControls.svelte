<script lang="ts">
  /**
   * WindowControls.svelte — Windows-style minimize / maximize / close buttons.
   *
   * macOS uses native traffic lights (left side, positioned by a Rust swizzle), so
   * this is only rendered on Windows, where the window is frameless (decorations off)
   * and therefore has no native caption buttons. Pinned to the right of the TitleBar.
   */
  import { getCurrentWindow } from "@tauri-apps/api/window";

  const win = getCurrentWindow();

  // toggleMaximize() can silently reject on a frameless (decorations:false) window,
  // so drive it explicitly and surface any error instead of the button doing nothing.
  async function toggleMaximize() {
    try {
      if (await win.isMaximized()) await win.unmaximize();
      else await win.maximize();
    } catch (e) {
      console.error("[window] maximize toggle failed", e);
    }
  }
</script>

<div class="window-controls">
  <button class="wc-btn" title="Minimize" aria-label="Minimize" onclick={() => win.minimize()}>
    <i class="bi bi-dash-lg"></i>
  </button>
  <button class="wc-btn" title="Maximize" aria-label="Maximize" onclick={toggleMaximize}>
    <i class="bi bi-square"></i>
  </button>
  <button class="wc-btn wc-close" title="Close" aria-label="Close" onclick={() => win.close()}>
    <i class="bi bi-x-lg"></i>
  </button>
</div>

<style>
  .window-controls {
    display: flex;
    align-items: stretch;
    flex-shrink: 0;
  }
  .wc-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    border: none;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 11px;
    transition: background 120ms ease, color 120ms ease;
  }
  .wc-btn:hover {
    background: color-mix(in srgb, var(--text-dim) 18%, transparent);
    color: var(--text);
  }
  /* Windows close-button red on hover. */
  .wc-close:hover {
    background: #e81123;
    color: #fff;
  }
</style>
