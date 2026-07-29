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
  import { settings } from '../../lib/stores/settings.svelte';
  import { docZoom } from '../../lib/utils/zoom';
  import SettingsPane from '../panes/SettingsPane.svelte';

  // Drawer toggles. The explorer can sit on either side; leftDrawerOpen /
  // rightDrawerOpen track the actual left/right panels regardless of which is which.
  const explorerOnLeft = $derived(settings.appearance.explorer_side === 'left');
  const leftDrawerOpen = $derived(explorerOnLeft ? ui.explorerVisible : ui.workspacesVisible);
  const rightDrawerOpen = $derived(explorerOnLeft ? ui.workspacesVisible : ui.explorerVisible);
  function toggleLeftDrawer() {
    if (explorerOnLeft) ui.explorerVisible = !ui.explorerVisible;
    else ui.workspacesVisible = !ui.workspacesVisible;
  }
  function toggleRightDrawer() {
    if (explorerOnLeft) ui.workspacesVisible = !ui.workspacesVisible;
    else ui.explorerVisible = !ui.explorerVisible;
  }


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

  // Settings drawer height (draggable). Persists for the app session.
  let drawerHeight = $state(480);
  let drawerResizing = $state(false);

  function startDrawerResize(e: MouseEvent) {
    e.preventDefault();
    drawerResizing = true;
    const startY = e.clientY;
    const startH = drawerHeight;
    const zoom = docZoom();
    const maxH = Math.round(window.innerHeight / zoom * 0.9);
    function onMove(ev: MouseEvent) {
      // clientY is visual px; divide by zoom so the drag tracks 1:1 at any ui_scale
      const dy = (ev.clientY - startY) / zoom;
      drawerHeight = Math.max(240, Math.min(maxH, startH + dy));
    }
    function onUp() {
      drawerResizing = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

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

<div class="titlebar-shell">
<div class="title-bar" class:title-bar--drawer-open={ui.settingsDrawerOpen}>
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

  <!-- Right actions — always pinned, never pushed out.
       Order: terminal, folder, left drawer, right drawer, settings. -->
  <div class="title-actions">
    {#if hasWorkspace}
      <button class="title-btn" title="New Terminal" onclick={() => workspaceManager.spawnTerminalInWorkspace()}>
        <i class="bi bi-terminal"></i>
      </button>
      <button class="title-btn" title="Open Folder" onclick={handleOpenFolder}>
        <i class="bi bi-folder2-open"></i>
      </button>
      <button
        class="title-btn"
        class:title-btn--active={leftDrawerOpen}
        title="Toggle left panel"
        onclick={toggleLeftDrawer}
      >
        <i class="bi bi-layout-sidebar"></i>
      </button>
      <button
        class="title-btn"
        class:title-btn--active={rightDrawerOpen}
        title="Toggle right panel"
        onclick={toggleRightDrawer}
      >
        <i class="bi bi-layout-sidebar-reverse"></i>
      </button>
    {/if}
    <button
      class="title-btn title-btn--settings"
      class:title-btn--settings-open={ui.settingsDrawerOpen}
      title="Settings"
      onclick={() => ui.settingsDrawerOpen = !ui.settingsDrawerOpen}
    >
      <i class="bi bi-gear"></i>
    </button>
  </div>
</div>

<!-- Settings drawer — unfurls from beneath the title bar, pushing the panes down -->
<div
  class="settings-drawer"
  class:settings-drawer--open={ui.settingsDrawerOpen}
  class:resizing={drawerResizing}
  style="--drawer-h: {drawerHeight}px"
  aria-hidden={!ui.settingsDrawerOpen}
>
  <div class="settings-drawer-inner">
    <SettingsPane />
  </div>
  <div
    class="settings-drawer-resize"
    onmousedown={startDrawerResize}
    role="separator"
    aria-orientation="horizontal"
    aria-label="Resize settings"
  ></div>
</div>
</div>

<style>
  /* The shell owns the 6px gap to the panes and stacks bar + drawer vertically,
     so opening the drawer adds real height and compresses the panes below. */
  .titlebar-shell {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    margin-bottom: 6px;
  }

  .title-bar {
    flex-shrink: 0;
    height: 32px;
    background: var(--bg-sidebar);
    border-radius: var(--radius-lg);
    border: 1px solid color-mix(in srgb, var(--text-dim) 22%, transparent);
    box-shadow: var(--shadow-md);
    display: flex;
    flex-direction: row;
    align-items: stretch;
    overflow: hidden;
    transition: border-radius 200ms var(--ease-default),
                border-color 200ms var(--ease-default);
  }
  /* When the drawer is open the bar squares off its bottom so the two read
     as one continuous surface unfurling downward. */
  .title-bar--drawer-open {
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
    border-bottom-color: transparent;
  }

  /* ── Settings drawer ───────────────────────────────────── */
  /* In-flow: its height is real, so growing it pushes the panes down. Bar and
     drawer share bg + squared adjoining corners so they read as one surface. */
  .settings-drawer {
    position: relative;
    flex-shrink: 0;
    overflow: hidden;
    max-height: 0;
    opacity: 0;
    pointer-events: none;
    margin-top: -1px; /* overlap the bar's bottom border → seamless join */
    background: var(--bg-sidebar);
    border: 1px solid color-mix(in srgb, var(--text-dim) 22%, transparent);
    border-top: none;
    border-bottom-left-radius: var(--radius-lg);
    border-bottom-right-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    transition: max-height 300ms var(--ease-default),
                opacity 200ms ease;
  }
  .settings-drawer.resizing {
    transition: none; /* track the cursor 1:1 while dragging */
  }
  .settings-drawer--open {
    max-height: var(--drawer-h);
    opacity: 1;
    pointer-events: auto;
  }
  .settings-drawer-inner {
    height: calc(var(--drawer-h) - 7px); /* leave room for the resize handle */
  }

  /* Resize handle pinned to the drawer's bottom edge */
  .settings-drawer-resize {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 7px;
    cursor: ns-resize;
    background: transparent;
    transition: background 120ms ease;
  }
  .settings-drawer-resize:hover,
  .settings-drawer.resizing .settings-drawer-resize {
    background: var(--accent-muted);
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

  /* Active (toggled-on) state — shared by the drawer toggle buttons. */
  .title-btn--active {
    color: var(--accent);
    background: var(--accent-subtle);
  }

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

  /* Settings gear — rotates and lights up when the drawer is open */
  .title-btn--settings .bi-gear {
    display: block;
    transition: transform 420ms var(--ease-default), color 200ms ease;
  }
  .title-btn--settings-open {
    color: var(--accent);
    background: var(--accent-subtle);
  }
  .title-btn--settings-open .bi-gear {
    transform: rotate(150deg);
    color: var(--accent);
  }

  @keyframes attn-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
</style>
