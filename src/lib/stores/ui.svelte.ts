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
  sidebarMode: "files" as "files" | "search" | "problems",
  zenMode: false,
  zenSnapshot: null as { explorerVisible: boolean; workspacesVisible: boolean } | null,
  /** PR/screenshot mode: hides recent files and projects for clean screenshots */
  prMode: false,
  sendToClaudeModal: null as SendToClaudeContext | null,
});
