<script lang="ts">
  import { onMount } from "svelte";

  let {
    filePath,
  }: {
    filePath: string;
  } = $props();

  let src = $state<string | null>(null);
  let dimensions = $state("");
  let error = $state("");

  const fileName = $derived(filePath.split("/").pop() ?? filePath);
  const ext = $derived(filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase());

  async function loadImage() {
    src = null;
    error = "";
    dimensions = "";

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
    dimensions = `${img.naturalWidth} × ${img.naturalHeight}`;
  }

  onMount(() => { loadImage(); });

  // Reload when filePath changes
  $effect(() => {
    filePath;
    loadImage();
  });
</script>

<div class="flex flex-col items-center justify-center h-full w-full overflow-auto p-8 gap-4">
  {#if error}
    <div class="text-txt-dim text-sm">{error}</div>
  {:else if src}
    <img {src} alt={fileName} class="max-w-full max-h-[80%] object-contain" onload={handleLoad} />
    <div class="text-txt-dim text-xs flex gap-3">
      <span>{fileName}</span>
      {#if dimensions}
        <span>{dimensions}</span>
      {/if}
    </div>
  {:else}
    <div class="text-txt-dim text-sm">Loading…</div>
  {/if}
</div>
