<script lang="ts">
  import { slide } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { attentionStore } from '../../lib/stores/attention.svelte';
  import { workspaceManager } from '../../lib/stores/workspace.svelte';

  const notifList = $derived(
    Object.values(attentionStore.notifications).sort((a, b) => {
      if (a.type === b.type) return a.timestamp - b.timestamp;
      return a.type === 'permission' ? -1 : 1;
    })
  );

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
</script>

{#if notifList.length > 0}
  <div
    class="attention-bar"
    transition:slide={{ duration: 180, easing: cubicOut, axis: 'y' }}
  >
    {#each notifList as n (n.terminalId)}
      {@const isPermission = n.type === 'permission'}
      {@const color = isPermission ? 'var(--ansi-red)' : 'var(--ansi-yellow)'}
      <div class="attention-row">
        <i class="bi bi-claude attention-icon" style="color: {color};"></i>
        <span class="attention-type" style="color: {color};">{isPermission ? 'permission' : 'idle'}</span>
        <span class="attention-sep">·</span>
        <span class="attention-terminal">{terminalTitle(n.terminalId)}</span>
        {#if n.message}
          <span class="attention-sep">—</span>
          <span class="attention-message">{n.message}</span>
        {/if}
        <button
          class="attention-dismiss"
          title="Dismiss"
          onclick={() => attentionStore.clear(n.terminalId)}
        >
          <i class="bi bi-x"></i>
        </button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .attention-bar {
    display: flex;
    flex-direction: column;
    margin-top: 6px;
    border-radius: var(--radius-lg);
    border: 1px solid color-mix(in srgb, var(--text-dim) 22%, transparent);
    background: var(--bg-sidebar);
    box-shadow: 0 4px 24px rgba(0,0,0,0.35);
    overflow: hidden;
    flex-shrink: 0;
  }

  .attention-row {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 10px;
    font-size: var(--ui-label);
    border-bottom: 1px solid var(--border);
  }
  .attention-row:last-child {
    border-bottom: none;
  }

  .attention-icon {
    font-size: var(--ui-xs);
    flex-shrink: 0;
    animation: attn-pulse 1.2s ease-in-out infinite;
  }

  .attention-type {
    font-size: var(--ui-sm);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex-shrink: 0;
  }

  .attention-sep {
    color: var(--text-dim);
    flex-shrink: 0;
  }

  .attention-terminal {
    color: var(--text-dim);
    flex-shrink: 0;
  }

  .attention-message {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }

  .attention-dismiss {
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
  .attention-dismiss:hover {
    color: var(--text);
    background: var(--bg-hover);
  }

  @keyframes attn-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
</style>
