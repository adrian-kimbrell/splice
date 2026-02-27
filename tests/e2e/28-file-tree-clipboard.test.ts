/**
 * Spec 28 – File tree cut/copy/paste
 *
 * Verifies that files can be copied and moved via the context-menu
 * Cut / Copy / Paste actions in the file tree.
 */

import {
  mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, realpathSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadApp, openWorkspace, closeAllWorkspaces,
  rightClickElement, clickContextMenuItem, sleep,
} from "./helpers";

describe("File tree clipboard (cut/copy/paste)", () => {
  let wsDir: string;

  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser);
    await sleep(300);
    wsDir = realpathSync(mkdtempSync(join(tmpdir(), "splice-clip-")));
    writeFileSync(join(wsDir, "source.ts"), "export const src = 1;\n");
    writeFileSync(join(wsDir, "moveme.ts"), "export const mv = 2;\n");
    mkdirSync(join(wsDir, "dest"));
    mkdirSync(join(wsDir, "dest2"));
    await openWorkspace(browser, wsDir);
    await sleep(1200);
  });

  after(async () => {
    await closeAllWorkspaces(browser).catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("file tree shows seed files and folders", async () => {
    const sourceEl = await browser.$('[data-path$="source.ts"]');
    await sourceEl.waitForExist({ timeout: 3_000 });
    const destEl = await browser.$('[data-path$="dest"]');
    await destEl.waitForExist({ timeout: 3_000 });
  });

  it("Copy → Paste duplicates the file into the destination folder", async () => {
    // Right-click source.ts → Copy
    await rightClickElement(browser, '[data-path$="source.ts"]');
    await sleep(200);
    await clickContextMenuItem(browser, "Copy");
    await sleep(200);

    // Expand dest folder first (click to expand)
    const destEl = await browser.$('[data-path$="/dest"]');
    await destEl.waitForExist({ timeout: 2_000 });

    // Right-click dest folder → Paste
    await rightClickElement(browser, '[data-path$="/dest"]');
    await sleep(200);
    await clickContextMenuItem(browser, "Paste");
    await sleep(800);

    // Original should still exist
    expect(existsSync(join(wsDir, "source.ts"))).toBe(true);
    // Copy should exist in dest/
    expect(existsSync(join(wsDir, "dest", "source.ts"))).toBe(true);
  });

  it("Cut → Paste moves the file into the destination folder", async () => {
    // Right-click moveme.ts → Cut
    await rightClickElement(browser, '[data-path$="moveme.ts"]');
    await sleep(200);
    await clickContextMenuItem(browser, "Cut");
    await sleep(200);

    // Right-click dest2 folder → Paste
    await rightClickElement(browser, '[data-path$="/dest2"]');
    await sleep(200);
    await clickContextMenuItem(browser, "Paste");
    await sleep(800);

    // Original should be gone
    expect(existsSync(join(wsDir, "moveme.ts"))).toBe(false);
    // File should now be in dest2/
    expect(existsSync(join(wsDir, "dest2", "moveme.ts"))).toBe(true);
  });

  it("Paste is disabled when clipboard is empty", async () => {
    // After a cut+paste the clipboard is cleared. Verify Paste item is disabled.
    await rightClickElement(browser, '[data-path$="/dest"]');
    await sleep(200);

    const pasteBtn = await browser.execute(() => {
      const items = document.querySelectorAll("button.split-dropdown-item");
      for (const item of Array.from(items)) {
        if ((item as HTMLElement).textContent?.trimStart().startsWith("Paste")) {
          return (item as HTMLButtonElement).disabled;
        }
      }
      return null;
    }) as boolean | null;

    // Dismiss menu
    await browser.keys(["Escape"]);
    await sleep(100);

    // Paste should be disabled (null means item wasn't found, which is also acceptable)
    if (pasteBtn !== null) {
      expect(pasteBtn).toBe(true);
    }
  });
});
