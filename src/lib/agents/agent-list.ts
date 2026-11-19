/**
 * The Agents panel's model: every terminal in every workspace that hosts an agent
 * session, with what it is doing right now. Pure; the panel supplies the stores.
 */
import type { AgentKind, PaneConfig } from "../stores/layout.svelte";
import type { AttentionNotification } from "../stores/attention.svelte";
import type { ClaudeStatus } from "../stores/claude.svelte";
import type { TerminalActivity } from "../ipc/commands";

/** Most urgent first; also the sort order inside a workspace. */
export const AGENT_STATES = ["permission", "done", "working", "idle", "exited"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** A terminal that printed within this window counts as working (agents animate while busy). */
export const WORKING_WINDOW_MS = 3000;

export interface AgentRow {
  terminalId: number;
  paneId: string;
  workspaceId: string;
  title: string;
  kind: AgentKind;
  state: AgentState;
  model?: string;
  contextPct?: number;
  /** When the agent started waiting (permission / done), Unix ms. */
  since?: number;
  message?: string;
}

export interface AgentGroup {
  workspaceId: string;
  workspaceName: string;
  rows: AgentRow[];
}

interface WorkspaceLike {
  id: string;
  name: string;
  panes: Record<string, PaneConfig>;
}

export function agentState(notification: AttentionNotification | undefined, activity: TerminalActivity | undefined): AgentState {
  if (notification) return notification.type === "permission" ? "permission" : "done";
  if (activity?.program_running === false) return "exited";
  if (activity?.quiet_ms != null && activity.quiet_ms < WORKING_WINDOW_MS) return "working";
  return "idle";
}

/** Every terminal id: an agent can start in any of them, with or without a hook reporting it. */
export function terminalIdsOf(workspaces: WorkspaceLike[]): number[] {
  const ids: number[] = [];
  for (const ws of workspaces) {
    for (const pane of Object.values(ws.panes)) {
      if (pane.kind === "terminal" && pane.terminalId != null) ids.push(pane.terminalId);
    }
  }
  return ids;
}

export function buildAgentGroups(
  workspaces: WorkspaceLike[],
  notifications: Record<number, AttentionNotification>,
  statuses: Record<number, ClaudeStatus>,
  activity: Record<number, TerminalActivity>,
): AgentGroup[] {
  const groups: AgentGroup[] = [];
  for (const ws of workspaces) {
    const rows: AgentRow[] = [];
    for (const [paneId, pane] of Object.entries(ws.panes)) {
      if (pane.kind !== "terminal" || pane.terminalId == null) continue;
      const id = pane.terminalId;
      // An agent is either running right now (seen in the process list) or reported
      // a session earlier through its hooks.
      const running = activity[id]?.agent ?? null;
      if (!running && !pane.claudeSessionId) continue;
      const notification = notifications[id];
      rows.push({
        terminalId: id,
        paneId,
        workspaceId: ws.id,
        title: pane.title,
        kind: running ?? pane.agentKind ?? "claude",
        state: agentState(notification, activity[id]),
        model: statuses[id]?.model,
        contextPct: statuses[id]?.contextPct,
        since: notification?.timestamp,
        message: notification?.message || undefined,
      });
    }
    if (rows.length === 0) continue;
    rows.sort((a, b) => AGENT_STATES.indexOf(a.state) - AGENT_STATES.indexOf(b.state) || a.terminalId - b.terminalId);
    groups.push({ workspaceId: ws.id, workspaceName: ws.name, rows });
  }
  return groups;
}

/** How many agents are waiting on the user. */
export function waitingCount(groups: AgentGroup[]): number {
  return groups.reduce((n, g) => n + g.rows.filter((r) => r.state === "permission" || r.state === "done").length, 0);
}

export const STATE_LABEL: Record<AgentState, string> = {
  permission: "Needs permission",
  done: "Finished",
  working: "Working",
  idle: "Idle",
  exited: "Not running",
};

/** "just now", "4m", "2h", "3d" */
export function shortAge(since: number, now: number): string {
  const mins = Math.max(0, Math.floor((now - since) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
