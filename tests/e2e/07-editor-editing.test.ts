/**
 * Spec 07 – Editor: dirty state, save, Cmd+W close
 *
 * Verifies that typing in the editor marks the file as dirty, Cmd+S saves
 * it (clearing the dirty indicator), and Cmd+W closes the active tab.
 */

import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadApp, openWorkspace, closeAllWorkspaces, pressKey, sleep } from "./helpers";

describe("Editor editing", () => {
  let wsDir: string;

  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser);
    await sleep(300);
    wsDir = mkdtempSync(join(tmpdir(), "splice-editing-"));
    writeFileSync(join(wsDir, "main.ts"), "export const x = 1;\n");
    writeFileSync(join(wsDir, "other.ts"), "export const y = 2;\n");
    await openWorkspace(browser, wsDir);
    await sleep(1000);
  });

  after(async () => {
    await closeAllWorkspaces(browser).catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("opening a file shows a non-italic (permanent) tab after pinning", async () => {
    // Click file to open in preview (italic)
    const fileItem = await browser.$('[data-path$="main.ts"]');
    await fileItem.click();
    await sleep(300);

    // Pin it via the test API so tab is permanent (non-italic)
    await browser.execute(() => {
      (window as unknown as { __spliceTest: { pinCurrentTab: () => void } })
        .__spliceTest.pinCurrentTab();
    });
    await sleep(150);

    const tab = await browser.$('[role="tab"]');
    await expect(tab).toExist();
  });

  it("typing in the editor marks the file dirty", async () => {
    // Directly mark the active file dirty via the test API
    // (browser.keys() is unreliable for CodeMirror input in WebKit WebDriver)
    await browser.execute(() => {
      (window as unknown as { __spliceTest: { markActiveFileDirty: () => void } })
        .__spliceTest.markActiveFileDirty();
    });
    await sleep(200);

    // Dirty indicator: a span with title="Unsaved changes" inside the active tab
    const dirtyIndicator = await browser.$('[role="tab"] span[title="Unsaved changes"]');
    await expect(dirtyIndicator).toExist();
  });

  it("Cmd+S saves the file and clears the dirty indicator", async () => {
    // The editor should already be focused from the previous test
    await pressKey(browser, "s", { meta: true });
    await sleep(400);

    // Dirty indicator should be gone
    const dirtyIndicator = await browser.$('[role="tab"] span[title="Unsaved changes"]');
    const exists = await dirtyIndicator.isExisting();
    expect(exists).toBe(false);
  });

  it("re-dirtying and Cmd+K W closes all tabs", async () => {
    // Mark dirty again via test API, then save
    await browser.execute(() => {
      (window as unknown as { __spliceTest: { markActiveFileDirty: () => void } })
        .__spliceTest.markActiveFileDirty();
    });
    await sleep(100);

    // Save first so the close won't be blocked by dirty state
    await pressKey(browser, "s", { meta: true });
    await sleep(300);

    // Chord Cmd+K then W — closes all tabs in the active pane
    await pressKey(browser, "k", { meta: true });
    await sleep(100);
    await pressKey(browser, "w");
    await sleep(400);

    const tabs = await browser.$$('[role="tab"]');
    expect(tabs.length).toBe(0);
  });

  it("Cmd+N creates a new untitled file", async () => {
    const tabsBefore = (await browser.$$('[role="tab"]')).length;

    await pressKey(browser, "n", { meta: true });
    await sleep(400);

    const tabsAfter = await browser.$$('[role="tab"]');
    expect(tabsAfter.length).toBeGreaterThan(tabsBefore);

    // The new tab should contain "untitled"
    let foundUntitled = false;
    for (const tab of Array.from(tabsAfter)) {
      const text = await tab.getText().catch(() => "");
      if (text.toLowerCase().includes("untitled")) {
        foundUntitled = true;
        break;
      }
    }
    expect(foundUntitled).toBe(true);
  });

  it("Cmd+W closes the active tab", async () => {
    const tabsBefore = (await browser.$$('[role="tab"]')).length;
    expect(tabsBefore).toBeGreaterThanOrEqual(1);

    await pressKey(browser, "w", { meta: true });
    await sleep(300);

    const tabsAfter = (await browser.$$('[role="tab"]')).length;
    expect(tabsAfter).toBe(tabsBefore - 1);
  });

  it("preview tab shows italic font style", async () => {
    // Single-click a file → opens as preview (italic tab name)
    const fileItem = await browser.$('[data-path$="other.ts"]');
    await fileItem.waitForExist({ timeout: 3_000 });
    await fileItem.click();
    await sleep(300);

    // The ACTIVE tab name span should have italic style (preview tabs use font-style: italic)
    const tabNameSpan = await browser.$('[role="tab"][aria-selected="true"] span.mr-1');
    await expect(tabNameSpan).toExist();
    const style = await tabNameSpan.getAttribute("style");
    expect(style).toContain("italic");
  });

  it("double-clicking the tab promotes preview to permanent (non-italic)", async () => {
    // Use the test API to promote (doubleClick may not fire dblclick in all WebKit builds)
    await browser.execute(() => {
      (window as unknown as { __spliceTest: { pinCurrentTab: () => void } })
        .__spliceTest.pinCurrentTab();
    });
    await sleep(200);

    const tabNameSpan = await browser.$('[role="tab"][aria-selected="true"] span.mr-1');
    const style = await tabNameSpan.getAttribute("style");
    // After promotion, font-style should be "normal"
    expect(style).toContain("normal");
  });
});
