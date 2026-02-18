<script lang="ts">
  import type { Workspace } from "../../lib/stores/workspace.svelte";
  import { workspaceManager } from "../../lib/stores/workspace.svelte";
  import type { PaneConfig } from "../../lib/stores/layout.svelte";

  let {
    workspace,
    isActive = false,
    selectedItem,
    compact = false,
    onItemClick,
    onWorkspaceClick,
    onClose,
  }: {
    workspace: Workspace;
    isActive?: boolean;
    selectedItem: string | null;
    compact?: boolean;
    onItemClick: (wsId: string, itemId: string) => void;
    onWorkspaceClick: () => void;
    onClose?: () => void;
  } = $props();

  let editing = $state(false);
  let editValue = $state("");

  function startEditing() {
    editValue = workspace.name;
    editing = true;
  }

  function commitEdit() {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== workspace.name) {
      workspaceManager.renameWorkspace(workspace.id, trimmed);
    }
    editing = false;
  }

  function handleEditKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") { commitEdit(); }
    else if (e.key === "Escape") { editing = false; }
  }

  // Show terminals + individual open files (not editor pane containers)
  const items = $derived.by(() => {
    const result: { id: string; name: string; type: "terminal" | "file" }[] = [];

    // Add terminal panes
    for (const pane of Object.values(workspace.panes)) {
      if (pane.kind === "terminal") {
        result.push({ id: pane.id, name: pane.title, type: "terminal" });
      }
    }

    // Add individual open files
    for (const file of workspace.openFiles) {
      result.push({
        id: `file:${file.path}`,
        name: file.name,
        type: "file",
      });
    }

    return result;
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="workspace-group">
  {#if !compact}
    <div
      class="workspace-header group flex items-center"
      onclick={onWorkspaceClick}
      ondblclick={(e) => { e.stopPropagation(); startEditing(); }}
      title="Double-click to rename"
    >
      {#if editing}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="workspace-rename-input"
          bind:value={editValue}
          onkeydown={handleEditKeydown}
          onblur={commitEdit}
          autofocus
          onclick={(e) => e.stopPropagation()}
        />
      {:else}
        <div class="workspace-title flex-1 min-w-0 truncate" class:text-txt-bright={isActive}>{workspace.name}</div>
        {#if onClose}
          <button
            class="pane-action-btn close shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-75"
            title="Close Workspace"
            onclick={(e) => { e.stopPropagation(); onClose?.(); }}
          >
            <i class="bi bi-x-lg" style="font-size: 12px"></i>
          </button>
        {/if}
      {/if}
    </div>
  {:else}
    <div class="workspace-separator"></div>
  {/if}
  <div class="session-list">
  {#each items as item, i}
    {@const isLast = i === items.length - 1}
    {@const isFirst = i === 0}
    {@const iconClass =
      item.type === "terminal"
        ? "bi-terminal"
        : "bi-file-earmark"}
    {@const itemKey = `${workspace.id}:${item.id}`}
    {@const isSelected = selectedItem === itemKey}
    <div
      class="session-item"
      class:compact
      class:first={isFirst}
      class:last={isLast}
      class:active={isSelected}
      onclick={() => onItemClick(workspace.id, item.id)}
      title={item.name}
    >
      <div class="session-tree-bar">
        <div class="tree-vertical-line"></div>
        <div class="tree-horizontal-line"></div>
      </div>
      <div class="session-icon"><i class="bi {iconClass}"></i></div>
      {#if !compact}
        <div class="session-info"><div class="session-title">{item.name}</div></div>
      {/if}
    </div>
  {/each}
  {#if items.length === 0}
    {#if !compact}
      <div class="pl-5 py-0.5 text-[10px] text-txt-dim italic">No folder opened</div>
    {/if}
  {/if}
  </div>
</div>
