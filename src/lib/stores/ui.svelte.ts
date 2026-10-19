/**
 * Global UI state store for transient, non-persisted UI concerns.
 *
 * Manages sidebar visibility and widths, command palette toggle, zen mode
 * (which snapshots and restores sidebar state), zoomed pane tracking, and
 * the "Send to Claude" modal context.
 *
 * `prMode` hides recent files/projects for clean promotional screenshots.
 *
 * Consumed by App.svelte (layout), TitleBar, sidebar components, and the
 * command palette. For persisted UI preferences (explorer width, theme),
 * see `settings.svelte.ts` instead.
 *
 * @exports ui - Svelte 5 reactive state object
 * @exports SendToClaudeContext - Payload passed to the Send to Claude modal
 */

export interface SendToClaudeContext {
  selectedText: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
}

export const ui = $state({
  explorerVisible: true,
  workspacesVisible: true,
  explorerWidth: 240,
  workspacesWidth: 220,
  commandPaletteOpen: false,
  zoomedPaneId: null as string | null,
  sidebarMode: "files" as "files" | "search" | "problems" | "git",
  zenMode: false,
  zenSnapshot: null as { explorerVisible: boolean; workspacesVisible: boolean } | null,
  /** PR/screenshot mode: hides recent files and projects for clean screenshots */
  prMode: false,
  sendToClaudeModal: null as SendToClaudeContext | null,
  addPromptModal: false,
  /** Settings drawer that unfurls from the title bar (replaces the separate window). */
  settingsDrawerOpen: false,
  /** True while a sidebar divider is being dragged. Terminals defer their expensive
   *  PTY-resize/refit until the drag ends, so the whole grid doesn't re-fit per frame. */
  sidebarResizing: false,
});

// --- Sidebar panels -------------------------------------------------------
// The explorer can sit on either side (settings.appearance.explorer_side), so
// layout code addresses panels by name and maps names to sides itself.

export type SidebarPanel = "explorer" | "workspaces";

export const SIDEBAR_MIN_WIDTH: Record<SidebarPanel, number> = { explorer: 150, workspaces: 62 };
export const SIDEBAR_DEFAULT_WIDTH: Record<SidebarPanel, number> = { explorer: 240, workspaces: 220 };
export const SIDEBAR_MAX_WIDTH = 500;

export function isPanelVisible(panel: SidebarPanel): boolean {
  return panel === "explorer" ? ui.explorerVisible : ui.workspacesVisible;
}

export function togglePanel(panel: SidebarPanel): void {
  if (panel === "explorer") ui.explorerVisible = !ui.explorerVisible;
  else ui.workspacesVisible = !ui.workspacesVisible;
}

export function panelWidth(panel: SidebarPanel): number {
  return panel === "explorer" ? ui.explorerWidth : ui.workspacesWidth;
}

export function setPanelWidth(panel: SidebarPanel, width: number): void {
  if (panel === "explorer") ui.explorerWidth = width;
  else ui.workspacesWidth = width;
}
