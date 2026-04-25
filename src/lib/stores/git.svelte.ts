/**
 * Reactive git status store — keyed by workspace ID.
 *
 * Provides file-level and directory-level git status for the file tree,
 * plus staged/unstaged/untracked groupings for the git panel.
 */

import type { GitFileStatus } from "../ipc/commands";

export type GitStatusKind = "modified" | "added" | "deleted" | "untracked" | "renamed" | "conflict" | "clean";

interface GitStoreEntry {
  files: GitFileStatus[];
  /** Absolute path → status for files */
  statusMap: Map<string, GitStatusKind>;
  /** Directory absolute path → most urgent child status */
  dirStatusMap: Map<string, GitStatusKind>;
  stagedFiles: GitFileStatus[];
  unstagedFiles: GitFileStatus[];
  untrackedFiles: GitFileStatus[];
  loading: boolean;
}

function emptyEntry(): GitStoreEntry {
  return {
    files: [],
    statusMap: new Map(),
    dirStatusMap: new Map(),
    stagedFiles: [],
    unstagedFiles: [],
    untrackedFiles: [],
    loading: false,
  };
}

export const gitStore = $state<Record<string, GitStoreEntry>>({});

/** Per-workspace refresh generation counter — prevents stale results from
 *  overwriting a more recent refresh when concurrent refreshes race. */
const refreshGenerations = new Map<string, number>();

/** Status priority — higher number = more urgent */
const STATUS_PRIORITY: Record<GitStatusKind, number> = {
  clean: 0,
  untracked: 1,
  added: 2,
  renamed: 3,
  modified: 4,
  deleted: 5,
  conflict: 6,
};

function charToStatus(c: string): GitStatusKind {
  switch (c) {
    case "M": return "modified";
    case "A": return "added";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "added"; // copied
    case "U": return "conflict";
    case "?": return "untracked";
    default: return "clean";
  }
}

function higherPriority(a: GitStatusKind, b: GitStatusKind): GitStatusKind {
  return STATUS_PRIORITY[a] >= STATUS_PRIORITY[b] ? a : b;
}

/**
 * Build directory status map: for each directory ancestor of a changed file,
 * set to the highest-priority status of any descendant.
 */
function buildDirStatusMap(statusMap: Map<string, GitStatusKind>, rootPath: string): Map<string, GitStatusKind> {
  const dirMap = new Map<string, GitStatusKind>();
  for (const [filePath, status] of statusMap) {
    let dir = filePath.substring(0, filePath.lastIndexOf("/"));
    while (dir.length >= rootPath.length) {
      const existing = dirMap.get(dir);
      if (existing) {
        dirMap.set(dir, higherPriority(existing, status));
      } else {
        dirMap.set(dir, status);
      }
      const nextSlash = dir.lastIndexOf("/");
      if (nextSlash < 0) break;
      dir = dir.substring(0, nextSlash);
    }
  }
  return dirMap;
}

export async function refreshGitStatus(workspaceId: string, rootPath: string): Promise<void> {
  if (!rootPath) return;

  // Initialize entry if missing
  if (!gitStore[workspaceId]) {
    gitStore[workspaceId] = emptyEntry();
  }
  gitStore[workspaceId].loading = true;

  // Per-workspace generation counter prevents a slow earlier refresh from
  // overwriting the results of a faster later one.
  const gen = (refreshGenerations.get(workspaceId) ?? 0) + 1;
  refreshGenerations.set(workspaceId, gen);

  try {
    const { gitStatus } = await import("../ipc/commands");
    const files = await gitStatus(rootPath);

    // Discard stale results if a newer refresh started while we awaited
    if (refreshGenerations.get(workspaceId) !== gen) return;

    const statusMap = new Map<string, GitStatusKind>();
    const staged: GitFileStatus[] = [];
    const unstaged: GitFileStatus[] = [];
    const untracked: GitFileStatus[] = [];

    // Ensure rootPath ends with /
    const root = rootPath.endsWith("/") ? rootPath : rootPath + "/";

    for (const file of files) {
      const absolutePath = root + file.path;
      const indexStatus = charToStatus(file.index_status);
      const worktreeStatus = charToStatus(file.worktree_status);

      // File status for tree coloring: use the most urgent of index or worktree
      const fileStatus = higherPriority(indexStatus, worktreeStatus);
      if (fileStatus !== "clean") {
        statusMap.set(absolutePath, fileStatus);
      }

      // Categorize for git panel
      if (file.index_status === "?" && file.worktree_status === "?") {
        untracked.push(file);
      } else {
        if (file.index_status !== " " && file.index_status !== "?") {
          staged.push(file);
        }
        if (file.worktree_status !== " " && file.worktree_status !== "?") {
          unstaged.push(file);
        }
      }
    }

    const dirStatusMap = buildDirStatusMap(statusMap, root);

    const entry = gitStore[workspaceId];
    entry.files = files;
    entry.statusMap = statusMap;
    entry.dirStatusMap = dirStatusMap;
    entry.stagedFiles = staged;
    entry.unstagedFiles = unstaged;
    entry.untrackedFiles = untracked;
    entry.loading = false;
  } catch (e) {
    console.error("Failed to refresh git status:", e);
    if (gitStore[workspaceId]) {
      gitStore[workspaceId].loading = false;
    }
  }
}

export function getFileGitStatus(workspaceId: string, absolutePath: string): GitStatusKind | null {
  return gitStore[workspaceId]?.statusMap.get(absolutePath) ?? null;
}

export function getDirGitStatus(workspaceId: string, absolutePath: string): GitStatusKind | null {
  return gitStore[workspaceId]?.dirStatusMap.get(absolutePath) ?? null;
}

export function getGitEntry(workspaceId: string): GitStoreEntry | null {
  return gitStore[workspaceId] ?? null;
}

export function getTotalChangedCount(workspaceId: string): number {
  const entry = gitStore[workspaceId];
  if (!entry) return 0;
  return entry.stagedFiles.length + entry.unstagedFiles.length + entry.untrackedFiles.length;
}
