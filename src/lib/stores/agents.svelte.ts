/**
 * Live data for the Agents panel: what each agent terminal is doing, polled from
 * Rust only while something is showing it (`watchAgentActivity`). One IPC call
 * covers every terminal, and nothing runs while the window is hidden.
 */
import { terminalActivity, type TerminalActivity } from "../ipc/commands";
import { workspaceManager } from "./workspace.svelte";
import { terminalIdsOf } from "../agents/agent-list";

export const POLL_MS = 2000;

export const agentActivity = $state({ byTerminal: {} as Record<number, TerminalActivity>, now: Date.now() });

let watchers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

async function refresh(): Promise<void> {
  if (document.hidden) return;
  const ids = terminalIdsOf(workspaceManager.workspaceList);
  agentActivity.now = Date.now();
  if (ids.length === 0) {
    if (Object.keys(agentActivity.byTerminal).length > 0) agentActivity.byTerminal = {};
    return;
  }
  try {
    const rows = await terminalActivity(ids);
    agentActivity.byTerminal = Object.fromEntries(rows.map((r) => [r.id, r]));
  } catch {
    // Keep the last known state; the next tick retries.
  }
}

/** Start polling while the caller is mounted; returns the disposer. */
export function watchAgentActivity(): () => void {
  watchers++;
  if (!timer) {
    void refresh();
    timer = setInterval(() => void refresh(), POLL_MS);
  }
  return () => {
    watchers--;
    if (watchers <= 0 && timer) {
      clearInterval(timer);
      timer = null;
      watchers = 0;
    }
  };
}
