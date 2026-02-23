<script lang="ts">
  import { ui } from "../../lib/stores/ui.svelte";
  import { workspaceManager } from "../../lib/stores/workspace.svelte";
  import { settings } from "../../lib/stores/settings.svelte";
  import { openSettingsWindow } from "../../lib/utils/settings-window";
  import { attentionStore } from "../../lib/stores/attention.svelte";

  const explorerOnLeft = $derived(settings.appearance.explorer_side === "left");
  const leftOpen = $derived(explorerOnLeft ? ui.explorerVisible : ui.workspacesVisible);
  const rightOpen = $derived(explorerOnLeft ? ui.workspacesVisible : ui.explorerVisible);
  const leftLabel = $derived(explorerOnLeft ? "Explorer" : "Workspaces");
  const rightLabel = $derived(explorerOnLeft ? "Workspaces" : "Explorer");

  function toggleLeft() {
    if (explorerOnLeft) ui.explorerVisible = !ui.explorerVisible;
    else ui.workspacesVisible = !ui.workspacesVisible;
  }
  function toggleRight() {
    if (explorerOnLeft) ui.workspacesVisible = !ui.workspacesVisible;
    else ui.explorerVisible = !ui.explorerVisible;
  }

  let {
    workspaceName = "Splice",
    language = "",
    branch = "",
  }: {
    workspaceName?: string;
    language?: string;
    branch?: string;
  } = $props();

  async function handleNewTerminal() {
    await workspaceManager.spawnTerminalInWorkspace();
  }

  function terminalTitle(terminalId: number): string {
    for (const ws of Object.values(workspaceManager.workspaces)) {
      for (const pane of Object.values(ws.panes)) {
        if (pane.kind === "terminal" && pane.terminalId === terminalId) {
          if (ws.id !== workspaceManager.activeWorkspaceId) {
            return `${pane.title} (${ws.name})`;
          }
          return pane.title;
        }
      }
    }
    return `Terminal ${terminalId}`;
  }

  // Sorted: permissions first, then by timestamp
  const notifList = $derived(
    Object.values(attentionStore.notifications).sort((a, b) => {
      if (a.type === b.type) return a.timestamp - b.timestamp;
      return a.type === "permission" ? -1 : 1;
    })
  );

  const primaryNotif = $derived(notifList[0] ?? null);

  let dropdownOpen = $state(false);

  function toggleDropdown() {
    if (notifList.length > 1) dropdownOpen = !dropdownOpen;
  }

  // Close dropdown when all notifications cleared
  $effect(() => {
    if (notifList.length === 0) dropdownOpen = false;
  });

  function handleClickOutside(e: MouseEvent) {
    if (dropdownOpen && !(e.target as HTMLElement).closest('.notif-area')) {
      dropdownOpen = false;
    }
  }
</script>

<svelte:document onclick={handleClickOutside} />

<div
  class="col-span-full flex items-center px-2 gap-0 border-t border-border"
  style="grid-row: 2; height: var(--topbar-height); background: var(--bg-topbar);"
>
  <!-- Left: sidebar mode + workspace name -->
  <button
    class="topbar-btn"
    class:active={ui.sidebarMode === "files" && ui.explorerVisible}
    title="Explorer"
    onclick={() => {
      if (ui.sidebarMode === "files" && ui.explorerVisible) {
        ui.explorerVisible = false;
      } else {
        ui.sidebarMode = "files";
        ui.explorerVisible = true;
      }
    }}
  >
    <i class="bi bi-files"></i>
  </button>
  <button
    class="topbar-btn"
    class:active={ui.sidebarMode === "search" && ui.explorerVisible}
    title="Search"
    onclick={() => {
      if (ui.sidebarMode === "search" && ui.explorerVisible) {
        ui.explorerVisible = false;
      } else {
        ui.sidebarMode = "search";
        ui.explorerVisible = true;
      }
    }}
  >
    <i class="bi bi-search"></i>
  </button>
  <span class="text-xs text-txt-dim ml-1 select-none shrink-0">{workspaceName}</span>

  <!-- Notification inline area -->
  {#if primaryNotif}
    {@const isPermission = primaryNotif.type === 'permission'}
    {@const color = isPermission ? 'var(--ansi-red)' : 'var(--ansi-yellow)'}
    <div class="notif-area" class:has-more={notifList.length > 1} onclick={toggleDropdown}>
      <i class="bi bi-claude notif-icon" style="color: {color};"></i>
      <span class="notif-label" style="color: {color};">
        {isPermission ? 'permission' : 'idle'}
      </span>
      <span class="notif-sep">·</span>
      <span class="notif-terminal">{terminalTitle(primaryNotif.terminalId)}</span>
      {#if primaryNotif.message}
        <span class="notif-sep">—</span>
        <span class="notif-message">{primaryNotif.message}</span>
      {/if}
      {#if notifList.length > 1}
        <span class="notif-more">+{notifList.length - 1}</span>
        <i class="bi bi-chevron-{dropdownOpen ? 'down' : 'up'} notif-chevron"></i>
      {:else}
        <button
          class="notif-dismiss"
          title="Dismiss"
          onclick={(e) => { e.stopPropagation(); attentionStore.clear(primaryNotif.terminalId); }}
        >
          <i class="bi bi-x"></i>
        </button>
      {/if}

      <!-- Dropdown -->
      {#if dropdownOpen}
        <div class="notif-dropdown">
          {#each notifList as n (n.terminalId)}
            {@const ip = n.type === 'permission'}
            {@const c = ip ? 'var(--ansi-red)' : 'var(--ansi-yellow)'}
            <div class="notif-dropdown-row">
              <i class="bi bi-claude notif-icon" style="color: {c};"></i>
              <span class="notif-label" style="color: {c};">{ip ? 'permission' : 'idle'}</span>
              <span class="notif-sep">·</span>
              <span class="notif-terminal">{terminalTitle(n.terminalId)}</span>
              {#if n.message}
                <span class="notif-sep">—</span>
                <span class="notif-message">{n.message}</span>
              {/if}
              <button
                class="notif-dismiss"
                title="Dismiss"
                onclick={(e) => { e.stopPropagation(); attentionStore.clear(n.terminalId); }}
              >
                <i class="bi bi-x"></i>
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <span class="flex-1"></span>
  {/if}

  <!-- Right: status + actions -->
  {#if branch}
    <span class="text-[11px] text-txt-dim whitespace-nowrap mr-1 shrink-0 flex items-center gap-1">
      <i class="bi bi-git" style="font-size: 10px;"></i>{branch}
    </span>
  {/if}
  {#if language}
    <span class="text-[11px] text-txt-dim whitespace-nowrap mr-1 shrink-0">{language}</span>
  {/if}
  <button class="topbar-btn" title="New Workspace" onclick={() => workspaceManager.createEmptyWorkspace()}>
    <i class="bi bi-folder-plus"></i>
  </button>
  <button class="topbar-btn" title="New Terminal" onclick={handleNewTerminal}>
    <i class="bi bi-terminal"></i>
  </button>
  <button class="topbar-btn" class:active={leftOpen} title="Toggle {leftLabel}" onclick={toggleLeft}>
    <i class="bi bi-layout-sidebar-inset"></i>
  </button>
  <button class="topbar-btn" class:active={rightOpen} title="Toggle {rightLabel}" onclick={toggleRight}>
    <i class="bi bi-layout-sidebar-inset-reverse"></i>
  </button>
  <button class="topbar-btn" title="Settings" onclick={openSettingsWindow}>
    <i class="bi bi-gear"></i>
  </button>
</div>

<style>
  .notif-area {
    display: flex;
    align-items: center;
    gap: 5px;
    flex: 1;
    min-width: 0;
    padding: 0 8px;
    font-size: 11px;
    overflow: visible;
    position: relative;
  }

  .notif-area.has-more {
    cursor: pointer;
    border-radius: 4px;
    padding: 3px 8px;
  }
  .notif-area.has-more:hover {
    background: var(--bg-hover);
  }

  .notif-icon {
    font-size: 9px;
    flex-shrink: 0;
    animation: claude-pulse 1.2s ease-in-out infinite;
  }

  .notif-label {
    font-size: 10px;
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

  .notif-more {
    color: var(--text-dim);
    font-size: 10px;
    flex-shrink: 0;
    margin-left: 2px;
  }

  .notif-chevron {
    font-size: 8px;
    color: var(--text-dim);
    flex-shrink: 0;
  }

  .notif-dismiss {
    flex-shrink: 0;
    color: var(--text-dim);
    background: none;
    border: none;
    cursor: pointer;
    padding: 0 2px;
    font-size: 13px;
    border-radius: 3px;
    display: flex;
    align-items: center;
    line-height: 1;
  }
  .notif-dismiss:hover {
    color: var(--text);
    background: var(--bg-hover);
  }

  /* Dropdown pops upward from footer */
  .notif-dropdown {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 0;
    min-width: 360px;
    max-width: 600px;
    background: var(--bg-palette);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 -4px 16px rgba(0,0,0,0.4);
    overflow: hidden;
    z-index: 1000;
    animation: dropdown-in 100ms ease-out;
  }

  .notif-dropdown-row {
    display: flex;
    align-items: center;
    gap: 5px;
    height: var(--topbar-height);
    padding: 0 10px;
    font-size: 11px;
    border-bottom: 1px solid var(--border);
  }
  .notif-dropdown-row:last-child {
    border-bottom: none;
  }

  @keyframes claude-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  @keyframes dropdown-in {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: translateY(0); }
  }
</style>
