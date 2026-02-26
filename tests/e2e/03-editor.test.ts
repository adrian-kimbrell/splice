/**
 * Spec 03 – Editor: open file, tab bar, dirty state, close tab
 */

import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadApp, openWorkspace, closeAllWorkspaces, sleep } from "./helpers";

describe("Editor tabs", () => {
  let wsDir: string;
  const FILE_CONTENT = "// hello from e2e\nexport const x = 42;\n";

  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser); // clear persisted state from previous run
    await sleep(300);
    wsDir = mkdtempSync(join(tmpdir(), "splice-editor-"));
    writeFileSync(join(wsDir, "index.ts"), FILE_CONTENT);
    writeFileSync(join(wsDir, "utils.ts"), "export const util = true;\n");
    await openWorkspace(browser, wsDir);
    await sleep(1200); // allow file tree + terminal to fully settle
  });

  after(async () => {
    await closeAllWorkspaces(browser).catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("clicking a file in the tree opens a tab", async () => {
    const fileItem = await browser.$('[data-path$="index.ts"]');
    await fileItem.click();
    await sleep(300);

    const tab = await browser.$('[role="tab"]');
    await expect(tab).toExist();
    const tabText = await tab.getText();
    expect(tabText).toContain("index.ts");
  });

  it("the editor content area is present", async () => {
    const editor = await browser.$(".cm-editor");
    await expect(editor).toExist();
  });

  it("the editor shows the file content", async () => {
    const content = await browser.$(".cm-content");
    await expect(content).toExist();
    const text = await content.getText();
    expect(text).toContain("hello from e2e");
  });

  it("opening a second file adds a second tab", async () => {
    // Pin the active tab (index.ts) via the test API so it won't be replaced by the next
    // preview-mode open. Using the API is more reliable than doubleClick() which may not
    // fire the dblclick DOM event in all WebKit/WebDriver configurations.
    await browser.execute(() => {
      (window as unknown as { __spliceTest: { pinCurrentTab: () => void } })
        .__spliceTest.pinCurrentTab();
    });
    await sleep(200);

    // Now single-click utils.ts. Because there is no longer a preview slot in the pane
    // (index.ts is now permanent), utils.ts opens as a new preview tab → 2 tabs total.
    const fileItem = await browser.$('[data-path$="utils.ts"]');
    await fileItem.waitForExist({ timeout: 5_000 });
    await fileItem.click();
    await sleep(600);

    const tabs = await browser.$$('[role="tab"]');
    expect(tabs.length).toBeGreaterThanOrEqual(2);
  });

  it("the active tab reflects the selected file", async () => {
    const activeTab = await browser.$('[role="tab"][aria-selected="true"]');
    await expect(activeTab).toExist();
    const text = await activeTab.getText();
    expect(text).toContain("utils.ts");
  });

  it("closing a tab via the close button removes it", async () => {
    const tabsBefore = (await browser.$$('[role="tab"]')).length;

    // Click the close button on the active tab
    const closeBtn = await browser.$('[role="tab"][aria-selected="true"] button');
    await closeBtn.click();
    await sleep(200);

    const tabsAfter = (await browser.$$('[role="tab"]')).length;
    expect(tabsAfter).toBe(tabsBefore - 1);
  });
});
