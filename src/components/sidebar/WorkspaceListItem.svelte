<script lang="ts">
  import type { Workspace } from "../../lib/stores/workspace.svelte";
  import { workspaceManager } from "../../lib/stores/workspace.svelte";
  import type { PaneConfig } from "../../lib/stores/layout.svelte";
  import { attentionStore } from "../../lib/stores/attention.svelte";

  let {
    workspace,
    isActive = false,
    selectedItem,
    compact = false,
    onItemClick,
    onWorkspaceClick,
    onClose,
    onHeaderContextMenu,
  }: {
    workspace: Workspace;
    isActive?: boolean;
    selectedItem: string | null;
    compact?: boolean;
    onItemClick: (wsId: string, itemId: string) => void;
    onWorkspaceClick: () => void;
    onClose?: () => void;
    onHeaderContextMenu?: (e: MouseEvent) => void;
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
    const result: { id: string; name: string; type: "terminal" | "file"; terminalId?: number }[] = [];

    // Add terminal panes
    for (const pane of Object.values(workspace.panes)) {
      if (pane.kind === "terminal") {
        result.push({ id: pane.id, name: pane.title, type: "terminal", terminalId: pane.terminalId });
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
      oncontextmenu={onHeaderContextMenu}
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
    <div
      class="workspace-header-compact"
      class:text-txt-bright={isActive}
      onclick={onWorkspaceClick}
      oncontextmenu={onHeaderContextMenu}
      title={workspace.name}
    >
      <i class="bi bi-diagram-2"></i>
    </div>
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
    {@const attention = item.terminalId != null ? attentionStore.notifications[item.terminalId] ?? null : null}
    <div
      class="session-item"
      class:compact
      class:first={isFirst}
      class:last={isLast}
      class:active={isSelected}
      class:attention-permission={attention?.type === 'permission'}
      class:attention-idle={attention?.type === 'idle'}
      onclick={() => onItemClick(workspace.id, item.id)}
      title={item.name}
    >
      <div class="session-tree-bar">
        <div class="tree-vertical-line"></div>
        <div class="tree-horizontal-line"></div>
      </div>
      <div class="session-icon">
        {#if attention}
          <i
            class="bi bi-claude attention-icon"
            style="color: {attention.type === 'permission' ? 'var(--ansi-red)' : 'var(--ansi-yellow)'};"
          ></i>
        {:else}
          <i class="bi {iconClass}"></i>
        {/if}
      </div>
      {#if !compact}
        <div class="session-info">
          <div class="session-title" style={attention ? `color: ${attention.type === 'permission' ? 'var(--ansi-red)' : 'var(--ansi-yellow)'}` : ''}>
            {item.name}
          </div>
        </div>
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

<style>
  .attention-permission {
    animation: sidebar-pulse-permission 1.2s ease-in-out infinite;
  }
  .attention-idle {
    animation: sidebar-pulse-idle 1.8s ease-in-out infinite;
  }
  .attention-icon {
    font-size: 9px;
    animation: bell-throb 1.2s ease-in-out infinite;
  }
  @keyframes sidebar-pulse-permission {
    0%, 100% { background: transparent; }
    50% { background: rgba(224, 108, 117, 0.12); }
  }
  @keyframes sidebar-pulse-idle {
    0%, 100% { background: transparent; }
    50% { background: rgba(229, 192, 123, 0.10); }
  }
  @keyframes bell-throb {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
</style>
