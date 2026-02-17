<script lang="ts">
  import { beginDrag, getDragActive, isDragging } from "../../lib/stores/drag.svelte";

  let {
    name,
    path,
    paneId,
    active = false,
    onclick,
    onclose,
  }: {
    name: string;
    path: string;
    paneId: string;
    active?: boolean;
    onclick: () => void;
    onclose?: () => void;
  } = $props();

  const isBeingDragged = $derived.by(() => {
    if (!isDragging()) return false;
    const d = getDragActive();
    return d?.filePath === path && d?.sourcePaneId === paneId;
  });

  function handleMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    beginDrag({ filePath: path, fileName: name, sourcePaneId: paneId }, e);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="group flex items-center px-4 h-full text-xs cursor-pointer border-r border-border border-t-2 whitespace-nowrap select-none transition-opacity duration-100"
  class:text-txt-bright={active && !isBeingDragged}
  class:bg-tab-active={active && !isBeingDragged}
  class:border-t-tab-indicator={active && !isBeingDragged}
  class:text-txt-dim={!active || isBeingDragged}
  class:border-t-transparent={!active || isBeingDragged}
  class:hover:text-txt={!active}
  class:hover:bg-hover={!active}
  style:opacity={isBeingDragged ? "0.35" : "1"}
  onmousedown={handleMouseDown}
  {onclick}
>
  <span class="mr-1">{name}</span>
  {#if onclose}
    <button
      class="flex items-center justify-center ml-1 rounded hover:bg-hover {active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}"
      style="width: 16px; height: 16px; color: var(--text-dim);"
      onclick={(e) => { e.stopPropagation(); onclose?.(); }}
      title="Close"
    >
      <i class="bi bi-x" style="font-size: 14px; line-height: 1;"></i>
    </button>
  {/if}
</div>
