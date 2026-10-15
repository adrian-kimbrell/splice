import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Core workspace-manager behaviour that had no direct coverage: creating,
// switching, closing and reordering workspaces, and the UI-state handoff that
// happens on switch. File/tab/session delegates have their own suites.

vi.mock("../ipc/commands", () => ({
  saveWorkspace: vi.fn().mockResolvedValue(undefined),
  setActiveWorkspaceId: vi.fn().mockResolvedValue(undefined),
  reorderWorkspaces: vi.fn().mockResolvedValue(undefined),
  getTerminalCwd: vi.fn().mockResolvedValue(null),
  closeWorkspace: vi.fn().mockResolvedValue([]),
  deleteWorkspace: vi.fn().mockResolvedValue(undefined),
  killTerminal: vi.fn().mockResolvedValue(undefined),
  unwatchPath: vi.fn().mockResolvedValue(undefined),
  sshDisconnect: vi.fn().mockResolvedValue(undefined),
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
import { ui } from "./ui.svelte";
import type { Workspace } from "./workspace-types";

type Mgr = {
  workspaces: Record<string, Workspace>;
  activeWorkspaceId: string | null;
  persistTimers: Record<string, ReturnType<typeof setTimeout>>;
};
const mgr = workspaceManager as unknown as Mgr;

function wipe() {
  for (const k of Object.keys(mgr.persistTimers)) {
    clearTimeout(mgr.persistTimers[k]);
    delete mgr.persistTimers[k];
  }
  for (const k of Object.keys(mgr.workspaces)) delete mgr.workspaces[k];
  mgr.activeWorkspaceId = null;
}

async function flushMicrotasks() {
  // dynamic import() + .then chains in the store need a couple of ticks
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("workspace manager core", () => {
  beforeEach(async () => {
    wipe();
    const ipc = await import("../ipc/commands");
    for (const fn of Object.values(ipc)) if (typeof fn === "function" && "mockClear" in fn) (fn as ReturnType<typeof vi.fn>).mockClear();
  });
  afterEach(() => wipe());

  it("createEmptyWorkspace_becomes_active_and_hides_explorer", () => {
    ui.explorerVisible = true;
    const ws = workspaceManager.createEmptyWorkspace("Scratch");
    expect(ws.name).toBe("Scratch");
    expect(ws.rootPath).toBe("");
    expect(ws.layout).toBeNull();
    expect(mgr.activeWorkspaceId).toBe(ws.id);
    expect(workspaceManager.activeWorkspace?.id).toBe(ws.id);
    expect(ui.explorerVisible).toBe(false); // empty workspace has nothing to explore
    expect(workspaceManager.workspaceList.map(w => w.id)).toEqual([ws.id]);
  });

  it("createEmptyWorkspace_defaults_name_to_Untitled", () => {
    expect(workspaceManager.createEmptyWorkspace().name).toBe("Untitled");
  });

  it("switchWorkspace_saves_and_restores_explorer_state_per_workspace", async () => {
    const a = workspaceManager.createEmptyWorkspace("A");
    const b = workspaceManager.createEmptyWorkspace("B");
    // Active is B. Simulate the user opening the explorer wide in B.
    ui.explorerVisible = true;
    ui.explorerWidth = 333;
    a.explorerVisible = false;
    a.explorerWidth = 200;

    workspaceManager.switchWorkspace(a.id);
    expect(mgr.activeWorkspaceId).toBe(a.id);
    expect(ui.explorerVisible).toBe(false);
    expect(ui.explorerWidth).toBe(200);
    // B remembered what the user had
    expect(b.explorerVisible).toBe(true);
    expect(b.explorerWidth).toBe(333);

    await flushMicrotasks();
    const ipc = await import("../ipc/commands");
    expect(vi.mocked(ipc.setActiveWorkspaceId)).toHaveBeenCalledWith(a.id);
  });

  it("switchWorkspace_ignores_unknown_ids", () => {
    const a = workspaceManager.createEmptyWorkspace("A");
    workspaceManager.switchWorkspace("nope");
    expect(mgr.activeWorkspaceId).toBe(a.id);
  });

  it("closeWorkspace_removes_and_falls_back_to_another_active", () => {
    const a = workspaceManager.createEmptyWorkspace("A");
    const b = workspaceManager.createEmptyWorkspace("B");
    workspaceManager.closeWorkspace(b.id); // b is active
    expect(mgr.workspaces[b.id]).toBeUndefined();
    expect(mgr.activeWorkspaceId).toBe(a.id);
    workspaceManager.closeWorkspace(a.id);
    expect(mgr.activeWorkspaceId).toBeNull();
    expect(workspaceManager.workspaceList).toEqual([]);
  });

  it("closeWorkspace_keeps_active_when_closing_an_inactive_one", () => {
    const a = workspaceManager.createEmptyWorkspace("A");
    workspaceManager.createEmptyWorkspace("B");
    workspaceManager.closeWorkspace(a.id);
    expect(mgr.activeWorkspaceId).not.toBe(a.id);
    expect(mgr.activeWorkspaceId).not.toBeNull();
  });

  it("closeWorkspace_cancels_a_pending_persist_timer", () => {
    const a = workspaceManager.createEmptyWorkspace("A");
    workspaceManager.debouncedPersistWorkspace(a.id);
    expect(mgr.persistTimers[a.id]).toBeDefined();
    workspaceManager.closeWorkspace(a.id);
    expect(mgr.persistTimers[a.id]).toBeUndefined();
  });

  it("closeWorkspaceWithCleanup_calls_backend_then_removes", async () => {
    const a = workspaceManager.createEmptyWorkspace("A");
    await workspaceManager.closeWorkspaceWithCleanup(a.id);
    const ipc = await import("../ipc/commands");
    expect(vi.mocked(ipc.closeWorkspace)).toHaveBeenCalledWith(a.id);
    expect(mgr.workspaces[a.id]).toBeUndefined();
  });

  it("closeWorkspaceWithCleanup_falls_back_to_delete_when_backend_close_fails", async () => {
    const ipc = await import("../ipc/commands");
    vi.mocked(ipc.closeWorkspace).mockRejectedValueOnce(new Error("ipc down"));
    const a = workspaceManager.createEmptyWorkspace("A");
    a.terminalIds.push(41);
    await workspaceManager.closeWorkspaceWithCleanup(a.id);
    expect(vi.mocked(ipc.killTerminal)).toHaveBeenCalledWith(41);
    expect(vi.mocked(ipc.deleteWorkspace)).toHaveBeenCalledWith(a.id);
    expect(mgr.workspaces[a.id]).toBeUndefined();
  });

  it("reorderWorkspace_moves_and_persists_the_new_order", async () => {
    const a = workspaceManager.createEmptyWorkspace("A");
    const b = workspaceManager.createEmptyWorkspace("B");
    const c = workspaceManager.createEmptyWorkspace("C");
    workspaceManager.reorderWorkspace(c.id, 0);
    expect(Object.keys(mgr.workspaces)).toEqual([c.id, a.id, b.id]);
    await flushMicrotasks();
    const ipc = await import("../ipc/commands");
    expect(vi.mocked(ipc.reorderWorkspaces)).toHaveBeenCalledWith([c.id, a.id, b.id]);
  });

  it("reorderWorkspace_noop_for_same_index_or_unknown_id", async () => {
    const a = workspaceManager.createEmptyWorkspace("A");
    const b = workspaceManager.createEmptyWorkspace("B");
    workspaceManager.reorderWorkspace(a.id, 0);
    workspaceManager.reorderWorkspace("ghost", 1);
    expect(Object.keys(mgr.workspaces)).toEqual([a.id, b.id]);
    await flushMicrotasks();
    const ipc = await import("../ipc/commands");
    expect(vi.mocked(ipc.reorderWorkspaces)).not.toHaveBeenCalled();
  });

  it("getActiveFilePath_reads_from_the_active_editor_pane", () => {
    const a = workspaceManager.createEmptyWorkspace("A");
    expect(workspaceManager.getActiveFilePath()).toBeNull();
    a.panes["ed"] = { id: "ed", kind: "editor", title: "x", filePaths: ["/f.ts"], activeFilePath: "/f.ts" };
    a.activePaneId = "ed";
    expect(workspaceManager.getActiveFilePath()).toBe("/f.ts");
    a.panes["t"] = { id: "t", kind: "terminal", title: "T", terminalId: 1 };
    a.activePaneId = "t";
    expect(workspaceManager.getActiveFilePath()).toBeNull();
  });
});
