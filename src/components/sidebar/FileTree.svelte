<script lang="ts">
  import FileTreeItem from "./FileTreeItem.svelte";
  import type { FileEntry } from "../../lib/stores/files.svelte";

  let {
    entries,
    onFileClick,
    onFileDoubleClick,
    selectedPath,
  }: {
    entries: FileEntry[];
    onFileClick: (entry: FileEntry) => void;
    onFileDoubleClick?: (entry: FileEntry) => void;
    selectedPath: string | null;
  } = $props();

  let treeEl = $state<HTMLDivElement>();
  let focusedPath = $state<string | null>(null);

  function getVisibleItems(el: HTMLDivElement): HTMLElement[] {
    return Array.from(el.querySelectorAll<HTMLElement>('[role="treeitem"]'));
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (!treeEl) return;
    const items = getVisibleItems(treeEl);
    if (items.length === 0) return;

    const currentIdx = items.findIndex(el => el.dataset.path === focusedPath);
    let handled = true;

    switch (e.key) {
      case "ArrowDown": {
        const next = Math.min(currentIdx + 1, items.length - 1);
        focusedPath = items[next].dataset.path ?? null;
        items[next].focus();
        break;
      }
      case "ArrowUp": {
        const prev = Math.max(currentIdx - 1, 0);
        focusedPath = items[prev].dataset.path ?? null;
        items[prev].focus();
        break;
      }
      case "Home": {
        focusedPath = items[0].dataset.path ?? null;
        items[0].focus();
        break;
      }
      case "End": {
        const last = items[items.length - 1];
        focusedPath = last.dataset.path ?? null;
        last.focus();
        break;
      }
      case "Enter":
      case " ": {
        if (currentIdx >= 0) {
          items[currentIdx].click();
        }
        break;
      }
      default:
        handled = false;
    }

    if (handled) e.preventDefault();
  }
</script>

<div
  bind:this={treeEl}
  class="py-1.5"
  role="tree"
  tabindex="0"
  onkeydown={handleKeyDown}
>
  {#each entries as entry (entry.path)}
    <FileTreeItem {entry} {onFileClick} {onFileDoubleClick} {selectedPath} {focusedPath} />
  {/each}
</div>
