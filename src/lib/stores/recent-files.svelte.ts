/**
 * Recently opened files tracking, persisted via Rust IPC commands.
 *
 * `loadRecentFiles()` fetches the list from the Rust backend on startup.
 * `addRecentFile(path)` pushes a file to the front of the list (deduped),
 * capped at 50 entries, and persists the update to disk via IPC.
 * Untitled (unsaved) buffers are excluded from tracking.
 *
 * The `recentFiles` array is reactive and consumed by the welcome page
 * and command palette.
 *
 * @exports recentFiles - Reactive array of recent file paths (most recent first)
 * @exports loadRecentFiles - Fetch from Rust backend (call once on startup)
 * @exports addRecentFile - Track a newly opened file
 */

export const recentFiles = $state<string[]>([]);

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function loadRecentFiles(): Promise<void> {
  if (!isTauri) return;
  try {
    const { getRecentFiles } = await import("../ipc/commands");
    const files = await getRecentFiles();
    recentFiles.length = 0;
    recentFiles.push(...files);
  } catch {
    // ignore
  }
}

export async function addRecentFile(path: string): Promise<void> {
  if (!isTauri || path.startsWith("untitled-")) return;
  try {
    const { addRecentFile: addRecent } = await import("../ipc/commands");
    await addRecent(path);
    // Update local state
    const idx = recentFiles.indexOf(path);
    if (idx !== -1) recentFiles.splice(idx, 1);
    recentFiles.unshift(path);
    if (recentFiles.length > 50) recentFiles.length = 50;
  } catch {
    // ignore
  }
}
