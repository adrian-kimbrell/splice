<script lang="ts">
  import { onDestroy } from "svelte";
  import { ui } from "../../lib/stores/ui.svelte";
  import type { SplitDirection } from "../../lib/stores/layout.svelte";

  let {
    title,
    cwd = "",
    branch = "",
    onSplit,
    onClose,
    onAction,
  }: {
    title: string;
    cwd?: string;
    branch?: string;
    onSplit?: (direction: SplitDirection, side: "before" | "after") => void;
    onClose?: () => void;
    onAction?: (action: string) => void;
  } = $props();

  let splitMenuOpen = $state(false);
  let splitBtnEl = $state<HTMLButtonElement>();

  let dropdownEl: HTMLDivElement | null = null;

  function createDropdown() {
    if (dropdownEl) return;
    dropdownEl = document.createElement("div");
    dropdownEl.className = "split-dropdown split-menu-container";
    dropdownEl.innerHTML = `
      <button class="split-dropdown-item" data-dir="horizontal" data-side="after">
        <i class="bi bi-layout-split"></i>
        <span>Split Right</span>
      </button>
      <button class="split-dropdown-item" data-dir="horizontal" data-side="before">
        <i class="bi bi-layout-split" style="transform: scaleX(-1)"></i>
        <span>Split Left</span>
      </button>
      <button class="split-dropdown-item" data-dir="vertical" data-side="after">
        <i class="bi bi-layout-split" style="transform: rotate(90deg)"></i>
        <span>Split Down</span>
      </button>
      <button class="split-dropdown-item" data-dir="vertical" data-side="before">
        <i class="bi bi-layout-split" style="transform: rotate(-90deg)"></i>
        <span>Split Up</span>
      </button>
    `;
    dropdownEl.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("[data-dir]");
      if (btn) {
        const dir = btn.getAttribute("data-dir") as SplitDirection;
        const side = btn.getAttribute("data-side") as "before" | "after";
        splitMenuOpen = false;
        onSplit?.(dir, side);
      }
    });
    document.body.appendChild(dropdownEl);
  }

  function removeDropdown() {
    if (dropdownEl) {
      dropdownEl.remove();
      dropdownEl = null;
    }
  }

  function updatePos() {
    if (!splitBtnEl || !dropdownEl) return;
    const r = splitBtnEl.getBoundingClientRect();
    dropdownEl.style.top = r.bottom + "px";
    dropdownEl.style.left = r.right + "px";
  }

  $effect(() => {
    if (splitMenuOpen) {
      createDropdown();
      updatePos();
    } else {
      removeDropdown();
    }
  });

  function onResize() {
    if (splitMenuOpen) updatePos();
    if (plusMenuOpen) updatePlusPos();
  }

  function closeMenus(e: MouseEvent) {
    const t = e.target as HTMLElement;
    if (splitMenuOpen && !t.closest(".split-menu-container")) splitMenuOpen = false;
    if (plusMenuOpen && !t.closest(".plus-menu-container")) plusMenuOpen = false;
  }

  function toggleSplitMenu(e: MouseEvent) {
    e.stopPropagation();
    plusMenuOpen = false;
    splitMenuOpen = !splitMenuOpen;
  }

  // --- Plus dropdown ---
  let plusMenuOpen = $state(false);
  let plusBtnEl = $state<HTMLButtonElement>();
  let plusDropdownEl: HTMLDivElement | null = null;

  function createPlusDropdown() {
    if (plusDropdownEl) return;
    plusDropdownEl = document.createElement("div");
    plusDropdownEl.className = "split-dropdown plus-menu-container";
    plusDropdownEl.innerHTML = `
      <button class="split-dropdown-item" data-action="new-file">
        <span>New File</span>
        <kbd>⌘ N</kbd>
      </button>
      <button class="split-dropdown-item" data-action="open-file">
        <span>Open File</span>
        <kbd>⌘ P</kbd>
      </button>
      <div class="split-dropdown-sep"></div>
      <button class="split-dropdown-item" data-action="search-project">
        <span>Search Project</span>
        <kbd>⌘ F</kbd>
      </button>
      <button class="split-dropdown-item" data-action="search-symbols">
        <span>Search Symbols</span>
        <kbd>⌘ T</kbd>
      </button>
      <div class="split-dropdown-sep"></div>
      <button class="split-dropdown-item" data-action="new-terminal">
        <span>New Terminal</span>
        <kbd>⌃ \`</kbd>
      </button>
    `;
    plusDropdownEl.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("[data-action]");
      if (btn) {
        const action = btn.getAttribute("data-action")!;
        plusMenuOpen = false;
        onAction?.(action);
      }
    });
    document.body.appendChild(plusDropdownEl);
  }

  function removePlusDropdown() {
    if (plusDropdownEl) { plusDropdownEl.remove(); plusDropdownEl = null; }
  }

  function updatePlusPos() {
    if (!plusBtnEl || !plusDropdownEl) return;
    const r = plusBtnEl.getBoundingClientRect();
    plusDropdownEl.style.top = r.bottom + "px";
    plusDropdownEl.style.left = r.right + "px";
  }

  $effect(() => {
    if (plusMenuOpen) { createPlusDropdown(); updatePlusPos(); }
    else { removePlusDropdown(); }
  });

  function togglePlusMenu(e: MouseEvent) {
    e.stopPropagation();
    splitMenuOpen = false;
    plusMenuOpen = !plusMenuOpen;
  }

  onDestroy(() => { removeDropdown(); removePlusDropdown(); });
</script>

<svelte:window onresize={onResize} />
<svelte:document onclick={closeMenus} />

<div
  class="flex items-center px-2.5 bg-tab-active border-b border-border text-xs shrink-0 select-none overflow-hidden min-w-0"
  style="height: 28px; min-height: 28px;"
>
  <span class="text-txt-bright font-medium whitespace-nowrap mr-2 overflow-hidden text-ellipsis min-w-0"
    >{title}</span
  >
  <span class="flex-1 min-w-0"></span>
  <span
    class="flex items-center gap-3 text-txt-dim text-[11px] whitespace-nowrap overflow-hidden min-w-0"
  >
    {#if cwd}
      <span class="overflow-hidden text-ellipsis"
        ><i class="bi bi-folder2 mr-1 text-[11px]"></i>{cwd}</span
      >
    {/if}
    {#if branch}
      <span class="overflow-hidden text-ellipsis"
        ><i class="bi bi-git mr-1 text-[11px]"></i>{branch}</span
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
