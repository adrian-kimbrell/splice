<script lang="ts">
  import { attentionStore } from '../../lib/stores/attention.svelte';
  import { workspaceManager } from '../../lib/stores/workspace.svelte';
  import { ui } from '../../lib/stores/ui.svelte';
  import { openSettingsWindow } from '../../lib/utils/settings-window';
  const bothHidden = $derived(
    !ui.explorerVisible && !ui.workspacesVisible && !ui.zenMode
  );

  const notifList = $derived(
    Object.values(attentionStore.notifications).sort((a, b) => {
      if (a.type === b.type) return a.timestamp - b.timestamp;
      return a.type === 'permission' ? -1 : 1;
    })
  );

  const hasWorkspace = $derived(!!workspaceManager.activeWorkspace);

  function terminalTitle(terminalId: number): string {
    for (const ws of Object.values(workspaceManager.workspaces)) {
      for (const pane of Object.values(ws.panes)) {
        if (pane.kind === 'terminal' && pane.terminalId === terminalId) {
          if (ws.id !== workspaceManager.activeWorkspaceId) {
            return `${pane.title} (${ws.name})`;
          }
          return pane.title;
        }
      }
    }
    return `Terminal ${terminalId}`;
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

<div class="title-bar" class:title-bar--compact={bothHidden}>
  <!-- Drag region fills remaining space -->
  <div class="title-center" data-tauri-drag-region></div>

  <!-- Notifications inline, prefixing the buttons -->
  {#each notifList as n (n.terminalId)}
    {@const isPermission = n.type === 'permission'}
    {@const color = isPermission ? 'var(--ansi-red)' : 'var(--ansi-yellow)'}
    <div class="notif-chip">
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

  <!-- Right actions -->
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
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.35);
    display: flex;
    flex-direction: row;
    align-items: stretch;
    overflow: hidden;
    transition: height 150ms ease;
  }

  .title-bar--compact {
    height: 22px;
  }

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
  .title-btn:hover {
    color: var(--text);
    background: var(--bg-hover);
  }

  .title-center {
    flex: 1;
    display: flex;
    flex-direction: column;
    cursor: grab;
    min-width: 0;
  }

  .notif-chip {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0 10px;
    border-left: 1px solid var(--border);
    font-size: var(--ui-label);
    cursor: default;
    flex-shrink: 0;
  }

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

  .notif-sep {
    color: var(--text-dim);
    flex-shrink: 0;
  }

  .notif-terminal {
    color: var(--text-dim);
    flex-shrink: 0;
  }

  .notif-message {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }

  .notif-dismiss {
    flex-shrink: 0;
    margin-left: auto;
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
  }
  .notif-dismiss:hover {
    color: var(--text);
    background: var(--bg-hover);
  }

  @keyframes attn-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
</style>
