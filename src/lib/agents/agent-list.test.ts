import { describe, it, expect } from "vitest";
import { agentState, terminalIdsOf, buildAgentGroups, waitingCount, shortAge } from "./agent-list";
import type { PaneConfig } from "../stores/layout.svelte";

const term = (id: number, over: Partial<PaneConfig> = {}): PaneConfig =>
  ({ id: `term-${id}`, kind: "terminal", title: `T${id}`, terminalId: id, claudeSessionId: `s${id}`, ...over }) as PaneConfig;
const ws = (id: string, panes: PaneConfig[]) => ({ id, name: id.toUpperCase(), panes: Object.fromEntries(panes.map((p) => [p.id, p])) });
const act = (id: number, program_running: boolean | null, quiet_ms: number | null, agent: "claude" | "codex" | null = null) =>
  ({ id, program_running, quiet_ms, agent });
const note = (terminalId: number, type: "permission" | "idle") => ({ terminalId, type, message: "m", timestamp: 1000 });

describe("agent list", () => {
  it("derives the state from the notification first, then from terminal activity", () => {
    expect(agentState(note(1, "permission"), act(1, true, 0))).toBe("permission");
    expect(agentState(note(1, "idle"), act(1, false, 0))).toBe("done");
    expect(agentState(undefined, act(1, false, 100))).toBe("exited");
    expect(agentState(undefined, act(1, true, 500))).toBe("working");
    expect(agentState(undefined, act(1, true, 60_000))).toBe("idle");
    expect(agentState(undefined, act(1, null, null))).toBe("idle");
    expect(agentState(undefined, undefined)).toBe("idle");
  });

  it("lists only terminals with an agent session, grouped by workspace, most urgent first", () => {
    const workspaces = [
      ws("a", [term(1), term(2), term(3, { claudeSessionId: null }), { id: "ed", kind: "editor", title: "x" } as PaneConfig]),
      ws("b", [term(4, { claudeSessionId: null })]),
      ws("c", [term(5, { agentKind: "codex" })]),
    ];
    expect(terminalIdsOf(workspaces)).toEqual([1, 2, 3, 4, 5]);
    const groups = buildAgentGroups(
      workspaces,
      { 2: note(2, "permission") },
      { 1: { terminalId: 1, model: "Fable", contextPct: 40, updatedAt: 0 } },
      { 1: act(1, true, 100), 5: act(5, false, null) },
    );
    expect(groups.map((g) => g.workspaceName)).toEqual(["A", "C"]);
    expect(groups[0].rows.map((r) => [r.terminalId, r.state])).toEqual([[2, "permission"], [1, "working"]]);
    expect(groups[0].rows[1]).toMatchObject({ model: "Fable", contextPct: 40, kind: "claude", paneId: "term-1" });
    expect(groups[0].rows[0].since).toBe(1000);
    expect(groups[1].rows[0]).toMatchObject({ kind: "codex", state: "exited" });
    expect(waitingCount(groups)).toBe(1);
  });

  it("lists an agent seen running even when no hook reported a session, and trusts the process for its kind", () => {
    const workspaces = [ws("a", [term(1, { claudeSessionId: null }), term(2, { agentKind: "claude" }), term(3, { claudeSessionId: null })])];
    const groups = buildAgentGroups(workspaces, {}, {}, { 1: act(1, true, 200, "codex"), 2: act(2, true, 9000, "codex"), 3: act(3, true, 100) });
    expect(groups[0].rows.map((r) => [r.terminalId, r.kind, r.state])).toEqual([[1, "codex", "working"], [2, "codex", "idle"]]);
  });

  it("formats ages compactly", () => {
    const now = 10 * 86_400_000;
    expect(shortAge(now - 5_000, now)).toBe("just now");
    expect(shortAge(now - 4 * 60_000, now)).toBe("4m");
    expect(shortAge(now - 2 * 3_600_000, now)).toBe("2h");
    expect(shortAge(now - 3 * 86_400_000, now)).toBe("3d");
  });
});
