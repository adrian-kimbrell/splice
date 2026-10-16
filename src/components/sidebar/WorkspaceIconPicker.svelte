<script lang="ts">
  /**
   * WorkspaceIconPicker -- small fixed popover for choosing the icon shown next to
   * a workspace's name in the workspaces bar (a "favourite" marker so a workspace
   * can be picked out at a glance).
   *
   * Opened from the workspace context menu at the click position. Picks a
   * Bootstrap icon class from a curated grid, or "None" to clear. Closes on
   * outside click or Escape. Positioning is zoom-aware via positionFixedMenu.
   */
  import { onMount } from "svelte";
  import { workspaceManager } from "../../lib/stores/workspace.svelte";
  import { positionFixedMenu } from "../../lib/utils/context-menu";

  let {
    wsId,
    x,
    y,
    onClose,
  }: {
    wsId: string;
    x: number;
    y: number;
    onClose: () => void;
  } = $props();

  /** Curated set — all present in bootstrap-icons 1.13. */
  const WORKSPACE_ICONS: string[] = [
    "bi-star-fill", "bi-heart-fill", "bi-bookmark-fill", "bi-pin-angle-fill",
    "bi-lightning-charge-fill", "bi-fire", "bi-flag-fill", "bi-rocket-takeoff-fill",
    "bi-code-slash", "bi-terminal-fill", "bi-bug-fill", "bi-gear-fill",
    "bi-database-fill", "bi-cloud-fill", "bi-globe2", "bi-cpu-fill",
    "bi-house-fill", "bi-briefcase-fill", "bi-book-fill", "bi-journal-code",
    "bi-folder-fill", "bi-box-seam-fill", "bi-tools", "bi-shield-fill",
    "bi-lightbulb-fill", "bi-palette-fill", "bi-robot", "bi-people-fill",
    "bi-music-note-beamed", "bi-camera-fill", "bi-cart-fill", "bi-bank",
  ];

  let el = $state<HTMLDivElement>();
  const current = $derived(workspaceManager.workspaces[wsId]?.icon ?? null);

  function pick(icon: string | null) {
    workspaceManager.setWorkspaceIcon(wsId, icon);
    onClose();
  }

  function onDocMousedown(e: MouseEvent) {
    if (el && !el.contains(e.target as Node)) onClose();
  }
  function onDocKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
  }

  onMount(() => {
    if (el) positionFixedMenu(el, x, y);
    // Defer so the click that opened us doesn't immediately close us.
    const id = setTimeout(() => {
      document.addEventListener("mousedown", onDocMousedown);
      document.addEventListener("keydown", onDocKeydown);
    }, 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", onDocMousedown);
      document.removeEventListener("keydown", onDocKeydown);
    };
  });
</script>

<div
  bind:this={el}
  class="ws-icon-picker split-dropdown ctx-menu-container"
  role="dialog"
  aria-label="Choose workspace icon"
>
  <div class="ws-icon-picker-title">Workspace icon</div>
  <div class="ws-icon-grid">
    {#each WORKSPACE_ICONS as icon (icon)}
      <button
        class="ws-icon-cell"
        class:selected={icon === current}
        title={icon.replace(/^bi-/, "").replace(/-fill$/, "").replace(/-/g, " ")}
        onclick={() => pick(icon)}
      >
        <i class="bi {icon}"></i>
      </button>
    {/each}
  </div>
  <button class="split-dropdown-item ws-icon-none" onclick={() => pick(null)} disabled={current === null}>
    <i class="bi bi-x-circle"></i>
    <span>No icon</span>
  </button>
</div>

<style>
  .ws-icon-picker {
    /* Override .split-dropdown's translateX(-100%): we anchor at the click point. */
    transform: none;
    z-index: 9999;
    width: 232px;
    padding: 6px 0 4px;
  }
  .ws-icon-picker-title {
    font-size: var(--ui-xs);
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.4px;
    padding: 2px 10px 6px;
    user-select: none;
  }
  .ws-icon-grid {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 2px;
    padding: 0 6px 6px;
  }
  .ws-icon-cell {
    height: 26px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    font-size: var(--ui-body);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 100ms, color 100ms;
  }
  .ws-icon-cell:hover { background: var(--bg-hover); color: var(--text-bright); }
  .ws-icon-cell.selected {
    background: var(--bg-selected);
    color: var(--accent);
    border-color: var(--accent);
  }
  .ws-icon-none[disabled] { opacity: 0.4; cursor: default; }
</style>
