<script lang="ts">
  /**
   * Image viewer with zoom.
   *
   * "Fit" sizes the image to the viewport without upscaling past 100%. Any zoom
   * action leaves fit mode and the image is laid out at natural size × zoom
   * inside a scrollable viewport, so large images pan with the scrollbars or
   * trackpad. Zoom anchors on the cursor (wheel/pinch) or the viewport centre
   * (buttons, keys), keeping the point under the pointer fixed.
   *
   * Input: ⌘/Ctrl + wheel or trackpad pinch, ⌘/Ctrl + = / − / 0 while the
   * viewer is focused (stopped there so the pane font zoom does not fire),
   * double-click to toggle fit ↔ 100%, and the toolbar buttons.
   */
  import { onMount } from "svelte";

  let {
    filePath,
  }: {
    filePath: string;
  } = $props();

  let src = $state<string | null>(null);
  let natural = $state<{ w: number; h: number } | null>(null);
  let error = $state("");

  let fitMode = $state(true);
  let zoom = $state(1);
  let viewport = $state({ w: 0, h: 0 });
  let viewportEl = $state<HTMLDivElement>();
  let imgEl = $state<HTMLImageElement>();

  const ZOOM_MIN = 0.05;
  const ZOOM_MAX = 32;
  const ZOOM_STEP = 1.25;

  const fileName = $derived(filePath.split("/").pop() ?? filePath);
  const ext = $derived(filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase());

  const fitScale = $derived.by(() => {
    if (!natural || viewport.w <= 0 || viewport.h <= 0) return 1;
    return Math.min(1, viewport.w / natural.w, viewport.h / natural.h);
  });
  const scale = $derived(fitMode ? fitScale : zoom);
  const percent = $derived(Math.round(scale * 100));
  const canZoomIn = $derived(scale < ZOOM_MAX);
  const canZoomOut = $derived(scale > ZOOM_MIN);

  async function loadImage() {
    src = null;
    error = "";
    natural = null;
    fitMode = true;
    zoom = 1;

    if (ext === "svg") {
      // SVGs can be loaded from file path directly in Tauri
      try {
        const { readFile } = await import("../../lib/ipc/commands");
        const content = await readFile(filePath);
        src = `data:image/svg+xml;base64,${btoa(content)}`;
      } catch (e) {
        error = String(e);
      }
    } else {
      try {
        const { readFileBase64 } = await import("../../lib/ipc/commands");
        const b64 = await readFileBase64(filePath);
        const mime = ext === "png" ? "image/png"
          : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
          : ext === "gif" ? "image/gif"
          : ext === "webp" ? "image/webp"
          : ext === "ico" ? "image/x-icon"
          : ext === "bmp" ? "image/bmp"
          : "application/octet-stream";
        src = `data:${mime};base64,${b64}`;
      } catch (e) {
        error = String(e);
      }
    }
  }

  function handleLoad(e: Event) {
    const img = e.target as HTMLImageElement;
    // An SVG without intrinsic size reports 0×0; fall back to its rendered box.
    natural = {
      w: img.naturalWidth || img.width || 300,
      h: img.naturalHeight || img.height || 150,
    };
  }

  /**
   * Set an explicit zoom, keeping the image point under `anchor` (client
   * coordinates; defaults to the viewport centre) where it is on screen.
   */
  function setZoom(next: number, anchor?: { x: number; y: number }) {
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    const el = viewportEl;
    const img = imgEl;
    const prev = scale;
    let pt: { nx: number; ny: number; cx: number; cy: number } | null = null;
    if (el && img && prev > 0) {
      const r = img.getBoundingClientRect();
      const vr = el.getBoundingClientRect();
      const cx = anchor?.x ?? vr.left + vr.width / 2;
      const cy = anchor?.y ?? vr.top + vr.height / 2;
      pt = { nx: (cx - r.left) / prev, ny: (cy - r.top) / prev, cx, cy };
    }
    fitMode = false;
    zoom = clamped;
    if (!pt || !el || !img) return;
    // After layout, scroll so the anchored image point is back under the cursor.
    requestAnimationFrame(() => {
      const r = img.getBoundingClientRect();
      el.scrollLeft += r.left + pt.nx * clamped - pt.cx;
      el.scrollTop += r.top + pt.ny * clamped - pt.cy;
    });
  }

  function zoomIn(anchor?: { x: number; y: number }) { setZoom(scale * ZOOM_STEP, anchor); }
  function zoomOut(anchor?: { x: number; y: number }) { setZoom(scale / ZOOM_STEP, anchor); }
  function zoomFit() { fitMode = true; }
  function zoomActual() { setZoom(1); }

  /** ⌘/Ctrl + wheel (and trackpad pinch, which WebKit reports as a ctrl-wheel) zooms. */
  function wheelZoom(node: HTMLElement) {
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      // Pinch deltas are small and continuous; mouse wheels are large and stepped.
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
      setZoom(scale * factor, { x: e.clientX, y: e.clientY });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return { destroy() { node.removeEventListener("wheel", onWheel); } };
  }

  function handleKeyDown(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || e.altKey || e.shiftKey) return;
    if (e.key === "=" || e.key === "+") zoomIn();
    else if (e.key === "-") zoomOut();
    else if (e.key === "0") zoomFit();
    else return;
    e.preventDefault();
    // The document-level handler would otherwise change the editor font too.
    e.stopPropagation();
  }

  function handleDblClick() {
    if (fitMode) zoomActual();
    else zoomFit();
  }

  // Track the viewport size so fit mode follows pane resizes.
  $effect(() => {
    const el = viewportEl;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      viewport = { w: el.clientWidth, h: el.clientHeight };
    });
    ro.observe(el);
    viewport = { w: el.clientWidth, h: el.clientHeight };
    return () => ro.disconnect();
  });

  onMount(() => { loadImage(); });

  // Reload when filePath changes
  $effect(() => {
    filePath;
    loadImage();
  });
</script>

<div class="flex flex-col h-full w-full min-h-0">
  {#if error}
    <div class="flex-1 flex items-center justify-center text-txt-dim text-sm">{error}</div>
  {:else if src}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
    <div
      bind:this={viewportEl}
      class="image-viewport flex-1 min-h-0 overflow-auto flex outline-none"
      tabindex="0"
      role="img"
      aria-label={fileName}
      use:wheelZoom
      onkeydown={handleKeyDown}
      ondblclick={handleDblClick}
    >
      <img
        bind:this={imgEl}
        {src}
        alt={fileName}
        class="image-content block"
        class:pixelated={scale >= 2}
        style={natural
          ? `width:${natural.w * scale}px;height:${natural.h * scale}px;`
          : "max-width:100%;max-height:100%;"}
        draggable="false"
        onload={handleLoad}
      />
    </div>
    <div class="image-toolbar text-txt-dim text-xs flex items-center gap-3 px-3 py-1.5 shrink-0">
      <span class="truncate" title={filePath}>{fileName}</span>
      {#if natural}
        <span class="shrink-0">{natural.w} × {natural.h}</span>
      {/if}
      <span class="flex-1"></span>
      <button class="zoom-btn" title="Zoom out (⌘−)" aria-label="Zoom out" disabled={!canZoomOut} onclick={() => zoomOut()}>−</button>
      <button class="zoom-btn zoom-pct" title="Reset to fit (⌘0)" aria-label="Reset zoom to fit" onclick={zoomFit}>{percent}%</button>
      <button class="zoom-btn" title="Zoom in (⌘=)" aria-label="Zoom in" disabled={!canZoomIn} onclick={() => zoomIn()}>+</button>
      <button class="zoom-btn" title="Actual size (double-click)" aria-label="Actual size" class:is-active={!fitMode && zoom === 1} onclick={zoomActual}>1:1</button>
      <button class="zoom-btn" title="Fit to window (⌘0)" aria-label="Fit to window" class:is-active={fitMode} onclick={zoomFit}>Fit</button>
    </div>
  {:else}
    <div class="flex-1 flex items-center justify-center text-txt-dim text-sm">Loading…</div>
  {/if}
</div>

<style>
  .image-viewport {
    padding: 16px;
    /* Faint checkerboard so transparent regions read as transparent. */
    background-color: var(--bg-editor, transparent);
    background-image:
      linear-gradient(45deg, rgba(128, 128, 128, 0.07) 25%, transparent 25%),
      linear-gradient(-45deg, rgba(128, 128, 128, 0.07) 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, rgba(128, 128, 128, 0.07) 75%),
      linear-gradient(-45deg, transparent 75%, rgba(128, 128, 128, 0.07) 75%);
    background-size: 16px 16px;
    background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  }
  .image-viewport:focus-visible {
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  /* margin:auto centres a small image and, unlike flex centring, keeps a
     large one scrollable from its top-left edge instead of clipping it. */
  .image-content {
    margin: auto;
    flex-shrink: 0;
    user-select: none;
    -webkit-user-drag: none;
  }
  .image-content.pixelated {
    image-rendering: pixelated;
  }
  .image-toolbar {
    border-top: 1px solid var(--border);
  }
  .zoom-btn {
    font: inherit;
    line-height: 1;
    padding: 3px 7px;
    min-width: 26px;
    border-radius: var(--radius-sm, 4px);
    color: inherit;
    background: transparent;
    border: 1px solid transparent;
    cursor: pointer;
  }
  .zoom-btn:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text-bright);
  }
  .zoom-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .zoom-btn.is-active {
    color: var(--text-bright);
    border-color: var(--border);
  }
  .zoom-pct {
    min-width: 48px;
    font-variant-numeric: tabular-nums;
  }
</style>
