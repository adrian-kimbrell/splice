/**
 * Spec 01 – App loads and core chrome is present
 *
 * Verifies that the Splice window starts up cleanly: the root layout,
 * welcome screen (or workspace grid), top bar, and sidebar controls
 * are all rendered within a reasonable time.
 */

import { loadApp } from "./helpers";

describe("App load", () => {
  before(async () => {
    await loadApp(browser);
  });

  it("root grid container is present", async () => {
    const root = await browser.$(".grid.h-screen");
    await expect(root).toExist();
  });

  it("shows welcome screen OR at least one workspace pane", async () => {
    // Either the welcome screen (no workspaces) or a live pane grid
    const welcome = await browser.$("div.welcome-screen");
    const pane = await browser.$("[data-pane-id]");
    const hasWelcome = await welcome.isExisting();
    const hasPane = await pane.isExisting();
    expect(hasWelcome || hasPane).toBe(true);
  });

  it("right sidebar (workspaces panel) exists", async () => {
    const sidebar = await browser.$('[aria-label="Workspaces"]');
    await expect(sidebar).toExist();
  });

  it("top bar is rendered", async () => {
    // The topbar is the second grid row; it contains .topbar-btn elements
    const btn = await browser.$("button.topbar-btn");
    await expect(btn).toExist();
  });

  it("page title is Splice", async () => {
    const title = await browser.getTitle();
    expect(title).toMatch(/splice/i);
  });
});
