import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Locks in the regression where last-second changes (within the 500ms debounce
// window) were lost when the user quit Splice. flushPersistTimers must
// synchronously drain pending timers and await their persists to disk.

vi.mock("../ipc/commands", () => ({
  saveWorkspace: vi.fn().mockResolvedValue(undefined),
  setActiveWorkspaceId: vi.fn().mockResolvedValue(undefined),
  getTerminalCwd: vi.fn().mockResolvedValue(null),
}));
vi.mock("./settings.svelte", () => ({
  settings: {
    terminal: { default_shell: "/bin/zsh" },
    general: { restore_previous_session: true },
    appearance: {},
  },
}));

import { workspaceManager } from "./workspace.svelte";

describe("flushPersistTimers", () => {
  let mgr: { persistTimers: Record<string, ReturnType<typeof setTimeout>> };
  let savedTimers: Record<string, ReturnType<typeof setTimeout>>;

  beforeEach(async () => {
    // persistWorkspaceImpl no-ops outside Tauri. Set the marker so the test
    // exercises the real save path.
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    mgr = workspaceManager as unknown as typeof mgr;
    // Snapshot any timers other tests left behind
    savedTimers = { ...mgr.persistTimers };
    for (const k of Object.keys(mgr.persistTimers)) {
      clearTimeout(mgr.persistTimers[k]);
      delete mgr.persistTimers[k];
    }

    // Reset save mock between tests
    const ipc = await import("../ipc/commands");
    vi.mocked(ipc.saveWorkspace).mockClear();
    vi.mocked(ipc.saveWorkspace).mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Restore prior timers (don't pollute other tests)
    for (const k of Object.keys(mgr.persistTimers)) {
      clearTimeout(mgr.persistTimers[k]);
      delete mgr.persistTimers[k];
    }
    Object.assign(mgr.persistTimers, savedTimers);
    delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("drains_pending_timer_and_awaits_save", async () => {
    // Plant a workspace + a pending debounce timer that wouldn't fire for 10s.
    (workspaceManager as unknown as { workspaces: Record<string, unknown> }).workspaces["ws-flush-1"] = {
      id: "ws-flush-1",
      name: "Flush Test",
      rootPath: "/tmp",
      fileTree: [],
      openFiles: [],
      openFileIndex: {},
      terminalIds: [],
      activeTerminalId: null,
      // persistWorkspaceImpl returns early on `if (!ws.layout)`, so a minimal
      // layout is required to reach the saveWorkspace call.
      layout: { type: "leaf", paneId: "ghost" },
      panes: {},
      activePaneId: null,
      gitBranch: "",
      explorerVisible: true,
      expandedPaths: new Set<string>(),
      sshConfig: null,
    };
    mgr.persistTimers["ws-flush-1"] = setTimeout(() => {}, 10_000);

    const ipc = await import("../ipc/commands");
    const saveSpy = vi.mocked(ipc.saveWorkspace);
    expect(saveSpy).not.toHaveBeenCalled();

    await (workspaceManager as unknown as { flushPersistTimers: () => Promise<void> }).flushPersistTimers();

    // Pending timer is gone (cleared, not waited out)
    expect(mgr.persistTimers["ws-flush-1"]).toBeUndefined();
    // Save fired immediately, before the original 10s would have elapsed
    expect(saveSpy).toHaveBeenCalledTimes(1);

    // Cleanup planted workspace
    delete (workspaceManager as unknown as { workspaces: Record<string, unknown> }).workspaces["ws-flush-1"];
  });

  it("noop_when_no_pending_timers", async () => {
    // No timers planted — flush should resolve cleanly with no save calls.
    const ipc = await import("../ipc/commands");
    const saveSpy = vi.mocked(ipc.saveWorkspace);

    await (workspaceManager as unknown as { flushPersistTimers: () => Promise<void> }).flushPersistTimers();

    expect(saveSpy).not.toHaveBeenCalled();
  });
});
