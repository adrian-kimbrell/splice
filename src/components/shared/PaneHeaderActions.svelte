<script lang="ts">
  /**
   * The right-hand action cluster shared by every pane header: the "+" menu
   * (new file / open file / search / new terminal), the split menu and the
   * close button. TabBar and TerminalTitlebar used to carry identical copies.
   */
  import type { SplitDirection } from "../../lib/stores/layout.svelte";
  import DropdownMenu, { type DropdownItem } from "./DropdownMenu.svelte";

  let {
    onSplit,
    onClose,
    onAction,
  }: {
    onSplit?: (direction: SplitDirection, side: "before" | "after") => void;
    onClose?: () => void;
    onAction?: (action: string) => void;
  } = $props();

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

  let plusMenuOpen = $state(false);
  let plusBtnEl = $state<HTMLButtonElement | null>(null);
  let plusDropdown: DropdownMenu;

  const plusItems: DropdownItem[] = [
    { label: "New File", shortcut: "⌘ N", action: "new-file" },
    { label: "Open File", shortcut: "⌘ O", action: "open-file" },
    { label: "", action: "", separator: true },
    { label: "Search Project", shortcut: "⌘ ⇧ F", action: "search-project" },
    { label: "", action: "", separator: true },
    { label: "New Terminal", shortcut: "⌃ `", action: "new-terminal" },
  ];

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
  onSelect={(action) => onAction?.(action)}
  containerClass="plus-menu-container"
/>

{#if onAction}
  <div class="plus-menu-container">
    <button bind:this={plusBtnEl} class="pane-action-btn" title="New..." onclick={togglePlusMenu}>
      <i class="bi bi-plus-lg"></i>
    </button>
  </div>
{/if}
{#if onSplit}
  <div class="split-menu-container">
    <button bind:this={splitBtnEl} class="pane-action-btn" title="Split Pane" onclick={toggleSplitMenu}>
      <i class="bi bi-layout-split"></i>
    </button>
  </div>
{/if}
{#if onClose}
  <button class="pane-action-btn close" title="Close" onclick={onClose}>
    <i class="bi bi-x-lg" style="font-size: var(--ui-icon)"></i>
  </button>
{/if}
