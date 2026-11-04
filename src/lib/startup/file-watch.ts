/**
 * Reacting to the Rust file watchers: reload clean buffers that changed on
 * disk (or warn when the buffer is dirty), and refresh the explorer and git
 * status when a watched directory tree changes.
 */
import { listen } from "@tauri-apps/api/event";
import { workspaceManager } from "../stores/workspace.svelte";
import { wasRecentlyWrittenBySplice } from "../stores/self-writes";
import { pushToast } from "../stores/toasts.svelte";
import { refreshGitStatus } from "../stores/git.svelte";
import { readFile } from "../ipc/commands";
import { isUnderRoot } from "../utils/path-utils";
import { log } from "../utils/log";

/** The Rust side already debounces by 150 ms; this coalesces bursts across watchers. */
const TREE_CHANGE_DEBOUNCE_MS = 50;

export async function startFileWatchListeners(): Promise<() => void> {
  const unlistenFile = await listen<string>("file:changed", async (event) => {
    const changedPath = event.payload;
    for (const ws of Object.values(workspaceManager.workspaces)) {
      if (ws.sshConfig) continue; // remote paths never fire local watcher events
      const file = ws.openFileIndex[changedPath];
      if (!file) continue;
      if (file.dirty) {
        // Our own save followed by a quick keystroke looks exactly like this;
        // only warn when the write did not come from Splice.
        if (!wasRecentlyWrittenBySplice(changedPath)) {
          pushToast("File changed externally: " + (changedPath.split("/").pop() ?? changedPath), "warning", 5000);
        }
        continue;
      }
      try {
        const content = await readFile(changedPath);
        file.content = content;
        file.originalContent = content;
        file.dirty = false;
      } catch (e) {
        log.warn("Failed to reload externally changed file:", changedPath, e);
      }
    }
  });

  let treeChangeTimer: ReturnType<typeof setTimeout> | null = null;
  const unlistenTree = await listen<string>("tree:changed", (event) => {
    if (treeChangeTimer) clearTimeout(treeChangeTimer);
    treeChangeTimer = setTimeout(() => {
      treeChangeTimer = null;
      const changedPath = event.payload;
      log.debug("[watch] tree:changed", changedPath);
      for (const [wsId, w] of Object.entries(workspaceManager.workspaces)) {
        if (w.rootPath && isUnderRoot(changedPath, w.rootPath)) {
          workspaceManager.loadFileTree(wsId);
          refreshGitStatus(wsId, w.rootPath);
        }
      }
    }, TREE_CHANGE_DEBOUNCE_MS);
  });

  return () => {
    if (treeChangeTimer) clearTimeout(treeChangeTimer);
    unlistenFile();
    unlistenTree();
  };
}
