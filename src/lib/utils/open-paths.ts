/**
 * Opening files and folders into the active workspace.
 *
 * Shared by the File menu, the welcome screen, OS drag-and-drop onto the window,
 * and Finder "Open With → Splice" (which arrives via the Rust side's pending
 * open-path buffer). Extracted from App.svelte so the component only wires UI.
 */
import { workspaceManager } from "../stores/workspace.svelte";
import { ui } from "../stores/ui.svelte";
import { pushToast } from "../stores/toasts.svelte";
import { addRecentFile } from "../stores/recent-files.svelte";
import { dispatchEditorAction } from "../stores/editor-actions.svelte";
import { log } from "./log";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/i;

/** Image files are opened as previews, so their bytes are never read as text. */
export function isImagePath(p: string): boolean {
  return IMAGE_EXT.test(p);
}

/** Surface a file-read failure as a short toast with a human cause. */
export function toastFileReadError(path: string, e: unknown): void {
  const name = path.split("/").pop() ?? path;
  const msg = String(e);
  let detail: string;
  if (msg.includes("not valid UTF-8") || msg.includes("not a text file")) {
    detail = "not a text file";
  } else if (msg.includes("Permission denied") || msg.includes("permission denied")) {
    detail = "permission denied";
  } else if (msg.includes("No such file") || msg.includes("not found")) {
    detail = "file not found";
  } else {
    // Include the raw message for unknown errors (trimmed to keep toast short)
    const raw = msg.replace(/^Error:\s*/, "").slice(0, 120);
    detail = raw || "read failed";
  }
  pushToast(`Cannot open "${name}": ${detail}`, "error", 6000);
  log.error("Failed to read file:", e);
}

/** Read a file for the active workspace, over SFTP when the workspace is remote. */
export async function readFileForWs(path: string): Promise<string> {
  const ws = workspaceManager.activeWorkspace;
  if (ws?.sshConfig) {
    const { sftpReadFile } = await import("../ipc/commands");
    return sftpReadFile(ws.id, path);
  }
  const { readFile } = await import("../ipc/commands");
  return readFile(path);
}

function ensureWorkspace(): void {
  if (!workspaceManager.activeWorkspace) {
    workspaceManager.createEmptyWorkspace();
  }
}

/** Open a single file as a tab in the active workspace (creating one if needed). */
export async function openFilePath(filePath: string): Promise<void> {
  ensureWorkspace();
  const content = isImagePath(filePath) ? "" : await readFileForWs(filePath);
  const name = filePath.split("/").pop() ?? "untitled";
  workspaceManager.openFileInWorkspace({ name, path: filePath, content });
  addRecentFile(filePath);
}

/**
 * Open a file and jump to a 1-based line (diagnostics, search results,
 * go-to-definition). The jump is dispatched after a short delay: when the file
 * was not already open, the editor that will consume the action mounts on the
 * next tick, and the previous file's editor must not swallow it first.
 */
export async function openFileAtLine(filePath: string, line: number): Promise<void> {
  await openFilePath(filePath);
  setTimeout(() => dispatchEditorAction("goto-line-number", line), 50);
}

/** Point the active workspace at a folder (creating a workspace if needed). */
export async function openFolderPath(path: string): Promise<void> {
  ensureWorkspace();
  await workspaceManager.openFolderInWorkspace(path);
  ui.explorerVisible = true;
}

/** `path` relative to the active workspace root, or unchanged when outside it. */
export function relativeToRoot(path: string): string {
  const root = workspaceManager.activeWorkspace?.rootPath;
  return root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
}

/** True for the "user cancelled" rejection some dialog paths throw. */
function isCancelled(e: unknown): boolean {
  return !!e && typeof e === "object" && "message" in e && String((e as { message: unknown }).message).includes("cancelled");
}

/** Show the folder picker and open the choice as the workspace root. */
export async function pickAndOpenFolder(): Promise<void> {
  if (!isTauri) return;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false });
    if (selected) await openFolderPath(selected);
  } catch (e) {
    if (!isCancelled(e)) log.error("Failed to open folder:", e);
  }
}

/** Show the file picker and open the choice as a tab. */
export async function pickAndOpenFile(): Promise<void> {
  if (!isTauri) return;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: false, multiple: false });
    if (selected) await openFilePath(selected);
  } catch (e) {
    if (!isCancelled(e)) toastFileReadError("", e);
  }
}

/** Open files dropped onto the window. Directories (trailing slash) are skipped. */
export async function openDroppedFiles(paths: string[]): Promise<void> {
  ensureWorkspace();
  for (const filePath of paths) {
    if (filePath.endsWith("/")) continue;
    try {
      await openFilePath(filePath);
    } catch (e) {
      toastFileReadError(filePath, e);
    }
  }
}

/**
 * Finder "Open With → Splice" hands paths to the Rust side, which buffers them
 * and pings us via the "open-path" event. Drain on startup (cold launch) and on
 * every ping (already-running). take_pending_open_paths drains atomically, so
 * the two triggers never double-open the same file.
 */
export async function drainOpenPaths(): Promise<void> {
  if (!isTauri) return;
  try {
    const { takePendingOpenPaths } = await import("../ipc/commands");
    for (const t of await takePendingOpenPaths()) {
      try {
        if (t.is_dir) await openFolderPath(t.path);
        else await openFilePath(t.path);
      } catch (e) {
        toastFileReadError(t.path, e);
      }
    }
  } catch (e) {
    log.error("Failed to open paths from OS:", e);
  }
}
