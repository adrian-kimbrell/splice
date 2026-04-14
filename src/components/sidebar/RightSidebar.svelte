<script lang="ts">
  import WorkspaceListItem from "./WorkspaceListItem.svelte";
  import { workspaceManager } from "../../lib/stores/workspace.svelte";
  import { ui } from "../../lib/stores/ui.svelte";

  let {
    side = "right",
  }: {
    side?: "left" | "right";
  } = $props();

  const wsList = $derived(Object.values(workspaceManager.workspaces));
  const activeId = $derived(workspaceManager.activeWorkspaceId);
  const sidebarWidth = $derived(ui.workspacesWidth);
  const compact = $derived(sidebarWidth < 80);

  // --- Drag-to-reorder state ---
  let listEl: HTMLDivElement | undefined;
  let dragId = $state<string | null>(null);
  let dragStartY = 0;
  let isDraggingActive = $state(false);
  let dragOverIndex = $state<number | null>(null);

  function getDropIndex(clientY: number): number {
    if (!listEl) return 0;
    const groups = listEl.querySelectorAll<HTMLElement>(".workspace-group");
    for (let i = 0; i < groups.length; i++) {
      const rect = groups[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return groups.length;
  }

  function handleWorkspaceMousedown(e: MouseEvent, wsId: string) {
    if (e.button !== 0) return;
    dragId = wsId;
    dragStartY = e.clientY;
    window.addEventListener("mousemove", handleDragMove);
    window.addEventListener("mouseup", handleDragUp);
  }

  function handleDragMove(e: MouseEvent) {
    if (!dragId) return;
    if (!isDraggingActive && Math.abs(e.clientY - dragStartY) > 4) {
      isDraggingActive = true;
    }
    if (isDraggingActive) {
      dragOverIndex = getDropIndex(e.clientY);
    }
  }

  function handleDragUp(e: MouseEvent) {
    window.removeEventListener("mousemove", handleDragMove);
    window.removeEventListener("mouseup", handleDragUp);
    if (isDraggingActive && dragId !== null && dragOverIndex !== null) {
      const entries = Object.keys(workspaceManager.workspaces);
      const fromIndex = entries.indexOf(dragId);
      // Adjust toIndex: removing fromIndex shifts items after it down by 1
      let toIndex = dragOverIndex;
      if (fromIndex !== -1 && fromIndex < toIndex) toIndex -= 1;
      workspaceManager.reorderWorkspace(dragId, toIndex);
    }
    dragId = null;
    isDraggingActive = false;
    dragOverIndex = null;
  }

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

  function showCtxMenu(e: MouseEvent, items: { icon: string; label: string; action: string }[], targetWsId?: string) {
    e.preventDefault();
    e.stopPropagation();
    removeCtxMenu();
    ctxMenuEl = document.createElement("div");
    ctxMenuEl.className = "split-dropdown ctx-menu-container";
    ctxMenuEl.style.top = e.clientY + "px";
    ctxMenuEl.style.left = e.clientX + "px";
    // Position menu away from the sidebar edge
    ctxMenuEl.style.transform = side === "right" ? "translateX(-100%)" : "translateX(0)";
    ctxMenuEl.innerHTML = items.map(item =>
      `<button class="split-dropdown-item" data-action="${item.action}">
        <i class="bi ${item.icon}"></i>
        <span>${item.label}</span>
      </button>`
    ).join("");
    ctxMenuEl.addEventListener("click", (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLElement>("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      // Switch to target workspace before executing workspace-scoped actions
      if (targetWsId) workspaceManager.switchWorkspace(targetWsId);
      if (action === "new-workspace") handleCreateWorkspace();
      else if (action === "new-file") workspaceManager.newUntitledFile();
      else if (action === "new-terminal") workspaceManager.spawnTerminalInWorkspace();
      else if (action === "open-file") handleOpenFile();
      removeCtxMenu();
    });
    document.body.appendChild(ctxMenuEl);
  }

  function handleContextMenu(e: MouseEvent) {
    showCtxMenu(e, [
      { icon: "bi-folder-plus", label: "New Workspace", action: "new-workspace" },
    ]);
  }

  function handleWorkspaceContextMenu(e: MouseEvent, wsId: string) {
    showCtxMenu(e, [
      { icon: "bi-file-earmark-plus", label: "New File", action: "new-file" },
      { icon: "bi-terminal", label: "New Terminal", action: "new-terminal" },
      { icon: "bi-folder2-open", label: "Open File", action: "open-file" },
    ], wsId);
  }

  async function handleOpenFile() {
    const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    if (!isTauri) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: false, multiple: false });
      if (selected) {
        // Ensure there's an active workspace
        if (!workspaceManager.activeWorkspace) {
          workspaceManager.createEmptyWorkspace();
        }
        const filePath = selected as string;
        const name = filePath.split("/").pop() ?? filePath;
        workspaceManager.openFileInWorkspace({ name, path: filePath, content: "" });
      }
    } catch (e) {
      console.error("Failed to open file:", e);
    }
  }

  function closeCtxMenu(e: MouseEvent) {
    if (ctxMenuEl && !(e.target as HTMLElement).closest(".ctx-menu-container")) {
      removeCtxMenu();
    }
  }

  onDestroy(() => removeCtxMenu());
</script>

<svelte:document onclick={closeCtxMenu} />

<div
  class="bg-sidebar border-border flex flex-col overflow-hidden"
  class:border-l={side === "right"}
  class:border-r={side === "left"}
  style="grid-column: {side === 'right' ? 5 : 1}; grid-row: 1"
  role="complementary"
  aria-label="Workspaces"
  oncontextmenu={handleContextMenu}
>
  <div class="flex-1 overflow-y-auto flex flex-col" bind:this={listEl}>
    {#each wsList as workspace, i (workspace.id)}
      {#if isDraggingActive && dragOverIndex === i}
        <div class="ws-drop-indicator"></div>
      {/if}
      <WorkspaceListItem
        {workspace}
        isActive={workspace.id === activeId}
        {selectedItem}
        {compact}
        onItemClick={handleItemClick}
        onWorkspaceClick={() => workspaceManager.switchWorkspace(workspace.id)}
        onClose={() => handleCloseWorkspace(workspace.id)}
        onHeaderContextMenu={(e) => handleWorkspaceContextMenu(e, workspace.id)}
        onHeaderMousedown={(e) => handleWorkspaceMousedown(e, workspace.id)}
        isDragging={isDraggingActive && workspace.id === dragId}
      />
    {/each}
    {#if isDraggingActive && dragOverIndex === wsList.length}
      <div class="ws-drop-indicator"></div>
    {/if}
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
