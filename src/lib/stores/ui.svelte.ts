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
});
