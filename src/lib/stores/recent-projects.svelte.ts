/**
 * Recently opened projects (workspace roots) tracking, persisted via Rust IPC commands.
 *
 * `loadRecentProjects()` fetches the list from the Rust backend on startup.
 * `addRecentProject(path)` pushes a project to the front of the list (deduped),
 * capped at 20 entries, and persists the update to disk via IPC.
 *
 * The `recentProjects` array is reactive and consumed by the welcome page
 * and the "Open Recent" command palette entries.
 *
 * @exports recentProjects - Reactive array of recent project paths (most recent first)
 * @exports loadRecentProjects - Fetch from Rust backend (call once on startup)
 * @exports addRecentProject - Track a newly opened project
 */

export const recentProjects = $state<string[]>([]);

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function loadRecentProjects(): Promise<void> {
  if (!isTauri) return;
  try {
    const { getRecentProjects } = await import("../ipc/commands");
    const projects = await getRecentProjects();
    recentProjects.length = 0;
    recentProjects.push(...projects);
  } catch {
    // ignore
  }
}

export async function addRecentProject(path: string): Promise<void> {
  if (!isTauri) return;
  try {
    const { addRecentProject: addProject } = await import("../ipc/commands");
    await addProject(path);
    // Update local state
    const idx = recentProjects.indexOf(path);
    if (idx !== -1) recentProjects.splice(idx, 1);
    recentProjects.unshift(path);
    if (recentProjects.length > 20) recentProjects.length = 20;
  } catch {
    // ignore
  }
}
