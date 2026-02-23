<script lang="ts">
  import { ui } from "../../lib/stores/ui.svelte";
  import type { SplitDirection } from "../../lib/stores/layout.svelte";
  import DropdownMenu, { type DropdownItem } from "../shared/DropdownMenu.svelte";
  import type { AttentionNotification } from "../../lib/stores/attention.svelte";
  import { beginDrag, getDragActive, isDragging } from "../../lib/stores/drag.svelte";

  let {
    title,
    cwd = "",
    paneId = "",
    notification = null,
    onSplit,
    onClose,
    onAction,
  }: {
    title: string;
    cwd?: string;
    paneId?: string;
    notification?: AttentionNotification | null;
    onSplit?: (direction: SplitDirection, side: "before" | "after") => void;
    onClose?: () => void;
    onAction?: (action: string) => void;
  } = $props();

  const isBeingDragged = $derived.by(() => {
    if (!isDragging()) return false;
    const d = getDragActive();
    return d?.kind === "terminal" && d?.sourcePaneId === paneId;
  });

  function handleMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    beginDrag({ filePath: "", fileName: title, sourcePaneId: paneId, kind: "terminal" }, e);
  }

  let splitMenuOpen = $state(false);
  let splitBtnEl = $state<HTMLButtonElement | null>(null);
  let splitDropdown: DropdownMenu;

  const splitItems: DropdownItem[] = [
    { label: "Split Right", icon: "bi-layout-split", action: "horizontal:after" },
    { label: "Split Left", icon: "bi-layout-split", iconStyle: "transform: scaleX(-1)", action: "horizontal:before" },
    { label: "Split Down", icon: "bi-layout-split", iconStyle: "transform: rotate(90deg)", action: "vertical:after" },
    { label: "Split Up", icon: "bi-layout-split", iconStyle: "transform: rotate(-90deg)", action: "vertical:before" },
  ];

  function handleSplitSelect(action: string) {
    const [dir, side] = action.split(":") as [SplitDirection, "before" | "after"];
    onSplit?.(dir, side);
  }

  // --- Plus dropdown ---
  let plusMenuOpen = $state(false);
  let plusBtnEl = $state<HTMLButtonElement | null>(null);
  let plusDropdown: DropdownMenu;

  const plusItems: DropdownItem[] = [
    { label: "New File", shortcut: "⌘ N", action: "new-file" },
    { label: "Open File", shortcut: "⌘ P", action: "open-file" },
    { label: "", action: "", separator: true },
    { label: "Search Project", shortcut: "⌘ F", action: "search-project" },
    { label: "Search Symbols", shortcut: "⌘ T", action: "search-symbols" },
    { label: "", action: "", separator: true },
    { label: "New Terminal", shortcut: "⌃ `", action: "new-terminal" },
  ];

  function handlePlusSelect(action: string) {
    onAction?.(action);
  }

  function toggleSplitMenu(e: MouseEvent) {
    e.stopPropagation();
    plusMenuOpen = false;
    splitMenuOpen = !splitMenuOpen;
  }

  function togglePlusMenu(e: MouseEvent) {
    e.stopPropagation();
    splitMenuOpen = false;
    plusMenuOpen = !plusMenuOpen;
  }

  function onResize() {
    splitDropdown?.reposition();
    plusDropdown?.reposition();
  }
</script>

<svelte:window onresize={onResize} />

<DropdownMenu
  bind:this={splitDropdown}
  bind:open={splitMenuOpen}
  triggerEl={splitBtnEl}
  items={splitItems}
  onSelect={handleSplitSelect}
  containerClass="split-menu-container"
/>
<DropdownMenu
  bind:this={plusDropdown}
  bind:open={plusMenuOpen}
  triggerEl={plusBtnEl}
  items={plusItems}
  onSelect={handlePlusSelect}
  containerClass="plus-menu-container"
/>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="flex items-center px-2.5 bg-tab-active border-b border-border text-xs shrink-0 select-none overflow-hidden min-w-0 transition-opacity duration-100"
  style="height: var(--titlebar-height); min-height: var(--titlebar-height);{isBeingDragged ? ' opacity: 0.35;' : ''}"
  onmousedown={handleMouseDown}
>
  <span class="text-txt-bright font-medium whitespace-nowrap mr-2 overflow-hidden text-ellipsis min-w-0"
    >{title}</span
  >
  {#if notification}
    <span
      class="attention-bell shrink-0 mr-2 flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded"
      style="color: {notification.type === 'permission' ? 'var(--ansi-red)' : 'var(--ansi-yellow)'}; background: {notification.type === 'permission' ? 'rgba(224,108,117,0.12)' : 'rgba(229,192,123,0.12)'};"
    >
      <i class="bi bi-claude" style="font-size: 9px;"></i>
      {notification.type === 'permission' ? 'permission' : 'waiting'}
    </span>
  {/if}
  <span class="flex-1 min-w-0"></span>
  <span
    class="flex items-center gap-3 text-txt-dim text-[11px] whitespace-nowrap overflow-hidden min-w-0"
  >
    {#if cwd}
      <span class="overflow-hidden text-ellipsis"
        ><i class="bi bi-folder2 mr-1 text-[11px]"></i>{cwd}</span
      >
    {/if}
  </span>
  <span class="flex items-center gap-0.5 ml-2.5 shrink-0">
    {#if ui.zoomedPaneId}
      <span class="text-[10px] uppercase tracking-wide text-accent mr-1 font-medium">Zoomed</span>
    {/if}
    {#if onAction}
      <div class="plus-menu-container">
        <button
          bind:this={plusBtnEl}
          class="pane-action-btn"
          title="New..."
          onclick={togglePlusMenu}
        >
          <i class="bi bi-plus-lg"></i>
        </button>
      </div>
    {/if}
    {#if onSplit}
      <div class="split-menu-container">
        <button
          bind:this={splitBtnEl}
          class="pane-action-btn"
          title="Split Pane"
          onclick={toggleSplitMenu}
        >
          <i class="bi bi-layout-split"></i>
        </button>
      </div>
    {/if}
    {#if onClose}
      <button class="pane-action-btn close" title="Close" onclick={onClose}>
        <i class="bi bi-x-lg" style="font-size: 16px"></i>
      </button>
    {/if}
  </span>
</div>

<style>
  .attention-bell {
    animation: bell-pulse 1.2s ease-in-out infinite;
  }
  @keyframes bell-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }
</style>
