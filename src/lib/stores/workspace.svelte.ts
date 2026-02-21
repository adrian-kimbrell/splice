import type { FileEntry, OpenFile } from "./files.svelte";
import type { LayoutNode, PaneConfig, SplitDirection } from "./layout.svelte";
import { splitNodeInTree, splitNodeInTreeWithSide, removeNodeFromTree, findSiblingLeaf, treeDepth, MAX_SPLIT_DEPTH, collectLeafIds } from "./layout.svelte";
import { ui } from "./ui.svelte";
import { isCornerDragActive } from "./corner-drag.svelte";
import { isDragging as isTabDragging } from "./drag.svelte";
import { settings } from "./settings.svelte";

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;

  // File explorer
  fileTree: FileEntry[];
  openFiles: OpenFile[];

  // Terminals (IDs reference global Rust PTY registry)
  terminalIds: number[];
  activeTerminalId: number | null;

  // Pane layout (null = no panes open)
  layout: LayoutNode | null;
  panes: Record<string, PaneConfig>;
  activePaneId: string | null;

  // Git
  gitBranch: string;

  // UI state per workspace
  explorerVisible: boolean;
  nameManuallySet?: boolean;
}

function generateId(): string {
  return crypto.randomUUID();
}

/** Returns the lowest positive integer not already used as a terminal display number. */
function nextTerminalNumber(workspaces: Record<string, Workspace>): number {
  const used = new Set<number>();
  for (const ws of Object.values(workspaces)) {
    for (const pane of Object.values(ws.panes)) {
      if (pane.kind === "terminal") {
        const m = pane.title.match(/^Terminal (\d+)$/);
        if (m) used.add(parseInt(m[1]));
      }
    }
  }
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

function findFirstLeaf(node: LayoutNode | null): string | null {
  if (!node) return null;
  if (node.type === "leaf") return node.paneId;
  return findFirstLeaf(node.children[0]);
}

class WorkspaceManager {
  workspaces = $state<Record<string, Workspace>>({});
  activeWorkspaceId = $state<string | null>(null);

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
  }

  closeWorkspace(id: string): void {
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

    // Find next untitled number
    const existing = ws.openFiles.filter(f => f.path.startsWith("untitled-"));
    const num = existing.length + 1;
    const path = `untitled-${num}`;

    this.openFileInWorkspace({ name: path, path, content: "" });
  }

  async openFolderInWorkspace(rootPath: string, workspaceId?: string): Promise<void> {
    const wsId = workspaceId ?? this.activeWorkspaceId;
    if (!wsId) return;
    const ws = this.workspaces[wsId];
    if (!ws) return;

    if (!ws.nameManuallySet) {
      ws.name = rootPath.split("/").pop() ?? "Untitled";
    }
    ws.rootPath = rootPath;

    // Load file tree
    this.loadFileTree(wsId);
    // Fetch git branch
    this.fetchGitBranch(wsId);
  }

  async createWorkspaceFromDirectory(rootPath: string): Promise<Workspace | null> {
    const dirName = rootPath.split("/").pop() ?? "Untitled";
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
      terminalIds: [terminalId],
      activeTerminalId: terminalId,
      layout: { type: "leaf", paneId },
      panes: {
        [paneId]: { id: paneId, kind: "terminal", title: `Terminal ${nextTerminalNumber(this.workspaces)}`, terminalId },
      },
      activePaneId: paneId,
      gitBranch: "",
      explorerVisible: true,
    };

    this.workspaces[id] = ws;
    this.activeWorkspaceId = id;
    ui.explorerVisible = ws.explorerVisible;

    // Load file tree and git branch in background
    this.loadFileTree(id);
    this.fetchGitBranch(id);

    return this.workspaces[id];
  }

  async spawnTerminalInWorkspace(workspaceId?: string): Promise<number | null> {
    let wsId = workspaceId ?? this.activeWorkspaceId;
    if (!wsId) {
      const ws = this.createEmptyWorkspace();
      wsId = ws.id;
    }
    const ws = this.workspaces[wsId];
    if (!ws) return null;

    try {
      const { spawnTerminal } = await import("../ipc/commands");
      const cwd = ws.rootPath || (typeof process !== "undefined" ? process.env.HOME : "") || "/";
      const terminalId = await spawnTerminal(settings.terminal.default_shell, cwd, 80, 24);

      // Re-validate workspace still exists after await
      if (!this.workspaces[wsId]) return null;

      ws.terminalIds.push(terminalId);
      ws.activeTerminalId = terminalId;

      const paneId = `term-${terminalId}`;
      ws.panes[paneId] = {
        id: paneId,
        kind: "terminal",
        title: `Terminal ${nextTerminalNumber(this.workspaces)}`,
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
    const ws = this.workspaces[id];
    if (ws) {
      try {
        const { closeWorkspace: closeWsIpc } = await import("../ipc/commands");
        await closeWsIpc(id);
      } catch (e) {
        console.error("Failed to close workspace on backend:", e);
        try {
          const { killTerminal } = await import("../ipc/commands");
          for (const tid of ws.terminalIds) {
            killTerminal(tid).catch(() => {});
          }
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

    // Add to workspace-level openFiles (content source of truth)
    const existing = ws.openFiles.find((f) => f.path === file.path);
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
    }

    // Determine target pane
    let paneId = targetPaneId;
    if (!paneId) {
      // If active pane is an editor, use it
      if (ws.activePaneId && ws.panes[ws.activePaneId]?.kind === "editor") {
        paneId = ws.activePaneId;
      } else {
        paneId = this.findFirstEditorPaneId();
      }
    }

    if (paneId && ws.panes[paneId]) {
      const pane = ws.panes[paneId];
      if (!pane.filePaths) pane.filePaths = [];

      // If incoming file is preview, replace any existing preview tab in this pane
      if (file.preview && !pane.filePaths.includes(file.path)) {
        const existingPreviewIdx = pane.filePaths.findIndex((p) => {
          const f = ws.openFiles.find((of) => of.path === p);
          return f?.preview;
        });
        if (existingPreviewIdx !== -1) {
          const oldPreviewPath = pane.filePaths[existingPreviewIdx];
          pane.filePaths.splice(existingPreviewIdx, 1);
          // Remove from ws.openFiles if unreferenced by any pane
          const stillReferenced = Object.values(ws.panes).some(
            (p) => p.kind === "editor" && p.filePaths?.includes(oldPreviewPath),
          );
          if (!stillReferenced) {
            const fileIdx = ws.openFiles.findIndex((f) => f.path === oldPreviewPath);
            if (fileIdx !== -1) ws.openFiles.splice(fileIdx, 1);
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
    this.validateLayout(ws);
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
    const stillReferenced = Object.values(ws.panes).some(
      (p) => p.kind === "editor" && p.filePaths?.includes(path),
    );
    if (!stillReferenced) {
      const fileIdx = ws.openFiles.findIndex((f) => f.path === path);
      if (fileIdx !== -1) ws.openFiles.splice(fileIdx, 1);
    }
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
    const file = ws.openFiles.find((f) => f.path === path);
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
    const file = ws.openFiles.find((f) => f.path === path);
    if (file) {
      file.preview = false;
    }
  }

  async saveActiveFile(): Promise<void> {
    const ws = this.activeWorkspace;
    if (!ws?.activePaneId) return;
    const pane = ws.panes[ws.activePaneId];
    if (!pane || pane.kind !== "editor" || !pane.activeFilePath) return;
    const oldPath = pane.activeFilePath;
    const file = ws.openFiles.find((f) => f.path === oldPath);
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
      // If path changed (Save As from untitled), update references
      if (savePath !== oldPath) {
        const newName = savePath.split("/").pop() ?? savePath;
        // Update openFiles entry
        file.path = savePath;
        file.name = newName;
        // Update pane filePaths reference
        const idx = pane.filePaths?.indexOf(oldPath);
        if (idx !== undefined && idx !== -1 && pane.filePaths) {
          pane.filePaths[idx] = savePath;
        }
        if (pane.activeFilePath === oldPath) {
          pane.activeFilePath = savePath;
        }
      }
      file.dirty = false;
      file.originalContent = file.content;
      if (file.preview) {
        file.preview = false;
      }
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
    const file = ws.openFiles.find((f) => f.path === oldPath);
    if (!file) return;

    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const chosen = await save({ title: "Save As" });
      if (!chosen) return;

      const { writeFile } = await import("../ipc/commands");
      await writeFile(chosen, file.content);

      if (chosen !== oldPath) {
        const newName = chosen.split("/").pop() ?? chosen;
        file.path = chosen;
        file.name = newName;
        for (const p of Object.values(ws.panes)) {
          if (p.kind !== "editor" || !p.filePaths) continue;
          const idx = p.filePaths.indexOf(oldPath);
          if (idx !== -1) p.filePaths[idx] = chosen;
          if (p.activeFilePath === oldPath) p.activeFilePath = chosen;
        }
      }
      file.dirty = false;
      file.originalContent = file.content;
      if (file.preview) file.preview = false;
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
    const file = ws.openFiles.find((f) => f.path === path);
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
        const newName = savePath.split("/").pop() ?? savePath;
        file.path = savePath;
        file.name = newName;
        // Update all pane references
        for (const pane of Object.values(ws.panes)) {
          if (pane.kind !== "editor" || !pane.filePaths) continue;
          const idx = pane.filePaths.indexOf(path);
          if (idx !== -1) pane.filePaths[idx] = savePath;
          if (pane.activeFilePath === path) pane.activeFilePath = savePath;
        }
      }
      file.dirty = false;
      file.originalContent = file.content;
      if (file.preview) file.preview = false;
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
    const file = ws.openFiles.find((f) => f.path === path);
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
    return paths.some((p) => ws.openFiles.find((f) => f.path === p)?.dirty);
  }

  /** Check if a specific file is dirty. */
  isFileDirty(path: string): boolean {
    const ws = this.activeWorkspace;
    if (!ws) return false;
    return ws.openFiles.find((f) => f.path === path)?.dirty ?? false;
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

    if (ws.layout && treeDepth(ws.layout) >= MAX_SPLIT_DEPTH) {
      console.warn("Split depth limit reached, cannot create new pane from tab drop");
      return;
    }

    // Remove file from source pane
    const sourcePaneConfig = ws.panes[sourcePaneId];
    if (sourcePaneConfig?.filePaths) {
      const idx = sourcePaneConfig.filePaths.indexOf(filePath);
      if (idx !== -1) sourcePaneConfig.filePaths.splice(idx, 1);
      if (sourcePaneConfig.activeFilePath === filePath) {
        sourcePaneConfig.activeFilePath =
          sourcePaneConfig.filePaths.length > 0 ? sourcePaneConfig.filePaths[0] : null;
      }
    }

    // Create new editor pane
    const newPaneId = `editor-${generateId().slice(0, 8)}`;
    ws.panes[newPaneId] = {
      id: newPaneId,
      kind: "editor",
      title: "Editor",
      filePaths: [filePath],
      activeFilePath: filePath,
    };

    // Insert into layout adjacent to target (layout is non-null since targetPaneId exists in it)
    const splitResult = splitNodeInTreeWithSide(ws.layout!, targetPaneId, newPaneId, direction, side);
    if (!splitResult.found) console.warn(`splitNodeInTreeWithSide: target "${targetPaneId}" not found in layout`);
    ws.layout = splitResult.tree;

    // If source pane is now empty, remove it
    if (sourcePaneConfig?.kind === "editor" && sourcePaneConfig.filePaths?.length === 0) {
      delete ws.panes[sourcePaneId];
      const removeResult = removeNodeFromTree(ws.layout!, sourcePaneId);
      if (!removeResult.found) console.warn(`removeNodeFromTree: target "${sourcePaneId}" not found in layout`);
      ws.layout = removeResult.tree;
    }

    ws.activePaneId = newPaneId;
    this.validateLayout(ws);
  }

  moveTabToExistingPane(
    filePath: string,
    sourcePaneId: string,
    targetPaneId: string,
  ): void {
    const ws = this.activeWorkspace;
    if (!ws) return;

    // Remove from source
    const sourcePaneConfig = ws.panes[sourcePaneId];
    if (sourcePaneConfig?.filePaths) {
      const idx = sourcePaneConfig.filePaths.indexOf(filePath);
      if (idx !== -1) sourcePaneConfig.filePaths.splice(idx, 1);
      if (sourcePaneConfig.activeFilePath === filePath) {
        sourcePaneConfig.activeFilePath =
          sourcePaneConfig.filePaths.length > 0 ? sourcePaneConfig.filePaths[0] : null;
      }
    }

    // Add to target
    const targetPaneConfig = ws.panes[targetPaneId];
    if (targetPaneConfig?.kind === "editor") {
      if (!targetPaneConfig.filePaths) targetPaneConfig.filePaths = [];
      if (!targetPaneConfig.filePaths.includes(filePath)) {
        targetPaneConfig.filePaths.push(filePath);
      }
      targetPaneConfig.activeFilePath = filePath;
    }

    // If source pane is now empty, remove it
    if (sourcePaneConfig?.kind === "editor" && sourcePaneConfig.filePaths?.length === 0) {
      delete ws.panes[sourcePaneId];
      const removeResult = removeNodeFromTree(ws.layout!, sourcePaneId);
      if (!removeResult.found) console.warn(`removeNodeFromTree: target "${sourcePaneId}" not found in layout`);
      ws.layout = removeResult.tree;
    }

    ws.activePaneId = targetPaneId;
    this.validateLayout(ws);
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
    const ws = this.workspaces[wsId];
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
        const cwd = ws.rootPath || (typeof process !== "undefined" ? process.env.HOME : "") || "/";
        const terminalId = await spawnTerminal(settings.terminal.default_shell, cwd, 80, 24);

        // Re-validate workspace still exists after await
        if (!this.workspaces[wsId]) return;

        ws.terminalIds.push(terminalId);
        ws.activeTerminalId = terminalId;

        newPaneId = `term-${terminalId}`;
        ws.panes[newPaneId] = {
          id: newPaneId,
          kind: "terminal",
          title: `Terminal ${nextTerminalNumber(this.workspaces)}`,
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
        const existing = ws.openFiles.filter(f => f.path.startsWith("untitled-"));
        const num = existing.length + 1;
        const path = `untitled-${num}`;
        this.openFileInWorkspace({ name: path, path, content: "" }, newPaneId);
      }
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
      // Re-validate workspace still exists after await
      if (!this.workspaces[wsId]) return;

      const idx = ws.terminalIds.indexOf(config.terminalId);
      if (idx !== -1) ws.terminalIds.splice(idx, 1);
      if (ws.activeTerminalId === config.terminalId) {
        ws.activeTerminalId = ws.terminalIds.length > 0 ? ws.terminalIds[0] : null;
      }
      delete ws.panes[paneId];
    } else if (config?.kind === "editor") {
      // Only remove files from ws.openFiles that aren't referenced by other editor panes
      const closingPaths = config.filePaths ?? [];
      delete ws.panes[paneId];

      for (const path of closingPaths) {
        const stillReferenced = Object.values(ws.panes).some(
          (p) => p.kind === "editor" && p.filePaths?.includes(path),
        );
        if (!stillReferenced) {
          const fileIdx = ws.openFiles.findIndex((f) => f.path === path);
          if (fileIdx !== -1) ws.openFiles.splice(fileIdx, 1);
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

    this.validateLayout(ws);
  }

  // --- Layout validation ---

  private validateLayout(ws: Workspace): void {
    if (!ws.layout) return;

    const leafIds = collectLeafIds(ws.layout);
    const paneIds = new Set(Object.keys(ws.panes));

    // Delete orphaned pane configs (in panes but not in layout)
    for (const paneId of paneIds) {
      if (!leafIds.has(paneId)) {
        console.warn(`validateLayout: orphaned pane config "${paneId}" — removing`);
        delete ws.panes[paneId];
      }
    }

    // Warn about dangling layout leaves (in layout but not in panes)
    for (const leafId of leafIds) {
      if (!paneIds.has(leafId)) {
        console.warn(`validateLayout: layout leaf "${leafId}" has no pane config`);
      }
    }

    // Fix activePaneId if it points to a removed pane
    if (ws.activePaneId && !ws.panes[ws.activePaneId]) {
      const remaining = Object.keys(ws.panes);
      ws.activePaneId = remaining.length > 0 ? findFirstLeaf(ws.layout) : null;
    }
  }

  // --- Focus tracking ---

  setActivePaneId(paneId: string, workspaceId?: string): void {
    const wsId = workspaceId ?? this.activeWorkspaceId;
    if (!wsId) return;
    const ws = this.workspaces[wsId];
    if (!ws) return;
    ws.activePaneId = paneId;
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

  // --- Initialization ---

  async initializeWorkspaces(): Promise<void> {
    try {
      const { getWorkspaces } = await import("../ipc/commands");
      const saved = await getWorkspaces();

      for (const rws of saved) {
        await this.createWorkspaceFromDirectory(rws.root_path);
      }
    } catch (e) {
      console.error("Failed to initialize workspaces:", e);
    }
  }

  async fetchGitBranch(workspaceId: string): Promise<void> {
    const ws = this.workspaces[workspaceId];
    if (!ws?.rootPath) return;
    try {
      const { getGitBranch } = await import("../ipc/commands");
      ws.gitBranch = await getGitBranch(ws.rootPath);
    } catch {
      ws.gitBranch = "";
    }
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
    try {
      const { readDirTree } = await import("../ipc/commands");
      ws.fileTree = await readDirTree(ws.rootPath);
    } catch (e) {
      console.error("Failed to load file tree:", e);
    }
  }
}

export const workspaceManager = new WorkspaceManager();

export function getActiveWorkspace(): Workspace | null {
  return workspaceManager.activeWorkspace;
}
