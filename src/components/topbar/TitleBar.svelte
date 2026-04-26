<script lang="ts">
  /**
   * TitleBar.svelte -- Top bar combining window drag region, attention notifications,
   * and quick-action buttons (open folder, new terminal, settings).
   *
   * The center area is a Tauri drag region (data-tauri-drag-region) for window movement.
   *
   * Notification display: Claude attention notifications (permission prompts and idle
   * alerts) appear as a collapsible area between the drag region and action buttons.
   * When collapsed, a badge shows the worst severity + count. On hover, it expands
   * into individual chips with terminal name, message, and dismiss button. The expand/
   * collapse uses CSS max-width transitions on the badge-wrap and chips-wrap elements.
   * Notifications are sorted with "permission" type first (higher severity).
   */
  import { attentionStore } from '../../lib/stores/attention.svelte';
  import { workspaceManager } from '../../lib/stores/workspace.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import { openSettingsWindow } from '../../lib/utils/settings-window';


  const notifList = $derived(
    Object.values(attentionStore.notifications).sort((a, b) => {
      if (a.type === b.type) return a.timestamp - b.timestamp;
      return a.type === 'permission' ? -1 : 1;
    })
  );

  const hasWorkspace = $derived(!!workspaceManager.activeWorkspace);

  // Worst severity drives badge color
  const worstType = $derived(notifList[0]?.type ?? 'idle');
  const worstColor = $derived(worstType === 'permission' ? 'var(--ansi-red)' : 'var(--ansi-yellow)');

  let notifExpanded = $state(false);

  function terminalTitle(terminalId: number): string {
    for (const ws of Object.values(workspaceManager.workspaces)) {
      for (const pane of Object.values(ws.panes)) {
        if (pane.kind === 'terminal' && pane.terminalId === terminalId) {
          if (ws.id !== workspaceManager.activeWorkspaceId) return `${pane.title} (${ws.name})`;
          return pane.title;
        }
      }
    }
    return `Terminal ${terminalId}`;
  }

  function handleNotifClick(terminalId: number) {
    for (const ws of Object.values(workspaceManager.workspaces)) {
      for (const [paneId, pane] of Object.entries(ws.panes)) {
        if (pane.kind === 'terminal' && pane.terminalId === terminalId) {
          workspaceManager.switchWorkspace(ws.id);
          workspaceManager.setActivePaneId(paneId, ws.id);
          attentionStore.clear(terminalId);
          return;
        }
      }
    }
  }

  async function handleOpenFolder() {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true, multiple: false });
      if (selected) {
        if (!workspaceManager.activeWorkspace) workspaceManager.createEmptyWorkspace();
        await workspaceManager.openFolderInWorkspace(selected as string);
        ui.explorerVisible = true;
      }
    } catch (e) {
      console.error('Failed to open folder:', e);
    }
  }
</script>

<div class="title-bar">
  <!-- Drag region fills remaining space -->
  <div class="title-center" data-tauri-drag-region></div>

  <!-- Notification area: compact badge → expanded chips on hover -->
  {#if notifList.length > 0}
    <div
      class="notif-area"
      class:notif-area--open={notifExpanded}
      onmouseenter={() => notifExpanded = true}
      onmouseleave={() => notifExpanded = false}
    >
      <!-- Badge (visible when collapsed) -->
      <div class="notif-badge-wrap">
        <div class="notif-badge" onclick={() => handleNotifClick(notifList[0].terminalId)} role="button" tabindex="-1">
          <i class="bi bi-claude notif-icon" style="color: {worstColor};"></i>
          <span class="notif-badge-type" style="color: {worstColor};">{worstType}</span>
          {#if notifList.length > 1}
            <span class="notif-badge-count">×{notifList.length}</span>
          {/if}
        </div>
      </div>

      <!-- Chips (visible when expanded) -->
      <div class="notif-chips-wrap">
      <div class="notif-chips">
        {#each notifList as n (n.terminalId)}
          {@const isPermission = n.type === 'permission'}
          {@const color = isPermission ? 'var(--ansi-red)' : 'var(--ansi-yellow)'}
          <div class="notif-chip" onclick={() => handleNotifClick(n.terminalId)} role="button" tabindex="-1">
            <i class="bi bi-claude notif-icon" style="color: {color};" aria-hidden="true"></i>
            <span class="notif-type" style="color: {color};">{isPermission ? 'permission' : 'idle'}</span>
            <span class="notif-sep">·</span>
            <span class="notif-terminal">{terminalTitle(n.terminalId)}</span>
            {#if n.message}
              <span class="notif-sep">—</span>
              <span class="notif-message">{n.message}</span>
            {/if}
            <button class="notif-dismiss" title="Dismiss" onclick={() => attentionStore.clear(n.terminalId)}>
              <i class="bi bi-x"></i>
            </button>
          </div>
        {/each}
      </div>
      </div>
    </div>
  {/if}

  <!-- Right actions — always pinned, never pushed out -->
  <div class="title-actions">
    {#if hasWorkspace}
      <button class="title-btn" title="Open Folder" onclick={handleOpenFolder}>
        <i class="bi bi-folder2-open"></i>
      </button>
    {/if}
    <button class="title-btn" title="New Terminal" onclick={() => workspaceManager.spawnTerminalInWorkspace()}>
      <i class="bi bi-terminal"></i>
    </button>
    <button class="title-btn" title="Settings" onclick={openSettingsWindow}>
      <i class="bi bi-gear"></i>
    </button>
  </div>
</div>

<style>
  .title-bar {
    flex-shrink: 0;
    height: 32px;
    margin-bottom: 6px;
    background: var(--bg-sidebar);
    border-radius: var(--radius-lg);
    border: 1px solid color-mix(in srgb, var(--text-dim) 22%, transparent);
    box-shadow: var(--shadow-md);
    display: flex;
    flex-direction: row;
    align-items: stretch;
    overflow: hidden;
    transition: height 150ms ease;
  }


  .title-center {
    flex: 1;
    cursor: grab;
    min-width: 0;
  }

  /* ── Notification area ─────────────────────────────────── */
  .notif-area {
    display: flex;
    align-items: center;
    overflow: hidden;
    flex-shrink: 0;
    border-left: 1px solid var(--border);
  }

  /* Badge wrapper — collapses width, owns the transition */
  .notif-badge-wrap {
    overflow: hidden;
    flex-shrink: 0;
    max-width: 160px;
    opacity: 1;
    transition: max-width 240ms ease-out, opacity 160ms ease;
  }
  .notif-area--open .notif-badge-wrap {
    max-width: 0;
    opacity: 0;
    pointer-events: none;
  }

  /* Badge inner — stable padding, no transition */
  .notif-badge {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0 10px;
    white-space: nowrap;
    cursor: pointer;
  }

  .notif-badge-type {
    font-size: var(--ui-sm);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .notif-badge-count {
    font-size: var(--ui-sm);
    color: var(--text-dim);
  }

  /* Chips wrapper — expands width, owns the transition */
  .notif-chips-wrap {
    overflow: hidden;
    max-width: 0;
    opacity: 0;
    pointer-events: none;
    transition: max-width 240ms ease-out, opacity 160ms ease 80ms;
  }
  .notif-area--open .notif-chips-wrap {
    max-width: 900px;
    opacity: 1;
    pointer-events: auto;
  }

  /* Chips inner — stable layout, no transition */
  .notif-chips {
    display: flex;
    align-items: center;
    white-space: nowrap;
  }

  .notif-chip {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0 10px;
    border-right: 1px solid var(--border);
    font-size: var(--ui-label);
    height: 100%;
    cursor: pointer;
  }
  .notif-chip:hover { background: var(--bg-hover); }
  .notif-chip:last-child { border-right: none; }

  .notif-icon {
    font-size: var(--ui-xs);
    flex-shrink: 0;
    animation: attn-pulse 1.2s ease-in-out infinite;
  }
  .notif-type {
    font-size: var(--ui-sm);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex-shrink: 0;
  }
  .notif-sep { color: var(--text-dim); flex-shrink: 0; }
  .notif-terminal { color: var(--text-dim); flex-shrink: 0; }
  .notif-message {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 200px;
  }

  .notif-dismiss {
    flex-shrink: 0;
    color: var(--text-dim);
    background: none;
    border: none;
    cursor: pointer;
    padding: 0 2px;
    font-size: var(--ui-md);
    border-radius: 3px;
    display: flex;
    align-items: center;
    line-height: 1;
    margin-left: 4px;
  }
  .notif-dismiss:hover { color: var(--text); background: var(--bg-hover); }

  /* ── Right action buttons ──────────────────────────────── */
  .title-actions {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    padding: 0 4px;
  }
  .title-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 5px;
    border: none;
    background: none;
    color: var(--text-dim);
    cursor: pointer;
    font-size: var(--ui-md);
  }
  .title-btn:hover { color: var(--text); background: var(--bg-hover); }

  @keyframes attn-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
</style>
