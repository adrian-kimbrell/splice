import { describe, it, expect, vi, beforeEach } from "vitest";

// Where a delegated agent's terminal goes, and that the launch command is typed
// only after the shell is ready.

const manager = vi.hoisted(() => ({
  workspaces: {} as Record<string, { id: string; name: string; rootPath: string; terminalIds: number[]; activeTerminalId: number | null; sshConfig?: unknown }>,
  activeWorkspaceId: null as string | null,
  switchWorkspace: vi.fn(),
  spawnTerminalInWorkspace: vi.fn(),
  createWorkspaceFromDirectory: vi.fn(),
  renamePane: vi.fn(),
}));

vi.mock("../stores/workspace.svelte", () => ({ workspaceManager: manager }));
vi.mock("../stores/workspace-session", () => ({ waitForShellReady: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../ipc/events", () => ({ onTerminalGrid: vi.fn() }));
vi.mock("../ipc/commands", () => ({ writeToTerminal: vi.fn() }));

import { spawnAgent, workspaceIdOfTerminal } from "./spawn-agent";
import { waitForShellReady } from "../stores/workspace-session";

const deps = { writeToTerminal: vi.fn().mockResolvedValue(undefined), subscribeToFrames: vi.fn() };
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  manager.workspaces = {
    a: { id: "a", name: "alpha", rootPath: "/p/alpha", terminalIds: [1, 2], activeTerminalId: 1 },
    b: { id: "b", name: "beta", rootPath: "/p/beta", terminalIds: [3], activeTerminalId: 3 },
  };
  manager.activeWorkspaceId = "b";
  manager.spawnTerminalInWorkspace.mockImplementation(async (wsId: string) => {
    manager.workspaces[wsId]!.terminalIds.push(9);
    return 9;
  });
});

describe("spawnAgent", () => {
  it("new_terminal lands in the caller's workspace, not the active one", async () => {
    const r = await spawnAgent({ target: "new_terminal", agent: "claude", command: "claude X", callerTerminalId: 2 }, deps);
    expect(manager.spawnTerminalInWorkspace).toHaveBeenCalledWith("a");
    expect(r).toEqual({ terminal_id: 9, pane_id: "term-9", workspace_id: "a", workspace: "alpha" });
    expect(manager.renamePane).toHaveBeenCalledWith("term-9", "Claude task", "a");
  });

  it("new_terminal falls back to the active workspace when the caller is unknown", async () => {
    const r = await spawnAgent({ target: "new_terminal", agent: "codex", command: "codex X" }, deps);
    expect(manager.spawnTerminalInWorkspace).toHaveBeenCalledWith("b");
    expect(r.workspace).toBe("beta");
    expect(manager.renamePane).toHaveBeenCalledWith("term-9", "Codex task", "b");
  });

  it("types the command with a carriage return only after the shell is ready", async () => {
    let ready!: () => void;
    (waitForShellReady as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise<void>((r) => { ready = r; }));
    await spawnAgent({ target: "new_terminal", agent: "claude", command: "claude \"$(cat '/h.md')\"" }, deps);
    await flush();
    expect(deps.writeToTerminal).not.toHaveBeenCalled();
    ready();
    await flush();
    expect(deps.writeToTerminal).toHaveBeenCalledTimes(1);
    const [id, bytes] = deps.writeToTerminal.mock.calls[0]!;
    expect(id).toBe(9);
    expect(new TextDecoder().decode(bytes)).toBe("claude \"$(cat '/h.md')\"\r");
  });

  it("new_workspace reuses an open workspace with the same root", async () => {
    const r = await spawnAgent({ target: "new_workspace", path: "/p/alpha", agent: "claude", command: "c" }, deps);
    expect(manager.switchWorkspace).toHaveBeenCalledWith("a");
    expect(manager.createWorkspaceFromDirectory).not.toHaveBeenCalled();
    expect(r.workspace_id).toBe("a");
  });

  it("new_workspace opens the folder and uses its first terminal", async () => {
    manager.createWorkspaceFromDirectory.mockImplementation(async (path: string) => {
      manager.workspaces.c = { id: "c", name: "gamma", rootPath: path, terminalIds: [7], activeTerminalId: 7 };
      return manager.workspaces.c;
    });
    const r = await spawnAgent({ target: "new_workspace", path: "/p/gamma", agent: "claude", command: "c" }, deps);
    expect(manager.spawnTerminalInWorkspace).not.toHaveBeenCalled();
    expect(r).toEqual({ terminal_id: 7, pane_id: "term-7", workspace_id: "c", workspace: "gamma" });
  });

  it("refuses an SSH workspace, where the handoff file does not exist", async () => {
    manager.workspaces.b!.sshConfig = { host: "h" };
    await expect(spawnAgent({ target: "new_terminal", agent: "claude", command: "c" }, deps)).rejects.toThrow(/SSH/);
    expect(manager.spawnTerminalInWorkspace).not.toHaveBeenCalled();
  });

  it("fails clearly with no workspace, a missing path, or no terminal", async () => {
    await expect(spawnAgent({ target: "new_workspace", agent: "claude", command: "c" }, deps)).rejects.toThrow(/path/);
    manager.spawnTerminalInWorkspace.mockResolvedValueOnce(null);
    await expect(spawnAgent({ target: "new_terminal", agent: "claude", command: "c" }, deps)).rejects.toThrow(/terminal/);
    manager.workspaces = {};
    manager.activeWorkspaceId = null;
    await expect(spawnAgent({ target: "new_terminal", agent: "claude", command: "c" }, deps)).rejects.toThrow(/no workspace/);
  });

  it("workspaceIdOfTerminal finds the owner", () => {
    expect(workspaceIdOfTerminal(3)).toBe("b");
    expect(workspaceIdOfTerminal(99)).toBeNull();
  });
});
