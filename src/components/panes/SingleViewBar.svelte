<script lang="ts">
  import type { PaneConfig } from "../../lib/stores/layout.svelte";

  let {
    leafIds,
    panes,
    activeId,
    onSelect,
    onClose,
    onAdd,
  }: {
    leafIds: string[];
    panes: Record<string, PaneConfig>;
    activeId: string | null;
    onSelect: (id: string) => void;
    onClose: (id: string) => void;
    onAdd: () => void;
  } = $props();

  let tabsEl = $state<HTMLDivElement>();

  // When the active tab changes (e.g. after +, which appends and activates a new
  // pane), scroll it into view so the newly highlighted tab is always visible.
  $effect(() => {
    activeId; // track
    const el = tabsEl;
    if (!el) return;
    requestAnimationFrame(() => {
      el.querySelector<HTMLElement>('[data-active="true"]')
        ?.scrollIntoView({ inline: "nearest", block: "nearest" });
    });
  });

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

<div class="single-view-bar flex items-center gap-1.5 px-2 shrink-0">
  <!-- Only the tabs scroll (horizontally). A soft right-edge fade hints at
       overflow; the scrollbar itself is hidden. The +, divider and exit
       controls are pinned outside the scroll region so they stay visible. -->
  <div bind:this={tabsEl} class="sv-tabs flex items-center gap-1 flex-1 min-w-0">
    {#each leafIds as id, i (id)}
      {@const config = panes[id]}
      {#if config}
        <button
          class="sv-tab flex items-center gap-1.5 shrink-0"
          class:sv-tab--active={id === activeId}
          data-active={id === activeId}
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
  </div>

  <button class="sv-icon-btn shrink-0" title="New terminal" onclick={onAdd}>
    <i class="bi bi-plus-lg"></i>
  </button>
</div>

<style>
  .single-view-bar {
    height: 34px;
    background: var(--bg-secondary, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--text-dim) 18%, transparent);
  }

  /* Horizontal-only scroll for the tab row, with the scrollbar hidden. A soft
     right-edge mask fades the last tab when the row overflows, hinting there's
     more to scroll to (falls over empty space when it doesn't overflow). */
  .sv-tabs {
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none; /* Firefox */
    -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 20px), transparent);
    mask-image: linear-gradient(to right, #000 calc(100% - 20px), transparent);
  }
  .sv-tabs::-webkit-scrollbar {
    display: none; /* WebKit */
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
</style>
