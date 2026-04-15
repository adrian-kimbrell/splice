<script lang="ts">
  import type { LayoutNode, PaneConfig } from "../../lib/stores/layout.svelte";
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
  }: {
    node: LayoutNode | null | undefined;
    panes: Record<string, PaneConfig>;
    paneSnippet: Snippet<[PaneConfig]>;
    isRoot?: boolean;
    activePaneId?: string | null;
    onPaneClick?: (paneId: string) => void;
  } = $props();

  let dragging = $state(false);
  let containerEl = $state<HTMLDivElement>();
  let leafEl = $state<HTMLDivElement>();

  const myDropZone = $derived.by(() => {
    if (!node || node.type !== "leaf") return null;
    const hoverId = getHoverPaneId();
    if (hoverId !== node.paneId) return null;
    return getHoverZone();
  });

  $effect(() => {
    if (!node || node.type !== "leaf" || !leafEl) return;
    const paneId = node.paneId;
    const el = leafEl;
    registerPane(paneId, el);
    return () => unregisterPane(paneId, el);
  });


  function handleMouseDown(e: MouseEvent) {
    if (!node || node.type !== "split") return;
    if (isCornerDragActive()) return;
    e.preventDefault();
    dragging = true;

    const rect = containerEl?.getBoundingClientRect();
    if (!rect) return;

    const MIN_PX = 80; // minimum pane size in pixels

    function handleMouseMove(e: MouseEvent) {
      if (!rect || !node || node.type !== "split") return;
      let ratio: number;
      if (node.direction === "horizontal") {
        ratio = (e.clientX - rect.left) / rect.width;
        const minRatio = MIN_PX / rect.width;
        ratio = Math.max(minRatio, Math.min(1 - minRatio, ratio));
      } else {
        ratio = (e.clientY - rect.top) / rect.height;
        const minRatio = MIN_PX / rect.height;
        ratio = Math.max(minRatio, Math.min(1 - minRatio, ratio));
      }
      node.ratio = ratio;
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

{#if node}
{#if node.type === "leaf"}
  {@const config = panes[node.paneId]}
  {#if config}
    <div
      bind:this={leafEl}
      data-pane-id={node.paneId}
      class="flex-1 flex overflow-hidden min-w-0 min-h-0 relative"
      style="contain: layout style paint; transition: border-color 150ms cubic-bezier(0.4,0,0.2,1), box-shadow 150ms cubic-bezier(0.4,0,0.2,1); border: {node.paneId === activePaneId ? '2px solid var(--pane-border-active)' : '1px solid var(--border)'}; {node.paneId === activePaneId ? 'box-shadow: 0 0 0 1px rgba(0,255,136,0.08), inset 0 0 24px rgba(0,255,136,0.03);' : ''}"
      role="group"
      onclick={() => {
        onPaneClick?.(node.paneId);
        // Focus the inner content element (terminal canvas or CodeMirror editor)
        const target = leafEl?.querySelector<HTMLElement>('canvas[tabindex], .cm-content');
        if (target) target.focus();
      }}
      onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") onPaneClick?.(node.paneId); }}
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
      style="flex: 0 0 calc({node.ratio * 100}% - 2px); overflow: hidden; contain: layout style paint; {node.direction === 'vertical' ? 'min-height: 80px;' : 'min-width: 80px;'}"
      class="flex min-w-0 min-h-0"
    >
      <PaneGrid node={node.children[0]} {panes} {paneSnippet} {activePaneId} {onPaneClick} />
    </div>

    <div
      class="shrink-0 transition-colors duration-100"
      class:cursor-col-resize={node.direction === "horizontal"}
      class:cursor-row-resize={node.direction === "vertical"}
      style="{node.direction === 'horizontal'
        ? 'width: 4px; min-width: 4px;'
        : 'height: 4px; min-height: 4px;'} background: {dragging ? '#aaaaaa' : 'var(--border)'};"
      role="separator"
      tabindex="0"
      aria-orientation={node.direction === "horizontal" ? "vertical" : "horizontal"}
      onmousedown={handleMouseDown}
      onmouseenter={(e) => { if (!dragging) e.currentTarget.style.background = '#888888'; }}
      onmouseleave={(e) => { if (!dragging) e.currentTarget.style.background = 'var(--border)'; }}
      onkeydown={(e) => {
        if (node.type !== "split") return;
        const step = 0.02;
        const size = node.direction === "horizontal" ? (containerEl?.offsetWidth ?? 800) : (containerEl?.offsetHeight ?? 600);
        const minRatio = 80 / size;
        if ((node.direction === "horizontal" && e.key === "ArrowLeft") ||
            (node.direction === "vertical" && e.key === "ArrowUp")) {
          e.preventDefault();
          node.ratio = Math.max(minRatio, node.ratio - step);
        } else if ((node.direction === "horizontal" && e.key === "ArrowRight") ||
                   (node.direction === "vertical" && e.key === "ArrowDown")) {
          e.preventDefault();
          node.ratio = Math.min(1 - minRatio, node.ratio + step);
        }
      }}
    ></div>

    <div style="flex: 1; overflow: hidden; contain: layout style paint; {node.direction === 'vertical' ? 'min-height: 80px;' : 'min-width: 80px;'}" class="flex min-w-0 min-h-0">
      <PaneGrid node={node.children[1]} {panes} {paneSnippet} {activePaneId} {onPaneClick} />
    </div>
  </div>
{/if}
{/if}

{#if showGhost}
  <div
    class="drag-ghost fixed pointer-events-none z-50 flex items-center gap-2 px-3 py-1.5 text-xs"
    style="left: {gx + 14}px; top: {gy + 2}px;"
  >
    <i class="bi bi-file-earmark" style="font-size: var(--ui-body); opacity: 0.6;"></i>
    {ghostLabel}
  </div>
{/if}
