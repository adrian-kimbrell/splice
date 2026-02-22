import type { FileEntry, OpenFile } from "./files.svelte";
import type { LayoutNode, PaneConfig, SplitDirection } from "./layout.svelte";
import { splitNodeInTree, splitNodeInTreeWithSide, removeNodeFromTree, swapLeavesInTree, findSiblingLeaf, treeDepth, MAX_SPLIT_DEPTH } from "./layout.svelte";
import { ui } from "./ui.svelte";
import { isCornerDragActive } from "./corner-drag.svelte";
import { isDragging as isTabDragging } from "./drag.svelte";
import { settings } from "./settings.svelte";
import type { RustWorkspace } from "../ipc/commands";
import { addRecentProject } from "./recent-projects.svelte";
import type { Workspace } from "./workspace-types";
import {
  generateId,
  findFirstLeaf,
  nextUntitledPath,
  applyFileRename,
  markFileSaved,
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
  isFileReferencedInAnyPane,
  getFilesToCloseOther,
  getFilesToCloseLeft,
  getFilesToCloseRight,
  getFilesToCloseClean,
} from "./workspace-tab-ops";
import {
  persistWorkspaceImpl,
  restoreWorkspaceImpl,
} from "./workspace-session";

export type { Workspace } from "./workspace-types";

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

    // Load file tree
    this.loadFileTree(wsId);
    // Fetch git branch
    this.fetchGitBranch(wsId);
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
    };

    this.workspaces[id] = ws;
    this.activeWorkspaceId = id;
    ui.explorerVisible = ws.explorerVisible;
    addRecentProject(rootPath);

    // Load file tree and git branch in background
    this.loadFileTree(id);
    this.fetchGitBranch(id);

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
      const cwd = overrideCwd || this.workspaces[wsId]!.rootPath || "/";
      const terminalId = await spawnTerminal(settings.terminal.default_shell, cwd, 80, 24);

      // Re-validate workspace still exists after await
      if (!this.workspaces[wsId]) return null;
      const ws = this.workspaces[wsId]!;

      ws.terminalIds.push(terminalId);
      ws.activeTerminalId = terminalId;

      const paneId = `term-${terminalId}`;
      ws.panes[paneId] = {
        id: paneId,
        kind: "terminal",
        title: `Terminal ${this.nextTermNum++}`,
        terminalId,
      };

      // Add to layout tree
      const isEmptyLayout = ws.layout === null;

      if (!isEmptyLayout && treeDepth(ws.layout) >= MAX_SPLIT_DEPTH) {
        console.warn("Split depth limit reached, cannot add more panes");
        // Still register the terminal, just don't split
        ws.activePaneId = paneId;
        return terminalId;
      }

      if (isEmptyLayout) {
        ws.layout = { type: "leaf", paneId };
      } else {
        // Find a valid split target: use activePaneId if it still exists, otherwise first leaf
        const targetId = (ws.activePaneId && ws.panes[ws.activePaneId])
          ? ws.activePaneId
          : findFirstLeaf(ws.layout);
        if (!targetId) {
          ws.layout = { type: "leaf", paneId };
        } else {
          const splitResult = splitNodeInTree(ws.layout!, targetId, paneId, "vertical");
          if (!splitResult.found) console.warn(`splitNodeInTree: target "${targetId}" not found in layout`);
          ws.layout = splitResult.tree;
        }
      }

      ws.activePaneId = paneId;
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
    for (const [id, config] of Object.entries(ws.panes)) {
      if (config.kind === "editor") return id;
    }
    return null;
  }

  openFileInWorkspace(file: OpenFile, targetPaneId?: string): void {
    const ws = this.activeWorkspace;
    if (!ws) return;

    // Determine target pane early for early-return check
    let paneId = targetPaneId;
    if (!paneId) {
      if (ws.activePaneId && ws.panes[ws.activePaneId]?.kind === "editor") {
        paneId = ws.activePaneId;
      } else {
        paneId = this.findFirstEditorPaneId();
      }
    }

    // Early return: file is already active in the target pane
    const pane = paneId ? ws.panes[paneId] : null;
    if (pane?.activeFilePath === file.path) {
      const existing = ws.openFileIndex[file.path];
      if (existing) {
        // Handle preview→pin promotion if needed
        if (existing.preview && !file.preview) existing.preview = false;
        // Re-register watcher in case it was dropped (e.g. after an unwatch/reconnect)
        if (!file.path.startsWith("untitled-")) {
          import("../ipc/commands").then(({ watchPath }) => watchPath(file.path)).catch(() => {});
        }
        return;
      }
    }

    // Watch file for external changes
    if (!file.path.startsWith("untitled-")) {
      import("../ipc/commands").then(({ watchPath }) => watchPath(file.path)).catch(() => {});
    }

    // Add to workspace-level openFiles (content source of truth)
    const existing = ws.openFileIndex[file.path];
    if (existing) {
      // If already open as pinned, don't downgrade to preview — just activate
      if (!existing.preview && file.preview) {
        file.preview = false;
      } else if (existing.preview && !file.preview) {
        // Promoting from preview to pinned
        existing.preview = false;
      }
    } else {
      ws.openFiles.push(file);
      ws.openFileIndex[file.path] = file;
    }

    if (paneId && ws.panes[paneId]) {
      const pane = ws.panes[paneId];
      if (!pane.filePaths) pane.filePaths = [];

      // If incoming file is preview, replace any existing preview tab in this pane (skip pinned)
      if (file.preview && !pane.filePaths.includes(file.path)) {
        const existingPreviewIdx = pane.filePaths.findIndex((p) => {
          const f = ws.openFileIndex[p];
          return f?.preview && !f?.pinned;
        });
        if (existingPreviewIdx !== -1) {
          const oldPreviewPath = pane.filePaths[existingPreviewIdx];
          pane.filePaths.splice(existingPreviewIdx, 1);
          // Remove from ws.openFiles if unreferenced by any pane
          if (!isFileReferencedInAnyPane(ws, oldPreviewPath)) {
            const fileIdx = ws.openFiles.findIndex((f) => f.path === oldPreviewPath);
            if (fileIdx !== -1) ws.openFiles.splice(fileIdx, 1);
            delete ws.openFileIndex[oldPreviewPath];
            if (!oldPreviewPath.startsWith("untitled-")) {
              import("../ipc/commands").then(({ unwatchPath }) => unwatchPath(oldPreviewPath)).catch(() => {});
            }
          }
        }
      }

      if (!pane.filePaths.includes(file.path)) {
        pane.filePaths.push(file.path);
      }
      pane.activeFilePath = file.path;
      ws.activePaneId = paneId;
    } else {
      // No editor pane exists — create one
      this.ensureEditorPane(undefined, [file.path]);
    }

    if (this.activeWorkspaceId) this.debouncedPersistWorkspace(this.activeWorkspaceId);
  }

  ensureEditorPane(paneId?: string, filePaths?: string[]): string {
    const ws = this.activeWorkspace;
    if (!ws) return "";

    const editorPaneId = paneId ?? `editor-${generateId().slice(0, 8)}`;

    // Already exists?
    if (ws.panes[editorPaneId]) return editorPaneId;

    ws.panes[editorPaneId] = {
      id: editorPaneId,
      kind: "editor",
      title: "Editor",
      filePaths: filePaths ?? [],
      activeFilePath: filePaths?.[0] ?? null,
    };

    // Check if layout is empty (no panes)
    if (!ws.layout) {
      ws.layout = { type: "leaf", paneId: editorPaneId };
    } else {
      ws.layout = {
        type: "split",
        direction: "horizontal",
        ratio: 0.6,
        children: [
          { type: "leaf", paneId: editorPaneId },
          ws.layout,
        ],
      };
    }

    ws.activePaneId = editorPaneId;
    validateLayout(ws);
    return editorPaneId;
  }

  closeFileInWorkspace(path: string, paneId?: string): void {
    const ws = this.activeWorkspace;
    if (!ws) return;

    // Determine which pane to close the file from
    const targetPaneId = paneId ?? ws.activePaneId;
    const pane = targetPaneId ? ws.panes[targetPaneId] : null;

    if (pane?.kind === "editor" && pane.filePaths) {
      const idx = pane.filePaths.indexOf(path);
      if (idx !== -1) {
        pane.filePaths.splice(idx, 1);
        if (pane.activeFilePath === path) {
          pane.activeFilePath =
            pane.filePaths.length > 0
              ? pane.filePaths[Math.max(0, idx - 1)]
              : null;
        }
      }

      // If pane is now empty, close it
      if (pane.filePaths.length === 0) {
        this.closePaneInWorkspace(targetPaneId!);
      }
    }

    // Only remove from ws.openFiles if no other pane references it
    if (!isFileReferencedInAnyPane(ws, path)) {
      const fileIdx = ws.openFiles.findIndex((f) => f.path === path);
      if (fileIdx !== -1) ws.openFiles.splice(fileIdx, 1);
      delete ws.openFileIndex[path];
      // Unwatch file
      if (!path.startsWith("untitled-")) {
        import("../ipc/commands").then(({ unwatchPath }) => unwatchPath(path)).catch(() => {});
      }
    }

    if (this.activeWorkspaceId) this.debouncedPersistWorkspace(this.activeWorkspaceId);
  }

  setActiveFileInWorkspace(path: string, paneId?: string): void {
    const ws = this.activeWorkspace;
    if (!ws) return;

    const targetPaneId = paneId ?? ws.activePaneId;
    const pane = targetPaneId ? ws.panes[targetPaneId] : null;
    if (pane?.kind === "editor") {
      pane.activeFilePath = path;
    }
  }

  updateFileContent(path: string, content: string): void {
    const ws = this.activeWorkspace;
    if (!ws) return;
    const file = ws.openFileIndex[path];
    if (file) {
      if (file.originalContent === undefined) {
        file.originalContent = file.content;
      }
      file.content = content;
      file.dirty = content !== file.originalContent;
      // Editing a preview file promotes it to pinned
      if (file.preview) {
        file.preview = false;
      }
    }
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
    if (!ws?.activePaneId) return;
    const pane = ws.panes[ws.activePaneId];
    if (!pane || pane.kind !== "editor" || !pane.activeFilePath) return;
    const oldPath = pane.activeFilePath;
    const file = ws.openFileIndex[oldPath];
    if (!file) return;

    let savePath = oldPath;

    // Untitled files need a Save As dialog
    if (oldPath.startsWith("untitled-")) {
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const chosen = await save({ title: "Save File" });
        if (!chosen) return; // User cancelled
        savePath = chosen;
      } catch {
        // Not in Tauri (demo mode) — can't save untitled
        return;
      }
    }

    try {
      const { writeFile } = await import("../ipc/commands");
      await writeFile(savePath, file.content);
      // If path changed (Save As from untitled), update index + all pane references
      if (savePath !== oldPath) {
        applyFileRename(ws, file, oldPath, savePath);
      }
      markFileSaved(file);
    } catch (e) {
      console.error("Failed to save file:", e);
    }
  }

  /** Always show save dialog, write file, update references. */
  async saveActiveFileAs(): Promise<void> {
    const ws = this.activeWorkspace;
    if (!ws?.activePaneId) return;
    const pane = ws.panes[ws.activePaneId];
    if (!pane || pane.kind !== "editor" || !pane.activeFilePath) return;
    const oldPath = pane.activeFilePath;
    const file = ws.openFileIndex[oldPath];
    if (!file) return;

    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const chosen = await save({ title: "Save As" });
      if (!chosen) return;

      const { writeFile } = await import("../ipc/commands");
      await writeFile(chosen, file.content);

      if (chosen !== oldPath) {
        applyFileRename(ws, file, oldPath, chosen);
      }
      markFileSaved(file);
    } catch {
      // Not in Tauri or user cancelled
    }
  }

  /** Save all dirty files in the active workspace. */
  async saveAllDirtyFiles(): Promise<void> {
    const ws = this.activeWorkspace;
    if (!ws) return;
    const dirtyFiles = ws.openFiles.filter((f) => f.dirty);
    for (const f of dirtyFiles) {
      await this.saveFile(f.path);
    }
  }

  /** Save a specific file by path. Returns true if saved, false if cancelled/failed. */
  async saveFile(path: string): Promise<boolean> {
    const ws = this.activeWorkspace;
    if (!ws) return false;
    const file = ws.openFileIndex[path];
    if (!file) return false;

    let savePath = path;

    if (path.startsWith("untitled-")) {
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const chosen = await save({ title: "Save File" });
        if (!chosen) return false;
        savePath = chosen;
      } catch {
        return false;
      }
    }

    try {
      const { writeFile } = await import("../ipc/commands");
      await writeFile(savePath, file.content);
      if (savePath !== path) {
        applyFileRename(ws, file, path, savePath);
      }
      markFileSaved(file);
      return true;
    } catch (e) {
      console.error("Failed to save file:", e);
      return false;
    }
  }

  /** Silently save a file (no dialog for untitled, no toast). Used for auto-save. */
  async saveFileQuiet(path: string): Promise<void> {
    const ws = this.activeWorkspace;
    if (!ws) return;
    if (path.startsWith("untitled-")) return; // Skip untitled files
    const file = ws.openFileIndex[path];
    if (!file || !file.dirty) return;
    try {
      const { writeFile } = await import("../ipc/commands");
      await writeFile(path, file.content);
      file.dirty = false;
      file.originalContent = file.content;
    } catch (e) {
      console.error("Auto-save failed:", e);
    }
  }

  /** Check if any file in the given pane is dirty. */
  hasDirtyFiles(paneId: string, workspaceId?: string): boolean {
    const wsId = workspaceId ?? this.activeWorkspaceId;
    if (!wsId) return false;
    const ws = this.workspaces[wsId];
    if (!ws) return false;
    const pane = ws.panes[paneId];
    if (!pane || pane.kind !== "editor") return false;
    const paths = pane.filePaths ?? [];
    return paths.some((p) => ws.openFileIndex[p]?.dirty);
  }

  /** Check if a specific file is dirty. */
  isFileDirty(path: string): boolean {
    const ws = this.activeWorkspace;
    if (!ws) return false;
    return ws.openFileIndex[path]?.dirty ?? false;
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
        const cwd = ws.rootPath || "/";
        const terminalId = await spawnTerminal(settings.terminal.default_shell, cwd, 80, 24);

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
      try {
        const { killTerminal } = await import("../ipc/commands");
        await killTerminal(config.terminalId);
      } catch (e) {
        console.error("Failed to kill terminal:", e);
      }
      // Re-validate workspace and pane still exist after await
      if (!this.workspaces[wsId] || !ws.panes[paneId]) return;

      const idx = ws.terminalIds.indexOf(config.terminalId);
      if (idx !== -1) ws.terminalIds.splice(idx, 1);
      if (ws.activeTerminalId === config.terminalId) {
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
    this.loadFileTree(result.ws.id);
    this.fetchGitBranch(result.ws.id);
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
