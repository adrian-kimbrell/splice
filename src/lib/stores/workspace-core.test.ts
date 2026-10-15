import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

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
  addAllowedRoot: vi.fn().mockResolvedValue(undefined),
  watchPath: vi.fn().mockResolvedValue(undefined),
  readDirTree: vi.fn().mockResolvedValue([]),
  getGitBranch: vi.fn().mockResolvedValue(""),
  gitStatus: vi.fn().mockResolvedValue({ repo_root: "", files: [] }),
  spawnTerminal: vi.fn().mockResolvedValue(1),
  readFile: vi.fn().mockResolvedValue(""),
  checkPidAlive: vi.fn().mockResolvedValue(false),
  writeToTerminal: vi.fn().mockResolvedValue(undefined),
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
import { applyFileRename, type Workspace } from "./workspace-types";
import type { RustWorkspace } from "../ipc/commands";

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

  // --- restore registers the root before touching the filesystem -------------
  // Roots loaded from disk are unknown to the Rust side until a save; for a root
  // outside HOME the watch was refused and never retried, so the explorer never
  // followed external changes after a relaunch.

  it("restoreWorkspace_grants_root_access_before_watching_and_reading_the_tree", async () => {
    const ipc = await import("../ipc/commands");
    const rws = {
      id: "r1", name: "proj", root_path: "/Volumes/ext/proj",
      layout: { type: "Leaf", pane_id: "p1" }, panes: [], terminal_ids: [],
      open_file_paths: [], active_file_path: null, active_pane_id: null,
      explorer_visible: true, expanded_paths: [], ssh_config: null,
    } as unknown as RustWorkspace;

    await workspaceManager.restoreWorkspace(rws);
    await new Promise(r => setTimeout(r, 20)); // let the import().then/finally chain settle

    expect(ipc.addAllowedRoot).toHaveBeenCalledWith("/Volumes/ext/proj");
    expect(ipc.watchPath).toHaveBeenCalledWith("/Volumes/ext/proj");
    expect(ipc.readDirTree).toHaveBeenCalledWith("/Volumes/ext/proj");
    const order = (fn: unknown) => (fn as Mock).mock.invocationCallOrder[0];
    expect(order(ipc.addAllowedRoot)).toBeLessThan(order(ipc.watchPath));
    expect(order(ipc.addAllowedRoot)).toBeLessThan(order(ipc.readDirTree));
  });

  // --- openFiles / openFileIndex must be the SAME $state proxy ---------------
  // Pushing a raw object into a $state array and assigning the same raw object
  // into a $state record yields two independent proxies; a `dirty` write via
  // the index was invisible via the list (Save All / close-confirm saw nothing).

  it("openFile_list_and_index_share_one_proxy", () => {
    const ws = workspaceManager.createEmptyWorkspace("p");
    workspaceManager.openFileInWorkspace({ name: "a.ts", path: "/a.ts", content: "x" });
    const live = mgr.workspaces[ws.id];
    expect(live.openFileIndex["/a.ts"]).toBe(live.openFiles[0]);
  });

  it("dirty_flag_set_via_index_is_visible_via_list", () => {
    const ws = workspaceManager.createEmptyWorkspace("p");
    workspaceManager.openFileInWorkspace({ name: "a.ts", path: "/a.ts", content: "x" });
    workspaceManager.updateFileContent("/a.ts", "changed");
    const live = mgr.workspaces[ws.id];
    expect(live.openFileIndex["/a.ts"].dirty).toBe(true);
    expect(live.openFiles[0].dirty).toBe(true);
    expect(live.openFiles.some(f => f.dirty)).toBe(true); // what Save All / close-confirm check
  });

  it("rename_via_index_updates_list_entry", () => {
    const ws = workspaceManager.createEmptyWorkspace("p");
    workspaceManager.newUntitledFile();
    const live = mgr.workspaces[ws.id];
    const untitled = live.openFiles[0].path;
    applyFileRename(live, live.openFileIndex[untitled], untitled, "/saved.ts");
    expect(live.openFiles).toHaveLength(1);
    expect(live.openFiles[0].path).toBe("/saved.ts");
    expect(live.openFiles[0].name).toBe("saved.ts");
    expect(live.openFileIndex["/saved.ts"]).toBe(live.openFiles[0]);
  });
});
