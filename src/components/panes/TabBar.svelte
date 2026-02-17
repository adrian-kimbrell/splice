<script lang="ts">
  import Tab from "./Tab.svelte";
  import { ui } from "../../lib/stores/ui.svelte";

  let {
    tabs,
    activeTab,
    paneId,
    onTabClick,
    onTabClose,
    onSplitHorizontal,
    onSplitVertical,
    onClose,
  }: {
    tabs: { name: string; path: string }[];
    activeTab: string | null;
    paneId: string;
    onTabClick: (path: string) => void;
    onTabClose?: (path: string) => void;
    onSplitHorizontal?: () => void;
    onSplitVertical?: () => void;
    onClose?: () => void;
  } = $props();
</script>

<div class="flex bg-tab border-b border-border h-8 shrink-0 overflow-hidden min-w-0">
  <div class="flex flex-1 overflow-x-auto min-w-0">
    {#each tabs as tab (tab.path)}
      <Tab
        name={tab.name}
        path={tab.path}
        {paneId}
        active={tab.path === activeTab}
        onclick={() => onTabClick(tab.path)}
        onclose={onTabClose ? () => onTabClose(tab.path) : undefined}
      />
    {/each}
  </div>
  <div class="flex items-center gap-0.5 px-1 shrink-0">
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
  </div>
</div>
