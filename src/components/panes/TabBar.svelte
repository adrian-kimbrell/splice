<script lang="ts">
  import Tab from "./Tab.svelte";
  import { ui } from "../../lib/stores/ui.svelte";
  import { getDragActive, isDragging } from "../../lib/stores/drag.svelte";
  import { workspaceManager } from "../../lib/stores/workspace.svelte";
  import type { SplitDirection } from "../../lib/stores/layout.svelte";
  import PaneHeaderActions from "../shared/PaneHeaderActions.svelte";
  import type { PaneHeaderAction, TabContextAction } from "../../lib/actions";
  import { formatRelativeTime, tickingNow } from "../../lib/utils/relative-time.svelte";
  import { showContextMenu, type ContextMenuItem } from "../../lib/utils/context-menu";
  import { clientToRectSpace } from "../../lib/utils/zoom";

  let reorderIndicatorIndex = $state<number | null>(null);
  let tabBarEl = $state<HTMLDivElement>();


  function handleTabBarDragOver(e: MouseEvent) {
    if (!isDragging() || !tabBarEl) return;
    const drag = getDragActive();
    if (!drag || drag.sourcePaneId !== paneId) {
      reorderIndicatorIndex = null;
      return;
    }

    // Compute insertion index from mouse position vs tab rects. Compare in rect
    // space so it stays correct under ui_scale zoom. See [[zoom-coords]].
    const tabEls = tabBarEl.querySelectorAll("[role='tab']");
    const px = clientToRectSpace(e.clientX, e.clientY, tabBarEl).x;
    let insertIdx = tabs.length;
    for (let i = 0; i < tabEls.length; i++) {
      const rect = tabEls[i].getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      if (px < midX) {
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
    onAction?: (action: PaneHeaderAction) => void;
    onTabContextAction?: (action: TabContextAction, path: string) => void;
    showPreviewToggle?: boolean;
    previewMode?: "editor" | "preview";
    onTogglePreview?: () => void;
  } = $props();

  // "Xm ago" badge shown when this editor pane hasn't been active for ≥5 min.
  // Re-derives every 30 s via tickingNow() and any time the workspace pane map changes.
  const lastTouchedLabel = $derived.by(() => {
    const ws = workspaceManager.activeWorkspace;
    const lastTouchedAt = ws?.panes[paneId]?.lastTouchedAt;
    return formatRelativeTime(lastTouchedAt, tickingNow());
  });


  // --- Tab context menu ---
  function showTabContextMenu(e: MouseEvent, tabPath: string) {
    const tabData = tabs.find((t) => t.path === tabPath);
    const isReadOnly = tabData?.readOnly ?? false;
    const isPinned = tabData?.pinned ?? false;
    const item = (label: string, action: TabContextAction, shortcut?: string): ContextMenuItem =>
      ({ label, shortcut, action: () => onTabContextAction?.(action, tabPath) });
    showContextMenu([
      item("Close", "close"),
      item("Close Others", "close-others", "\u2325\u2318T"),
      "sep",
      item("Close Left", "close-left", "\u2318K  E"),
      item("Close Right", "close-right", "\u2318K  T"),
      "sep",
      item("Close Clean", "close-clean", "\u2318K  U"),
      item("Close All", "close-all", "\u2318K  W"),
      "sep",
      item(isReadOnly ? "Make File Writable" : "Make File Read-Only", "toggle-readonly"),
      "sep",
      item(isPinned ? "Unpin Tab" : "Pin Tab", "toggle-pin", "\u2318K  \u21E7\u21A9"),
    ], e.clientX, e.clientY);
  }

</script>



<div class="flex bg-tab border-b border-border h-8 shrink-0 overflow-hidden min-w-0">
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
    {#if lastTouchedLabel}
      <span class="text-txt-dim text-[11px] flex items-center gap-1 mr-1 shrink-0 opacity-70" title="Last active in this pane">
        <i class="bi bi-clock-history text-[10px]"></i>{lastTouchedLabel}
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
    <PaneHeaderActions {onAction} {onSplit} {onClose} />
  </div>
</div>

<style>
  .tab-scroll {
    mask-image: linear-gradient(to right, black calc(100% - 20px), transparent 100%);
    -webkit-mask-image: linear-gradient(to right, black calc(100% - 20px), transparent 100%);
  }
</style>
