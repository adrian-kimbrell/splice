<script lang="ts">
  let {
    filePath,
    rootPath,
  }: {
    filePath: string;
    rootPath: string;
  } = $props();

  const segments = $derived.by(() => {
    let relative = filePath;
    if (rootPath && filePath.startsWith(rootPath)) {
      relative = filePath.slice(rootPath.length);
      if (relative.startsWith("/")) relative = relative.slice(1);
    }
    return relative.split("/").filter(Boolean);
  });
</script>

<div class="flex items-center h-6 px-3 bg-editor border-b border-border text-[11px] text-txt-dim overflow-hidden shrink-0 gap-0.5">
  {#each segments as segment, i}
    {#if i > 0}
      <i class="bi bi-chevron-right" style="font-size: var(--ui-xxs); opacity: 0.5;"></i>
    {/if}
    <span class:text-txt={i === segments.length - 1} class="whitespace-nowrap">{segment}</span>
  {/each}
</div>
