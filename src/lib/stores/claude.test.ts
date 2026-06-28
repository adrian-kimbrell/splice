import { describe, it, expect, beforeEach } from "vitest";
import { claudeStore, toolLabel, statusFromPayload } from "./claude.svelte";

beforeEach(() => {
  // Clear any state left by other tests.
  for (const id of Object.keys(claudeStore.activity)) claudeStore.clear(Number(id));
  for (const id of Object.keys(claudeStore.status)) claudeStore.clear(Number(id));
  for (const id of Object.keys(claudeStore.permissions)) claudeStore.removePermission(id);
});

// ---------------------------------------------------------------------------
// toolLabel
// ---------------------------------------------------------------------------

describe("toolLabel", () => {
  it("uses the basename for file tools", () => {
    expect(toolLabel("Edit", "/a/b/grid.rs")).toBe("Editing grid.rs");
    expect(toolLabel("Write", "/x/y/new.ts")).toBe("Writing new.ts");
    expect(toolLabel("Read", "/x/y/old.ts")).toBe("Reading old.ts");
  });

  it("uses the first token of a Bash command", () => {
    expect(toolLabel("Bash", null, "cargo test --lib")).toBe("Ran cargo");
  });

  it("falls back to a generic label for unknown tools", () => {
    expect(toolLabel("Bash")).toBe("Ran command");
    expect(toolLabel("Mystery")).toBe("Mystery");
    expect(toolLabel("")).toBe("Working");
  });
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
// activity transitions
// ---------------------------------------------------------------------------

describe("activity", () => {
  it("recordTool flips a session to working with a current label", () => {
    claudeStore.recordTool(1, "Edit", "/a/grid.rs");
    expect(claudeStore.activity[1].state).toBe("working");
    expect(claudeStore.activity[1].current).toBe("Editing grid.rs");
    expect(claudeStore.activity[1].recent[0].tool).toBe("Edit");
  });

  it("keeps the feed newest-first and capped", () => {
    for (let i = 0; i < 25; i++) claudeStore.recordTool(1, "Bash", null, `cmd${i}`);
    expect(claudeStore.activity[1].recent.length).toBe(20);
    expect(claudeStore.activity[1].recent[0].label).toBe("Ran cmd24");
  });

  it("markIdle clears current but preserves history", () => {
    claudeStore.recordTool(1, "Edit", "/a/grid.rs");
    claudeStore.markIdle(1);
    expect(claudeStore.activity[1].state).toBe("idle");
    expect(claudeStore.activity[1].current).toBeUndefined();
    expect(claudeStore.activity[1].recent.length).toBe(1);
  });

  it("clear drops both status and activity for a terminal", () => {
    claudeStore.recordTool(1, "Edit", "/a/grid.rs");
    claudeStore.setStatus({ terminalId: 1, updatedAt: 0 });
    claudeStore.clear(1);
    expect(claudeStore.activity[1]).toBeUndefined();
    expect(claudeStore.status[1]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// permission requests
// ---------------------------------------------------------------------------

describe("permissions", () => {
  const req = (id: string, terminalId = 1) => ({
    id,
    terminalId,
    toolName: "Bash",
    command: "rm -rf build/",
    at: Number(id.replace(/\D/g, "")) || 0,
  });

  it("adds and lists permission requests oldest-first", () => {
    claudeStore.addPermission(req("perm-2"));
    claudeStore.addPermission(req("perm-1"));
    expect(claudeStore.permissionList.map((p) => p.id)).toEqual(["perm-1", "perm-2"]);
  });

  it("removePermission drops a single request", () => {
    claudeStore.addPermission(req("perm-1"));
    claudeStore.removePermission("perm-1");
    expect(claudeStore.permissions["perm-1"]).toBeUndefined();
  });

  it("clear(terminalId) drops only that terminal's pending prompts", () => {
    claudeStore.addPermission(req("perm-1", 1));
    claudeStore.addPermission(req("perm-2", 2));
    claudeStore.clear(1);
    expect(claudeStore.permissions["perm-1"]).toBeUndefined();
    expect(claudeStore.permissions["perm-2"]).toBeDefined();
  });
});
