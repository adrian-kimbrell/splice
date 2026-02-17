<script lang="ts">
  import { ui } from "../../lib/stores/ui.svelte";

  let {
    title,
    cwd = "",
    branch = "",
    onSplitHorizontal,
    onSplitVertical,
    onClose,
  }: {
    title: string;
    cwd?: string;
    branch?: string;
    onSplitHorizontal?: () => void;
    onSplitVertical?: () => void;
    onClose?: () => void;
  } = $props();
</script>

<div
  class="flex items-center px-2.5 bg-tab-active border-b border-border text-xs shrink-0 select-none overflow-hidden min-w-0"
  style="height: 28px; min-height: 28px;"
>
  <span class="text-txt-bright font-medium whitespace-nowrap mr-2 overflow-hidden text-ellipsis min-w-0"
    >{title}</span
  >
  <span class="flex-1 min-w-0"></span>
  <span
    class="flex items-center gap-3 text-txt-dim text-[11px] whitespace-nowrap overflow-hidden min-w-0"
  >
    {#if cwd}
      <span class="overflow-hidden text-ellipsis"
        ><i class="bi bi-folder2 mr-1 text-[11px]"></i>{cwd}</span
      >
    {/if}
    {#if branch}
      <span class="overflow-hidden text-ellipsis"
        ><i class="bi bi-git mr-1 text-[11px]"></i>{branch}</span
      >
    {/if}
  </span>
  <span class="flex items-center gap-0.5 ml-2.5 shrink-0">
    {#if ui.zoomedPaneId}
      <span class="text-[10px] uppercase tracking-wide text-accent mr-1 font-medium">Zoomed</span>
    {/if}
    {#if onSplitHorizontal}
      <button class="pane-action-btn" title="Split Right" onclick={onSplitHorizontal}>
        <i class="bi bi-layout-split"></i>
      </button>
    {/if}
    {#if onSplitVertical}
      <button class="pane-action-btn" title="Split Down" onclick={onSplitVertical}>
        <i class="bi bi-layout-split" style="transform: rotate(90deg)"></i>
      </button>
    {/if}
    {#if onClose}
      <button class="pane-action-btn close" title="Close" onclick={onClose}>
        <i class="bi bi-x-lg" style="font-size: 16px"></i>
      </button>
    {/if}
  </span>
</div>
