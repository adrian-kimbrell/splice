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
