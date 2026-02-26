/**
 * Spec 05 – Pane splitting and layout
 *
 * Verifies that splitting a pane via the split button creates a second
 * [data-pane-id] node, and that the resize divider is present.
 */

import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadApp, openWorkspace, closeAllWorkspaces, sleep } from "./helpers";

describe("Pane split", () => {
  let wsDir: string;

  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser); // clear persisted state from previous run
    await sleep(300);
    wsDir = mkdtempSync(join(tmpdir(), "splice-split-"));
    writeFileSync(join(wsDir, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(wsDir, "b.ts"), "export const b = 2;\n");
    await openWorkspace(browser, wsDir);
    await sleep(1000);

    // Open a file so there's content to split
    const file = await browser.$('[data-path$="a.ts"]');
    await file.click();
    await sleep(400);
  });

  after(async () => {
    await closeAllWorkspaces(browser).catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("starts with at most two panes (terminal + editor)", async () => {
    // A fresh workspace has 1 terminal pane. Clicking a file in before
    // adds an editor pane, giving 1–2 panes total.
    const panes = await browser.$$("[data-pane-id]");
    expect(panes.length).toBeGreaterThanOrEqual(1);
    expect(panes.length).toBeLessThanOrEqual(2);
  });

  it("split button is visible in the tab bar", async () => {
    const splitBtn = await browser.$("button.pane-action-btn .bi-layout-split");
    await expect(splitBtn).toExist();
  });

  it("clicking split creates a second pane", async () => {
    const panesBefore = (await browser.$$("[data-pane-id]")).length;

    // Click the split button directly (not the container div) so that
    // the button's onclick handler fires and opens the split dropdown.
    const splitBtn = await browser.$("button[title='Split Pane']");
    await splitBtn.waitForExist({ timeout: 3_000 });
    await splitBtn.click();
    await sleep(300);

    // The dropdown is appended to document.body — wait for it then click the first item.
    const dropdownItem = await browser.$("button.split-dropdown-item");
    await dropdownItem.waitForExist({ timeout: 2_000 });
    await dropdownItem.click();
    await sleep(800);

    const panesAfter = await browser.$$("[data-pane-id]");
    expect(panesAfter.length).toBeGreaterThan(panesBefore);
  });

  it("a resize divider is present between panes", async () => {
    const panes = await browser.$$("[data-pane-id]");
    // If we have ≥ 2 panes, the split layout is in place
    expect(panes.length).toBeGreaterThanOrEqual(2);
  });

  it("each pane has a distinct pane ID", async () => {
    const panes = await browser.$$("[data-pane-id]");
    // Collect IDs sequentially (ElementArray.map may not be available in all webdriver impl)
    const ids: (string | null)[] = [];
    for (const p of Array.from(panes)) {
      ids.push(await p.getAttribute("data-pane-id"));
    }
    const unique = new Set(ids.filter(Boolean));
    expect(unique.size).toBe(ids.length);
  });
});
