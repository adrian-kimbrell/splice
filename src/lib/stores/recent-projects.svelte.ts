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
