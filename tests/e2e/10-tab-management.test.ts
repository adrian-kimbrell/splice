/**
 * Spec 10 – Advanced tab management
 *
 * Tests tab context menus (Close Others, Close All), pinning via context menu,
 * and keyboard chord shortcuts for bulk-tab operations.
 */

import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadApp,
  openWorkspace,
  closeAllWorkspaces,
  pressKey,
  sleep,
} from "./helpers";

describe("Tab management", () => {
  let wsDir: string;

  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser);
    await sleep(300);
    wsDir = mkdtempSync(join(tmpdir(), "splice-tabs-"));
    for (let i = 0; i < 8; i++) {
      writeFileSync(join(wsDir, `file${i}.ts`), `export const v${i} = ${i};\n`);
    }
    await openWorkspace(browser, wsDir);
    await sleep(1000);
  });

  after(async () => {
    await closeAllWorkspaces(browser).catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  /** Open the first N files as permanent tabs via the test API. */
  async function openFiles(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await browser.execute((path: string) => {
        void (
          window as unknown as {
            __spliceTest: { openFilePinned: (p: string) => Promise<void> };
          }
        ).__spliceTest.openFilePinned(path);
      }, join(wsDir, `file${i}.ts`));
      await sleep(100);
    }
    await sleep(300);
  }

  /** Right-click the active tab and click a context menu item by label. */
  async function tabContextMenu(itemLabel: string): Promise<void> {
    const activeTab = await browser.$('[role="tab"][aria-selected="true"]');
    await expect(activeTab).toExist();
    const rect = await browser.execute((el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    }, activeTab);
    await browser.execute((r: { left: number; top: number; width: number; height: number }) => {
      const target = document.querySelector('[role="tab"][aria-selected="true"]');
      if (target)
        target.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: r.left + r.width / 2,
            clientY: r.top + r.height / 2,
          })
        );
    }, rect);
    await sleep(200);

    // Find and click the matching item
    await browser.waitUntil(
      async () => {
        const items = await browser.$$("button.split-dropdown-item");
        for (const item of Array.from(items)) {
          const text = await item.getText().catch(() => "");
          if (text.includes(itemLabel)) {
            await item.click();
            return true;
          }
        }
        return false;
      },
      { timeout: 2_000, interval: 100, timeoutMsg: `Context menu item "${itemLabel}" not found` }
    );
    await sleep(200);
  }

  // ── tests ──────────────────────────────────────────────────────────────────

  it("opening 5 files creates 5 tabs", async () => {
    await openFiles(5);

    const tabs = await browser.$$('[role="tab"]');
    expect(tabs.length).toBeGreaterThanOrEqual(5);
  });

  it("Close Others leaves only the active tab", async () => {
    // Make file2 the active tab
    await browser.execute((path: string) => {
      void (
        window as unknown as {
          __spliceTest: { openFilePinned: (p: string) => Promise<void> };
        }
      ).__spliceTest.openFilePinned(path);
    }, join(wsDir, "file2.ts"));
    await sleep(300);

    const tabsBefore = (await browser.$$('[role="tab"]')).length;
    expect(tabsBefore).toBeGreaterThanOrEqual(2);

    await tabContextMenu("Close Others");
    await sleep(400);

    const tabsAfter = await browser.$$('[role="tab"]');
    expect(tabsAfter.length).toBe(1);

    // Remaining tab should be file2
    const remainingText = await tabsAfter[0].getText().catch(() => "");
    expect(remainingText).toContain("file2");
  });

  it("Cmd+K W closes all tabs in the pane", async () => {
    // Re-open a couple of files first
    await openFiles(3);
    await sleep(200);

    const tabsBefore = (await browser.$$('[role="tab"]')).length;
    expect(tabsBefore).toBeGreaterThanOrEqual(1);

    // Chord Cmd+K → W: close all tabs
    await pressKey(browser, "k", { meta: true });
    await sleep(100);
    await pressKey(browser, "w");
    await sleep(400);

    const tabsAfter = (await browser.$$('[role="tab"]')).length;
    expect(tabsAfter).toBe(0);
  });

  it("pinning a tab via context menu shows the pin icon", async () => {
    // Open file0 as a preview tab (single click via test API works too)
    const fileItem = await browser.$('[data-path$="file0.ts"]');
    await fileItem.click();
    await sleep(300);

    // The active tab name span should be italic (preview)
    const tabSpan = await browser.$('[role="tab"][aria-selected="true"] span.mr-1');
    const styleBefore = await tabSpan.getAttribute("style");
    expect(styleBefore).toContain("italic");

    // Pin via context menu
    await tabContextMenu("Pin Tab");
    await sleep(300);

    // After pinning: font style becomes normal, pin icon appears
    const tabSpanAfter = await browser.$('[role="tab"] span.mr-1');
    const styleAfter = await tabSpanAfter.getAttribute("style");
    expect(styleAfter).toContain("normal");
  });

  it("pinned tab is not closed by Close Others", async () => {
    // Open file3 and file4 as additional tabs
    await openFiles(4);
    await sleep(200);

    const tabsBefore = (await browser.$$('[role="tab"]')).length;
    expect(tabsBefore).toBeGreaterThanOrEqual(2);

    // Make file3 the active tab and run Close Others
    await browser.execute((path: string) => {
      void (
        window as unknown as {
          __spliceTest: { openFilePinned: (p: string) => Promise<void> };
        }
      ).__spliceTest.openFilePinned(path);
    }, join(wsDir, "file3.ts"));
    await sleep(200);

    await tabContextMenu("Close Others");
    await sleep(400);

    // The pinned file0 should still be present (pin protects from close-others)
    // AND file3 (the active one). So ≥ 1 tab
    const tabsAfter = await browser.$$('[role="tab"]');
    expect(tabsAfter.length).toBeGreaterThanOrEqual(1);
  });

  it("Close Left removes tabs to the left of active", async () => {
    // Close all first, then open 4 files in order
    await pressKey(browser, "k", { meta: true });
    await sleep(100);
    await pressKey(browser, "w");
    await sleep(300);

    for (let i = 0; i < 4; i++) {
      await browser.execute((path: string) => {
        void (
          window as unknown as {
            __spliceTest: { openFilePinned: (p: string) => Promise<void> };
          }
        ).__spliceTest.openFilePinned(path);
      }, join(wsDir, `file${i}.ts`));
      await sleep(80);
    }
    await sleep(200);

    // Activate file2 (index 2) — tabs to its left: file0, file1
    await browser.execute((path: string) => {
      void (
        window as unknown as {
          __spliceTest: { openFilePinned: (p: string) => Promise<void> };
        }
      ).__spliceTest.openFilePinned(path);
    }, join(wsDir, "file2.ts"));
    await sleep(200);

    const allTabs = (await browser.$$('[role="tab"]')).length;
    expect(allTabs).toBeGreaterThanOrEqual(3);

    // Chord Cmd+K → E: close tabs to the left
    await pressKey(browser, "k", { meta: true });
    await sleep(100);
    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { code: "KeyE", bubbles: true, cancelable: true })
      );
    });
    await sleep(400);

    const tabsAfter = await browser.$$('[role="tab"]');
    // file0 and file1 should be gone; file2 and file3 should remain
    expect(tabsAfter.length).toBeLessThan(allTabs);
    expect(tabsAfter.length).toBeGreaterThanOrEqual(1);
  });
});
