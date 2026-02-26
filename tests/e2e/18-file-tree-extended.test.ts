/**
 * Spec 18 – Extended file tree operations
 *
 * Folder creation via context menu, collapse all, and delete option verification.
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadApp,
  openWorkspace,
  closeAllWorkspaces,
  rightClickElement,
  clickContextMenuItem,
  sleep,
} from "./helpers";

describe("File tree extended operations", () => {
  let wsDir: string;

  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser);
    await sleep(300);
    wsDir = realpathSync(mkdtempSync(join(tmpdir(), "splice-tree2-")));
    writeFileSync(join(wsDir, "a.ts"), "export const a = 1;\n");
    mkdirSync(join(wsDir, "subdir"));
    writeFileSync(join(wsDir, "subdir", "nested.ts"), "export const n = 2;\n");
    await openWorkspace(browser, wsDir);
    await sleep(1200);
  });

  after(async () => {
    await closeAllWorkspaces(browser).catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("creating a new folder via context menu shows inline input", async () => {
    await rightClickElement(browser, '[data-path$="subdir"]');
    await sleep(200);
    await clickContextMenuItem(browser, "New Folder");

    const inlineInput = await browser.$('[role="tree"] input');
    await inlineInput.waitForExist({ timeout: 2_000 });

    // Cancel without committing
    await browser.keys(["Escape"]);
    await sleep(200);
  });

  it("submitting a folder name creates it in the tree", async () => {
    await rightClickElement(browser, '[data-path$="subdir"]');
    await sleep(200);
    await clickContextMenuItem(browser, "New Folder");
    await sleep(300);

    const inlineInput = await browser.$('[role="tree"] input');
    await inlineInput.waitForExist({ timeout: 2_000 });
    await inlineInput.clearValue();
    await inlineInput.setValue("e2e_folder");
    await browser.keys(["Enter"]);
    await sleep(600);

    const newFolder = await browser.$('[data-path$="e2e_folder"]');
    await expect(newFolder).toExist();
  });

  it("context menu includes a Delete option for files", async () => {
    await rightClickElement(browser, '[data-path$="a.ts"]');
    await sleep(200);

    const items = await browser.$$("button.split-dropdown-item");
    const labels: string[] = [];
    for (const item of Array.from(items)) {
      labels.push(await item.getText().catch(() => ""));
    }
    expect(labels.some((l) => l.includes("Delete"))).toBe(true);

    // Dismiss without triggering native dialog
    await browser.keys(["Escape"]);
    await sleep(100);
  });

  it("Collapse All in context menu collapses expanded folders", async () => {
    // Start from a known state: collapse everything first
    await rightClickElement(browser, '[data-path$="a.ts"]');
    await sleep(200);
    await clickContextMenuItem(browser, "Collapse All");
    await sleep(400);

    // Now expand subdir by clicking it
    const subdir = await browser.$('[data-path$="subdir"]');
    await expect(subdir).toExist();
    await subdir.click();
    await sleep(400);

    // Verify nested.ts is visible after expansion
    const nestedBefore = await browser.$('[data-path$="nested.ts"]');
    await nestedBefore.waitForExist({ timeout: 2_000 });

    // Right-click a tree entry and trigger Collapse All
    await rightClickElement(browser, '[data-path$="a.ts"]');
    await sleep(200);
    await clickContextMenuItem(browser, "Collapse All");
    await sleep(400);

    // nested.ts should no longer be in DOM after collapsing
    const nestedAfter = await browser.$('[data-path$="nested.ts"]');
    const nestedExists = await nestedAfter.isExisting();
    expect(nestedExists).toBe(false);
  });
});
