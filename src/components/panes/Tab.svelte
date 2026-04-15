<script lang="ts">
  import { beginDrag, getDragActive, isDragging } from "../../lib/stores/drag.svelte";

  let {
    name,
    path,
    paneId,
    active = false,
    preview = false,
    dirty = false,
    pinned = false,
    onclick,
    onclose,
    ondblclick,
    oncontextmenu,
  }: {
    name: string;
    path: string;
    paneId: string;
    active?: boolean;
    preview?: boolean;
    dirty?: boolean;
    pinned?: boolean;
    onclick: () => void;
    onclose?: () => void;
    ondblclick?: () => void;
    oncontextmenu?: (e: MouseEvent) => void;
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
    beginDrag({ filePath: path, fileName: name, sourcePaneId: paneId, kind: "editor" }, e);
  }
</script>

<div
  class="group flex items-center px-4 h-full text-xs cursor-pointer border-r border-border border-b-2 whitespace-nowrap select-none"
  style="transition: background 120ms cubic-bezier(0.4,0,0.2,1), color 120ms cubic-bezier(0.4,0,0.2,1), border-bottom-color 120ms cubic-bezier(0.4,0,0.2,1), opacity 100ms;"
  role="tab"
  tabindex={active ? 0 : -1}
  aria-selected={active}
  class:text-txt-bright={active && !isBeingDragged}
  class:bg-tab-active={active && !isBeingDragged}
  class:border-b-tab-indicator={active && !isBeingDragged}
  class:text-txt-dim={!active || isBeingDragged}
  class:border-b-transparent={!active || isBeingDragged}
  class:hover:text-txt={!active}
  class:hover:bg-hover={!active}
  style:opacity={isBeingDragged ? "0.35" : "1"}
  onmousedown={handleMouseDown}
  onclick={() => onclick()}
  ondblclick={() => ondblclick?.()}
  oncontextmenu={(e) => { if (oncontextmenu) { e.preventDefault(); oncontextmenu(e); } }}
  onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onclick(); } }}
>
  {#if pinned}
    <i class="bi bi-pin-fill" style="font-size: var(--ui-sm); color: var(--text-dim); margin-right: 2px;"></i>
  {/if}
  <span class="mr-1" style:font-style={preview ? "italic" : "normal"}>{name}</span>
  {#if onclose && !pinned}
    {#if dirty}
      <span
        class="flex items-center justify-center ml-1 group-hover:hidden"
        style="width: 16px; height: 16px; color: var(--text-bright);"
        title="Unsaved changes"
      >
        <span style="width: 6px; height: 6px; border-radius: 50%; background: currentColor; display: block;"></span>
      </span>
    {/if}
    <button
      class="flex items-center justify-center ml-1 rounded hover:bg-hover {active || dirty ? 'opacity-100' : 'opacity-0'} {dirty ? 'hidden' : ''} group-hover:!flex group-hover:!opacity-100"
      style="width: 16px; height: 16px; color: var(--text-dim);"
      onclick={(e) => { e.stopPropagation(); onclose?.(); }}
      title="Close"
    >
      <i class="bi bi-x" style="font-size: var(--ui-btn); line-height: 1;"></i>
    </button>
  {/if}
</div>
