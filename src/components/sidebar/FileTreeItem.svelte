<script lang="ts">
  import type { FileEntry } from "../../lib/stores/files.svelte";
  import { getFileIcon } from "../../lib/utils/file-icons";
  // readDirTree imported dynamically in toggle()
  import FileTreeItem from "./FileTreeItem.svelte";

  let {
    entry,
    depth = 0,
    onFileClick,
    selectedPath,
  }: {
    entry: FileEntry;
    depth?: number;
    onFileClick: (entry: FileEntry) => void;
    selectedPath: string | null;
  } = $props();

  let expanded = $state(false);
  let loading = $state(false);
  // Local state for children — ensures re-render after async lazy-load
  let children = $state<FileEntry[] | undefined>(undefined);
  const indent = $derived(8 + depth * 16);
  const icon = $derived(entry.is_dir ? null : getFileIcon(entry.name));
  const isSelected = $derived(selectedPath === entry.path);

  let hasAutoExpanded = false;
  // Sync from parent when entry.children is populated externally
  $effect(() => {
    if (entry.children && entry.children.length > 0) {
      children = entry.children;
      if (!hasAutoExpanded) {
        hasAutoExpanded = true;
        expanded = true;
      }
    }
  });

  async function toggle() {
    if (entry.is_dir) {
      expanded = !expanded;
      // Lazy-load children if not yet loaded
      if (expanded && !children) {
        loading = true;
        try {
          const { readDirTree } = await import("../../lib/ipc/commands");
          const result = await readDirTree(entry.path);
          entry.children = result; // cache on entry
          children = result;       // drive local rendering
        } catch (e) {
          console.error("Failed to load directory:", e);
        } finally {
          loading = false;
        }
      }
    } else {
      onFileClick(entry);
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="tree-item"
  class:active={isSelected}
  style="padding-left: {indent}px; padding-right: 8px; position: relative;"
  onclick={toggle}
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
  {#each children as child (child.name)}
    <FileTreeItem
      entry={child}
      depth={depth + 1}
      {onFileClick}
      {selectedPath}
    />
  {/each}
{/if}
