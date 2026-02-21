<script lang="ts">
  import Tab from "./Tab.svelte";
  import { ui } from "../../lib/stores/ui.svelte";
  import type { SplitDirection } from "../../lib/stores/layout.svelte";
  import DropdownMenu, { type DropdownItem } from "../shared/DropdownMenu.svelte";

  let {
    tabs,
    activeTab,
    paneId,
    onTabClick,
    onTabClose,
    onTabDoubleClick,
    onSplit,
    onClose,
    onAction,
  }: {
    tabs: { name: string; path: string; preview?: boolean; dirty?: boolean }[];
    activeTab: string | null;
    paneId: string;
    onTabClick: (path: string) => void;
    onTabClose?: (path: string) => void;
    onTabDoubleClick?: (path: string) => void;
    onSplit?: (direction: SplitDirection, side: "before" | "after") => void;
    onClose?: () => void;
    onAction?: (action: string) => void;
  } = $props();

  // --- Split dropdown ---
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

<div class="flex bg-tab border-b border-border h-8 shrink-0 overflow-hidden min-w-0">
  <div class="flex flex-1 overflow-x-auto min-w-0">
    {#each tabs as tab (tab.path)}
      <Tab
        name={tab.name}
        path={tab.path}
        {paneId}
        active={tab.path === activeTab}
        preview={tab.preview}
        dirty={tab.dirty}
        onclick={() => onTabClick(tab.path)}
        onclose={onTabClose ? () => onTabClose(tab.path) : undefined}
        ondblclick={onTabDoubleClick ? () => onTabDoubleClick(tab.path) : undefined}
      />
    {/each}
  </div>
  <div class="flex items-center gap-0.5 px-1 shrink-0">
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
  </div>
</div>
