<script lang="ts">
  import WorkspaceListItem from "./WorkspaceListItem.svelte";
  import { workspaceManager } from "../../lib/stores/workspace.svelte";
  import { ui } from "../../lib/stores/ui.svelte";

  const wsList = $derived(Object.values(workspaceManager.workspaces));
  const activeId = $derived(workspaceManager.activeWorkspaceId);
  const compact = $derived(ui.rightSidebarWidth < 80);

  const selectedItem = $derived.by(() => {
    if (!activeId) return null;
    const ws = workspaceManager.workspaces[activeId];
    if (!ws?.activePaneId) return null;
    const pane = ws.panes[ws.activePaneId];
    if (!pane) return null;
    // For terminals, key by pane id; for editors, key by active file path
    if (pane.kind === "terminal") {
      return `${activeId}:${pane.id}`;
    }
    if (pane.kind === "editor" && pane.activeFilePath) {
      return `${activeId}:file:${pane.activeFilePath}`;
    }
    return null;
  });

  function handleItemClick(wsId: string, itemId: string) {
    workspaceManager.switchWorkspace(wsId);
    if (itemId.startsWith("file:")) {
      // Activate the file in whichever editor pane has it
      const filePath = itemId.slice(5);
      const ws = workspaceManager.workspaces[wsId];
      if (ws) {
        for (const [paneId, pane] of Object.entries(ws.panes)) {
          if (pane.kind === "editor" && pane.filePaths?.includes(filePath)) {
            workspaceManager.setActiveFileInWorkspace(filePath, paneId);
            workspaceManager.setActivePaneId(paneId, wsId);
            return;
          }
        }
      }
    } else {
      // Terminal pane — just focus it
      workspaceManager.setActivePaneId(itemId, wsId);
    }
  }

  function handleCreateWorkspace() {
    workspaceManager.createEmptyWorkspace();
  }

  async function handleCloseWorkspace(id: string) {
    await workspaceManager.closeWorkspaceWithCleanup(id);
  }

  // --- Context menu ---
  import { onDestroy } from "svelte";

  let ctxMenuEl: HTMLDivElement | null = null;

  function removeCtxMenu() {
    if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
  }

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault();
    removeCtxMenu();
    ctxMenuEl = document.createElement("div");
    ctxMenuEl.className = "split-dropdown ctx-menu-container";
    ctxMenuEl.style.top = e.clientY + "px";
    ctxMenuEl.style.left = e.clientX + "px";
    ctxMenuEl.style.transform = "translateX(-100%)";
    ctxMenuEl.innerHTML = `
      <button class="split-dropdown-item" data-action="new-workspace">
        <i class="bi bi-folder-plus"></i>
        <span>New Workspace</span>
      </button>
    `;
    ctxMenuEl.addEventListener("click", (ev) => {
      const btn = (ev.target as HTMLElement).closest("[data-action]");
      if (btn) {
        handleCreateWorkspace();
        removeCtxMenu();
      }
    });
    document.body.appendChild(ctxMenuEl);
  }

  function closeCtxMenu(e: MouseEvent) {
    if (ctxMenuEl && !(e.target as HTMLElement).closest(".ctx-menu-container")) {
      removeCtxMenu();
    }
  }

  onDestroy(() => removeCtxMenu());
</script>

<svelte:document onclick={closeCtxMenu} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="bg-sidebar border-l border-border flex flex-col overflow-hidden" style="grid-column: 5; grid-row: 1" oncontextmenu={handleContextMenu}>
  <div class="flex-1 overflow-y-auto flex flex-col">
    {#each wsList as workspace (workspace.id)}
      <WorkspaceListItem
        {workspace}
        isActive={workspace.id === activeId}
        {selectedItem}
        {compact}
        onItemClick={handleItemClick}
        onWorkspaceClick={() => workspaceManager.switchWorkspace(workspace.id)}
        onClose={() => handleCloseWorkspace(workspace.id)}
      />
    {/each}
    {#if wsList.length === 0}
      <div class="flex flex-col items-center justify-center px-4 h-full text-center">
        <i class="bi bi-window-stack text-2xl text-txt-dim mb-3 block"></i>
        {#if !compact}
          <p class="text-xs text-txt-dim mb-3">No workspaces open.<br />Click + to create one.</p>
        {/if}
      </div>
    {/if}
  </div>
</div>
