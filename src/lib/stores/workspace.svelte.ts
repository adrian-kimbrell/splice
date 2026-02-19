import type { FileEntry, OpenFile } from "./files.svelte";
import type { LayoutNode, PaneConfig, SplitDirection } from "./layout.svelte";
import { splitNodeInTree, splitNodeInTreeWithSide, removeNodeFromTree, findSiblingLeaf, treeDepth, MAX_SPLIT_DEPTH, collectLeafIds } from "./layout.svelte";
import { ui } from "./ui.svelte";
import { isCornerDragActive } from "./corner-drag.svelte";
import { isDragging as isTabDragging } from "./drag.svelte";

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;

  // File explorer
  fileTree: FileEntry[];
  openFiles: OpenFile[];
  activeFilePath: string | null;

  // Terminals (IDs reference global Rust PTY registry)
  terminalIds: number[];
  activeTerminalId: number | null;

  // Pane layout (null = no panes open)
  layout: LayoutNode | null;
  panes: Record<string, PaneConfig>;
  activePaneId: string | null;

  // UI state per workspace
  leftSidebarVisible: boolean;
  nameManuallySet?: boolean;
}

function generateId(): string {
  return crypto.randomUUID();
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
      current.leftSidebarVisible = ui.leftSidebarVisible;
    }
    this.activeWorkspaceId = id;
    // Restore target workspace's sidebar state
    ui.leftSidebarVisible = this.workspaces[id].leftSidebarVisible;
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
      activeFilePath: null,
      terminalIds: [],
      activeTerminalId: null,
      layout: null,
      panes: {},
      activePaneId: null,
      leftSidebarVisible: false,
    };

    this.workspaces[id] = ws;
    this.activeWorkspaceId = id;
    ui.leftSidebarVisible = ws.leftSidebarVisible;
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
  }

  async createWorkspaceFromDirectory(rootPath: string): Promise<Workspace | null> {
    const dirName = rootPath.split("/").pop() ?? "Untitled";
    const id = generateId();

    // Spawn terminal first so we have a real terminalId (no placeholder)
    let terminalId: number;
    let paneId: string;
    try {
      const { spawnTerminal } = await import("../ipc/commands");
      terminalId = await spawnTerminal("/bin/zsh", rootPath, 80, 24);
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
      activeFilePath: null,
      terminalIds: [terminalId],
      activeTerminalId: terminalId,
      layout: { type: "leaf", paneId },
      panes: {
        [paneId]: { id: paneId, kind: "terminal", title: `Terminal ${terminalId}`, terminalId },
      },
      activePaneId: paneId,
      leftSidebarVisible: true,
    };

    this.workspaces[id] = ws;
    this.activeWorkspaceId = id;
    ui.leftSidebarVisible = ws.leftSidebarVisible;

    // Load file tree in background
    this.loadFileTree(id);

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
      const terminalId = await spawnTerminal("/bin/zsh", cwd, 80, 24);

      ws.terminalIds.push(terminalId);
      ws.activeTerminalId = terminalId;

      const paneId = `term-${terminalId}`;
      ws.panes[paneId] = {
        id: paneId,
        kind: "terminal",
        title: `Terminal ${terminalId}`,
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
    if (!existing) {
      ws.openFiles.push(file);
    }
    ws.activeFilePath = file.path;

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
      // Add to pane's filePaths if not already there
      const pane = ws.panes[paneId];
      if (!pane.filePaths) pane.filePaths = [];
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

    if (filePaths?.[0]) ws.activeFilePath = filePaths[0];
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
      if (ws.activeFilePath === path) {
        ws.activeFilePath = ws.openFiles.length > 0 ? ws.openFiles[0].path : null;
      }
    }
  }

  setActiveFileInWorkspace(path: string, paneId?: string): void {
    const ws = this.activeWorkspace;
    if (!ws) return;
    ws.activeFilePath = path;

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
        const terminalId = await spawnTerminal("/bin/zsh", cwd, 80, 24);

        ws.terminalIds.push(terminalId);
        ws.activeTerminalId = terminalId;

        newPaneId = `term-${terminalId}`;
        ws.panes[newPaneId] = {
          id: newPaneId,
          kind: "terminal",
          title: `Terminal ${terminalId}`,
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

      if (ws.activeFilePath && !ws.openFiles.some((f) => f.path === ws.activeFilePath)) {
        ws.activeFilePath = ws.openFiles.length > 0 ? ws.openFiles[0].path : null;
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
