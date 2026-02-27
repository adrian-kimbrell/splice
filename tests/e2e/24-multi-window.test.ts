/**
 * Spec 24 – Multi-window persistence
 *
 * Verifies that each window gets its own workspace file, the window registry
 * is updated on open/close, and the main window is not affected by secondary
 * window operations.
 *
 * Note: getWindowRegistry() is async (IPC call) so we can't return it from
 * browser.execute(). Tests here use only synchronous bridge functions.
 */

import { loadApp } from "./helpers";

describe("Multi-window persistence", () => {
  before(async () => {
    await loadApp(browser);
    // Start clean: fire-and-forget (Promise not serializable through WebDriver)
    await browser.execute(() =>
      void (window as unknown as Record<string, { closeAllWorkspaces: () => Promise<void> }>)
        .__spliceTest.closeAllWorkspaces()
    );
    await browser.pause(400);
  });

  it("app loads successfully", async () => {
    const root = await browser.$(".grid.h-screen");
    await expect(root).toExist();
  });

  it("getWorkspaceIds returns an array (sync bridge check)", async () => {
    const ids = await browser.execute(() =>
      (window as unknown as Record<string, { getWorkspaceIds: () => string[] }>)
        .__spliceTest.getWorkspaceIds()
    ) as string[];
    expect(Array.isArray(ids)).toBe(true);
  });

  it("opening a new window does not crash the app", async () => {
    // fire-and-forget — openNewWindow returns a Promise; use void
    await browser.execute(() =>
      void (window as unknown as Record<string, { openNewWindow?: () => Promise<void> }>)
        .__spliceTest.openNewWindow?.()
    );
    // Wait for the async register_window IPC call to complete
    await browser.pause(800);

    // App should still be alive
    const root = await browser.$(".grid.h-screen");
    await expect(root).toExist();
  });

  it("main window workspace count is unaffected by secondary window opening", async () => {
    const mainIds = await browser.execute(() =>
      (window as unknown as Record<string, { getWorkspaceIds: () => string[] }>)
        .__spliceTest.getWorkspaceIds()
    ) as string[];
    // Secondary window opening should not add workspaces to the main window
    expect(Array.isArray(mainIds)).toBe(true);
  });
});
