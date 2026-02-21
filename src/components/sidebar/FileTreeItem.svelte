<script lang="ts">
  import type { FileEntry } from "../../lib/stores/files.svelte";
  import { getFileIcon } from "../../lib/utils/file-icons";
  import FileTreeItem from "./FileTreeItem.svelte";

  let {
    entry,
    depth = 0,
    onFileClick,
    onFileDoubleClick,
    selectedPath,
    focusedPath = null,
  }: {
    entry: FileEntry;
    depth?: number;
    onFileClick: (entry: FileEntry) => void;
    onFileDoubleClick?: (entry: FileEntry) => void;
    selectedPath: string | null;
    focusedPath?: string | null;
  } = $props();

  let expanded = $state(false);
  let loading = $state(false);
  let children = $state<FileEntry[] | undefined>(undefined);
  const indent = $derived(8 + depth * 16);
  const icon = $derived(entry.is_dir ? null : getFileIcon(entry.name));
  const isSelected = $derived(selectedPath === entry.path);
  const isFocused = $derived(focusedPath === entry.path);

  let hasAutoExpanded = false;
  $effect(() => {
    if (entry.children && entry.children.length > 0) {
      children = entry.children;
      if (!hasAutoExpanded) {
        hasAutoExpanded = true;
        expanded = true;
      }
    }
  });

  let clickTimer: ReturnType<typeof setTimeout> | null = null;

  async function toggleDir() {
    expanded = !expanded;
    if (expanded && !children) {
      loading = true;
      try {
        const { readDirTree } = await import("../../lib/ipc/commands");
        const result = await readDirTree(entry.path);
        entry.children = result;
        children = result;
      } catch (e) {
        console.error("Failed to load directory:", e);
      } finally {
        loading = false;
      }
    }
  }

  function handleClick() {
    if (entry.is_dir) {
      toggleDir();
      return;
    }
    // Single click on file: delay to distinguish from double-click
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      clickTimer = null;
      onFileClick(entry);
    }, 250);
  }

  function handleDblClick() {
    if (entry.is_dir) return;
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
    }
    onFileDoubleClick?.(entry);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowRight" && entry.is_dir) {
      if (!expanded) {
        e.preventDefault();
        e.stopPropagation();
        toggleDir();
      }
    } else if (e.key === "ArrowLeft" && entry.is_dir && expanded) {
      e.preventDefault();
      e.stopPropagation();
      expanded = false;
    }
  }
</script>

<div
  class="tree-item"
  class:active={isSelected}
  style="padding-left: {indent}px; padding-right: 8px; position: relative;"
  role="treeitem"
  tabindex={isFocused ? 0 : -1}
  aria-expanded={entry.is_dir ? expanded : undefined}
  aria-selected={isSelected}
  data-path={entry.path}
  onclick={handleClick}
  ondblclick={handleDblClick}
  onkeydown={handleKeyDown}
>
  {#each Array(depth) as _, i}
    <span
      class="absolute top-0 bottom-0 pointer-events-none"
      style="left: {16 + i * 16}px; width: 1px; background: var(--tree-line); opacity: 0.25;"
    ></span>
  {/each}
  {#if entry.is_dir}
    <i
      class="bi tree-chevron w-4 text-center text-xs text-txt-dim shrink-0 transition-transform duration-100"
      class:bi-chevron-down={expanded}
      class:bi-chevron-right={!expanded}
    ></i>
    <i
      class="bi tree-file-icon folder text-lg mr-1.5 shrink-0"
      class:bi-folder2-open={expanded}
      class:bi-folder2={!expanded}
    ></i>
    <span class="text-txt-bright font-medium truncate" title={entry.name}>{entry.name}</span>
    {#if loading}
      <span class="text-txt-dim text-[10px] ml-1">...</span>
    {/if}
  {:else}
    <span class="w-4 shrink-0"></span>
    <i
      class="bi {icon?.icon} tree-file-icon {icon?.cls} text-lg mr-1.5 shrink-0"
    ></i>
    <span class="truncate" title={entry.name}>{entry.name}</span>
  {/if}
</div>

{#if entry.is_dir && expanded && children}
  {#each children as child (child.path)}
    <FileTreeItem
      entry={child}
      depth={depth + 1}
      {onFileClick}
      {onFileDoubleClick}
      {selectedPath}
      {focusedPath}
    />
  {/each}
{/if}
