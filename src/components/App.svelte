<script lang="ts">
  import { log } from "../lib/utils/log";
  /**
   * App.svelte -- Root component for the Splice editor.
   *
   * Startup sequence (onMount):
   *   1. Init keybindings + eagerly pre-import IPC commands module
   *   2. Await initSettings() so workspace restore can check restore_previous_session
   *   3. Register Claude session listener (before workspace restore to avoid missing events)
   *   4. workspaceManager.initializeWorkspaces() -- restores persisted workspaces/terminals
   *   5. Wire Tauri event listeners: settings-changed, menu-event, attention notifications,
   *      file watcher (file:changed, tree:changed), native drag-drop, window close
   *   6. Start git status polling
   *
   * Sidebar layout: The explorer and workspaces panels are "logical" sidebars. The user
   * can swap which physical side (left/right) the explorer appears on via
   * settings.appearance.explorer_side. All width/visibility/toggle functions go through
   * a physical-to-logical indirection layer (explorerOnLeft derived + setLeftWidth, etc.).
   *
   * Sidebar resize: mousedown on the gutter captures mousemove/mouseup on window,
   * clamping width to [minWidth, 500px] and persisting to settings on mouseup.
   *
   * Menu routing: Tauri native menu items emit "menu-event" strings; the listener in
   * onMount maps each string to the corresponding action (save, find, zoom, zen mode, etc.).
   *
   * Pane wiring: The PaneGrid receives a Svelte snippet (paneSnippet) that renders
   * EditorPane, TerminalPane, or DiffPane based on PaneConfig.kind. All file/tab
   * callbacks (open, close, save, dirty-check) are defined here and passed as props.
   */
  import { onMount, onDestroy } from "svelte";
  import LeftSidebar from "./sidebar/LeftSidebar.svelte";
  import RightSidebar from "./sidebar/RightSidebar.svelte";
  import EditorPane from "./panes/EditorPane.svelte";
  import TerminalPane from "./panes/TerminalPane.svelte";
  import DiffPane from "./panes/DiffPane.svelte";
  import PaneGrid from "./panes/PaneGrid.svelte";
  // SingleViewBar (top tab switcher) is temporarily unused — switching is driven
  // from the workspace sidebar. Re-import + re-add in the single-view branch to revive.
  import CommandPalette from "./overlays/CommandPalette.svelte";
  import SshConnectForm from "./overlays/SshConnectForm.svelte";
  import Toasts from "./overlays/Toasts.svelte";
  import SendToClaudeModal from "./overlays/SendToClaudeModal.svelte";
  import AddPromptModal from "./overlays/AddPromptModal.svelte";
  import TitleBar from "./topbar/TitleBar.svelte";
  import { showContextMenu } from "../lib/utils/context-menu";
  import { openNewWindow } from "../lib/utils/new-window";
  import { isImagePath, toastFileReadError, readFileForWs, openDroppedFiles, drainOpenPaths, pickAndOpenFolder, pickAndOpenFile } from "../lib/utils/open-paths";
  import WelcomeScreen from "./WelcomeScreen.svelte";
  import { confirmUnsaved, requestCloseWorkspace } from "../lib/utils/close-workspace";
  import { wasRecentlyWrittenBySplice } from "../lib/stores/self-writes";
  import { ui } from "../lib/stores/ui.svelte";
  import { initKeybindings, enterZenMode, exitZenMode, bumpFocusedPaneFont, resetFocusedPaneFont } from "../lib/utils/keybindings";
  import type { FileEntry } from "../lib/stores/files.svelte";
  import type { PaneConfig, SplitDirection } from "../lib/stores/layout.svelte";
  import { collectLeafIds } from "../lib/stores/layout.svelte";
  import { type DropZone, setDropCallback } from "../lib/stores/drag.svelte";
  import type { TabDragData } from "../lib/stores/drag.svelte";
  import { workspaceManager } from "../lib/stores/workspace.svelte";
  import { settings, effectiveSettings, initSettings, debouncedSaveSettings, flushSettingsSave, loadProjectSettings } from "../lib/stores/settings.svelte";
  import type { Settings } from "../lib/stores/settings.svelte";
  import { applyTheme } from "../lib/theme/themes";
  import { loadCustomThemes } from "../lib/theme/custom-themes.svelte";
  import { dispatchEditorAction } from "../lib/stores/editor-actions.svelte";
  import { loadRecentFiles, addRecentFile } from "../lib/stores/recent-files.svelte";
  import { loadRecentProjects } from "../lib/stores/recent-projects.svelte";
  import { pushToast } from "../lib/stores/toasts.svelte";
  import { isUnderRoot } from "../lib/utils/path-utils";
  import { cancelPendingResume } from "../lib/stores/workspace-session";
  import { getTabsForPane, getActiveTabForPane, getContentForPane } from "../lib/stores/workspace-view-helpers";

  // Pre-import commands module for fast access after first load
  let _commands: typeof import("../lib/ipc/commands") | null = null;
  async function getCommands() {
    if (!_commands) _commands = await import("../lib/ipc/commands");
    return _commands;
  }


  function handleSplitPane(paneId: string, direction: SplitDirection, side: "before" | "after" = "after") {
    workspaceManager.splitPane(paneId, direction, side);
  }

  function handlePaneAction(action: string) {
    switch (action) {
      case "new-file":
        workspaceManager.newUntitledFile();
        break;
      case "open-file":
        handleOpenFile();
        break;
      case "search-project":
        ui.sidebarMode = "search";
        ui.explorerVisible = true;
        break;
      case "new-terminal":
        workspaceManager.spawnTerminalInWorkspace();
        break;
    }
  }

  // confirmUnsaved lives in lib/utils/close-workspace.ts so the workspaces bar can
  // share it. Imported above.

  async function handleClosePane(paneId: string) {
    if (workspaceManager.hasDirtyFiles(paneId)) {
      const choice = await confirmUnsaved();
      if (choice === "cancel") return;
      if (choice === "save") {
        const ws = workspaceManager.activeWorkspace;
        if (ws) {
          const pane = ws.panes[paneId];
          const dirtyPaths = (pane?.filePaths ?? []).filter((p) =>
            ws.openFileIndex[p]?.dirty,
          );
          for (const p of dirtyPaths) {
            const saved = await workspaceManager.saveFile(p);
            if (!saved) return; // User cancelled Save As → abort close
          }
        }
      }
    }
    workspaceManager.closePaneInWorkspace(paneId);
  }

  async function handleCloseActiveTab() {
    const ws = workspaceManager.activeWorkspace;
    if (!ws?.activePaneId) return;
    const pane = ws.panes[ws.activePaneId];
    if (!pane) return;
    if (pane.kind === "editor" && pane.activeFilePath) {
      await handleTabClose(pane.activeFilePath, ws.activePaneId);
    } else if (pane.kind === "terminal") {
      await handleClosePane(ws.activePaneId);
    }
  }

  async function handleCloseAllTabs() {
    const ws = workspaceManager.activeWorkspace;
    if (!ws?.activePaneId) return;
    const pane = ws.panes[ws.activePaneId];
    if (!pane || pane.kind !== "editor") return;
    const paths = [...(pane.filePaths ?? [])];
    // Save As renames an untitled file in place; keep the file objects so we close
    // whatever path each one ends up with.
    const files = paths.map((p) => ws.openFileIndex[p]);
    // Check for dirty files
    const dirtyPaths = paths.filter((p) =>
      ws.openFileIndex[p]?.dirty,
    );
    if (dirtyPaths.length > 0) {
      const choice = await confirmUnsaved();
      if (choice === "cancel") return;
      if (choice === "save") {
        for (const p of dirtyPaths) {
          const saved = await workspaceManager.saveFile(p);
          if (!saved) return;
        }
      }
    }
    paths.forEach((p, i) => {
      workspaceManager.closeFileInWorkspace(files[i]?.path ?? p, ws.activePaneId!);
    });
  }

  async function handleCloseWorkspace() {
    const ws = workspaceManager.activeWorkspace;
    if (!ws) return;
    await requestCloseWorkspace(ws.id);
  }

  async function handleTabClose(path: string, paneId: string) {
    // Save As renames an untitled file in place: close the path it ends up with.
    const file = workspaceManager.activeWorkspace?.openFileIndex[path];
    if (workspaceManager.isFileDirty(path)) {
      const choice = await confirmUnsaved();
      if (choice === "cancel") return;
      if (choice === "save") {
        const saved = await workspaceManager.saveFile(path);
        if (!saved) return; // User cancelled Save As → abort close
      }
    }
    workspaceManager.closeFileInWorkspace(file?.path ?? path, paneId);
  }

  function handlePaneClick(paneId: string) {
    workspaceManager.setActivePaneId(paneId);
  }

  function handleWindowFocus() {
    // Delay so any mousedown/click from the activating click processes first.
    // If the user clicked a specific pane, activePaneId will already be updated
    // by the time this runs, so we focus the right pane rather than the old one.
    setTimeout(() => {
      // An open overlay or a focused text field outside the panes (command palette,
      // search, rename input, settings) keeps focus: yanking it into the pane would
      // send the next keystroke to the shell — Escape meant for the palette, say.
      if (ui.commandPaletteOpen || ui.settingsDrawerOpen || ui.addPromptModal) return;
      const active = document.activeElement as HTMLElement | null;
      const inTextField =
        !!active &&
        (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
      if (inTextField && !active.closest("[data-pane-id]")) return;
      const paneId = ui.zoomedPaneId ?? workspaceManager.activeWorkspace?.activePaneId;
      if (!paneId) return;
      const paneEl = document.querySelector(`[data-pane-id="${paneId}"]`);
      const target = paneEl?.querySelector<HTMLElement>('canvas[tabindex], .cm-content');
      target?.focus();
    }, 0);
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

  // Active file path in the focused pane — used to reveal the file in the tree
  const activeRevealPath = $derived.by(() => {
    const ws = workspaceManager.activeWorkspace;
    if (!ws?.activePaneId) return null;
    const pane = ws.panes[ws.activePaneId];
    return pane?.kind === "editor" ? (pane.activeFilePath ?? null) : null;
  });

  // --- Physical sidebar layout derived from logical panel state ---
  const explorerOnLeft = $derived(settings.appearance.explorer_side === "left");

  // Map physical sides to logical panels
  const leftVisible = $derived(explorerOnLeft ? ui.explorerVisible : ui.workspacesVisible);
  const rightVisible = $derived(explorerOnLeft ? ui.workspacesVisible : ui.explorerVisible);
  const leftWidth = $derived(explorerOnLeft ? ui.explorerWidth : ui.workspacesWidth);
  const rightWidth = $derived(explorerOnLeft ? ui.workspacesWidth : ui.explorerWidth);
  const leftMinWidth = $derived(explorerOnLeft ? 150 : 62);
  const rightMinWidth = $derived(explorerOnLeft ? 62 : 150);
  const leftLabel = $derived(explorerOnLeft ? "Explorer" : "Workspaces");
  const rightLabel = $derived(explorerOnLeft ? "Workspaces" : "Explorer");

  function setLeftWidth(w: number) {
    if (explorerOnLeft) ui.explorerWidth = w;
    else ui.workspacesWidth = w;
  }
  function setRightWidth(w: number) {
    if (explorerOnLeft) ui.workspacesWidth = w;
    else ui.explorerWidth = w;
  }
  function toggleLeft() {
    if (explorerOnLeft) ui.explorerVisible = !ui.explorerVisible;
    else ui.workspacesVisible = !ui.workspacesVisible;
  }
  function toggleRight() {
    if (explorerOnLeft) ui.workspacesVisible = !ui.workspacesVisible;
    else ui.explorerVisible = !ui.explorerVisible;
  }

  function handleSidebarResizeDown(side: "left" | "right", e: MouseEvent) {
    e.preventDefault();
    ui.sidebarResizing = true;
    const startX = e.clientX;
    const startWidth = side === "left" ? leftWidth : rightWidth;
    const min = side === "left" ? leftMinWidth : rightMinWidth;

    // Coalesce mousemove → one width write per animation frame. The width feeds the
    // top-level grid, so an unthrottled write reflowed the whole editor area on every
    // mouse event; RAF-batching caps it at one reflow per painted frame.
    let pendingX = startX;
    let rafPending = false;
    function applyWidth() {
      rafPending = false;
      const delta = pendingX - startX;
      const newWidth = side === "left" ? startWidth + delta : startWidth - delta;
      const clamped = Math.max(min, Math.min(500, newWidth));
      if (side === "left") setLeftWidth(clamped);
      else setRightWidth(clamped);
    }
    function onMove(e: MouseEvent) {
      pendingX = e.clientX;
      if (!rafPending) { rafPending = true; requestAnimationFrame(applyWidth); }
    }

    function onUp() {
      ui.sidebarResizing = false;
      // Explorer width is per-workspace: store it on the active workspace and persist.
      const activeWs = workspaceManager.activeWorkspace;
      if (activeWs && workspaceManager.activeWorkspaceId) {
        activeWs.explorerWidth = ui.explorerWidth;
        workspaceManager.debouncedPersistWorkspace(workspaceManager.activeWorkspaceId);
      }
      // Keep the global setting as the default seed for first paint / new windows.
      settings.appearance.explorer_width = ui.explorerWidth;
      settings.appearance.workspaces_width = ui.workspacesWidth;
      debouncedSaveSettings();
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

  async function handleFileClick(entry: FileEntry) {
    selectedFilePath = entry.path;
    if (entry.is_dir) return;

    try {
      // Use cached content if file is already open; skip text read for binary image files
      const existing = ws?.openFileIndex[entry.path];
      const content = existing ? existing.content : isImagePath(entry.path) ? "" : await readFileForWs(entry.path);
      workspaceManager.openFileInWorkspace({
        name: entry.name,
        path: entry.path,
        content,
        preview: true,
      });
      addRecentFile(entry.path);
    } catch (e) {
      toastFileReadError(entry.path, e);
    }
  }

  async function handleFileDoubleClick(entry: FileEntry) {
    selectedFilePath = entry.path;
    if (entry.is_dir) return;

    try {
      // Use cached content if file is already open; skip text read for binary image files
      const existing = ws?.openFileIndex[entry.path];
      const content = existing ? existing.content : isImagePath(entry.path) ? "" : await readFileForWs(entry.path);
      workspaceManager.openFileInWorkspace({
        name: entry.name,
        path: entry.path,
        content,
        preview: false,
      });
      addRecentFile(entry.path);
    } catch (e) {
      toastFileReadError(entry.path, e);
    }
  }

  function handleTabDoubleClick(path: string) {
    workspaceManager.promotePreviewTab(path);
  }

  function handleTabContextAction(action: string, path: string, paneId: string) {
    switch (action) {
      case "close":
        handleTabClose(path, paneId);
        break;
      case "close-others":
        workspaceManager.closeOtherFilesInPane(path, paneId);
        break;
      case "close-left":
        workspaceManager.closeFilesToLeftInPane(path, paneId);
        break;
      case "close-right":
        workspaceManager.closeFilesToRightInPane(path, paneId);
        break;
      case "close-clean":
        workspaceManager.closeCleanFilesInPane(paneId);
        break;
      case "close-all":
        workspaceManager.closeAllFilesInPane(paneId);
        break;
      case "toggle-readonly":
        workspaceManager.toggleFileReadOnly(path);
        break;
      case "toggle-pin":
        workspaceManager.toggleFilePinned(path);
        break;
    }
  }

  function handleTabClick(path: string, paneId: string) {
    workspaceManager.setActiveFileInWorkspace(path, paneId);
  }

  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  let showSshForm = $state(false);



  const showWelcome = $derived(
    Object.keys(workspaceManager.workspaces).length === 0,
  );


  const handleOpenFolder = pickAndOpenFolder;

  function handleNewFile() {
    workspaceManager.newUntitledFile();
  }


  const handleOpenFile = pickAndOpenFile;


  // Hide sidebars on welcome screen, but user can toggle them back via drawers
  $effect(() => {
    if (showWelcome) {
      ui.explorerVisible = false;
      ui.workspacesVisible = false;
    }
  });


  // Apply theme and UI scale when appearance settings change
  $effect(() => {
    applyTheme(effectiveSettings.appearance.theme);
  });

  $effect(() => {
    const scale = effectiveSettings.appearance.ui_scale / 100;
    document.documentElement.style.zoom = `${scale}`;
  });


  $effect(() => {
    document.documentElement.style.setProperty("--font-size", `${effectiveSettings.appearance.font_size}px`);
  });

  // Load project-level settings when the active workspace's root path changes.
  // Reads `<rootPath>/.splice/settings.json` and merges it on top of user
  // settings for as long as that workspace is active.
  $effect(() => {
    const activeId = workspaceManager.activeWorkspaceId;
    const rootPath = activeId ? workspaceManager.workspaces[activeId]?.rootPath ?? null : null;
    loadProjectSettings(rootPath || null);
  });

  // Focus the active pane's content (terminal canvas / editor) when the active
  // workspace or its active pane changes, so the user can type immediately after a
  // workspace switch without clicking. Panes persist across switches (display
  // toggle), so mount-time focus can't cover this. Targets the active PANE
  // specifically — the `active` prop passed to panes is workspace-level, so focusing
  // per-terminal would land on the wrong pane.
  $effect(() => {
    const wsId = workspaceManager.activeWorkspaceId;
    if (!wsId) return;
    const paneId = workspaceManager.workspaces[wsId]?.activePaneId;
    if (!paneId) return;
    requestAnimationFrame(() => {
      if (workspaceManager.activeWorkspaceId !== wsId) return;
      // Pick the visible match (pane ids live in every workspace's DOM; only the
      // active workspace is displayed) and don't steal focus already inside it.
      const candidates = document.querySelectorAll<HTMLElement>(`[data-pane-id="${paneId}"]`);
      const paneEl = Array.from(candidates).find((el) => el.offsetParent !== null);
      if (!paneEl || paneEl.contains(document.activeElement)) return;
      paneEl.querySelector<HTMLElement>('canvas[tabindex], .cm-content')?.focus();
    });
  });

  onMount(async () => {
    const stopKeybindings = initKeybindings();
    // Dev tooling: WebDriver test hooks (`window.__spliceTest`) and the dev API event
    // bridge for dev_server.rs. Vite drops this block from production builds; it is
    // live in `tauri:dev` and in `vite build --mode e2e` (npm run build:e2e), where the
    // Rust side is a debug build that runs the dev API server.
    if (import.meta.env.DEV || import.meta.env.MODE === "e2e") {
      import("../lib/dev/test-helpers")
        .then(({ registerTestHelpers }) =>
          registerTestHelpers({ workspaceManager, readFileForWs, ui, settings, openNewWindow }),
        )
        .catch((e) => log.warn("[dev] test helpers failed to load:", e));
      // Standalone module so its listeners survive App.svelte HMR updates.
      import("../lib/dev/index").catch((e) => log.warn("[dev] dev API bridge failed to load:", e));
    }
    // Eagerly pre-import commands module
    import("../lib/ipc/commands").then(m => { _commands = m; });
    // Await settings before initializing workspaces (restore_previous_session check)
    await initSettings();
    // Load any user-installed custom themes so they're available immediately
    loadCustomThemes();
    // Restore sidebar widths from persisted settings, enforcing minimums
    ui.explorerWidth = Math.max(150, settings.appearance.explorer_width ?? 240);
    ui.workspacesWidth = settings.appearance.workspaces_width ?? 220;

    let unlistenSettings: (() => void) | null = null;
    let unlistenAttention: (() => void) | null = null;
    let unlistenMenu: (() => void) | null = null;
    let unlistenDragDrop: (() => void) | null = null;
    let unlistenFileChanged: (() => void) | null = null;
    let unlistenTreeChanged: (() => void) | null = null;
    let unlistenClosing: (() => void) | null = null;
    let unlistenSession: (() => void) | null = null;
    let unlistenOpenPath: (() => void) | null = null;
    let unlistenClaudeStatus: (() => void) | null = null;
    let treeChangeTimer: ReturnType<typeof setTimeout> | null = null;

    // Register the Claude session listener BEFORE restoring workspaces so we
    // never miss a session event from a restored terminal's Claude process.
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenSession = await listen<{ terminal_id: number; session_id: string; claude_pid: number }>("terminal:claude-session", ({ payload }) => {
        const ws = Object.values(workspaceManager.workspaces).find(
          w => w.terminalIds.includes(payload.terminal_id)
        );
        const paneId = `term-${payload.terminal_id}`;
        if (ws?.panes[paneId]) {
          cancelPendingResume(payload.terminal_id);
          ws.panes[paneId].claudeSessionId = payload.session_id;
          ws.panes[paneId].claudePid = payload.claude_pid;
          workspaceManager.debouncedPersistWorkspace(ws.id);
        }
      });
    }

    workspaceManager.initializeWorkspaces();
    loadRecentFiles();
    loadRecentProjects();

    // Main window: reopen any secondary windows registered before a crash
    if (isTauri) {
      const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const currentLabel = getCurrentWebviewWindow().label;
      if (currentLabel === "main") {
        const { getAllWorkspaceLabels } = await getCommands();
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const labels = await getAllWorkspaceLabels();
        for (const l of labels) {
          if (l === currentLabel) continue;
          new WebviewWindow(l, {
            url: "/",
            title: "Splice",
            width: 1280,
            height: 800,
            minWidth: 800,
            minHeight: 600,
            decorations: true,
            titleBarStyle: "overlay",
            hiddenTitle: true,
            resizable: true,
          });
        }
      }
    }

    const stopGitPolling = workspaceManager.startGitPolling();

    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      import("@tauri-apps/api/event").then(({ listen }) => {
        listen<Settings>("settings-changed", (event) => {
          const updated = event.payload;
          if (updated.general) Object.assign(settings.general, updated.general);
          if (updated.editor) Object.assign(settings.editor, updated.editor);
          if (updated.appearance) Object.assign(settings.appearance, updated.appearance);
          if (updated.terminal) Object.assign(settings.terminal, updated.terminal);
        }).then((fn) => { unlistenSettings = fn; });

        listen<string>("menu-event", (event) => {
          switch (event.payload) {
            case "new-file":
              handleNewFile();
              break;
            case "open-file":
              handleOpenFile();
              break;
            case "open-folder":
              handleOpenFolder();
              break;
            case "save":
              workspaceManager.saveActiveFile();
              break;
            case "save-as":
              workspaceManager.saveActiveFileAs();
              break;
            case "save-all":
              workspaceManager.saveAllDirtyFiles();
              break;
            case "close-tab":
              handleCloseActiveTab();
              break;
            case "close-all-tabs":
              handleCloseAllTabs();
              break;
            case "close-workspace":
              handleCloseWorkspace();
              break;
            case "settings":
              ui.settingsDrawerOpen = true;
              break;
            case "find":
              dispatchEditorAction("find");
              break;
            case "find-in-files":
              ui.sidebarMode = "search";
              ui.explorerVisible = true;
              break;
            case "replace":
              dispatchEditorAction("replace");
              break;
            case "goto-line":
              dispatchEditorAction("goto-line");
              break;
            case "format-document":
              dispatchEditorAction("format-document");
              break;
            case "command-palette":
              ui.commandPaletteOpen = !ui.commandPaletteOpen;
              break;
            case "toggle-sidebar":
              ui.explorerVisible = !ui.explorerVisible;
              break;
            case "toggle-word-wrap":
              dispatchEditorAction("toggle-word-wrap");
              break;
            case "zoom-in":
              bumpFocusedPaneFont(1);
              break;
            case "zoom-out":
              bumpFocusedPaneFont(-1);
              break;
            case "zoom-reset":
              resetFocusedPaneFont();
              break;
            case "new-terminal":
              workspaceManager.spawnTerminalInWorkspace();
              break;
            case "new-window":
              openNewWindow();
              break;
            case "zen-mode":
              if (ui.zenMode) exitZenMode(); else enterZenMode();
              break;
          }
        }).then((fn) => { unlistenMenu = fn; });

        listen("open-path", () => { drainOpenPaths(); })
          .then((fn) => { unlistenOpenPath = fn; });
      });

      // Drain anything macOS handed us during cold launch (before listeners were ready).
      drainOpenPaths();

      const { installClaudeHook } = await getCommands();
      const { onAttentionNotify } = await import("../lib/ipc/events");
      const { attentionStore } = await import("../lib/stores/attention.svelte");

      installClaudeHook().catch(log.warn);

      unlistenAttention = await onAttentionNotify((payload) => {
        // Only show notifications for terminals with an active Claude session
        // in THIS Splice instance. This prevents cross-instance leakage when
        // multiple Splice windows share the same ~/.config/Splice/.attention_port.
        const hasActiveSession = Object.values(workspaceManager.workspaces).some(w => {
          if (!w.terminalIds.includes(payload.terminal_id)) return false;
          const paneId = `term-${payload.terminal_id}`;
          return !!w.panes[paneId]?.claudeSessionId;
        });
        if (!hasActiveSession) return;
        attentionStore.notify({
          terminalId: payload.terminal_id,
          type: payload.notification_type === "permission_prompt" ? "permission" : "idle",
          message: payload.message,
          timestamp: Date.now(),
        });
      });

      // --- Live Claude status HUD (context-window % + cost in the terminal header) ---
      const { onClaudeStatus } = await import("../lib/ipc/events");
      const { claudeStore, statusFromPayload } = await import("../lib/stores/claude.svelte");

      // A terminal is "ours" only if it has an active Claude session in THIS
      // instance — mirrors the attention-notify guard to avoid cross-instance leakage.
      const hasActiveClaudeSession = (terminalId: number): boolean =>
        Object.values(workspaceManager.workspaces).some(
          w => w.terminalIds.includes(terminalId) && !!w.panes[`term-${terminalId}`]?.claudeSessionId,
        );

      unlistenClaudeStatus = await onClaudeStatus((p) => {
        if (!hasActiveClaudeSession(p.terminal_id)) return;
        const status = statusFromPayload(p);
        if (status) claudeStore.setStatus(status);
      });

      // Persist all workspaces before the window closes, awaiting completion
      import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
        const appWindow = getCurrentWindow();
        const currentLabel = appWindow.label;
        unlistenClosing = await appWindow.onCloseRequested(async (event) => {
          event.preventDefault();
          // A secondary window owns its workspaces: closing it deletes its workspace
          // file (unregisterWindow below), so everything in it is gone for good.
          // Confirm first when there is anything to lose.
          if (currentLabel !== "main") {
            const count = Object.keys(workspaceManager.workspaces).length;
            if (count > 0) {
              let ok = true;
              try {
                const { ask } = await import("@tauri-apps/plugin-dialog");
                ok = await ask(
                  `Close this window? ${count} workspace${count === 1 ? "" : "s"} in it will be removed, and their terminals ended.`,
                  { title: "Close Window", kind: "warning", okLabel: "Close Window", cancelLabel: "Cancel" },
                );
              } catch {
                ok = window.confirm("Close this window and remove its workspaces?");
              }
              if (!ok) return;
            }
          }
          flushSettingsSave();
          // Cancel + flush any pending debounced persistence so state mutated
          // <500ms before quit is not lost when timers fire after destroy.
          await workspaceManager.flushPersistTimers();
          await Promise.allSettled(
            Object.keys(workspaceManager.workspaces).map(wsId =>
              workspaceManager.persistWorkspace(wsId)
            )
          );
          // Graceful close of secondary window: remove from registry + delete workspace file
          if (currentLabel !== "main") {
            const { unregisterWindow } = await getCommands();
            await unregisterWindow(currentLabel).catch(log.warn);
          }
          try {
            await appWindow.destroy();
          } catch {
            await appWindow.close();
          }
        });
      }).catch(log.warn);

      // Listen for file watcher events
      const { listen } = await import("@tauri-apps/api/event");
      listen<string>("file:changed", async (event) => {
        const changedPath = event.payload;
        for (const ws of Object.values(workspaceManager.workspaces)) {
          if (ws.sshConfig) continue; // remote paths won't fire local watcher events
          const file = ws.openFileIndex[changedPath];
          if (!file) continue;
          if (file.dirty) {
            // Our own save followed by a quick keystroke looks exactly like this;
            // only warn when the write did not come from Splice.
            if (!wasRecentlyWrittenBySplice(changedPath)) {
              pushToast("File changed externally: " + (changedPath.split("/").pop() ?? changedPath), "warning", 5000);
            }
          } else {
            try {
              const { readFile } = await getCommands();
              const content = await readFile(changedPath);
              file.content = content;
              file.originalContent = content;
              file.dirty = false;
            } catch {
              // ignore read errors
            }
          }
        }
      }).then((fn) => { unlistenFileChanged = fn; });

      // Listen for directory tree changes (new/deleted/renamed files)
      listen<string>("tree:changed", (event) => {
        if (treeChangeTimer) clearTimeout(treeChangeTimer);
        treeChangeTimer = setTimeout(async () => {
          treeChangeTimer = null;
          const changedPath = event.payload;
          log.debug("[watch] tree:changed", changedPath);
          const { refreshGitStatus } = await import("../lib/stores/git.svelte");
          for (const [wsId, w] of Object.entries(workspaceManager.workspaces)) {
            if (w.rootPath && isUnderRoot(changedPath, w.rootPath)) {
              workspaceManager.loadFileTree(wsId);
              refreshGitStatus(wsId, w.rootPath);
            }
          }
        }, 50);
      }).then((fn) => { unlistenTreeChanged = fn; });

      // Listen for native file drag-and-drop
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      unlistenDragDrop = await getCurrentWebview().onDragDropEvent(async (event) => {
        if (event.payload.type !== "drop") return;
        const paths = event.payload.paths;
        if (paths.length === 0) return;

        // Tauri reports position in physical pixels; elementFromPoint expects CSS pixels.
        const dpr = window.devicePixelRatio || 1;
        const x = event.payload.position.x / dpr;
        const y = event.payload.position.y / dpr;

        // Walk up from the drop point looking for a folder row (FileTreeItem
        // sets data-path + data-is-dir). If we find one, copy each dropped
        // file into that folder. Otherwise fall back to opening in the editor.
        let el: Element | null = document.elementFromPoint(x, y);
        let targetDir: string | null = null;
        while (el) {
          if (el instanceof HTMLElement && el.dataset.path && el.dataset.isDir === "true") {
            targetDir = el.dataset.path;
            break;
          }
          el = el.parentElement;
        }

        if (targetDir) {
          const { copyPath } = await import("../lib/ipc/commands");
          let ok = 0;
          for (const src of paths) {
            const name = src.split("/").filter(Boolean).pop() ?? "file";
            const dest = `${targetDir}/${name}`;
            try {
              await copyPath(src, dest);
              ok++;
            } catch (e) {
              log.error(`Failed to copy ${src} → ${dest}:`, e);
              pushToast(`Could not copy ${name}: ${e}`, "error");
            }
          }
          if (ok > 0) {
            pushToast(ok === 1 ? `Copied 1 item` : `Copied ${ok} items`, "success");
          }
        } else {
          openDroppedFiles(paths);
        }
      });
    }

    // Listen for close-active-tab from keybindings
    const closeTabHandler = () => handleCloseActiveTab();
    document.addEventListener("splice:close-active-tab", closeTabHandler);

    // Listen for open-file from command palette
    const openFileHandler = () => handleOpenFile();
    document.addEventListener("splice:open-file", openFileHandler);

    setDropCallback((data: TabDragData, targetPaneId: string, zone: DropZone) => {
      if (!zone || !targetPaneId) return;

      const ws = workspaceManager.activeWorkspace;
      if (!ws) return;
      // The drag may have started in a workspace that was switched away mid-drag
      // (⌘⌥⇧→ with the button held); its source pane is not in this workspace.
      if (!ws.panes[data.sourcePaneId]) return;

      const sourceKind = data.kind ?? "editor";
      const targetKind = ws.panes[targetPaneId]?.kind ?? "editor";

      // Center zone between different pane kinds → swap positions
      if (zone === "center" && sourceKind !== targetKind && data.sourcePaneId !== targetPaneId) {
        workspaceManager.swapPanesInLayout(data.sourcePaneId, targetPaneId);
        return;
      }

      // Terminal source drags: layout-level operations (no tab merging)
      if (sourceKind === "terminal") {
        if (data.sourcePaneId === targetPaneId) return;
        if (zone === "center") {
          workspaceManager.swapPanesInLayout(data.sourcePaneId, targetPaneId);
        } else {
          let direction: SplitDirection = "horizontal";
          let side: "before" | "after" = "after";
          if (zone === "left") { direction = "horizontal"; side = "before"; }
          else if (zone === "right") { direction = "horizontal"; side = "after"; }
          else if (zone === "top") { direction = "vertical"; side = "before"; }
          else if (zone === "bottom") { direction = "vertical"; side = "after"; }
          workspaceManager.movePaneInLayout(data.sourcePaneId, targetPaneId, direction, side);
        }
        return;
      }

      // Editor tab drags (original behavior — works for any target kind)
      if (data.sourcePaneId === targetPaneId && zone === "center") return;
      if (data.sourcePaneId === targetPaneId) {
        const cfg = ws.panes[targetPaneId];
        if (cfg?.filePaths && cfg.filePaths.length <= 1) return;
      }

      let direction: SplitDirection = "horizontal";
      let side: "before" | "after" = "after";
      if (zone === "left") { direction = "horizontal"; side = "before"; }
      else if (zone === "right") { direction = "horizontal"; side = "after"; }
      else if (zone === "top") { direction = "vertical"; side = "before"; }
      else if (zone === "bottom") { direction = "vertical"; side = "after"; }
      handleTabDrop(data.filePath, data.sourcePaneId, targetPaneId, direction, side, zone);
    });

    // onMount ignores a cleanup returned from an async callback (it sees a
    // Promise, not a function) — register teardown via onDestroy instead.
    mountCleanup = () => {
      stopKeybindings();
      setDropCallback(null);
      stopGitPolling();
      document.removeEventListener("splice:close-active-tab", closeTabHandler);
      document.removeEventListener("splice:open-file", openFileHandler);
      unlistenSettings?.();
      unlistenAttention?.();
      unlistenMenu?.();
      unlistenDragDrop?.();
      unlistenFileChanged?.();
      if (treeChangeTimer) clearTimeout(treeChangeTimer);
      unlistenTreeChanged?.();
      unlistenClosing?.();
      unlistenSession?.();
      unlistenOpenPath?.();
      unlistenClaudeStatus?.();
    };
  });

  let mountCleanup: (() => void) | null = null;
  onDestroy(() => mountCleanup?.());
</script>

<svelte:window onfocus={handleWindowFocus} />



<div
  id="app-root"
  class="grid"
  data-tauri-drag-region
  style="height: 100vh; background: var(--bg-editor); padding: 6px; grid-template-columns: {leftVisible && !ui.zenMode
    ? `${leftWidth}px 6px`
    : '0px 0px'} minmax(0,1fr) {rightVisible && !ui.zenMode
    ? `6px ${rightWidth}px`
    : '0px 0px'}; grid-template-rows: 1fr 0px;"
>

  <!-- LEFT SIDEBAR -->
  <div style:display={leftVisible ? 'contents' : 'none'}>
    {#if explorerOnLeft}
      <LeftSidebar
        entries={fileTree}
        onFileClick={handleFileClick}
        onFileDoubleClick={handleFileDoubleClick}
        selectedPath={selectedFilePath}
        revealPath={activeRevealPath}
        hasFolder={!!ws?.rootPath || !!ws?.sshConfig}
        hasWorkspace={!!ws}
        rootPath={ws?.rootPath ?? ""}
        sshWorkspaceId={ws?.sshConfig ? ws.id : null}
        side="left"
        onResizeStart={(e) => handleSidebarResizeDown('left', e)}
      />
    {:else}
      <RightSidebar side="left" onResizeStart={(e) => handleSidebarResizeDown('left', e)} />
    {/if}
  </div>

  <!-- CENTER: PANE GRID — render ALL workspaces, hide inactive with display:none -->
  <div class="flex flex-col min-w-0" style="grid-column: 3; grid-row: 1; overflow: hidden;">
    <!-- TitleBar is always mounted (even with no workspace / on the welcome screen)
         so its settings drawer can always slide down into the main area. It handles
         the no-workspace case internally (hasWorkspace gates workspace-only actions). -->
    <TitleBar />

    {#each Object.entries(workspaceManager.workspaces) as [wsId, workspace] (wsId)}
      {@const isActive = wsId === workspaceManager.activeWorkspaceId}
      {@const hasContent = workspace.rootPath || workspace.layout !== null || workspace.sshConfig}
      <div
        class="flex-1 flex flex-col overflow-hidden min-w-0 min-h-0"
        style:display={isActive ? "flex" : "none"}
      >
        <!-- Only the active workspace mounts its panes. Inactive workspaces render
             nothing (their PTYs stay alive in Rust; terminals repaint on remount via
             the onMount resize). Keeps switch cost O(active) instead of O(all open). -->
        {#if isActive}
        {#if hasContent}
          {#snippet paneSnippet(config: PaneConfig)}
            {#if config.kind === "editor"}
              {@const activeOpenFile = config.activeFilePath ? workspace.openFileIndex[config.activeFilePath] ?? null : null}
              <EditorPane
                tabs={getTabsForPane(workspace, config)}
                activeTab={getActiveTabForPane(config)}
                content={getContentForPane(workspace, config)}
                filePath={config.activeFilePath ?? ""}
                paneId={config.id}
                rootPath={workspace.rootPath ?? ""}
                gitBranch={workspace.gitBranch ?? ""}
                readOnly={activeOpenFile?.readOnly ?? false}
                onTabClick={(path) => handleTabClick(path, config.id)}
                onTabClose={(path) => handleTabClose(path, config.id)}
                onTabDoubleClick={handleTabDoubleClick}
                onSplit={workspace.viewMode === "single" ? undefined : (dir, side) => handleSplitPane(config.id, dir, side)}
                onClose={() => handleClosePane(config.id)}
                onAction={handlePaneAction}
                onTabContextAction={(action, path) => handleTabContextAction(action, path, config.id)}
                onContentChange={(content) => {
                  if (config.activeFilePath) {
                    workspaceManager.updateFileContent(config.activeFilePath, content);
                  }
                }}
                onSave={() => workspaceManager.saveActiveFile()}
                onAutoSave={() => {
                  if (config.activeFilePath) {
                    workspaceManager.saveFileQuiet(config.activeFilePath);
                  }
                }}
              />
            {:else if config.kind === "diff"}
              <DiffPane
                filePath={config.diffFilePath ?? ""}
                oldContent={config.diffOldContent ?? ""}
                newContent={config.diffNewContent ?? ""}
                staged={config.diffStaged ?? false}
                rootPath={workspace.rootPath ?? ""}
                preview={config.diffPreview ?? false}
                paneId={config.id}
                onClose={() => handleClosePane(config.id)}
              />
            {:else}
              <TerminalPane
                title={config.title}
                cwd={workspace.rootPath ?? ""}
                gitBranch={workspace.gitBranch ?? ""}
                terminalId={config.terminalId ?? 0}
                paneId={config.id}
                active={isActive}
                onSplit={workspace.viewMode === "single" ? undefined : (dir, side) => handleSplitPane(config.id, dir, side)}
                onClose={() => handleClosePane(config.id)}
                onAction={handlePaneAction}
                onRename={(t) => workspaceManager.renamePane(config.id, t)}
              />
            {/if}
          {/snippet}
          {#if workspace.layout}
          {#if workspace.viewMode === "single"}
          <!-- Switcher order = pane creation order (panes-map insertion order),
               not tree geometry, which zigzags as splits target the shallowest leaf. -->
          {@const leafSet = collectLeafIds(workspace.layout)}
          {@const leafIds = Object.keys(workspace.panes).filter((id) => leafSet.has(id))}
          {@const singleActiveId = (workspace.activePaneId && workspace.panes[workspace.activePaneId]) ? workspace.activePaneId : leafIds[0]}
          <!-- Top tab switcher (SingleViewBar) is hidden for now — pane switching
               is driven from the workspace sidebar. Kept the component for later.
               Wrap in a leaf-styled container so the pane keeps the normal rounded
               border + active glow. Only the active leaf mounts; keyed by paneId so
               switching mounts a fresh instance (CanvasTerminal binds terminalId once). -->
          <div class="flex-1 flex overflow-hidden min-w-0 min-h-0 relative">
            {#if singleActiveId && workspace.panes[singleActiveId]}
              <div class="single-pane flex-1 flex overflow-hidden min-w-0 min-h-0 relative">
                {#key singleActiveId}
                  {@render paneSnippet(workspace.panes[singleActiveId])}
                {/key}
              </div>
            {/if}
          </div>
          {:else}
          <div class="flex-1 flex overflow-hidden min-w-0 min-h-0 relative">
            <div class="flex-1 flex overflow-hidden min-w-0 min-h-0" style:visibility={isActive && ui.zoomedPaneId && workspace.panes[ui.zoomedPaneId] ? 'hidden' : 'visible'}>
              <PaneGrid
                node={workspace.layout}
                panes={workspace.panes}
                {paneSnippet}
                isRoot={true}
                activePaneId={workspace.activePaneId}
                onPaneClick={handlePaneClick}
              />
            </div>
            {#if isActive && ui.zoomedPaneId && workspace.panes[ui.zoomedPaneId]}
              <!-- data-pane-id: focus helpers look the active pane up by id and pick the
                   visible match; without it they land on the hidden grid copy. -->
              <div class="absolute inset-0 flex overflow-hidden" data-pane-id={ui.zoomedPaneId}>
                <!-- Key by paneId so zooming a different terminal mounts a fresh
                     CanvasTerminal instead of reusing one bound to the prior terminalId. -->
                {#key ui.zoomedPaneId}
                  {@render paneSnippet(workspace.panes[ui.zoomedPaneId])}
                {/key}
              </div>
            {/if}
          </div>
          {/if}
          {:else}
          <div
            class="flex-1 flex items-center justify-center"
            role="region"
            aria-label="Empty workspace"
            oncontextmenu={(e) => {
              e.preventDefault();
              showContextMenu([
                { label: "New File",     action: handleNewFile },
                { label: "New Terminal", action: () => workspaceManager.spawnTerminalInWorkspace() },
              ], e.clientX, e.clientY);
            }}
          >
            <div style="width: 96px; height: 96px; opacity: 0.35; background-color: var(--accent); -webkit-mask-image: url('/logo.png'); -webkit-mask-size: contain; -webkit-mask-repeat: no-repeat; -webkit-mask-position: center; mask-image: url('/logo.png'); mask-size: contain; mask-repeat: no-repeat; mask-position: center;" aria-hidden="true"></div>
          </div>
          {/if}
        {:else}
          {#if !showSshForm}
          <div class="flex-1 flex items-center justify-center">
            <div class="text-center">
              <i class="bi bi-file-earmark-plus text-3xl text-txt-dim mb-3 block"></i>
              <p class="text-txt-dim text-sm mb-4">Get started</p>
              <div class="flex flex-col gap-2">
                <button class="welcome-item welcome-item-compact" onclick={handleNewFile}>
                  <i class="bi bi-file-earmark-plus"></i>
                  <span style="flex: none;">New File</span>
                </button>
                {#if isTauri}
                  <button class="welcome-item welcome-item-compact" onclick={handleOpenFolder}>
                    <i class="bi bi-folder2-open"></i>
                    <span style="flex: none;">Open Folder</span>
                  </button>
                {/if}
                <button class="welcome-item welcome-item-compact" onclick={() => workspaceManager.spawnTerminalInWorkspace()}>
                  <i class="bi bi-terminal"></i>
                  <span style="flex: none;">Terminal</span>
                </button>
                {#if isTauri}
                  <button class="welcome-item welcome-item-compact" onclick={() => showSshForm = true}>
                    <i class="bi bi-hdd-network"></i>
                    <span style="flex: none;">Connect to Remote</span>
                  </button>
                {/if}
              </div>
            </div>
          </div>
        {/if}
        {/if}
        {/if}
      </div>
    {:else}
      <WelcomeScreen onNewFile={handleNewFile} onOpenFolder={handleOpenFolder} />
    {/each}
  </div>

  <!-- RIGHT SIDEBAR -->
  <div style:display={rightVisible ? 'contents' : 'none'}>
    {#if !explorerOnLeft}
      <LeftSidebar
        entries={fileTree}
        onFileClick={handleFileClick}
        onFileDoubleClick={handleFileDoubleClick}
        selectedPath={selectedFilePath}
        revealPath={activeRevealPath}
        hasFolder={!!ws?.rootPath || !!ws?.sshConfig}
        hasWorkspace={!!ws}
        rootPath={ws?.rootPath ?? ""}
        sshWorkspaceId={ws?.sshConfig ? ws.id : null}
        side="right"
        onResizeStart={(e) => handleSidebarResizeDown('right', e)}
      />
    {:else}
      <RightSidebar side="right" onResizeStart={(e) => handleSidebarResizeDown('right', e)} />
    {/if}
  </div>

  <!-- OVERLAYS -->
  <CommandPalette />
  <Toasts />
  <SendToClaudeModal />
  <AddPromptModal />
  {#if showSshForm && workspaceManager.activeWorkspace}
    <SshConnectForm workspace={workspaceManager.activeWorkspace} onclose={() => showSshForm = false} />
  {/if}
</div>

<!-- Left edge drawer trigger -->
<div
  class="sidebar-drawer-zone"
  style="transform: translateX({leftVisible ? `${leftWidth + 2}px` : '3px'})"
>
  <button
    class="sidebar-drawer-btn"
    title={leftVisible ? `Hide ${leftLabel}` : `Show ${leftLabel}`}
    onclick={toggleLeft}
  >
    <i class="bi bi-chevron-{leftVisible ? 'left' : 'right'}" style="font-size: var(--ui-sm);"></i>
  </button>
</div>

<!-- Right edge drawer trigger -->
<div
  class="sidebar-drawer-zone right"
  style="transform: translateX(-{rightVisible ? `${rightWidth + 2}px` : '3px'})"
>
  <button
    class="sidebar-drawer-btn"
    title={rightVisible ? `Hide ${rightLabel}` : `Show ${rightLabel}`}
    onclick={toggleRight}
  >
    <i class="bi bi-chevron-{rightVisible ? 'right' : 'left'}" style="font-size: var(--ui-sm);"></i>
  </button>
</div>

<style>
  /* Single-view active pane: mirror .pane-leaf--active from PaneGrid so the lone
     pane keeps the normal rounded border + accent glow. */
  .single-pane {
    contain: layout style paint;
    border-radius: var(--radius-lg);
    border: 1px solid var(--accent-border);
    outline: 2px solid var(--accent-subtle);
    outline-offset: -2px;
    box-shadow: var(--accent-glow);
  }

</style>
