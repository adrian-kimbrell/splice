import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Covers the workspace icon feature end to end at the store level:
//   - setWorkspaceIcon sets / clears and schedules a persist
//   - persistWorkspaceImpl writes `icon` to the Rust record
//   - restoreWorkspaceImpl reads `icon` back (and tolerates its absence)
//   - renameWorkspace now persists too (it used to only mutate memory)

vi.mock("../ipc/commands", () => ({
  saveWorkspace: vi.fn().mockResolvedValue(undefined),
  setActiveWorkspaceId: vi.fn().mockResolvedValue(undefined),
  getTerminalCwd: vi.fn().mockResolvedValue(null),
  spawnTerminal: vi.fn().mockResolvedValue(7),
  readFile: vi.fn().mockResolvedValue(""),
  checkPidAlive: vi.fn().mockResolvedValue(false),
  writeToTerminal: vi.fn().mockResolvedValue(undefined),
  killTerminal: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../ipc/events", () => ({
  onTerminalGrid: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("./settings.svelte", () => {
  const fakeSettings = {
    terminal: { default_shell: "/bin/zsh" },
    general: { restore_previous_session: true, default_single_view: false },
    appearance: {},
    editor: {},
  };
  return { settings: fakeSettings, effectiveSettings: fakeSettings };
});

import { workspaceManager } from "./workspace.svelte";
import { persistWorkspaceImpl, restoreWorkspaceImpl } from "./workspace-session";
import type { Workspace } from "./workspace-types";
import type { RustWorkspace } from "../ipc/commands";

type Mgr = {
  workspaces: Record<string, Workspace>;
  persistTimers: Record<string, ReturnType<typeof setTimeout>>;
};
const mgr = workspaceManager as unknown as Mgr;

function plant(id: string, extra: Partial<Workspace> = {}): Workspace {
  const ws: Workspace = {
    id,
    name: "Planted",
    rootPath: "/tmp/planted",
    fileTree: [],
    openFiles: [],
    openFileIndex: {},
    terminalIds: [],
    activeTerminalId: null,
    layout: { type: "leaf", paneId: "ghost" },
    panes: {},
    activePaneId: null,
    gitBranch: "",
    explorerVisible: true,
    explorerWidth: 240,
    expandedPaths: new Set<string>(),
    sshConfig: null,
    ...extra,
  };
  mgr.workspaces[id] = ws;
  return mgr.workspaces[id];
}

describe("workspace icon", () => {
  beforeEach(() => {
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    for (const k of Object.keys(mgr.persistTimers)) {
      clearTimeout(mgr.persistTimers[k]);
      delete mgr.persistTimers[k];
    }
  });
  afterEach(async () => {
    for (const k of Object.keys(mgr.persistTimers)) {
      clearTimeout(mgr.persistTimers[k]);
      delete mgr.persistTimers[k];
    }
    for (const k of Object.keys(mgr.workspaces)) {
      if (k.startsWith("ws-icon-")) delete mgr.workspaces[k];
    }
    delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    const ipc = await import("../ipc/commands");
    vi.mocked(ipc.saveWorkspace).mockClear();
  });

  it("setWorkspaceIcon_sets_and_schedules_persist", () => {
    plant("ws-icon-1");
    workspaceManager.setWorkspaceIcon("ws-icon-1", "bi-star-fill");
    expect(mgr.workspaces["ws-icon-1"].icon).toBe("bi-star-fill");
    expect(mgr.persistTimers["ws-icon-1"]).toBeDefined();
  });

  it("setWorkspaceIcon_null_or_blank_clears", () => {
    plant("ws-icon-2", { icon: "bi-fire" });
    workspaceManager.setWorkspaceIcon("ws-icon-2", null);
    expect(mgr.workspaces["ws-icon-2"].icon).toBeNull();
    workspaceManager.setWorkspaceIcon("ws-icon-2", "   ");
    expect(mgr.workspaces["ws-icon-2"].icon).toBeNull();
  });

  it("setWorkspaceIcon_unknown_workspace_is_noop", () => {
    expect(() => workspaceManager.setWorkspaceIcon("ws-icon-nope", "bi-fire")).not.toThrow();
    expect(mgr.persistTimers["ws-icon-nope"]).toBeUndefined();
  });

  it("renameWorkspace_schedules_persist", () => {
    plant("ws-icon-3");
    workspaceManager.renameWorkspace("ws-icon-3", "Renamed");
    expect(mgr.workspaces["ws-icon-3"].name).toBe("Renamed");
    expect(mgr.workspaces["ws-icon-3"].nameManuallySet).toBe(true);
    expect(mgr.persistTimers["ws-icon-3"]).toBeDefined();
  });

  it("persist_writes_icon_to_rust_record", async () => {
    const ws = plant("ws-icon-4", { icon: "bi-rocket-takeoff-fill" });
    await persistWorkspaceImpl(ws, null);
    const ipc = await import("../ipc/commands");
    const saved = vi.mocked(ipc.saveWorkspace).mock.calls[0]?.[0] as RustWorkspace;
    expect(saved).toBeDefined();
    expect(saved.icon).toBe("bi-rocket-takeoff-fill");
  });

  it("persist_writes_null_icon_when_unset", async () => {
    const ws = plant("ws-icon-5");
    await persistWorkspaceImpl(ws, null);
    const ipc = await import("../ipc/commands");
    const saved = vi.mocked(ipc.saveWorkspace).mock.calls[0]?.[0] as RustWorkspace;
    expect(saved.icon).toBeNull();
  });

  function rustRecord(extra: Partial<RustWorkspace> = {}): RustWorkspace {
    return {
      id: "ws-icon-r",
      name: "Restored",
      root_path: "/tmp/restored",
      layout: { type: "Leaf", pane_id: "p1" },
      panes: [
        {
          id: "p1",
          pane_type: { Terminal: { shell: "/bin/zsh", cwd: "/tmp/restored" } },
          title: "Terminal 1",
          file_paths: [],
          active_file_path: null,
        },
      ],
      terminal_ids: [],
      open_file_paths: [],
      active_file_path: null,
      active_pane_id: "p1",
      explorer_visible: true,
      ...extra,
    } as RustWorkspace;
  }

  it("restore_reads_icon_from_rust_record", async () => {
    const { ws } = await restoreWorkspaceImpl(rustRecord({ icon: "bi-bug-fill" }), 0, () => 1);
    expect(ws.icon).toBe("bi-bug-fill");
  });

  it("restore_tolerates_missing_icon_from_older_files", async () => {
    const { ws } = await restoreWorkspaceImpl(rustRecord(), 0, () => 1);
    expect(ws.icon).toBeNull();
  });
});
