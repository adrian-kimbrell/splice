/**
 * Spec 17 – File save verification
 *
 * Verifies that Cmd+S actually writes content to disk (not just clears the dirty indicator).
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadApp,
  openWorkspace,
  closeAllWorkspaces,
  pressKey,
  sleep,
} from "./helpers";

describe("File save verification", () => {
  let wsDir: string;
  let filePath: string;

  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser);
    await sleep(300);
    wsDir = realpathSync(mkdtempSync(join(tmpdir(), "splice-save-")));
    filePath = join(wsDir, "save-test.ts");
    writeFileSync(filePath, "const ORIGINAL = true;\n");
    await openWorkspace(browser, wsDir);
    await sleep(1000);

    // Open the file as a pinned tab
    await browser.execute((path: string) => {
      void (window as unknown as { __spliceTest: { openFilePinned: (p: string) => Promise<void> } })
        .__spliceTest.openFilePinned(path);
    }, filePath);
    await sleep(400);
  });

  after(async () => {
    await closeAllWorkspaces(browser).catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("Cmd+S writes updated content to disk", async () => {
    const newContent = "const SAVED = true;\n";

    // Update the in-memory content and mark dirty
    await browser.execute((content: string) => {
      (window as unknown as { __spliceTest: { updateActiveFileContent: (c: string) => void } })
        .__spliceTest.updateActiveFileContent(content);
    }, newContent);
    await sleep(100);

    // Save with Cmd+S
    await pressKey(browser, "s", { meta: true });
    await sleep(400);

    // Read from disk in the test process
    const diskContent = readFileSync(filePath, "utf8");
    expect(diskContent).toBe(newContent);
  });

  it("dirty indicator is gone after save", async () => {
    // The unsaved-changes indicator should not be present after a successful save
    const unsavedIndicator = await browser.$('[role="tab"] span[title="Unsaved changes"]');
    const exists = await unsavedIndicator.isExisting();
    expect(exists).toBe(false);
  });

  it("saving again with unchanged content is idempotent", async () => {
    // Press Cmd+S again — no dirty state, should not crash
    await pressKey(browser, "s", { meta: true });
    await sleep(200);

    const root = await browser.$(".grid.h-screen");
    await expect(root).toExist();
  });
});
