/**
 * The window's half of the MCP bridge. Rust serves the MCP endpoint and answers
 * most tools from its own state; the one thing it cannot do is change the
 * workspace layout, so `spawn_agent` arrives here as an `mcp:request` event and
 * is answered with `mcp_resolve`. Rust addresses the event to a single window.
 */
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { mcpResolve } from "../ipc/commands";
import { spawnAgent, type SpawnAgentRequest } from "../agents/spawn-agent";
import { pushToast } from "../stores/toasts.svelte";
import { workCounters } from "../utils/jank-monitor";
import { refreshInbox } from "../stores/inbox.svelte";
import { log } from "../utils/log";

interface McpRequest {
  request_id: string;
  /** Label of the window Rust chose to handle this request. */
  window?: string;
  kind: string;
  target?: "new_terminal" | "new_workspace";
  path?: string | null;
  agent?: "claude" | "codex";
  command?: string;
  caller_terminal_id?: number | null;
}

export async function handleMcpRequest(req: McpRequest): Promise<void> {
  workCounters.mcpRequests++;
  try {
    if (req.kind !== "spawn_agent" || !req.command) throw new Error(`unsupported request: ${req.kind}`);
    const spawn: SpawnAgentRequest = {
      target: req.target === "new_workspace" ? "new_workspace" : "new_terminal",
      path: req.path ?? null,
      agent: req.agent === "codex" ? "codex" : "claude",
      command: req.command,
      callerTerminalId: req.caller_terminal_id ?? null,
    };
    const result = await spawnAgent(spawn);
    // Delegation is never silent: say what was started and by whom.
    const who = spawn.callerTerminalId != null ? `the agent in terminal ${spawn.callerTerminalId}` : "an agent";
    pushToast(`${spawn.agent === "codex" ? "Codex" : "Claude"} started in “${result.workspace}” by ${who}`, "info");
    await mcpResolve(req.request_id, true, result);
  } catch (e) {
    log.warn("mcp request failed:", e);
    await mcpResolve(req.request_id, false, e instanceof Error ? e.message : String(e)).catch(() => {});
  }
}

/** True when a request is addressed to a different window than `label`. */
export function isForAnotherWindow(req: Pick<McpRequest, "window">, label: string): boolean {
  return req.window != null && req.window !== label;
}

export async function startMcpBridge(): Promise<() => void> {
  // `listen` is global: it also receives events Rust addressed to another window
  // (emit_to). Each request names its target, and only that window acts on it.
  const label = getCurrentWindow().label;
  const unlistenRequest = await listen<McpRequest>("mcp:request", ({ payload }) => {
    if (isForAnotherWindow(payload, label)) return;
    void handleMcpRequest(payload);
  });
  const unlistenInbox = await listen<number>("inbox:changed", () => { void refreshInbox(); });
  void refreshInbox();
  return () => { unlistenRequest(); unlistenInbox(); };
}
