<script lang="ts">
  import type { LayoutNode, PaneConfig, SplitDirection } from "../../lib/stores/layout.svelte";
  import type { Snippet } from "svelte";
  import {
    type DropZone,
    getDragActive,
    getHoverPaneId,
    getHoverZone,
    getGhostX,
    getGhostY,
    isDragging,
    registerPane,
    unregisterPane,
    endDrag,
  } from "../../lib/stores/drag.svelte";
  import { isCornerDragActive } from "../../lib/stores/corner-drag.svelte";
  import CornerDragOverlay from "./CornerDragOverlay.svelte";
  import PaneGrid from "./PaneGrid.svelte";

  let {
    node,
    panes,
    paneSnippet,
    isRoot = false,
    activePaneId = null,
    onPaneClick,
    onTabDrop,
  }: {
    node: LayoutNode;
    panes: Record<string, PaneConfig>;
    paneSnippet: Snippet<[PaneConfig]>;
    isRoot?: boolean;
    activePaneId?: string | null;
    onPaneClick?: (paneId: string) => void;
    onTabDrop?: (filePath: string, sourcePaneId: string, targetPaneId: string, direction: SplitDirection, side: "before" | "after", zone: DropZone) => void;
  } = $props();

  let dragging = $state(false);
  let containerEl = $state<HTMLDivElement>();
  let leafEl = $state<HTMLDivElement>();

  const myDropZone = $derived.by(() => {
    if (node.type !== "leaf") return null;
    const hoverId = getHoverPaneId();
    if (hoverId !== node.paneId) return null;
    return getHoverZone();
  });

  $effect(() => {
    if (node.type !== "leaf" || !leafEl) return;
    const paneId = node.paneId;
    const el = leafEl;
    registerPane(paneId, el);
    return () => unregisterPane(paneId, el);
  });

  $effect(() => {
    if (node.type !== "leaf") return;

    function onTabDropEvent() {
      const active = getDragActive();
      const zone = getHoverZone();
      const targetPaneId = getHoverPaneId();
      if (!active || !zone || !targetPaneId) { endDrag(); return; }
      if (targetPaneId !== node.paneId) return;

      if (active.sourcePaneId === targetPaneId && zone === "center") { endDrag(); return; }
      if (active.sourcePaneId === targetPaneId) {
        const cfg = panes[targetPaneId];
        if (cfg?.filePaths && cfg.filePaths.length <= 1) { endDrag(); return; }
      }

      let direction: SplitDirection = "horizontal";
      let side: "before" | "after" = "after";

      if (zone === "left") { direction = "horizontal"; side = "before"; }
      else if (zone === "right") { direction = "horizontal"; side = "after"; }
      else if (zone === "top") { direction = "vertical"; side = "before"; }
      else if (zone === "bottom") { direction = "vertical"; side = "after"; }

      onTabDrop?.(active.filePath, active.sourcePaneId, targetPaneId, direction, side, zone);
      endDrag();
    }

    document.addEventListener("tab-drop", onTabDropEvent);
    return () => document.removeEventListener("tab-drop", onTabDropEvent);
  });

  function handleMouseDown(e: MouseEvent) {
    if (node.type !== "split") return;
    if (isCornerDragActive()) return;
    e.preventDefault();
    dragging = true;

    const rect = containerEl?.getBoundingClientRect();
    if (!rect) return;

    function handleMouseMove(e: MouseEvent) {
      if (!rect || node.type !== "split") return;
      let ratio: number;
      if (node.direction === "horizontal") {
        ratio = (e.clientX - rect.left) / rect.width;
      } else {
        ratio = (e.clientY - rect.top) / rect.height;
      }
      node.ratio = Math.max(0.1, Math.min(0.9, ratio));
    }

    function handleMouseUp() {
      dragging = false;
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }

  function getOverlayStyle(zone: DropZone): string {
    // Inset overlays so they don't cover the full pane edge-to-edge
    const pad = "4px";
    switch (zone) {
      case "left":   return `left: ${pad}; top: ${pad}; width: calc(50% - ${pad}); height: calc(100% - ${pad} * 2);`;
      case "right":  return `right: ${pad}; top: ${pad}; width: calc(50% - ${pad}); height: calc(100% - ${pad} * 2);`;
      case "top":    return `left: ${pad}; top: ${pad}; width: calc(100% - ${pad} * 2); height: calc(50% - ${pad});`;
      case "bottom": return `left: ${pad}; bottom: ${pad}; width: calc(100% - ${pad} * 2); height: calc(50% - ${pad});`;
      case "center": return `left: ${pad}; top: ${pad}; width: calc(100% - ${pad} * 2); height: calc(100% - ${pad} * 2);`;
      default: return "display: none;";
    }
  }

  // Ghost (root only)
  const showGhost = $derived(isRoot && isDragging());
  const ghostLabel = $derived(getDragActive()?.fileName ?? "");
  const gx = $derived(getGhostX());
  const gy = $derived(getGhostY());
</script>

{#if node.type === "leaf"}
  {@const config = panes[node.paneId]}
  {#if config}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={leafEl}
      class="flex-1 flex overflow-hidden min-w-0 min-h-0 relative"
      style="contain: layout style paint; border: {node.paneId === activePaneId ? '2px solid var(--pane-border-active)' : '1px solid var(--border)'}"
      onclick={() => onPaneClick?.(node.paneId)}
    >
      {@render paneSnippet(config)}
      {#if myDropZone}
        <div
          class="drop-zone-highlight absolute pointer-events-none z-10"
          style={getOverlayStyle(myDropZone)}
        ></div>
      {/if}
    </div>
  {/if}
{:else}
  <div
    bind:this={containerEl}
    class="flex overflow-hidden min-w-0 min-h-0"
    class:flex-row={node.direction === "horizontal"}
    class:flex-col={node.direction === "vertical"}
    style="flex: 1;{isRoot ? ' position: relative;' : ''}"
  >
    {#if isRoot}
      <CornerDragOverlay {node} {containerEl} />
    {/if}
    <div
      style="flex: 0 0 calc({node.ratio * 100}% - 2px); overflow: hidden; contain: layout style paint;"
      class="flex min-w-0 min-h-0"
    >
      <PaneGrid node={node.children[0]} {panes} {paneSnippet} {activePaneId} {onPaneClick} {onTabDrop} />
    </div>

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="shrink-0 transition-colors duration-100"
      class:cursor-col-resize={node.direction === "horizontal"}
      class:cursor-row-resize={node.direction === "vertical"}
      style="{node.direction === 'horizontal'
        ? 'width: 4px; min-width: 4px;'
        : 'height: 4px; min-height: 4px;'} background: {dragging ? '#aaaaaa' : 'var(--border)'};"
      onmousedown={handleMouseDown}
      onmouseenter={(e) => { if (!dragging) e.currentTarget.style.background = '#888888'; }}
      onmouseleave={(e) => { if (!dragging) e.currentTarget.style.background = 'var(--border)'; }}
    ></div>

    <div style="flex: 1; overflow: hidden; contain: layout style paint;" class="flex min-w-0 min-h-0">
      <PaneGrid node={node.children[1]} {panes} {paneSnippet} {activePaneId} {onPaneClick} {onTabDrop} />
    </div>
  </div>
{/if}

{#if showGhost}
  <div
    class="drag-ghost fixed pointer-events-none z-50 flex items-center gap-2 px-3 py-1.5 text-xs"
    style="left: {gx + 14}px; top: {gy + 2}px;"
  >
    <i class="bi bi-file-earmark" style="font-size: 12px; opacity: 0.6;"></i>
    {ghostLabel}
  </div>
{/if}
