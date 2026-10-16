/**
 * Spec 20 – Zen mode
 *
 * Cmd+Shift+Enter enters zen mode (hides sidebars + topbar).
 * Escape exits zen mode and restores the previous sidebar state — unless focus is
 * inside a terminal or editor, where Escape belongs to vim / readline.
 */

import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadApp, openWorkspace, closeAllWorkspaces, pressKey, sleep } from "./helpers";

/** Move keyboard focus off the terminal canvas / editor onto the document body. */
async function blurActiveElement(): Promise<void> {
  await browser.execute(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
  });
  await sleep(100);
}

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
      await blurActiveElement();
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

  it("Escape inside the focused terminal does not exit zen mode", async () => {
    await browser.execute(() => {
      (document.querySelector("canvas[tabindex]") as HTMLElement | null)?.focus();
    });
    await sleep(100);
    await browser.keys(["Escape"]);
    await sleep(400);

    const zenMode = await browser.execute(() =>
      (window as unknown as { __spliceTest: { isZenMode: () => boolean } }).__spliceTest.isZenMode()
    ) as boolean;
    expect(zenMode).toBe(true);
  });

  it("Escape exits zen mode", async () => {
    await blurActiveElement();
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
    const root = await browser.$("#app-root");
    await expect(root).toExist();
  });
});
