<script lang="ts">
  import type { PaneConfig } from "../../lib/stores/layout.svelte";

  let {
    leafIds,
    panes,
    activeId,
    onSelect,
    onClose,
    onAdd,
    onExit,
  }: {
    leafIds: string[];
    panes: Record<string, PaneConfig>;
    activeId: string | null;
    onSelect: (id: string) => void;
    onClose: (id: string) => void;
    onAdd: () => void;
    onExit: () => void;
  } = $props();

  function iconFor(config: PaneConfig): string {
    if (config.kind === "terminal") return "bi-terminal";
    if (config.kind === "diff") return "bi-file-diff";
    return "bi-file-earmark-code";
  }

  function labelFor(config: PaneConfig): string {
    if (config.kind === "editor") {
      const path = config.activeFilePath;
      if (path) return path.split("/").pop() || path;
    }
    if (config.kind === "diff" && config.diffFilePath) {
      return config.diffFilePath.split("/").pop() || config.diffFilePath;
    }
    return config.title;
  }
</script>

<div class="single-view-bar flex items-center gap-2 px-2 py-1 shrink-0">
  <!-- Tabs keep their natural width and scroll horizontally when they overflow.
       The scroll region has its own bottom padding so the thin themed scrollbar
       sits in dedicated space instead of crowding the tabs. -->
  <div class="sv-tabs flex items-center gap-1 flex-1 min-w-0">
    {#each leafIds as id, i (id)}
      {@const config = panes[id]}
      {#if config}
        <button
          class="sv-tab flex items-center gap-1.5 shrink-0"
          class:sv-tab--active={id === activeId}
          title={labelFor(config)}
          onclick={() => onSelect(id)}
          onauxclick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(id); } }}
        >
          <span class="sv-index text-[10px] tabular-nums opacity-50 shrink-0">{i + 1}</span>
          <i class="bi {iconFor(config)} text-[11px] shrink-0"></i>
          <span class="sv-label truncate">{labelFor(config)}</span>
          {#if leafIds.length > 1}
            <span
              class="sv-close shrink-0"
              role="button"
              tabindex="-1"
              title="Close pane"
              onclick={(e) => { e.stopPropagation(); onClose(id); }}
              onkeydown={() => {}}
            >
              <i class="bi bi-x"></i>
            </span>
          {/if}
        </button>
      {/if}
    {/each}

    <button class="sv-icon-btn shrink-0" title="New terminal" onclick={onAdd}>
      <i class="bi bi-plus-lg"></i>
    </button>
  </div>

  <button class="sv-exit shrink-0 flex items-center gap-1.5" title="Back to split view (⌘⇧\)" onclick={onExit}>
    <i class="bi bi-layout-split text-[11px]"></i>
    <span class="text-[11px]">Split view</span>
  </button>
</div>

<style>
  .single-view-bar {
    background: var(--bg-secondary, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--text-dim) 18%, transparent);
  }

  /* Horizontal-only scroll for the tab row. The bottom padding reserves room for
     the scrollbar so it never overlaps the tabs; a matching negative margin keeps
     the bar's overall height unchanged. */
  .sv-tabs {
    overflow-x: auto;
    overflow-y: hidden;
    padding-bottom: 6px;
    margin-bottom: -6px;
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--text-dim) 35%, transparent) transparent;
  }
  .sv-tabs::-webkit-scrollbar {
    height: 6px;
  }
  .sv-tabs::-webkit-scrollbar-track {
    background: transparent;
  }
  .sv-tabs::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--text-dim) 30%, transparent);
    border-radius: 999px;
  }
  .sv-tabs::-webkit-scrollbar-thumb:hover {
    background: color-mix(in srgb, var(--text-dim) 55%, transparent);
  }

  .sv-label {
    max-width: 160px;
  }

  .sv-tab {
    padding: 3px 8px;
    border-radius: var(--radius-md, 6px);
    color: var(--text-dim);
    border: 1px solid transparent;
    font-size: var(--ui-body, 12px);
    line-height: 1.2;
    background: transparent;
    transition: background var(--duration-fast, 120ms) var(--ease-default),
                color var(--duration-fast, 120ms) var(--ease-default),
                border-color var(--duration-fast, 120ms) var(--ease-default);
  }
  .sv-tab:hover {
    background: color-mix(in srgb, var(--text-dim) 10%, transparent);
    color: var(--text-bright);
  }
  .sv-tab--active {
    color: var(--text-bright);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    border-color: var(--accent-border, color-mix(in srgb, var(--accent) 40%, transparent));
  }

  .sv-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border-radius: 3px;
    opacity: 0.5;
    margin-left: 2px;
  }
  .sv-close:hover {
    opacity: 1;
    background: color-mix(in srgb, var(--text-dim) 25%, transparent);
  }

  .sv-icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: var(--radius-md, 6px);
    color: var(--text-dim);
    background: transparent;
  }
  .sv-icon-btn:hover {
    color: var(--text-bright);
    background: color-mix(in srgb, var(--text-dim) 12%, transparent);
  }

  .sv-exit {
    padding: 3px 8px;
    border-radius: var(--radius-md, 6px);
    color: var(--text-dim);
    background: transparent;
  }
  .sv-exit:hover {
    color: var(--text-bright);
    background: color-mix(in srgb, var(--text-dim) 12%, transparent);
  }
</style>
