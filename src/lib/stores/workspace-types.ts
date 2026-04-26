import type { FileEntry, OpenFile } from "./files.svelte";
import type { LayoutNode, PaneConfig, SplitDirection } from "./layout.svelte";
import { MAX_SPLIT_DEPTH } from "./layout.svelte";

export interface SshConfig {
  host: string;
  port: number;
  user: string;
  keyPath: string;
  remotePath: string;
}

/**
 * Returns true if `p` is a safe filesystem path that can be passed as an SSH
 * `-i` argument without risk of option injection. Rejects anything that starts
 * with `-`, contains whitespace, or contains shell/SSH metacharacters.
 */
export function isSafeKeyPath(p: string): boolean {
  return /^~?\/[^\s`$&|;<>'"\\!*?{}()[\]#\x00-\x1f]+$/.test(p);
}

/**
 * Builds the `extraArgs` for spawning `/usr/bin/ssh` to open a terminal into
 * the remote workspace. Mirrors the live-spawn path in workspace.svelte.ts so
 * restore yields the same SSH connection (key, port, accept-new, cd to remote
 * path, exec login shell).
 */
export function buildSshExtraArgs(sshConfig: SshConfig): string[] {
  const target = sshConfig.user ? `${sshConfig.user}@${sshConfig.host}` : sshConfig.host;
  const escapedPath = sshConfig.remotePath.replace(/'/g, "'\\''");
  const keyArgs: string[] = [];
  if (sshConfig.keyPath) {
    if (!isSafeKeyPath(sshConfig.keyPath)) {
      throw new Error(`Unsafe SSH key path rejected: "${sshConfig.keyPath}"`);
    }
    keyArgs.push("-i", sshConfig.keyPath);
  }
  return [
    ...keyArgs,
    "-p", String(sshConfig.port),
    "-t",
    "-o", "StrictHostKeyChecking=accept-new",
    target,
    `cd '${escapedPath}' && exec $SHELL -l`,
  ];
}

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;

  // File explorer
  fileTree: FileEntry[];
  openFiles: OpenFile[];
  openFileIndex: Record<string, OpenFile>;

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

  // Persists which folder paths the user has expanded in the file tree so the
  // state survives workspace switches within a session.
  expandedPaths: Set<string>;

  // SSH remote workspace config (null = local workspace)
  sshConfig?: SshConfig | null;
}

export function generateId(): string {
  return crypto.randomUUID();
}

export function findFirstLeaf(node: LayoutNode | null): string | null {
  if (!node) return null;
  if (node.type === "leaf") return node.paneId;
  return findFirstLeaf(node.children[0]);
}

/**
 * Convert a Rust-serialized LayoutNode (PascalCase types, snake_case fields, remapped IDs)
 * into a frontend LayoutNode.
 */
export function remapLayout(node: unknown, idMap: Map<string, string>, depth = 0): LayoutNode {
  if (depth > MAX_SPLIT_DEPTH) throw new Error("Layout depth exceeds maximum");
  const n = node as Record<string, unknown>;
  const type = (n.type as string).toLowerCase();
  if (type === "leaf") {
    const savedId = (n.pane_id ?? n.paneId) as string;
    return { type: "leaf", paneId: idMap.get(savedId) ?? savedId };
  }
  const children = n.children as unknown[];
  if (!Array.isArray(children) || children.length < 2) {
    console.warn("remapLayout: malformed split (expected 2 children), treating as leaf", n);
    const firstId = idMap.size > 0 ? idMap.values().next().value! : "pane-fallback";
    return { type: "leaf", paneId: firstId };
  }
  const direction = (n.direction as string).toLowerCase() as SplitDirection;
  return {
    type: "split",
    direction,
    ratio: (n.ratio as number) ?? 0.5,
    children: [remapLayout(children[0], idMap, depth + 1), remapLayout(children[1], idMap, depth + 1)],
  };
}

/**
 * Returns the next available `untitled-N` path for the workspace.
 * Single pass over openFiles — no intermediate filter array.
 */
export function nextUntitledPath(ws: Workspace): string {
  const maxNum = ws.openFiles.reduce((max, f) => {
    if (!f.path.startsWith("untitled-")) return max;
    const n = parseInt(f.path.slice("untitled-".length));
    return isNaN(n) ? max : Math.max(max, n);
  }, 0);
  return `untitled-${maxNum + 1}`;
}

/**
 * Convert a frontend LayoutNode into the Rust-expected serialization format
 * (PascalCase type tags, snake_case field names).
 */
export function frontendToRustLayout(node: LayoutNode): unknown {
  if (node.type === "leaf") {
    return { type: "Leaf", pane_id: node.paneId };
  }
  return {
    type: "Split",
    direction: node.direction === "horizontal" ? "Horizontal" : "Vertical",
    ratio: node.ratio,
    children: node.children.map(frontendToRustLayout),
  };
}

/** Update all pane references when a file is renamed/saved-as, and re-key the openFileIndex. */
export function applyFileRename(ws: Workspace, file: OpenFile, oldPath: string, newPath: string): void {
  const newName = newPath.split("/").pop() ?? newPath;
  delete ws.openFileIndex[oldPath];
  file.path = newPath;
  file.name = newName;
  ws.openFileIndex[newPath] = file;
  for (const pane of Object.values(ws.panes)) {
    if (pane.kind !== "editor" || !pane.filePaths) continue;
    const idx = pane.filePaths.indexOf(oldPath);
    if (idx !== -1) pane.filePaths[idx] = newPath;
    if (pane.activeFilePath === oldPath) pane.activeFilePath = newPath;
  }
}

/** Mark a file as cleanly saved (clear dirty flag and reset original content). */
export function markFileSaved(file: OpenFile): void {
  file.dirty = false;
  file.originalContent = file.content;
  if (file.preview) file.preview = false;
}

export async function fetchGitBranchImpl(ws: Workspace): Promise<void> {
  if (!ws.rootPath) return;
  try {
    const { getGitBranch } = await import("../ipc/commands");
    ws.gitBranch = await getGitBranch(ws.rootPath);
  } catch {
    ws.gitBranch = "";
  }
}

export async function loadFileTreeImpl(ws: Workspace): Promise<void> {
  if (!ws.rootPath) return;
  try {
    if (ws.sshConfig) {
      const { sftpListDir } = await import("../ipc/commands");
      ws.fileTree = await sftpListDir(ws.id, ws.rootPath);
    } else {
      const { readDirTree } = await import("../ipc/commands");
      ws.fileTree = await readDirTree(ws.rootPath);
    }
  } catch (e) {
    console.error("Failed to load file tree:", e);
  }
}
