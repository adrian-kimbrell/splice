import { describe, it, expect, beforeEach } from "vitest";
import { claudeStore, statusFromPayload } from "./claude.svelte";

beforeEach(() => {
  for (const id of Object.keys(claudeStore.status)) claudeStore.clear(Number(id));
});

// ---------------------------------------------------------------------------
// statusFromPayload
// ---------------------------------------------------------------------------

describe("statusFromPayload", () => {
  it("flattens Claude's statusLine JSON", () => {
    const s = statusFromPayload({
      terminal_id: 3,
      model: { display_name: "Opus 4.8" },
      context_window: { used_percentage: 62 },
      cost: { total_cost_usd: 0.18 },
      rate_limits: { five_hour: { used_percentage: 34 }, seven_day: { used_percentage: 12 } },
    });
    expect(s).toMatchObject({
      terminalId: 3,
      model: "Opus 4.8",
      contextPct: 62,
      costUsd: 0.18,
      rateLimit5h: 34,
      rateLimit7d: 12,
    });
  });

  it("returns null without a positive terminal_id", () => {
    expect(statusFromPayload({ terminal_id: 0 })).toBeNull();
    expect(statusFromPayload({})).toBeNull();
  });

  it("tolerates missing fields", () => {
    const s = statusFromPayload({ terminal_id: 1 });
    expect(s?.contextPct).toBeUndefined();
    expect(s?.costUsd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

describe("claudeStore", () => {
  it("setStatus stores keyed by terminalId", () => {
    claudeStore.setStatus({ terminalId: 1, contextPct: 50, updatedAt: 0 });
    expect(claudeStore.status[1].contextPct).toBe(50);
  });

  it("clear drops a terminal's status", () => {
    claudeStore.setStatus({ terminalId: 1, updatedAt: 0 });
    claudeStore.clear(1);
    expect(claudeStore.status[1]).toBeUndefined();
  });
});
