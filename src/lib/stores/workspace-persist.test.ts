import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// A workspace whose last pane was closed must still be saved (as "no panes"), or
// the stale record on disk resurrects its old terminals on the next launch.

vi.mock("../ipc/commands", () => ({
  saveWorkspace: vi.fn().mockResolvedValue(undefined),
  getTerminalCwd: vi.fn().mockResolvedValue(null),
}));
vi.mock("./settings.svelte", () => {
  const s = { terminal: { default_shell: "/bin/zsh" }, general: {}, appearance: {}, editor: {} };
  return { settings: s, effectiveSettings: s };
});

import { persistWorkspaceImpl } from "./workspace-session";
import type { Workspace } from "./workspace-types";

function ws(): Workspace {
  return {
    id: "w1", name: "proj", rootPath: "/tmp/proj", fileTree: [], openFiles: [], openFileIndex: {},
    terminalIds: [], activeTerminalId: null, layout: null, panes: {}, activePaneId: null,
    gitBranch: "", explorerVisible: true, explorerWidth: 240, expandedPaths: new Set(),
  };
}

describe("persistWorkspaceImpl", () => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });

  it("persists_a_workspace_with_no_panes_as_a_null_layout", async () => {
    const { saveWorkspace } = await import("../ipc/commands");
    await persistWorkspaceImpl(ws(), null);
    expect(saveWorkspace).toHaveBeenCalledTimes(1);
    const saved = (saveWorkspace as Mock).mock.calls[0][0] as { layout: unknown; panes: unknown[]; terminal_ids: number[]; root_path: string };
    expect(saved.layout).toBeNull();
    expect(saved.panes).toEqual([]);
    expect(saved.terminal_ids).toEqual([]);
    expect(saved.root_path).toBe("/tmp/proj");
  });
});
