import { describe, it, expect, vi, beforeEach } from "vitest";

// The window's half of spawn_agent: every request is answered exactly once,
// success or failure, so the HTTP caller never waits for the timeout.

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("../ipc/commands", () => ({ mcpResolve: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../agents/spawn-agent", () => ({ spawnAgent: vi.fn() }));
vi.mock("../stores/toasts.svelte", () => ({ pushToast: vi.fn() }));
vi.mock("../stores/inbox.svelte", () => ({ refreshInbox: vi.fn().mockResolvedValue(undefined) }));

import { handleMcpRequest, startMcpBridge, isForAnotherWindow } from "./mcp-bridge";
import { mcpResolve } from "../ipc/commands";
import { spawnAgent } from "../agents/spawn-agent";
import { pushToast } from "../stores/toasts.svelte";
import { refreshInbox } from "../stores/inbox.svelte";
import { listen } from "@tauri-apps/api/event";
import { workCounters } from "../utils/jank-monitor";

beforeEach(() => vi.clearAllMocks());

describe("handleMcpRequest", () => {
  it("spawns, announces the delegation, and resolves with the result", async () => {
    const result = { terminal_id: 5, pane_id: "term-5", workspace_id: "w", workspace: "proj" };
    (spawnAgent as ReturnType<typeof vi.fn>).mockResolvedValue(result);
    const before = workCounters.mcpRequests;
    await handleMcpRequest({ request_id: "r1", kind: "spawn_agent", target: "new_workspace", path: "/p", agent: "codex", command: "codex X", caller_terminal_id: 2 });
    expect(spawnAgent).toHaveBeenCalledWith({ target: "new_workspace", path: "/p", agent: "codex", command: "codex X", callerTerminalId: 2 });
    expect(pushToast).toHaveBeenCalledWith(expect.stringContaining("terminal 2"), "info");
    expect(mcpResolve).toHaveBeenCalledTimes(1);
    expect(mcpResolve).toHaveBeenCalledWith("r1", true, result);
    expect(workCounters.mcpRequests).toBe(before + 1);
  });

  it("resolves with the error message when the spawn fails", async () => {
    (spawnAgent as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no workspace is open"));
    await handleMcpRequest({ request_id: "r2", kind: "spawn_agent", command: "claude X" });
    expect(mcpResolve).toHaveBeenCalledWith("r2", false, "no workspace is open");
    expect(pushToast).not.toHaveBeenCalled();
  });

  it("rejects kinds it does not know and requests without a command", async () => {
    await handleMcpRequest({ request_id: "r3", kind: "format_disk", command: "x" });
    await handleMcpRequest({ request_id: "r4", kind: "spawn_agent" });
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(mcpResolve).toHaveBeenNthCalledWith(1, "r3", false, expect.stringContaining("unsupported"));
    expect(mcpResolve).toHaveBeenNthCalledWith(2, "r4", false, expect.stringContaining("unsupported"));
  });
});

describe("window targeting", () => {
  it("a request addressed to another window is ignored; an unaddressed one is handled", () => {
    expect(isForAnotherWindow({ window: "window-2" }, "main")).toBe(true);
    expect(isForAnotherWindow({ window: "main" }, "main")).toBe(false);
    expect(isForAnotherWindow({}, "main")).toBe(false);
  });

  it("the listener drops requests for other windows before doing any work", async () => {
    await startMcpBridge();
    const handler = (listen as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "mcp:request")![1];
    handler({ payload: { request_id: "x", kind: "spawn_agent", command: "c", window: "window-2" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(mcpResolve).not.toHaveBeenCalled();
  });
});

describe("startMcpBridge", () => {
  it("listens for requests and inbox changes and loads the inbox once", async () => {
    await startMcpBridge();
    const events = (listen as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(events).toEqual(["mcp:request", "inbox:changed"]);
    expect(refreshInbox).toHaveBeenCalledTimes(1);
  });
});
