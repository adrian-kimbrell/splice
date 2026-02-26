/**
 * Spec 21 – Tab context menu
 *
 * Right-clicking a tab shows a context menu with working actions:
 * Close Others, Pin Tab, Close.
 */

import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadApp, openWorkspace, closeAllWorkspaces, pressKey, sleep } from "./helpers";

describe("Tab context menu", () => {
  let wsDir: string;

  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser);
    await sleep(300);
    wsDir = realpathSync(mkdtempSync(join(tmpdir(), "splice-tabctx-")));
    for (const name of ["a.ts", "b.ts", "c.ts"]) {
      writeFileSync(join(wsDir, name), `export const ${name[0]} = 1;\n`);
    }
    await openWorkspace(browser, wsDir);
    await sleep(1000);
  });

  after(async () => {
    await closeAllWorkspaces(browser).catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  /** Open files as pinned tabs. */
  async function openFiles(names: string[]): Promise<void> {
    for (const name of names) {
      await browser.execute((path: string) => {
        void (window as unknown as { __spliceTest: { openFilePinned: (p: string) => Promise<void> } })
          .__spliceTest.openFilePinned(path);
      }, join(wsDir, name));
      await sleep(100);
    }
    await sleep(300);
  }

  /** Right-click a tab by index (0-based) and click a context menu item by label. */
  async function tabCtxMenu(tabIndex: number, label: string): Promise<void> {
    await browser.execute((idx: number) => {
      const tabs = document.querySelectorAll('[role="tab"]');
      const tab = tabs[idx] as HTMLElement | undefined;
      if (!tab) throw new Error(`No tab at index ${idx}`);
      const rect = tab.getBoundingClientRect();
      tab.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }));
    }, tabIndex);
    await sleep(200);

    await browser.waitUntil(
      async () => {
        return (await browser.execute((lbl: string) => {
          const items = document.querySelectorAll("button.split-dropdown-item");
          for (const item of Array.from(items)) {
            if ((item as HTMLElement).textContent?.trimStart().startsWith(lbl)) {
              (item as HTMLElement).click();
              return true;
            }
          }
          return false;
        }, label)) as boolean;
      },
      { timeout: 2_000, interval: 100, timeoutMsg: `Tab context menu item "${label}" not found` }
    );
    await sleep(200);
  }

  it("right-clicking a tab shows a context menu", async () => {
    await openFiles(["a.ts", "b.ts"]);

    await browser.execute(() => {
      const tab = document.querySelector('[role="tab"]') as HTMLElement | null;
      if (!tab) throw new Error("No tab found");
      const rect = tab.getBoundingClientRect();
      tab.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }));
    });
    await sleep(200);

    const menu = await browser.$(".tab-ctx-menu, .split-dropdown");
    await expect(menu).toExist();

    const items = await browser.$$("button.split-dropdown-item");
    expect(items.length).toBeGreaterThan(0);

    await browser.keys(["Escape"]);
    await sleep(100);
  });

  it("Close Others leaves only the right-clicked tab", async () => {
    // Close existing tabs and open 3 fresh ones
    await pressKey(browser, "k", { meta: true });
    await sleep(100);
    await pressKey(browser, "w");
    await sleep(300);

    await openFiles(["a.ts", "b.ts", "c.ts"]);

    const tabsBefore = (await browser.$$('[role="tab"]')).length;
    expect(tabsBefore).toBeGreaterThanOrEqual(2);

    // Right-click tab index 0 and choose "Close Others"
    await tabCtxMenu(0, "Close Others");
    await sleep(400);

    const tabsAfter = (await browser.$$('[role="tab"]')).length;
    expect(tabsAfter).toBe(1);
  });

  it("Pin Tab shows pin icon on the tab", async () => {
    // Re-open b.ts and c.ts
    await openFiles(["b.ts", "c.ts"]);

    await tabCtxMenu(0, "Pin Tab");
    await sleep(300);

    // After pinning, a pin icon (bi-pin-fill or bi-pin) should appear in the tab bar
    const pinIcon = await browser.$(".bi-pin-fill, .bi-pin");
    await expect(pinIcon).toExist();
  });

  it("Close removes one tab", async () => {
    const tabsBefore = (await browser.$$('[role="tab"]')).length;
    expect(tabsBefore).toBeGreaterThanOrEqual(1);

    await tabCtxMenu(tabsBefore - 1, "Close");
    await sleep(300);

    const tabsAfter = (await browser.$$('[role="tab"]')).length;
    expect(tabsAfter).toBe(tabsBefore - 1);
  });
});
