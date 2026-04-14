/**
 * Spec 01 – App loads and core state is present
 */
import { describe, it, expect, beforeAll } from "vitest";
import { api } from "../e2e/dev-api.js";

describe("App load", () => {
  beforeAll(async () => {
    await api.reset();
    await api.waitForReset();
  });

  it("dev server is reachable", async () => {
    const res = await api.ping();
    expect(res.ok).toBe(true);
  });

  it("state returns valid structure", async () => {
    const state = await api.state();
    expect(state).toHaveProperty("ui");
    expect(state).toHaveProperty("workspaces");
    expect(Array.isArray(state.workspaces)).toBe(true);
  });

  it("UI defaults are sensible", async () => {
    const { ui } = await api.state();
    expect(typeof ui.explorerVisible).toBe("boolean");
    expect(typeof ui.explorerWidth).toBe("number");
    expect(ui.explorerWidth).toBeGreaterThan(0);
    expect(ui.zenMode).toBe(false);
  });

  it("root grid container is present in DOM", async () => {
    // The root layout is a grid div directly inside #app
    const els = await api.domQuery("#app > div.grid");
    expect(els.length).toBeGreaterThan(0);
    expect(els[0].visible).toBe(true);
  });

  it("shows welcome screen or at least one pane after reset", async () => {
    const welcome = await api.domQuery("div.welcome-screen");
    const panes = await api.domQuery("[data-pane-id]");
    expect(welcome.length + panes.length).toBeGreaterThan(0);
  });

  it("workspaces sidebar element exists in DOM", async () => {
    const sidebar = await api.domQuery('[aria-label="Workspaces"]');
    expect(sidebar.length).toBeGreaterThan(0);
  });

  it("topbar buttons exist in DOM", async () => {
    const btns = await api.domQuery("button.topbar-btn");
    expect(btns.length).toBeGreaterThan(0);
  });
});
