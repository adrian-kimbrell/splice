<script lang="ts">
  import { onMount } from "svelte";
  import LeftSidebar from "./sidebar/LeftSidebar.svelte";
  import RightSidebar from "./sidebar/RightSidebar.svelte";
  import EditorPane from "./panes/EditorPane.svelte";
  import TerminalPane from "./panes/TerminalPane.svelte";
  import PaneGrid from "./panes/PaneGrid.svelte";
  import StatusBar from "./statusbar/StatusBar.svelte";
  import TopBar from "./topbar/TopBar.svelte";
  import CommandPalette from "./overlays/CommandPalette.svelte";
  import SettingsModal from "./overlays/SettingsModal.svelte";
  import { ui } from "../lib/stores/ui.svelte";
  import { initKeybindings } from "../lib/utils/keybindings";
  import type { FileEntry } from "../lib/stores/files.svelte";
  import type { PaneConfig, SplitDirection } from "../lib/stores/layout.svelte";
  import type { DropZone } from "../lib/stores/drag.svelte";
  import { workspaceManager, type Workspace } from "../lib/stores/workspace.svelte";
  import { getLanguageName } from "../lib/utils/language";

  function handleSplitPane(paneId: string, direction: SplitDirection) {
    workspaceManager.splitPane(paneId, direction);
  }

  async function confirmUnsaved(): Promise<boolean> {
    if (isTauri) {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      return ask("You have unsaved changes. Close anyway?", { title: "Unsaved Changes", kind: "warning" });
    }
    return confirm("You have unsaved changes. Close anyway?");
  }

  async function handleClosePane(paneId: string) {
    if (workspaceManager.hasDirtyFiles(paneId)) {
      if (!(await confirmUnsaved())) return;
    }
    workspaceManager.closePaneInWorkspace(paneId);
  }

  async function handleTabClose(path: string, paneId: string) {
    if (workspaceManager.isFileDirty(path)) {
      if (!(await confirmUnsaved())) return;
    }
    workspaceManager.closeFileInWorkspace(path, paneId);
  }

  function handlePaneClick(paneId: string) {
    workspaceManager.setActivePaneId(paneId);
  }

  function handleTabDrop(
    filePath: string,
    sourcePaneId: string,
    targetPaneId: string,
    direction: SplitDirection,
    side: "before" | "after",
    zone: DropZone,
  ) {
    if (zone === "center") {
      workspaceManager.moveTabToExistingPane(filePath, sourcePaneId, targetPaneId);
    } else {
      workspaceManager.moveTabToNewPane(filePath, sourcePaneId, targetPaneId, direction, side);
    }
  }

  let selectedFilePath = $state<string | null>(null);

  // Sidebar resize drag state
  let draggingSidebar: "left" | "right" | null = $state(null);

  function handleSidebarResizeDown(side: "left" | "right", e: MouseEvent) {
    e.preventDefault();
    draggingSidebar = side;
    const startX = e.clientX;
    const startWidth = side === "left" ? ui.leftSidebarWidth : ui.rightSidebarWidth;

    function onMove(e: MouseEvent) {
      const delta = e.clientX - startX;
      const newWidth = side === "left" ? startWidth + delta : startWidth - delta;
      const min = side === "right" ? 62 : 36;
      const clamped = Math.max(min, Math.min(500, newWidth));
      if (side === "left") ui.leftSidebarWidth = clamped;
      else ui.rightSidebarWidth = clamped;
    }

    function onUp() {
      draggingSidebar = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // Derive everything from the active workspace — access $state fields directly for reactivity
  const ws = $derived.by(() => {
    const id = workspaceManager.activeWorkspaceId;
    if (!id) return null;
    return workspaceManager.workspaces[id] ?? null;
  });

  const fileTree = $derived(ws?.fileTree ?? []);

  const activePane = $derived(ws?.activePaneId ? ws.panes[ws.activePaneId] ?? null : null);
  const activeFileName = $derived(
    activePane?.kind === "editor" && activePane.activeFilePath
      ? activePane.activeFilePath.split("/").pop() ?? null
      : null,
  );
  const statusLanguage = $derived(
    activePane?.kind === "editor" && activePane.activeFilePath
      ? getLanguageName(activePane.activeFilePath)
      : "",
  );

  function getTabsForPane(workspace: Workspace, config: PaneConfig): { name: string; path: string }[] {
    if (config.kind !== "editor") return [];
    const paths = config.filePaths ?? [];
    return paths.map((p) => {
      const openFile = workspace.openFiles.find((f) => f.path === p);
      return { name: openFile?.name ?? p.split("/").pop() ?? "untitled", path: p };
    });
  }

  function getActiveTabForPane(config: PaneConfig): string | null {
    if (config.kind !== "editor") return null;
    return config.activeFilePath ?? null;
  }

  function getContentForPane(workspace: Workspace, config: PaneConfig): string {
    if (config.kind !== "editor") return "";
    const activePath = config.activeFilePath;
    if (!activePath) return "";
    const openFile = workspace.openFiles.find((f) => f.path === activePath);
    return openFile?.content ?? "";
  }

  async function handleFileClick(entry: FileEntry) {
    selectedFilePath = entry.path;
    if (entry.is_dir) return;

    try {
      const { readFile } = await import("../lib/ipc/commands");
      const content = await readFile(entry.path);
      workspaceManager.openFileInWorkspace({
        name: entry.name,
        path: entry.path,
        content,
      });
    } catch (e) {
      console.error("Failed to read file:", e);
    }
  }

  function handleTabClick(path: string, paneId: string) {
    workspaceManager.setActiveFileInWorkspace(path, paneId);
  }

  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  const showWelcome = $derived(
    Object.keys(workspaceManager.workspaces).length === 0,
  );

  async function handleOpenFolder() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
      if (selected) {
        if (!workspaceManager.activeWorkspace) {
          workspaceManager.createEmptyWorkspace();
        }
        await workspaceManager.openFolderInWorkspace(selected as string);
        workspaceManager.newUntitledFile();
        ui.leftSidebarVisible = true;
      }
    } catch (e) {
      console.error("Failed to open folder:", e);
    }
  }

  function handleNewFile() {
    workspaceManager.newUntitledFile();
  }

  // Hide sidebars on welcome screen, but user can toggle them back via drawers
  $effect(() => {
    if (showWelcome) {
      ui.leftSidebarVisible = false;
      ui.rightSidebarVisible = false;
    }
  });

  // Sync sidebar visibility to the active workspace whenever it changes
  $effect(() => {
    const wsId = workspaceManager.activeWorkspaceId;
    const visible = ui.leftSidebarVisible;
    if (wsId) {
      const w = workspaceManager.workspaces[wsId];
      if (w) w.leftSidebarVisible = visible;
    }
  });

  onMount(() => {
    initKeybindings();
    workspaceManager.initializeWorkspaces();
  });
</script>

<div
  class="grid h-screen"
  style="grid-template-columns: {ui.leftSidebarVisible
    ? `${ui.leftSidebarWidth}px 4px`
    : '0px 0px'} minmax(0,1fr) {ui.rightSidebarVisible
    ? `4px ${ui.rightSidebarWidth}px`
    : '0px 0px'}; grid-template-rows: 35px 1fr 28px;"
>
  <!-- TOP BAR -->
  <TopBar workspaceName={ws?.name ?? "malloc"} />

  <!-- LEFT SIDEBAR -->
  <div style:display={ui.leftSidebarVisible ? 'contents' : 'none'}>
    <LeftSidebar
      entries={fileTree}
      onFileClick={handleFileClick}
      selectedPath={selectedFilePath}
      hasFolder={!!ws?.rootPath}
      hasWorkspace={!!ws}
    />
    <!-- Left resize handle -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      style="grid-column: 2; grid-row: 2; cursor: col-resize; background: {draggingSidebar === 'left' ? '#aaaaaa' : 'var(--border)'}; transition: background 100ms;"
      onmousedown={(e) => handleSidebarResizeDown('left', e)}
      onmouseenter={(e) => { if (!draggingSidebar) e.currentTarget.style.background = '#888888'; }}
      onmouseleave={(e) => { if (!draggingSidebar) e.currentTarget.style.background = 'var(--border)'; }}
    ></div>
  </div>

  <!-- CENTER: PANE GRID — render ALL workspaces, hide inactive with display:none -->
  <div class="flex flex-col overflow-hidden min-w-0" style="grid-column: 3; grid-row: 2">
    {#each Object.entries(workspaceManager.workspaces) as [wsId, workspace] (wsId)}
      {@const isActive = wsId === workspaceManager.activeWorkspaceId}
      {@const hasContent = workspace.rootPath || (workspace.layout.type !== "leaf" || workspace.layout.paneId !== "__empty__")}
      <div
        class="flex-1 flex flex-col overflow-hidden min-w-0 min-h-0"
        style:display={isActive ? "flex" : "none"}
      >
        {#if hasContent}
          {#snippet paneSnippet(config: PaneConfig)}
            {#if config.kind === "editor"}
              <EditorPane
                tabs={getTabsForPane(workspace, config)}
                activeTab={getActiveTabForPane(config)}
                content={getContentForPane(workspace, config)}
                filePath={config.activeFilePath ?? ""}
                paneId={config.id}
                onTabClick={(path) => handleTabClick(path, config.id)}
                onTabClose={(path) => handleTabClose(path, config.id)}
                onSplitHorizontal={() => handleSplitPane(config.id, "horizontal")}
                onSplitVertical={() => handleSplitPane(config.id, "vertical")}
                onClose={() => handleClosePane(config.id)}
                onContentChange={(content) => {
                  if (config.activeFilePath) {
                    workspaceManager.updateFileContent(config.activeFilePath, content);
                  }
                }}
              />
            {:else}
              <TerminalPane
                title={config.title}
                cwd={workspace.rootPath ?? ""}
                branch=""
                terminalId={config.terminalId ?? 0}
                active={isActive}
                onSplitHorizontal={() => handleSplitPane(config.id, "horizontal")}
                onSplitVertical={() => handleSplitPane(config.id, "vertical")}
                onClose={() => handleClosePane(config.id)}
              />
            {/if}
          {/snippet}
          <div class="flex-1 flex overflow-hidden min-w-0 min-h-0 relative">
            <div class="flex-1 flex overflow-hidden min-w-0 min-h-0" style:visibility={isActive && ui.zoomedPaneId && workspace.panes[ui.zoomedPaneId] ? 'hidden' : 'visible'}>
              <PaneGrid
                node={workspace.layout}
                panes={workspace.panes}
                {paneSnippet}
                isRoot={true}
                activePaneId={workspace.activePaneId}
                onPaneClick={handlePaneClick}
                onTabDrop={handleTabDrop}
              />
            </div>
            {#if isActive && ui.zoomedPaneId && workspace.panes[ui.zoomedPaneId]}
              <div class="absolute inset-0 flex overflow-hidden">
                {@render paneSnippet(workspace.panes[ui.zoomedPaneId])}
              </div>
            {/if}
          </div>
        {:else}
          <div class="flex-1 flex items-center justify-center">
            <div class="text-center">
              <i class="bi bi-file-earmark-plus text-3xl text-txt-dim mb-3 block"></i>
              <p class="text-txt-dim text-sm mb-4">Get started</p>
              <div class="flex flex-col gap-2">
                <button class="welcome-item" style="justify-content: center; width: auto; padding: 6px 16px; border-radius: 4px; border: 1px solid var(--border);" onclick={handleNewFile}>
                  <i class="bi bi-file-earmark-plus"></i>
                  <span style="flex: none;">New File</span>
                </button>
                {#if isTauri}
                  <button class="welcome-item" style="justify-content: center; width: auto; padding: 6px 16px; border-radius: 4px; border: 1px solid var(--border);" onclick={handleOpenFolder}>
                    <i class="bi bi-folder2-open"></i>
                    <span style="flex: none;">Open Folder</span>
                  </button>
                {/if}
              </div>
            </div>
          </div>
        {/if}
      </div>
    {:else}
      <div class="welcome-screen flex-1 flex items-center justify-center">
        <div class="welcome-container">
          <div class="welcome-header">
            <i class="bi bi-braces text-3xl text-accent"></i>
            <div>
              <div class="text-txt-bright text-xl font-medium">malloc</div>
              <div class="text-txt-dim text-xs">A modern code editor</div>
            </div>
          </div>

          <fieldset class="welcome-section">
            <legend class="welcome-legend">Get Started</legend>
            <button class="welcome-item" onclick={handleNewFile}>
              <i class="bi bi-file-earmark-plus"></i>
              <span>New File</span>
              <kbd>Cmd N</kbd>
            </button>
            {#if isTauri}
              <button class="welcome-item" onclick={handleOpenFolder}>
                <i class="bi bi-folder2-open"></i>
                <span>Open Folder</span>
                <kbd>Cmd O</kbd>
              </button>
            {/if}
            <button class="welcome-item" onclick={() => (ui.commandPaletteOpen = true)}>
              <i class="bi bi-command"></i>
              <span>Command Palette</span>
              <kbd>Cmd K</kbd>
            </button>
          </fieldset>

          <fieldset class="welcome-section">
            <legend class="welcome-legend">Configure</legend>
            <button class="welcome-item" onclick={() => (ui.settingsOpen = true)}>
              <i class="bi bi-gear"></i>
              <span>Open Settings</span>
              <kbd>Cmd ,</kbd>
            </button>
          </fieldset>
        </div>
      </div>
    {/each}
  </div>

  <!-- RIGHT SIDEBAR -->
  <div style:display={ui.rightSidebarVisible ? 'contents' : 'none'}>
    <!-- Right resize handle -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      style="grid-column: 4; grid-row: 2; cursor: col-resize; background: {draggingSidebar === 'right' ? '#aaaaaa' : 'var(--border)'}; transition: background 100ms;"
      onmousedown={(e) => handleSidebarResizeDown('right', e)}
      onmouseenter={(e) => { if (!draggingSidebar) e.currentTarget.style.background = '#888888'; }}
      onmouseleave={(e) => { if (!draggingSidebar) e.currentTarget.style.background = 'var(--border)'; }}
    ></div>
    <RightSidebar />
  </div>

  <!-- STATUS BAR -->
  <StatusBar workspaceName={ws?.name ?? ""} language={statusLanguage} />

  <!-- OVERLAYS -->
  <CommandPalette />
  <SettingsModal />
</div>

<!-- Left edge drawer trigger -->
<div
  class="sidebar-drawer-zone"
  style="left: {ui.leftSidebarVisible ? `${ui.leftSidebarWidth + 2}px` : '3px'}"
>
  <button
    class="sidebar-drawer-btn"
    title={ui.leftSidebarVisible ? "Hide Explorer" : "Show Explorer"}
    onclick={() => (ui.leftSidebarVisible = !ui.leftSidebarVisible)}
  >
    <i class="bi bi-chevron-{ui.leftSidebarVisible ? 'left' : 'right'}" style="font-size: 10px;"></i>
  </button>
</div>

<!-- Right edge drawer trigger -->
<div
  class="sidebar-drawer-zone right"
  style="right: {ui.rightSidebarVisible ? `${ui.rightSidebarWidth + 2}px` : '3px'}"
>
  <button
    class="sidebar-drawer-btn"
    title={ui.rightSidebarVisible ? "Hide Workspaces" : "Show Workspaces"}
    onclick={() => (ui.rightSidebarVisible = !ui.rightSidebarVisible)}
  >
    <i class="bi bi-chevron-{ui.rightSidebarVisible ? 'right' : 'left'}" style="font-size: 10px;"></i>
  </button>
</div>
