<script lang="ts">
  import { convertFileSrc } from "@tauri-apps/api/core";

  let {
    filePath,
    content = "",
  }: {
    filePath: string;
    content?: string;
  } = $props();

  const src = $derived(convertFileSrc(filePath));

  let iframeEl = $state<HTMLIFrameElement>();
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    // Track content changes; ignore the initial render
    content;
    if (!iframeEl) return;
    if (reloadTimer !== null) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      if (iframeEl) iframeEl.src = src;
    }, 800);
    return () => {
      if (reloadTimer !== null) { clearTimeout(reloadTimer); reloadTimer = null; }
    };
  });
</script>

<div class="html-preview-wrap">
  <iframe
    bind:this={iframeEl}
    {src}
    title="HTML Preview"
    class="html-preview-frame"
  ></iframe>
</div>

<style>
  .html-preview-wrap {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: #fff;
  }
  .html-preview-frame {
    flex: 1;
    width: 100%;
    height: 100%;
    border: none;
    display: block;
  }
  /* Disable pointer events on the iframe while a pane resize drag is in progress
     so the parent window's mousemove handler keeps receiving events. */
  :global(body.pane-resizing) .html-preview-frame {
    pointer-events: none;
  }
</style>
