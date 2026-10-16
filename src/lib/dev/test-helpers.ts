/**
 * Registers `window.__spliceTest` — a bag of test hooks used by WebDriver E2E automation.
 * Called once from App.svelte's onMount. Compiled in every build but only accessible
 * via window (not exported to production code paths).
 */

import type { workspaceManager as _wm } from "../stores/workspace.svelte";
import type { ui as _ui } from "../stores/ui.svelte";
import type { settings as _settings } from "../stores/settings.svelte";

export interface TestHelperDeps {
  workspaceManager: typeof _wm;
  readFileForWs: (path: string) => Promise<string>;
  ui: typeof _ui;
  settings: typeof _settings;
  openNewWindow: () => void;
}

export function registerTestHelpers(deps: TestHelperDeps): void {
  const { workspaceManager, readFileForWs, ui, settings, openNewWindow } = deps;

  (window as unknown as Record<string, unknown>).__spliceTest = {
    openWorkspace: (path: string) => workspaceManager.createWorkspaceFromDirectory(path),
    closeAllWorkspaces: () =>
      Promise.all(
        Object.keys(workspaceManager.workspaces).map((id) =>
          workspaceManager.closeWorkspaceWithCleanup(id),
        ),
      ),
    getWorkspaceIds: () => Object.keys(workspaceManager.workspaces),
    /** Promote the active preview tab in the active editor pane to a permanent (pinned) tab. */
    pinCurrentTab: () => {
      const activeWs = workspaceManager.activeWorkspace;
      if (!activeWs) return;
      const pane = activeWs.activePaneId ? activeWs.panes[activeWs.activePaneId] : null;
      if (!pane || pane.kind !== "editor") return;
      const activePath = pane.activeFilePath;
      if (activePath) workspaceManager.promotePreviewTab(activePath);
    },
    /** Switch the active workspace by ID. */
    switchToWorkspace: (id: string) => workspaceManager.switchWorkspace(id),
    /** Return the currently active workspace ID. */
    getActiveWorkspaceId: () => workspaceManager.activeWorkspaceId,
    /** Open a file as a permanent (non-preview) tab in the active pane. */
    openFilePinned: async (filePath: string) => {
      const name = filePath.split("/").pop() ?? filePath;
      const existing = workspaceManager.activeWorkspace?.openFileIndex[filePath];
      const content = existing ? existing.content : await readFileForWs(filePath);
      workspaceManager.openFileInWorkspace({ name, path: filePath, content, preview: false });
    },
    /** Directly mark the active file in the active pane as dirty (for E2E tests). */
    markActiveFileDirty: () => {
      const activeWs = workspaceManager.activeWorkspace;
      if (!activeWs) return;
      const pane = activeWs.activePaneId ? activeWs.panes[activeWs.activePaneId] : null;
      if (!pane || pane.kind !== "editor" || !pane.activeFilePath) return;
      const file = activeWs.openFileIndex[pane.activeFilePath];
      if (file) file.dirty = true;
    },
    /** Ensure the file explorer sidebar is visible (for E2E tests). */
    showExplorer: () => {
      ui.explorerVisible = true;
    },
    /** Return sidebar logical state (for E2E tests — avoids display:contents WebDriver ambiguity). */
    getSidebarState: () => ({ explorerVisible: ui.explorerVisible, sidebarMode: ui.sidebarMode }),
    /** Update the active file's in-memory content and mark it dirty (for save-verification tests). */
    updateActiveFileContent: (content: string) => {
      const activeWs = workspaceManager.activeWorkspace;
      if (!activeWs) return;
      const pane = activeWs.activePaneId ? activeWs.panes[activeWs.activePaneId] : null;
      if (!pane || pane.kind !== "editor" || !pane.activeFilePath) return;
      const file = activeWs.openFileIndex[pane.activeFilePath];
      if (file) {
        file.content = content;
        file.dirty = true;
      }
    },
    /** Return registered secondary window labels from windows.json (for E2E tests). */
    getWindowRegistry: async () => {
      const { getSecondaryWindowLabels } = await import("../ipc/commands");
      return getSecondaryWindowLabels();
    },
    /** Open a new secondary window (for E2E tests). */
    openNewWindow: () => openNewWindow(),
    /** Snapshot of transient UI state plus the focused element (for E2E diagnostics). */
    getUiState: () => {
      const el = document.activeElement as HTMLElement | null;
      return {
        commandPaletteOpen: ui.commandPaletteOpen,
        zenMode: ui.zenMode,
        zoomedPaneId: ui.zoomedPaneId,
        sidebarMode: ui.sidebarMode,
        explorerVisible: ui.explorerVisible,
        activeElement: el
          ? { tag: el.tagName, id: el.id || null, className: el.className || null, placeholder: el.getAttribute("placeholder") }
          : null,
      };
    },
    /** Return true if zen mode is active. */
    isZenMode: () => ui.zenMode,
    /** Return the current ui_scale (for command palette execution verification). */
    getUiScale: () => settings.appearance.ui_scale,
    /** Flip a boolean setting addressed by dotted path, e.g. "terminal.copy_on_select". */
    toggleSetting: (path: string) => {
      const keys = path.split(".");
      const leaf = keys.pop();
      let node: Record<string, unknown> = settings as unknown as Record<string, unknown>;
      for (const k of keys) node = node[k] as Record<string, unknown>;
      if (leaf && typeof node[leaf] === "boolean") node[leaf] = !node[leaf];
    },
    /** Plain-object snapshot of the current settings (for E2E assertions). */
    getSettings: () => JSON.parse(JSON.stringify(settings)) as Record<string, unknown>,
    /** Return Rust-side AppState HashMap sizes (e2e debug command, only works in --features e2e build). */
    getDebugStats: async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        return await invoke("get_debug_stats");
      } catch {
        return null;
      }
    },
    /** Attempt ssh_connect and return { ok, err }. Used by E2E SSH error-path tests. */
    sshConnectTest: async (
      workspaceId: string,
      config: Record<string, unknown>,
    ): Promise<{ ok: boolean; err?: string }> => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("ssh_connect", { workspaceId, config });
        return { ok: true };
      } catch (e) {
        return { ok: false, err: String(e) };
      }
    },
    /** Attempt ssh_ping and return { ok, value, err }. Used by E2E SSH error-path tests. */
    sshPingTest: async (
      workspaceId: string,
    ): Promise<{ ok: boolean; value?: boolean; err?: string }> => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const value = await invoke<boolean>("ssh_ping", { workspaceId });
        return { ok: true, value };
      } catch (e) {
        return { ok: false, err: String(e) };
      }
    },
    /** Benchmark tab switching FPS over N rAF-timed iterations across open files. */
    benchmarkTabSwitching: async (iterations = 200) => {
      const ws = workspaceManager.activeWorkspace;
      if (!ws || !ws.activePaneId) return "No active workspace/pane";
      const pane = ws.panes[ws.activePaneId];
      if (!pane || pane.kind !== "editor") return "Active pane is not an editor";
      const paths = Object.keys(ws.openFileIndex);
      if (paths.length < 2) return "Open at least 2 files first";

      let i = 0;
      let frames = 0;
      const start = performance.now();

      await new Promise<void>((resolve) => {
        function step() {
          workspaceManager.setActiveFileInWorkspace(paths[i % paths.length], ws!.activePaneId!);
          i++;
          frames++;
          if (frames < iterations) {
            requestAnimationFrame(step);
          } else {
            resolve();
          }
        }
        requestAnimationFrame(step);
      });

      const elapsed = performance.now() - start;
      const fps = (frames / (elapsed / 1000)).toFixed(1);
      return `${fps} FPS`;
    },
  };
}
