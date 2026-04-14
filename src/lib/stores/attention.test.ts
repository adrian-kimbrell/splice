import { describe, it, expect, beforeEach } from "vitest";
import { attentionStore } from "./attention.svelte";
import type { AttentionNotification } from "./attention.svelte";

function makeNote(terminalId: number, type: "permission" | "idle" = "idle"): AttentionNotification {
  return { terminalId, type, message: `msg-${terminalId}`, timestamp: Date.now() };
}

beforeEach(() => {
  attentionStore.clearAll();
});

// ---------------------------------------------------------------------------
// notify
// ---------------------------------------------------------------------------

describe("notify", () => {
  it("adds a notification", () => {
    attentionStore.notify(makeNote(1));
    expect(attentionStore.count).toBe(1);
  });

  it("overwrites existing notification for same terminalId", () => {
    attentionStore.notify(makeNote(1, "idle"));
    attentionStore.notify({ terminalId: 1, type: "permission", message: "updated", timestamp: 0 });
    expect(attentionStore.count).toBe(1);
    expect(attentionStore.notifications[1].type).toBe("permission");
    expect(attentionStore.notifications[1].message).toBe("updated");
  });

  it("stores multiple notifications for different terminals", () => {
    attentionStore.notify(makeNote(1));
    attentionStore.notify(makeNote(2));
    attentionStore.notify(makeNote(3));
    expect(attentionStore.count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

describe("clear", () => {
  it("removes the notification for the given terminalId", () => {
    attentionStore.notify(makeNote(1));
    attentionStore.notify(makeNote(2));
    attentionStore.clear(1);
    expect(attentionStore.notifications[1]).toBeUndefined();
    expect(attentionStore.notifications[2]).toBeDefined();
    expect(attentionStore.count).toBe(1);
  });

  it("no-ops for unknown terminalId", () => {
    attentionStore.notify(makeNote(1));
    expect(() => attentionStore.clear(99)).not.toThrow();
    expect(attentionStore.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// clearAll
// ---------------------------------------------------------------------------

describe("clearAll", () => {
  it("removes all notifications", () => {
    attentionStore.notify(makeNote(1));
    attentionStore.notify(makeNote(2));
    attentionStore.clearAll();
    expect(attentionStore.count).toBe(0);
  });

  it("is idempotent on empty store", () => {
    expect(() => attentionStore.clearAll()).not.toThrow();
    expect(attentionStore.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// hasPermission
// ---------------------------------------------------------------------------

describe("hasPermission", () => {
  it("returns false when no notifications", () => {
    expect(attentionStore.hasPermission).toBe(false);
  });

  it("returns false when only idle notifications", () => {
    attentionStore.notify(makeNote(1, "idle"));
    attentionStore.notify(makeNote(2, "idle"));
    expect(attentionStore.hasPermission).toBe(false);
  });

  it("returns true when at least one permission notification", () => {
    attentionStore.notify(makeNote(1, "idle"));
    attentionStore.notify(makeNote(2, "permission"));
    expect(attentionStore.hasPermission).toBe(true);
  });

  it("returns false after permission notification is cleared", () => {
    attentionStore.notify(makeNote(1, "permission"));
    attentionStore.clear(1);
    expect(attentionStore.hasPermission).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// count
// ---------------------------------------------------------------------------

describe("count", () => {
  it("reflects current notification count accurately", () => {
    expect(attentionStore.count).toBe(0);
    attentionStore.notify(makeNote(1));
    expect(attentionStore.count).toBe(1);
    attentionStore.notify(makeNote(2));
    expect(attentionStore.count).toBe(2);
    attentionStore.clear(1);
    expect(attentionStore.count).toBe(1);
    attentionStore.clearAll();
    expect(attentionStore.count).toBe(0);
  });
});
