<script lang="ts">
  import type { FileEntry } from "../../lib/stores/files.svelte";
  import { getFileIcon } from "../../lib/utils/file-icons";
  import FileTreeItem from "./FileTreeItem.svelte";
  import { getContext } from "svelte";

  interface ExpandedCtx { has(p: string): boolean; add(p: string): void; delete(p: string): void; }
  const expandedCtx = getContext<ExpandedCtx | undefined>("expandedPaths");

  let {
    entry,
    depth = 0,
    onFileClick,
    onFileDoubleClick,
    onContextMenu,
    selectedPath,
    focusedPath = null,
    collapseGeneration = 0,
    refreshGeneration = 0,
    inlineCreateDir = null,
    inlineCreateType = null,
    sshWorkspaceId = null,
    onInlineCreateSubmit,
    onInlineCreateCancel,
  }: {
    entry: FileEntry;
    depth?: number;
    onFileClick: (entry: FileEntry) => void;
    onFileDoubleClick?: (entry: FileEntry) => void;
    onContextMenu?: (e: MouseEvent, entry: FileEntry) => void;
    selectedPath: string | null;
    focusedPath?: string | null;
    collapseGeneration?: number;
    refreshGeneration?: number;
    inlineCreateDir?: string | null;
    inlineCreateType?: "file" | "folder" | null;
    sshWorkspaceId?: string | null;
    onInlineCreateSubmit?: (value: string) => void;
    onInlineCreateCancel?: () => void;
  } = $props();

  // Restore expanded state from the per-workspace context (survives workspace switches).
  let expanded = $state(entry.is_dir && (expandedCtx?.has(entry.path) ?? false));
  let loading = $state(false);
  let children = $state<FileEntry[] | undefined>(undefined);

  // When mounting in a restored-expanded state, load children immediately.
  let didRestoreLoad = false;
  $effect(() => {
    if (!didRestoreLoad) {
      didRestoreLoad = true;
      if (expanded && entry.is_dir && !children && !loading) {
        reloadChildren();
      }
    }
  });
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
        expandedCtx?.add(entry.path);
      }
    }
  });

  // Collapse all: when collapseGeneration increments, collapse this item
  let lastCollapseGen = 0;
  $effect(() => {
    if (collapseGeneration > lastCollapseGen) {
      lastCollapseGen = collapseGeneration;
      expanded = false;
      expandedCtx?.delete(entry.path);
    }
  });

  // Refresh: when refreshGeneration increments, reload children if expanded
  let lastRefreshGen = 0;
  $effect(() => {
    if (refreshGeneration > lastRefreshGen) {
      lastRefreshGen = refreshGeneration;
      if (expanded && entry.is_dir) {
        reloadChildren();
      }
    }
  });

  function autoFocus(node: HTMLInputElement) {
    requestAnimationFrame(() => node.focus());
  }

  // Auto-expand this directory when it becomes the inline create target
  $effect(() => {
    if (inlineCreateDir === entry.path && entry.is_dir && !expanded) {
      toggleDir();
    }
  });

  async function reloadChildren() {
    loading = true;
    try {
      let result: FileEntry[];
      if (sshWorkspaceId) {
        const { sftpListDir } = await import("../../lib/ipc/commands");
        result = await sftpListDir(sshWorkspaceId, entry.path);
      } else {
        const { readDirTree } = await import("../../lib/ipc/commands");
        result = await readDirTree(entry.path);
      }
      entry.children = result;
      children = result;
    } catch (e) {
      console.error("Failed to reload directory:", e);
    } finally {
      loading = false;
    }
  }

  async function toggleDir() {
    expanded = !expanded;
    if (expanded) expandedCtx?.add(entry.path);
    else expandedCtx?.delete(entry.path);
    if (expanded && !children) {
      loading = true;
      try {
        let result: FileEntry[];
        if (sshWorkspaceId) {
          const { sftpListDir } = await import("../../lib/ipc/commands");
          result = await sftpListDir(sshWorkspaceId, entry.path);
        } else {
          const { readDirTree } = await import("../../lib/ipc/commands");
          result = await readDirTree(entry.path);
        }
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
    onFileClick(entry);
  }

  function handleDblClick() {
    if (entry.is_dir) return;
    onFileDoubleClick?.(entry);
  }

  function handleContextMenu(e: MouseEvent) {
    if (!onContextMenu) return;
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(e, entry);
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
      expandedCtx?.delete(entry.path);
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
  oncontextmenu={handleContextMenu}
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
    <span class="text-txt-bright font-medium whitespace-nowrap" title={entry.name}>{entry.name}</span>
    {#if loading}
      <span class="text-txt-dim text-[10px] ml-1">...</span>
    {/if}
  {:else}
    <span class="w-4 shrink-0"></span>
    <i
      class="bi {icon?.icon} tree-file-icon {icon?.cls} text-lg mr-1.5 shrink-0"
    ></i>
    <span class="whitespace-nowrap" title={entry.name}>{entry.name}</span>
  {/if}
</div>

{#if entry.is_dir && expanded && children}
  {#each children as child (child.path)}
    <FileTreeItem
      entry={child}
      depth={depth + 1}
      {onFileClick}
      {onFileDoubleClick}
      {onContextMenu}
      {selectedPath}
      {focusedPath}
      {collapseGeneration}
      {refreshGeneration}
      {inlineCreateDir}
      {inlineCreateType}
      {sshWorkspaceId}
      {onInlineCreateSubmit}
      {onInlineCreateCancel}
    />
  {/each}
  {#if inlineCreateDir === entry.path && inlineCreateType}
    <div
      class="tree-item"
      style="padding-left: {8 + (depth + 1) * 16}px; padding-right: 8px;"
    >
      <span class="w-4 shrink-0"></span>
      <i class="bi {inlineCreateType === 'folder' ? 'bi-folder2' : 'bi-file-earmark'} tree-file-icon {inlineCreateType === 'folder' ? 'folder' : ''} text-lg mr-1.5 shrink-0"></i>
      <input
        use:autoFocus
        class="flex-1 min-w-0 px-1 py-0 text-xs outline-none"
        style="background: var(--bg-input); color: var(--text-bright); border: 1px solid var(--accent); line-height: 20px;"
        onkeydown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); onInlineCreateSubmit?.((e.target as HTMLInputElement).value); }
          if (e.key === "Escape") { e.preventDefault(); onInlineCreateCancel?.(); }
        }}
        onblur={() => onInlineCreateCancel?.()}
      />
    </div>
  {/if}
{/if}
