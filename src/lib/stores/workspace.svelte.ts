import type { FileEntry, OpenFile } from "./files.svelte";
import type { LayoutNode, PaneConfig, SplitDirection } from "./layout.svelte";
import { splitNodeInTree, splitNodeInTreeWithSide, removeNodeFromTree, swapLeavesInTree, findSiblingLeaf, treeDepth, MAX_SPLIT_DEPTH } from "./layout.svelte";
import { ui } from "./ui.svelte";
import { isCornerDragActive } from "./corner-drag.svelte";
import { isDragging as isTabDragging } from "./drag.svelte";
import { settings } from "./settings.svelte";
import type { RustWorkspace } from "../ipc/commands";
import { addRecentProject } from "./recent-projects.svelte";
import { attentionStore } from "./attention.svelte";
import type { Workspace, SshConfig } from "./workspace-types";
import {
  generateId,
  findFirstLeaf,
  nextUntitledPath,
  fetchGitBranchImpl,
  loadFileTreeImpl,
} from "./workspace-types";
import {
  validateLayout,
  toggleFilePinned,
  toggleFileReadOnly,
  reorderTabInPane,
  moveTabToNewPane,
  moveTabToExistingPane,
  getFilesToCloseOther,
  getFilesToCloseLeft,
  getFilesToCloseRight,
  getFilesToCloseClean,
} from "./workspace-tab-ops";
import {
  persistWorkspaceImpl,
  restoreWorkspaceImpl,
  cancelPendingResume,
} from "./workspace-session";
import {
  findFirstEditorPaneId,
  ensureEditorPane,
  openFileInWorkspace,
  closeFileInWorkspace,
  setActiveFileInWorkspace,
  updateFileContent,
  saveActiveFile,
  saveActiveFileAs,
  saveFile,
  saveFileQuiet,
  saveAllDirtyFiles,
  hasDirtyFilesByPane,
  isFileDirty,
} from "./workspace-file-ops";

export type { Workspace } from "./workspace-types";

function buildSshExtraArgs(sshConfig: SshConfig): string[] {
  const target = sshConfig.user ? `${sshConfig.user}@${sshConfig.host}` : sshConfig.host;
  const escapedPath = sshConfig.remotePath.replace(/'/g, "'\\''");
  return [
    ...(sshConfig.keyPath ? ["-i", sshConfig.keyPath] : []),
    "-p", String(sshConfig.port),
    "-t",
    "-o", "StrictHostKeyChecking=accept-new",
    target,
    `cd '${escapedPath}' && exec $SHELL -l`,
  ];
}

class WorkspaceManager {
  workspaces = $state<Record<string, Workspace>>({});
  activeWorkspaceId = $state<string | null>(null);
  private nextTermNum = $state(1);
  private persistTimers: Record<string, ReturnType<typeof setTimeout>> = {};

  get activeWorkspace(): Workspace | null {
    if (!this.activeWorkspaceId) return null;
    return this.workspaces[this.activeWorkspaceId] ?? null;
  }

  get workspaceList(): Workspace[] {
    return Object.values(this.workspaces);
  }

  /** Derives activeFilePath from the active pane's state — single source of truth. */
  getActiveFilePath(wsId?: string): string | null {
    const id = wsId ?? this.activeWorkspaceId;
    if (!id) return null;
    const ws = this.workspaces[id];
    if (!ws?.activePaneId) return null;
    const pane = ws.panes[ws.activePaneId];
    if (!pane || pane.kind !== "editor") return null;
    return pane.activeFilePath ?? null;
  }

  // --- Core ---

  reorderWorkspace(id: string, toIndex: number): void {
    const entries = Object.entries(this.workspaces);
    const fromIndex = entries.findIndex(([k]) => k === id);
    if (fromIndex === -1 || fromIndex === toIndex) return;
    const [entry] = entries.splice(fromIndex, 1);
    entries.splice(toIndex, 0, entry);
    this.workspaces = Object.fromEntries(entries) as Record<string, Workspace>;
    const ids = Object.keys(this.workspaces);
    import("../ipc/commands").then(({ reorderWorkspaces }) => {
      reorderWorkspaces(ids).catch(console.warn);
    });
  }

  renameWorkspace(id: string, name: string): void {
    const ws = this.workspaces[id];
    if (!ws) return;
    ws.name = name;
    ws.nameManuallySet = true;
  }

  switchWorkspace(id: string): void {
    if (!(id in this.workspaces)) return;
    // Save current workspace's sidebar state
    const current = this.activeWorkspace;
    if (current) {
      current.explorerVisible = ui.explorerVisible;
    }
    this.activeWorkspaceId = id;
    // Restore target workspace's sidebar state
    ui.explorerVisible = this.workspaces[id].explorerVisible;
    // Persist the active workspace ID
    import("../ipc/commands").then(({ setActiveWorkspaceId }) => {
      setActiveWorkspaceId(id).catch(console.warn);
    });
  }

  closeWorkspace(id: string): void {
    if (this.persistTimers[id]) {
      clearTimeout(this.persistTimers[id]);
      delete this.persistTimers[id];
    }
    delete this.workspaces[id];
    if (this.activeWorkspaceId === id) {
      const remaining = Object.keys(this.workspaces);
      this.activeWorkspaceId = remaining.length > 0 ? remaining[0] : null;
    }
  }

  // --- Workspace creation ---

  createEmptyWorkspace(name?: string): Workspace {
    const id = generateId();
    const ws: Workspace = {
      id,
      name: name ?? "Untitled",
      rootPath: "",
      fileTree: [],
      openFiles: [],
      openFileIndex: {},
      terminalIds: [],
      activeTerminalId: null,
      layout: null,
      panes: {},
      activePaneId: null,
      gitBranch: "",
      explorerVisible: false,
      expandedPaths: new Set(),
    };

    this.workspaces[id] = ws;
    this.activeWorkspaceId = id;
    ui.explorerVisible = ws.explorerVisible;
    return this.workspaces[id];
  }

  /** Create an untitled file in the active workspace (creating a workspace if needed). */
  newUntitledFile(): void {
    if (!this.activeWorkspace) {
      this.createEmptyWorkspace("Untitled");
    }
    const ws = this.activeWorkspace;
    if (!ws) return;

    const path = nextUntitledPath(ws);
    this.openFileInWorkspace({ name: path, path, content: "" });
  }

  async openFolderInWorkspace(rootPath: string, workspaceId?: string): Promise<void> {
    const wsId = workspaceId ?? this.activeWorkspaceId;
    if (!wsId) return;
    const ws = this.workspaces[wsId];
    if (!ws) return;

    if (!ws.nameManuallySet) {
      ws.name = rootPath.split("/").filter(Boolean).pop() || "Untitled";
    }
    ws.rootPath = rootPath;
    addRecentProject(rootPath);

    // Grant Rust access to this directory, start watching it, then load the tree
    import("../ipc/commands").then(async ({ addAllowedRoot, watchPath }) => {
      await addAllowedRoot(rootPath);
      watchPath(rootPath).catch(() => {});
    }).finally(() => {
      this.loadFileTree(wsId);
      this.fetchGitBranch(wsId);
    });

    // Persist so a force-reload keeps the updated root path
    this.debouncedPersistWorkspace(wsId);
  }

  async createWorkspaceFromDirectory(rootPath: string): Promise<Workspace | null> {
    const dirName = rootPath.split("/").filter(Boolean).pop() || "Untitled";
    const id = generateId();

    // Spawn terminal first so we have a real terminalId (no placeholder)
    let terminalId: number;
    let paneId: string;
    try {
      const { spawnTerminal } = await import("../ipc/commands");
      terminalId = await spawnTerminal(settings.terminal.default_shell, rootPath, 80, 24);
      paneId = `term-${terminalId}`;
    } catch (e) {
      console.error("Failed to spawn terminal for workspace:", e);
      return null;
    }

    const ws: Workspace = {
      id,
      name: dirName,
      rootPath,
      fileTree: [],
      openFiles: [],
      openFileIndex: {},
      terminalIds: [terminalId],
      activeTerminalId: terminalId,
      layout: { type: "leaf", paneId },
      panes: {
        [paneId]: { id: paneId, kind: "terminal", title: `Terminal ${this.nextTermNum++}`, terminalId },
      },
      activePaneId: paneId,
      gitBranch: "",
      explorerVisible: true,
      expandedPaths: new Set(),
    };

    this.workspaces[id] = ws;
    this.activeWorkspaceId = id;
    ui.explorerVisible = ws.explorerVisible;
    addRecentProject(rootPath);

    // Grant Rust access to this directory, start watching it, then load file tree and git branch
    import("../ipc/commands").then(async ({ addAllowedRoot, watchPath }) => {
      await addAllowedRoot(rootPath);
      watchPath(rootPath).catch(() => {});
    }).finally(() => {
      this.loadFileTree(id);
      this.fetchGitBranch(id);
    });

    // Persist immediately so a force-reload doesn't lose the workspace
    this.debouncedPersistWorkspace(id);

    return this.workspaces[id];
  }

  async spawnTerminalInWorkspace(workspaceId?: string, overrideCwd?: string): Promise<number | null> {
    let wsId = workspaceId ?? this.activeWorkspaceId;
    if (!wsId) {
      const ws = this.createEmptyWorkspace();
      wsId = ws.id;
    }
    if (!this.workspaces[wsId]) return null;

    try {
      const { spawnTerminal } = await import("../ipc/commands");
      const ws = this.workspaces[wsId]!;

      let terminalId: number;
      if (ws.sshConfig) {
        // Remote workspace: spawn ssh with extra args; local cwd is irrelevant
        terminalId = await spawnTerminal("/usr/bin/ssh", "/", 80, 24, buildSshExtraArgs(ws.sshConfig));
      } else {
        const cwd = overrideCwd || ws.rootPath || "/";
        terminalId = await spawnTerminal(settings.terminal.default_shell, cwd, 80, 24);
      }

      // Re-validate workspace still exists after await
      if (!this.workspaces[wsId]) return null;
      const ws2 = this.workspaces[wsId]!;

      ws2.terminalIds.push(terminalId);
      ws2.activeTerminalId = terminalId;

      const paneId = `term-${terminalId}`;
      ws2.panes[paneId] = {
        id: paneId,
        kind: "terminal",
        title: `Terminal ${this.nextTermNum++}`,
        terminalId,
      };

      // Add to layout tree
      const isEmptyLayout = ws2.layout === null;

      if (!isEmptyLayout && treeDepth(ws2.layout!) >= MAX_SPLIT_DEPTH) {
        console.warn("Split depth limit reached, cannot add more panes");
        // Still register the terminal, just don't split
        ws2.activePaneId = paneId;
        return terminalId;
      }

      if (isEmptyLayout) {
        ws2.layout = { type: "leaf", paneId };
      } else {
        // Find a valid split target: use activePaneId if it still exists, otherwise first leaf
        const targetId = (ws2.activePaneId && ws2.panes[ws2.activePaneId])
          ? ws2.activePaneId
          : findFirstLeaf(ws2.layout);
        if (!targetId) {
          ws2.layout = { type: "leaf", paneId };
        } else {
          const splitResult = splitNodeInTree(ws2.layout!, targetId, paneId, "vertical");
          if (!splitResult.found) console.warn(`splitNodeInTree: target "${targetId}" not found in layout`);
          ws2.layout = splitResult.tree;
        }
      }

      ws2.activePaneId = paneId;
      return terminalId;
    } catch (e) {
      console.error("Failed to spawn terminal:", e);
      return null;
    }
  }

  async closeWorkspaceWithCleanup(id: string): Promise<void> {
    // Cancel any pending persist timer so it can't re-save a workspace we're about to close
    if (this.persistTimers[id]) {
      clearTimeout(this.persistTimers[id]);
      delete this.persistTimers[id];
    }
    const ws = this.workspaces[id];
    if (ws) {
      // Disconnect SSH session if remote
      if (ws.sshConfig) {
        import("../ipc/commands").then(({ sshDisconnect }) => {
          sshDisconnect(id).catch(() => {});
        });
      }

      // Unwatch the workspace directory and all open file watchers (local only)
      if (!ws.sshConfig && (ws.rootPath || ws.openFiles.length > 0)) {
        import("../ipc/commands").then(({ unwatchPath }) => {
          if (ws.rootPath) unwatchPath(ws.rootPath!).catch(() => {});
          for (const file of ws.openFiles) {
            if (!file.path.startsWith("untitled-")) {
              unwatchPath(file.path).catch(() => {});
            }
          }
        });
      }
      // Clear attention notifications for all terminals in this workspace
      for (const tid of ws.terminalIds) {
        attentionStore.clear(tid);
      }
      try {
        const { closeWorkspace: closeWsIpc } = await import("../ipc/commands");
        await closeWsIpc(id);
      } catch (e) {
        console.error("Failed to close workspace on backend:", e);
        // IPC failed — kill terminals individually and remove the workspace record
        // from the backend so it isn't spuriously restored on next launch.
        try {
          const { killTerminal, deleteWorkspace } = await import("../ipc/commands");
          for (const tid of ws.terminalIds) {
            killTerminal(tid).catch(() => {});
          }
          await deleteWorkspace(id).catch(() => {});
        } catch (_) {}
      }
    }
    this.closeWorkspace(id);
  }

  // --- File actions on active workspace ---

  findFirstEditorPaneId(): string | null {
    const ws = this.activeWorkspace;
    if (!ws) return null;
    return findFirstEditorPaneId(ws);
  }

  openFileInWorkspace(file: OpenFile, targetPaneId?: string): void {
    const ws = this.activeWorkspace;
    if (!ws) return;
    openFileInWorkspace(ws, file, targetPaneId);
    if (this.activeWorkspaceId) this.debouncedPersistWorkspace(this.activeWorkspaceId);
  }

  ensureEditorPane(paneId?: string, filePaths?: string[]): string {
    const ws = this.activeWorkspace;
    if (!ws) return "";
    return ensureEditorPane(ws, paneId, filePaths);
  }

  closeFileInWorkspace(path: string, paneId?: string): void {
    const ws = this.activeWorkspace;
    if (!ws) return;
    closeFileInWorkspace(ws, path, paneId);
    if (this.activeWorkspaceId) this.debouncedPersistWorkspace(this.activeWorkspaceId);
  }

  setActiveFileInWorkspace(path: string, paneId?: string): void {
    const ws = this.activeWorkspace;
    if (!ws) return;
    setActiveFileInWorkspace(ws, path, paneId);
  }

  updateFileContent(path: string, content: string): void {
    const ws = this.activeWorkspace;
    if (!ws) return;
    updateFileContent(ws, path, content);
  }

  promotePreviewTab(path: string): void {
    const ws = this.activeWorkspace;
    if (!ws) return;
    const file = ws.openFileIndex[path];
    if (file?.preview) {
      file.preview = false;
    }
  }

  async saveActiveFile(): Promise<void> {
    const ws = this.activeWorkspace;
    if (!ws) return;
    await saveActiveFile(ws);
  }

  /** Always show save dialog, write file, update references. */
  async saveActiveFileAs(): Promise<void> {
    const ws = this.activeWorkspace;
    if (!ws) return;
    await saveActiveFileAs(ws);
  }

  /** Save all dirty files in the active workspace. */
  async saveAllDirtyFiles(): Promise<void> {
    const ws = this.activeWorkspace;
    if (!ws) return;
    await saveAllDirtyFiles(ws);
  }

  /** Save a specific file by path. Returns true if saved, false if cancelled/failed. */
  async saveFile(path: string): Promise<boolean> {
    const ws = this.activeWorkspace;
    if (!ws) return false;
    return saveFile(ws, path);
  }

  /** Silently save a file (no dialog for untitled, no toast). Used for auto-save. */
  async saveFileQuiet(path: string): Promise<void> {
    const ws = this.activeWorkspace;
    if (!ws) return;
    await saveFileQuiet(ws, path);
  }

  /** Check if any file in the given pane is dirty. */
  hasDirtyFiles(paneId: string, workspaceId?: string): boolean {
    const wsId = workspaceId ?? this.activeWorkspaceId;
    if (!wsId) return false;
    const ws = this.workspaces[wsId];
    if (!ws) return false;
    return hasDirtyFilesByPane(ws, paneId);
  }

  /** Check if a specific file is dirty. */
  isFileDirty(path: string): boolean {
    const ws = this.activeWorkspace;
    if (!ws) return false;
    return isFileDirty(ws, path);
  }

  /** Close all tabs in pane except the given path. Skips pinned tabs. */
  closeOtherFilesInPane(path: string, paneId: string): void {
    const ws = this.activeWorkspace;
    if (!ws) return;
    for (const p of getFilesToCloseOther(ws, path, paneId).reverse())
      this.closeFileInWorkspace(p, paneId);
  }

  /** Close all tabs to the left of the given path. Skips pinned tabs. */
  closeFilesToLeftInPane(path: string, paneId: string): void {
    const ws = this.activeWorkspace;
    if (!ws) return;
    for (const p of getFilesToCloseLeft(ws, path, paneId).reverse())
      this.closeFileInWorkspace(p, paneId);
  }

  /** Close all tabs to the right of the given path. Skips pinned tabs. */
  closeFilesToRightInPane(path: string, paneId: string): void {
    const ws = this.activeWorkspace;
    if (!ws) return;
    for (const p of getFilesToCloseRight(ws, path, paneId).reverse())
      this.closeFileInWorkspace(p, paneId);
  }

  /** Close all non-dirty tabs in pane. Skips pinned tabs. */
  closeCleanFilesInPane(paneId: string): void {
    const ws = this.activeWorkspace;
    if (!ws) return;
    for (const p of getFilesToCloseClean(ws, paneId).reverse())
      this.closeFileInWorkspace(p, paneId);
  }

  /** Close all tabs in pane (including pinned/dirty). */
  closeAllFilesInPane(paneId: string): void {
    const ws = this.activeWorkspace;
    if (!ws) return;
    const pane = ws.panes[paneId];
    if (!pane?.filePaths || pane.kind !== "editor") return;
    const paths = [...pane.filePaths];
    for (let i = paths.length - 1; i >= 0; i--) {
      this.closeFileInWorkspace(paths[i], paneId);
    }
  }

  /** Toggle pinned flag. When pinning, move tab after other pinned tabs and promote from preview. */
  toggleFilePinned(path: string): void {
    const ws = this.activeWorkspace;
    if (!ws) return;
    toggleFilePinned(ws, path);
  }

  /** Toggle readOnly flag on an open file. */
  toggleFileReadOnly(path: string): void {
    const ws = this.activeWorkspace;
    if (!ws) return;
    toggleFileReadOnly(ws, path);
  }

  /** Reorder a tab within the same pane. */
  reorderTabInPane(paneId: string, fromIndex: number, toIndex: number): void {
    const ws = this.activeWorkspace;
    if (!ws) return;
    reorderTabInPane(ws, paneId, fromIndex, toIndex);
  }

  // --- Tab drag & drop ---

  moveTabToNewPane(
    filePath: string,
    sourcePaneId: string,
    targetPaneId: string,
    direction: SplitDirection,
    side: "before" | "after",
  ): void {
    const ws = this.activeWorkspace;
    if (!ws) return;
    moveTabToNewPane(ws, filePath, sourcePaneId, targetPaneId, direction, side);
  }

  movePaneInLayout(
    sourcePaneId: string,
    targetPaneId: string,
    direction: SplitDirection,
    side: "before" | "after",
  ): void {
    const ws = this.activeWorkspace;
    if (!ws || !ws.layout) return;
    if (sourcePaneId === targetPaneId) return;

    // Step 1: Remove source pane from layout
    const removeResult = removeNodeFromTree(ws.layout, sourcePaneId);
    if (!removeResult.found || !removeResult.tree) return;

    // Check depth after removal (more accurate than before)
    if (treeDepth(removeResult.tree) >= MAX_SPLIT_DEPTH) return;

    // Step 2: Re-insert source pane adjacent to target
    const insertResult = splitNodeInTreeWithSide(removeResult.tree, targetPaneId, sourcePaneId, direction, side);
    if (!insertResult.found) {
      // Target not found after removal — restore original layout to avoid orphaning
      console.warn(`movePaneInLayout: target "${targetPaneId}" not found after removing source`);
      return;
    }

    ws.layout = insertResult.tree;
    ws.activePaneId = sourcePaneId;
    validateLayout(ws);
  }

  swapPanesInLayout(paneIdA: string, paneIdB: string): void {
    const ws = this.activeWorkspace;
    if (!ws || !ws.layout) return;
    if (paneIdA === paneIdB) return;

    ws.layout = swapLeavesInTree(ws.layout, paneIdA, paneIdB);
    ws.activePaneId = paneIdA;
  }

  moveTabToExistingPane(
    filePath: string,
    sourcePaneId: string,
    targetPaneId: string,
  ): void {
    const ws = this.activeWorkspace;
    if (!ws) return;
    moveTabToExistingPane(ws, filePath, sourcePaneId, targetPaneId);
  }

  // --- Terminal actions on active workspace ---

  addTerminalToWorkspace(terminalId: number): void {
    const ws = this.activeWorkspace;
    if (!ws) return;
    if (!ws.terminalIds.includes(terminalId)) {
      ws.terminalIds.push(terminalId);
    }
    ws.activeTerminalId = terminalId;
  }

  removeTerminalFromWorkspace(terminalId: number): void {
    const ws = this.activeWorkspace;
    if (!ws) return;
    const idx = ws.terminalIds.indexOf(terminalId);
    if (idx !== -1) {
      ws.terminalIds.splice(idx, 1);
      if (ws.activeTerminalId === terminalId) {
        ws.activeTerminalId =
          ws.terminalIds.length > 0 ? ws.terminalIds[0] : null;
      }
    }
  }

  // --- Pane splitting / closing ---

  async splitPane(paneId: string, direction: SplitDirection, side: "before" | "after" = "after", workspaceId?: string): Promise<void> {
    if (isCornerDragActive() || isTabDragging()) return;

    const wsId = workspaceId ?? this.activeWorkspaceId;
    if (!wsId) return;
    let ws = this.workspaces[wsId];
    if (!ws) return;

    const sourcePane = ws.panes[paneId];
    if (!sourcePane) return;

    if (ws.layout && treeDepth(ws.layout) >= MAX_SPLIT_DEPTH) {
      console.warn("Split depth limit reached, cannot split further");
      return;
    }

    try {
      let newPaneId: string;

      if (sourcePane.kind === "terminal") {
        // Spawn a new terminal for the split
        const { spawnTerminal } = await import("../ipc/commands");
        let terminalId: number;
        if (ws.sshConfig) {
          terminalId = await spawnTerminal("/usr/bin/ssh", "/", 80, 24, buildSshExtraArgs(ws.sshConfig));
        } else {
          const cwd = ws.rootPath || "/";
          terminalId = await spawnTerminal(settings.terminal.default_shell, cwd, 80, 24);
        }

        // Re-validate workspace still exists after await
        if (!this.workspaces[wsId]) return;
        ws = this.workspaces[wsId]!;
        if (isCornerDragActive() || isTabDragging()) return;

        ws.terminalIds.push(terminalId);
        ws.activeTerminalId = terminalId;

        newPaneId = `term-${terminalId}`;
        ws.panes[newPaneId] = {
          id: newPaneId,
          kind: "terminal",
          title: `Terminal ${this.nextTermNum++}`,
          terminalId,
        };
      } else {
        newPaneId = `editor-${generateId().slice(0, 8)}`;
        ws.panes[newPaneId] = {
          id: newPaneId,
          kind: "editor",
          title: "Editor",
          filePaths: [],
          activeFilePath: null,
        };
      }

      const splitResult = splitNodeInTreeWithSide(ws.layout!, paneId, newPaneId, direction, side);
      if (!splitResult.found) console.warn(`splitNodeInTreeWithSide: target "${paneId}" not found in layout`);
      ws.layout = splitResult.tree;
      ws.activePaneId = newPaneId;

      // Open an untitled file in new editor panes
      if (ws.panes[newPaneId].kind === "editor") {
        const path = nextUntitledPath(ws);
        this.openFileInWorkspace({ name: path, path, content: "" }, newPaneId);
      }

      this.debouncedPersistWorkspace(wsId);
    } catch (e) {
      console.error("Failed to split pane:", e);
    }
  }

  async closePaneInWorkspace(paneId: string, workspaceId?: string): Promise<void> {
    if (isCornerDragActive()) return;

    const wsId = workspaceId ?? this.activeWorkspaceId;
    if (!wsId) return;
    const ws = this.workspaces[wsId];
    if (!ws) return;

    const config = ws.panes[paneId];
    if (config?.kind === "terminal" && config.terminalId != null) {
      const termId = config.terminalId;
      try {
        const { killTerminal } = await import("../ipc/commands");
        await killTerminal(termId);
      } catch (e) {
        console.error("Failed to kill terminal:", e);
      }
      attentionStore.clear(termId);
      cancelPendingResume(termId);
      // Re-validate workspace and pane still exist after await
      if (!this.workspaces[wsId] || !ws.panes[paneId]) return;

      const idx = ws.terminalIds.indexOf(termId);
      if (idx !== -1) ws.terminalIds.splice(idx, 1);
      if (ws.activeTerminalId === termId) {
        ws.activeTerminalId = ws.terminalIds.length > 0 ? ws.terminalIds[0] : null;
      }
      delete ws.panes[paneId];
    } else if (config?.kind === "editor") {
      // Only remove files from ws.openFiles that aren't referenced by other editor panes.
      // Build the referenced-paths set once (O(N)) then check membership in O(1) per file.
      const closingPaths = config.filePaths ?? [];
      delete ws.panes[paneId];

      const referencedPaths = new Set<string>();
      for (const pane of Object.values(ws.panes)) {
        if (pane.kind === "editor" && pane.filePaths) {
          for (const p of pane.filePaths) referencedPaths.add(p);
        }
      }
      for (const path of closingPaths) {
        if (!referencedPaths.has(path)) {
          const fileIdx = ws.openFiles.findIndex((f) => f.path === path);
          if (fileIdx !== -1) ws.openFiles.splice(fileIdx, 1);
          delete ws.openFileIndex[path];
        }
      }
    } else {
      delete ws.panes[paneId];
    }

    // Compute sibling BEFORE removing from tree
    const siblingLeafId = ws.layout ? findSiblingLeaf(ws.layout, paneId) : null;

    if (ws.layout) {
      const removeResult = removeNodeFromTree(ws.layout, paneId);
      if (!removeResult.found) console.warn(`removeNodeFromTree: target "${paneId}" not found in layout`);
      ws.layout = removeResult.tree;
    }

    // Update activePaneId: if we just closed the active pane, pick the spatial neighbor
    const remainingPaneIds = Object.keys(ws.panes);
    if (remainingPaneIds.length === 0) {
      ws.layout = null;
      ws.activePaneId = null;
    } else if (ws.activePaneId === paneId || !ws.panes[ws.activePaneId!]) {
      // Prefer sibling leaf (spatial neighbor), fall back to first leaf
      if (siblingLeafId && ws.panes[siblingLeafId]) {
        ws.activePaneId = siblingLeafId;
      } else {
        ws.activePaneId = findFirstLeaf(ws.layout);
      }
    }

    validateLayout(ws);
    this.debouncedPersistWorkspace(wsId);
  }

  // --- Focus tracking ---

  setActivePaneId(paneId: string, workspaceId?: string): void {
    const wsId = workspaceId ?? this.activeWorkspaceId;
    if (!wsId) return;
    const ws = this.workspaces[wsId];
    if (!ws) return;
    ws.activePaneId = paneId;
    this.debouncedPersistWorkspace(wsId);
  }

  // --- Layout actions on active workspace ---

  setLayout(layout: LayoutNode): void {
    const ws = this.activeWorkspace;
    if (!ws) return;
    ws.layout = layout;
  }

  setPane(id: string, config: PaneConfig): void {
    const ws = this.activeWorkspace;
    if (!ws) return;
    ws.panes[id] = config;
  }

  removePane(id: string): void {
    const ws = this.activeWorkspace;
    if (!ws) return;
    delete ws.panes[id];
  }

  // --- Persistence ---

  async persistWorkspace(wsId: string): Promise<void> {
    const ws = this.workspaces[wsId];
    if (!ws) return;
    // Snapshot current explorer visibility for the active workspace so toggling
    // the sidebar is persisted even without switching workspaces first.
    if (wsId === this.activeWorkspaceId) {
      ws.explorerVisible = ui.explorerVisible;
    }
    await persistWorkspaceImpl(ws, this.getActiveFilePath(wsId));
  }

  debouncedPersistWorkspace(wsId: string): void {
    if (this.persistTimers[wsId]) clearTimeout(this.persistTimers[wsId]);
    this.persistTimers[wsId] = setTimeout(() => {
      delete this.persistTimers[wsId];
      this.persistWorkspace(wsId);
    }, 500);
  }

  // --- Initialization ---

  async initializeWorkspaces(): Promise<void> {
    try {
      const { getWorkspaces } = await import("../ipc/commands");
      const { active_workspace_id, workspaces } = await getWorkspaces();
      const shouldRestore = settings.general.restore_previous_session;

      let globalResumeIndex = 0;
      for (const rws of workspaces) {
        if (shouldRestore && rws.panes.length > 0) {
          globalResumeIndex += await this.restoreWorkspace(rws, globalResumeIndex);
        } else {
          await this.createWorkspaceFromDirectory(rws.root_path);
        }
      }

      const first = Object.keys(this.workspaces)[0];
      const target =
        active_workspace_id && this.workspaces[active_workspace_id]
          ? active_workspace_id
          : first;
      if (target) this.switchWorkspace(target);
    } catch (e) {
      console.error("Failed to initialize workspaces:", e);
    }
  }

  async restoreWorkspace(rws: RustWorkspace, resumeStartIndex = 0): Promise<number> {
    const result = await restoreWorkspaceImpl(rws, resumeStartIndex, () => this.nextTermNum++);
    this.workspaces[result.ws.id] = result.ws;
    const ws = result.ws;

    if (ws.sshConfig) {
      // Reconnect SSH session on restore, then load the remote file tree and spawn
      // a fresh SSH terminal (panes were not restored for SSH workspaces).
      import("../ipc/commands").then(async ({ sshConnect }) => {
        try {
          await sshConnect(ws.id, ws.sshConfig!);
          this.loadFileTree(ws.id);
          await this.spawnTerminalInWorkspace(ws.id);
        } catch (e) {
          console.error("Failed to reconnect SSH session:", e);
        }
      });
    } else {
      this.loadFileTree(ws.id);
      this.fetchGitBranch(ws.id);
      if (ws.rootPath) {
        import("../ipc/commands").then(({ watchPath }) => watchPath(ws.rootPath!).catch(() => {}));
      }
    }
    return result.resumeCount;
  }

  async fetchGitBranch(workspaceId: string): Promise<void> {
    const ws = this.workspaces[workspaceId];
    if (!ws) return;
    await fetchGitBranchImpl(ws);
  }

  startGitBranchPolling(): () => void {
    const interval = setInterval(() => {
      const wsId = this.activeWorkspaceId;
      if (wsId) this.fetchGitBranch(wsId);
    }, 10000);
    return () => clearInterval(interval);
  }

  async loadFileTree(workspaceId: string): Promise<void> {
    const ws = this.workspaces[workspaceId];
    if (!ws) return;
    await loadFileTreeImpl(ws);
  }
}

export const workspaceManager = new WorkspaceManager();

export function getActiveWorkspace(): Workspace | null {
  return workspaceManager.activeWorkspace;
}
