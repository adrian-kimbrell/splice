/**
 * Spec 20 – Zen mode
 *
 * Cmd+Shift+Enter enters zen mode (hides sidebars + topbar).
 * Escape exits zen mode and restores the previous sidebar state.
 */

import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadApp, openWorkspace, closeAllWorkspaces, pressKey, sleep } from "./helpers";

describe("Zen mode", () => {
  let wsDir: string;

  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser);
    await sleep(300);
    wsDir = mkdtempSync(join(tmpdir(), "splice-zen-"));
    await openWorkspace(browser, wsDir);
    await sleep(800);

    // Ensure sidebar is shown before the test sequence
    await browser.execute(() => {
      (window as unknown as { __spliceTest: { showExplorer: () => void } }).__spliceTest.showExplorer();
    });
    await sleep(200);
  });

  after(async () => {
    // Ensure zen mode is off and cleanup
    const zenActive = await browser.execute(() =>
      (window as unknown as { __spliceTest: { isZenMode: () => boolean } }).__spliceTest.isZenMode()
    ) as boolean;
    if (zenActive) {
      await browser.keys(["Escape"]);
      await sleep(300);
    }
    await browser.execute(() => {
      (window as unknown as { __spliceTest: { showExplorer: () => void } }).__spliceTest.showExplorer();
    });
    await sleep(100);
    await closeAllWorkspaces(browser).catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("Cmd+Shift+Enter enters zen mode", async () => {
    await pressKey(browser, "Enter", { meta: true, shift: true });
    await sleep(400);

    const zenMode = await browser.execute(() =>
      (window as unknown as { __spliceTest: { isZenMode: () => boolean } }).__spliceTest.isZenMode()
    ) as boolean;
    expect(zenMode).toBe(true);
  });

  it("zen mode hides the explorer sidebar", async () => {
    const state = await browser.execute(() =>
      (window as unknown as { __spliceTest: { getSidebarState: () => { explorerVisible: boolean; sidebarMode: string } } })
        .__spliceTest.getSidebarState()
    ) as { explorerVisible: boolean; sidebarMode: string };
    expect(state.explorerVisible).toBe(false);
  });

  it("Escape exits zen mode", async () => {
    await browser.keys(["Escape"]);
    await sleep(400);

    const zenMode = await browser.execute(() =>
      (window as unknown as { __spliceTest: { isZenMode: () => boolean } }).__spliceTest.isZenMode()
    ) as boolean;
    expect(zenMode).toBe(false);
  });

  it("sidebars restored after exiting zen mode", async () => {
    // After Escape in zen mode the snapshot (explorerVisible=true) should be restored
    const state = await browser.execute(() =>
      (window as unknown as { __spliceTest: { getSidebarState: () => { explorerVisible: boolean; sidebarMode: string } } })
        .__spliceTest.getSidebarState()
    ) as { explorerVisible: boolean; sidebarMode: string };
    expect(state.explorerVisible).toBe(true);
  });

  it("app is functional after zen mode cycle", async () => {
    const root = await browser.$(".grid.h-screen");
    await expect(root).toExist();
  });
});
