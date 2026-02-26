/**
 * Spec 04 – Terminal pane: canvas present, focus, basic input
 */

import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadApp, openWorkspace, closeAllWorkspaces, sleep } from "./helpers";

describe("Terminal pane", () => {
  let wsDir: string;

  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser); // clear persisted state from previous run
    await sleep(300);
    wsDir = mkdtempSync(join(tmpdir(), "splice-term-"));
    await openWorkspace(browser, wsDir);
    await sleep(1200); // give terminal time to spawn
  });

  after(async () => {
    await closeAllWorkspaces(browser).catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("terminal canvas element exists", async () => {
    const canvas = await browser.$("canvas.terminal-canvas");
    await expect(canvas).toExist();
  });

  it("terminal canvas has a non-zero size", async () => {
    const canvas = await browser.$("canvas.terminal-canvas");
    const size = await canvas.getSize();
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
  });

  it("terminal canvas is focusable (has tabindex)", async () => {
    const canvas = await browser.$("canvas.terminal-canvas");
    const tabindex = await canvas.getAttribute("tabindex");
    expect(tabindex).not.toBeNull();
    expect(Number(tabindex)).toBeGreaterThanOrEqual(0);
  });

  it("terminal container has the expected class", async () => {
    const container = await browser.$("div.canvas-terminal-container");
    await expect(container).toExist();
  });

  it("can send a keypress to the terminal without crashing", async () => {
    const canvas = await browser.$("canvas.terminal-canvas");
    await canvas.click();
    // Send a benign key (just 'l' — ls equivalent in shells is safe)
    await browser.keys(["l"]);
    await sleep(100);
    // App should still be alive — check root element still present
    const root = await browser.$(".grid.h-screen");
    await expect(root).toExist();
  });
});
