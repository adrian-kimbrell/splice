import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MENU_ACTION_IDS, registerActions, runAction } from "./actions";

vi.mock("./utils/log", () => ({ log: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe("action registry", () => {
  it("lists exactly the native menu ids declared in lib.rs", () => {
    const rs = readFileSync(join(process.cwd(), "src-tauri/src/lib.rs"), "utf8");
    const menuIds = new Set([...rs.matchAll(/MenuItemBuilder::with_id\("([a-z-]+)"/g)].map((m) => m[1]));
    expect(menuIds.size).toBeGreaterThan(0);
    expect([...menuIds].sort()).toEqual([...MENU_ACTION_IDS].sort());
  });

  beforeEach(async () => {
    const { log } = await import("./utils/log");
    vi.mocked(log.warn).mockClear();
  });

  it("runs a registered handler and reports unknown or unregistered ids", async () => {
    const { log } = await import("./utils/log");
    const save = vi.fn();
    const dispose = registerActions({ save });
    expect(runAction("save")).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(runAction("not-an-action")).toBe(false);
    expect(log.warn).toHaveBeenCalledWith("Unknown action id:", "not-an-action");
    dispose();
    expect(runAction("save")).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("logs a rejected async handler instead of throwing", async () => {
    const { log } = await import("./utils/log");
    const dispose = registerActions({ "save-all": async () => { throw new Error("disk full"); } });
    expect(runAction("save-all")).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(log.error).toHaveBeenCalled();
    dispose();
  });
});
