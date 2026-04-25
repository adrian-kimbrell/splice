<script lang="ts">
  import { onDestroy } from "svelte";
  import Tab from "./Tab.svelte";
  import { ui } from "../../lib/stores/ui.svelte";
  import { getDragActive, isDragging } from "../../lib/stores/drag.svelte";
  import { workspaceManager } from "../../lib/stores/workspace.svelte";
  import type { SplitDirection } from "../../lib/stores/layout.svelte";
  import DropdownMenu, { type DropdownItem } from "../shared/DropdownMenu.svelte";

  let reorderIndicatorIndex = $state<number | null>(null);
  let tabBarEl = $state<HTMLDivElement>();


  function handleTabBarDragOver(e: MouseEvent) {
    if (!isDragging() || !tabBarEl) return;
    const drag = getDragActive();
    if (!drag || drag.sourcePaneId !== paneId) {
      reorderIndicatorIndex = null;
      return;
    }

    // Compute insertion index from mouse position vs tab rects
    const tabEls = tabBarEl.querySelectorAll("[role='tab']");
    let insertIdx = tabs.length;
    for (let i = 0; i < tabEls.length; i++) {
      const rect = tabEls[i].getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      if (e.clientX < midX) {
        insertIdx = i;
        break;
      }
    }
    reorderIndicatorIndex = insertIdx;
  }

  function handleTabBarDragLeave() {
    reorderIndicatorIndex = null;
  }

  function handleTabBarDrop() {
    if (reorderIndicatorIndex === null) return;
    const drag = getDragActive();
    if (!drag || drag.sourcePaneId !== paneId) {
      reorderIndicatorIndex = null;
      return;
    }
    const fromIndex = tabs.findIndex((t) => t.path === drag.filePath);
    let toIndex = reorderIndicatorIndex;
    if (fromIndex < toIndex) toIndex = Math.max(0, toIndex - 1);
    workspaceManager.reorderTabInPane(paneId, fromIndex, toIndex);
    reorderIndicatorIndex = null;
  }

  let {
    tabs,
    activeTab,
    paneId,
    gitBranch = "",
    onTabClick,
    onTabClose,
    onTabDoubleClick,
    onSplit,
    onClose,
    onAction,
    onTabContextAction,
    showPreviewToggle = false,
    previewMode = "editor",
    onTogglePreview,
  }: {
    tabs: { name: string; path: string; preview?: boolean; dirty?: boolean; pinned?: boolean; readOnly?: boolean }[];
    activeTab: string | null;
    paneId: string;
    gitBranch?: string;
    onTabClick: (path: string) => void;
    onTabClose?: (path: string) => void;
    onTabDoubleClick?: (path: string) => void;
    onSplit?: (direction: SplitDirection, side: "before" | "after") => void;
    onClose?: () => void;
    onAction?: (action: string) => void;
    onTabContextAction?: (action: string, path: string) => void;
    showPreviewToggle?: boolean;
    previewMode?: "editor" | "preview";
    onTogglePreview?: () => void;
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

  // --- Tab context menu ---
  let ctxMenuEl = $state<HTMLDivElement | null>(null);
  let ctxMenuPath = $state<string | null>(null);

  function showTabContextMenu(e: MouseEvent, tabPath: string) {
    removeCtxMenu();
    ctxMenuPath = tabPath;
    const tabData = tabs.find((t) => t.path === tabPath);
    const isReadOnly = tabData?.readOnly ?? false;
    const isPinned = tabData?.pinned ?? false;

    const menu = document.createElement("div");
    menu.className = "tab-ctx-menu split-dropdown";
    menu.style.position = "fixed";
    menu.style.top = `${e.clientY}px`;
    menu.style.left = `${e.clientX}px`;
    menu.style.transform = "none";

    const items: { label: string; shortcut?: string; action: string; separator?: boolean }[] = [
      { label: "Close", action: "close" },
      { label: "Close Others", shortcut: "\u2325\u2318T", action: "close-others" },
      { label: "", action: "", separator: true },
      { label: "Close Left", shortcut: "\u2318K  E", action: "close-left" },
      { label: "Close Right", shortcut: "\u2318K  T", action: "close-right" },
      { label: "", action: "", separator: true },
      { label: "Close Clean", shortcut: "\u2318K  U", action: "close-clean" },
      { label: "Close All", shortcut: "\u2318K  W", action: "close-all" },
      { label: "", action: "", separator: true },
      { label: isReadOnly ? "Make File Writable" : "Make File Read-Only", action: "toggle-readonly" },
      { label: "", action: "", separator: true },
      { label: isPinned ? "Unpin Tab" : "Pin Tab", shortcut: "\u2318K  \u21E7\u21A9", action: "toggle-pin" },
    ];

    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement("div");
        sep.className = "split-dropdown-sep";
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement("button");
      btn.className = "split-dropdown-item";
      btn.textContent = item.label;
      if (item.shortcut) {
        const kbd = document.createElement("kbd");
        kbd.textContent = item.shortcut;
        btn.appendChild(kbd);
      }
      btn.addEventListener("click", () => {
        onTabContextAction?.(item.action, tabPath);
        removeCtxMenu();
      });
      menu.appendChild(btn);
    }

    document.body.appendChild(menu);
    ctxMenuEl = menu;

    // Clamp to viewport
    requestAnimationFrame(() => {
      if (!menu.parentNode) return;
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        menu.style.left = `${window.innerWidth - rect.width - 4}px`;
      }
      if (rect.bottom > window.innerHeight) {
        menu.style.top = `${window.innerHeight - rect.height - 4}px`;
      }
    });
  }

  function removeCtxMenu() {
    if (ctxMenuEl) {
      ctxMenuEl.remove();
      ctxMenuEl = null;
      ctxMenuPath = null;
    }
  }

  onDestroy(() => removeCtxMenu());

  function handleDocClick(e: MouseEvent) {
    if (ctxMenuEl && !ctxMenuEl.contains(e.target as Node)) {
      removeCtxMenu();
    }
  }

  function onResize() {
    splitDropdown?.reposition();
    plusDropdown?.reposition();
    removeCtxMenu();
  }
</script>

<svelte:window onresize={onResize} />
<svelte:document onclick={handleDocClick} />

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
  <div class="shrink-0 transition-all duration-150" style="width: var(--header-traffic-offset, 0px);"></div>
  <div
    bind:this={tabBarEl}
    class="flex flex-1 overflow-x-auto min-w-0 relative tab-scroll"
    onmousemove={handleTabBarDragOver}
    onmouseleave={handleTabBarDragLeave}
    onmouseup={handleTabBarDrop}
  >
    {#each tabs as tab, tabIdx (tab.path)}
      {#if reorderIndicatorIndex === tabIdx}
        <div class="w-0.5 bg-accent shrink-0 self-stretch"></div>
      {/if}
      <Tab
        name={tab.name}
        path={tab.path}
        {paneId}
        active={tab.path === activeTab}
        preview={tab.preview}
        dirty={tab.dirty}
        pinned={tab.pinned}
        onclick={() => onTabClick(tab.path)}
        onclose={onTabClose ? () => onTabClose(tab.path) : undefined}
        ondblclick={onTabDoubleClick ? () => onTabDoubleClick(tab.path) : undefined}
        oncontextmenu={(e) => showTabContextMenu(e, tab.path)}
      />
    {/each}
    {#if reorderIndicatorIndex === tabs.length}
      <div class="w-0.5 bg-accent shrink-0 self-stretch"></div>
    {/if}
  </div>
  <div class="flex items-center gap-0.5 px-1 shrink-0">
    {#if gitBranch}
      <span class="text-txt-dim text-[11px] flex items-center gap-1 mr-1 shrink-0">
        <i class="bi bi-git"></i>{gitBranch}
      </span>
    {/if}
    {#if ui.zoomedPaneId}
      <span class="text-[10px] uppercase tracking-wide text-accent mr-1 font-medium">Zoomed</span>
    {/if}
    {#if showPreviewToggle && onTogglePreview}
      <button
        class="pane-action-btn"
        title={previewMode === "editor" ? "Show Preview" : "Show Editor"}
        onclick={onTogglePreview}
      >
        <i class="bi {previewMode === 'editor' ? 'bi-eye' : 'bi-eye-slash'}"></i>
      </button>
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
        <i class="bi bi-x-lg" style="font-size: var(--ui-icon)"></i>
      </button>
    {/if}
  </div>
</div>

<style>
  .tab-scroll {
    mask-image: linear-gradient(to right, black calc(100% - 20px), transparent 100%);
    -webkit-mask-image: linear-gradient(to right, black calc(100% - 20px), transparent 100%);
  }
</style>
