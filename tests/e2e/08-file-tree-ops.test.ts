/**
 * Spec 08 – File tree operations
 *
 * Context menu, inline file creation, rename dialog, and folder expand/collapse.
 * Delete is not automated because it triggers a native OS confirmation dialog.
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

describe("File tree operations", () => {
  let wsDir: string;

  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser);
    await sleep(300);
    wsDir = realpathSync(mkdtempSync(join(tmpdir(), "splice-tree-")));
    writeFileSync(join(wsDir, "alpha.ts"), "export const a = 1;\n");
    writeFileSync(join(wsDir, "beta.ts"), "export const b = 2;\n");
    mkdirSync(join(wsDir, "subdir"));
    writeFileSync(join(wsDir, "subdir", "deep.ts"), "export const d = 3;\n");
    await openWorkspace(browser, wsDir);
    await sleep(1200);
  });

  after(async () => {
    await closeAllWorkspaces(browser).catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("file tree is present and shows seed files", async () => {
    const tree = await browser.$('[role="tree"]');
    await expect(tree).toExist();

    const alpha = await browser.$('[data-path$="alpha.ts"]');
    await expect(alpha).toExist();
    const beta = await browser.$('[data-path$="beta.ts"]');
    await expect(beta).toExist();
  });

  it("right-clicking a file opens the context menu", async () => {
    await rightClickElement(browser, '[data-path$="alpha.ts"]');
    await sleep(200);

    // The context menu is a div appended to body with split-dropdown class
    const menu = await browser.$(".split-dropdown");
    await expect(menu).toExist();

    // Should contain standard file menu items
    const newFile = await browser.$("button.split-dropdown-item");
    await expect(newFile).toExist();

    // Dismiss menu with Escape
    await browser.keys(["Escape"]);
    await sleep(100);
  });

  it("context menu has expected items for a file", async () => {
    await rightClickElement(browser, '[data-path$="beta.ts"]');
    await sleep(200);

    const items = await browser.$$("button.split-dropdown-item");
    const labels: string[] = [];
    for (const item of Array.from(items)) {
      labels.push(await item.getText().catch(() => ""));
    }

    expect(labels.some((l) => l.includes("New File"))).toBe(true);
    expect(labels.some((l) => l.includes("Rename"))).toBe(true);
    expect(labels.some((l) => l.includes("Delete"))).toBe(true);

    await browser.keys(["Escape"]);
    await sleep(100);
  });

  it("creating a new file via context menu shows an inline input", async () => {
    await rightClickElement(browser, '[data-path$="alpha.ts"]');
    await sleep(200);
    await clickContextMenuItem(browser, "New File");

    // An inline input should appear inside the file tree.
    // Use waitForExist (polls) rather than a one-shot toExist() check, because
    // Svelte's microtask DOM update and the rAF-based autoFocus need a frame to run.
    const inlineInput = await browser.$('[role="tree"] input');
    await inlineInput.waitForExist({ timeout: 2_000 });

    // Cancel the create with Escape
    await browser.keys(["Escape"]);
    await sleep(200);
  });

  it("submitting a new file name creates the file in the tree", async () => {
    const newFileName = "e2e_created.ts";

    await rightClickElement(browser, '[data-path$="alpha.ts"]');
    await sleep(200);
    await clickContextMenuItem(browser, "New File");
    await sleep(300);

    const inlineInput = await browser.$('[role="tree"] input');
    await inlineInput.waitForExist({ timeout: 2_000 });
    await inlineInput.clearValue();
    await inlineInput.setValue(newFileName);
    await browser.keys(["Enter"]);
    await sleep(600);

    // File should now appear in the tree
    const newFile = await browser.$(`[data-path$="${newFileName}"]`);
    await expect(newFile).toExist();
  });

  it("renaming a file via context menu shows a centered dialog input", async () => {
    await rightClickElement(browser, '[data-path$="beta.ts"]');
    await sleep(200);
    await clickContextMenuItem(browser, "Rename");
    await sleep(300);

    // Rename dialog: fixed overlay containing an input pre-filled with the old name
    const renameInput = await browser.$('div[style*="translate(-50%, -50%)"] input');
    await expect(renameInput).toExist();

    const value = await renameInput.getValue();
    expect(value).toContain("beta"); // pre-filled with existing name

    // Dismiss without saving
    await browser.keys(["Escape"]);
    await sleep(200);
  });

  it("renaming a file updates the tree entry", async () => {
    await rightClickElement(browser, '[data-path$="beta.ts"]');
    await sleep(200);
    await clickContextMenuItem(browser, "Rename");
    await sleep(300);

    const renameInput = await browser.$('div[style*="translate(-50%, -50%)"] input');
    await renameInput.waitForExist({ timeout: 2_000 });
    await renameInput.clearValue();
    await renameInput.setValue("renamed_beta.ts");
    await browser.keys(["Enter"]);
    await sleep(600);

    // New name should appear in tree
    const renamed = await browser.$('[data-path$="renamed_beta.ts"]');
    await expect(renamed).toExist();

    // Old name should be gone — use /beta.ts to avoid matching renamed_beta.ts
    const old = await browser.$('[data-path$="/beta.ts"]');
    const oldExists = await old.isExisting();
    expect(oldExists).toBe(false);
  });

  it("folder entry shows expand chevron and can be expanded", async () => {
    const subdir = await browser.$('[data-path$="subdir"]');
    await expect(subdir).toExist();

    // Click to expand
    await subdir.click();
    await sleep(400);

    // After expansion the deep.ts file should be visible
    const deepFile = await browser.$('[data-path$="deep.ts"]');
    await expect(deepFile).toExist();
  });

  it("clicking folder again collapses it", async () => {
    const subdir = await browser.$('[data-path$="subdir"]');
    await subdir.click();
    await sleep(300);

    // deep.ts should no longer be in DOM (or not visible)
    const deepFile = await browser.$('[data-path$="deep.ts"]');
    const exists = await deepFile.isExisting();
    expect(exists).toBe(false);
  });
});
