/**
 * Pure query helpers that derive display-layer data from workspace state.
 * These have no side effects and no Svelte reactivity — safe to call from
 * any context including non-reactive code.
 */

import type { Workspace } from "./workspace.svelte";
import type { PaneConfig } from "./layout.svelte";

export type TabInfo = {
  name: string;
  path: string;
  preview?: boolean;
  dirty?: boolean;
  pinned?: boolean;
  readOnly?: boolean;
};

/** Returns the display tabs for an editor pane (empty array for non-editor panes). */
export function getTabsForPane(workspace: Workspace, config: PaneConfig): TabInfo[] {
  if (config.kind !== "editor") return [];
  const paths = config.filePaths ?? [];
  return paths.map((p) => {
    const openFile = workspace.openFileIndex[p];
    return {
      name: openFile?.name ?? p.split("/").pop() ?? "untitled",
      path: p,
      preview: openFile?.preview,
      dirty: openFile?.dirty,
      pinned: openFile?.pinned,
      readOnly: openFile?.readOnly,
    };
  });
}

/** Returns the active file path for an editor pane, or null for non-editor panes. */
export function getActiveTabForPane(config: PaneConfig): string | null {
  if (config.kind !== "editor") return null;
  return config.activeFilePath ?? null;
}

/** Returns the current in-memory content of the active file in a pane. */
export function getContentForPane(workspace: Workspace, config: PaneConfig): string {
  if (config.kind !== "editor") return "";
  const activePath = config.activeFilePath;
  if (!activePath) return "";
  return workspace.openFileIndex[activePath]?.content ?? "";
}
