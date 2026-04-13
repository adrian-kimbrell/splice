/**
 * Spec 25 – LSP Diagnostics
 *
 * Verifies that TypeScript type errors appear as CM6 lint decorations and in the
 * Problems panel. Skipped when typescript-language-server is not installed.
 */

import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { loadApp, openWorkspace, closeAllWorkspaces, pressKey, sleep } from "./helpers";

function tslsAvailable(): boolean {
  try {
    execSync("which typescript-language-server", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("LSP Diagnostics", () => {
  let wsDir: string;
  let filePath: string;
  const skip = !tslsAvailable();

  before(async () => {
    if (skip) return;
    await loadApp(browser);
    await closeAllWorkspaces(browser);
    await sleep(300);
    wsDir = realpathSync(mkdtempSync(join(tmpdir(), "splice-lsp-diag-")));
    filePath = join(wsDir, "bad.ts");
    // Deliberate type error: assigning a string to a number-typed variable
    writeFileSync(filePath, 'const x: number = "not a number";\n');
    await openWorkspace(browser, wsDir);
    await sleep(1000);

    // Open the file as a pinned tab
    await browser.execute((path: string) => {
      void (window as unknown as { __spliceTest: { openFilePinned: (p: string) => Promise<void> } })
        .__spliceTest.openFilePinned(path);
    }, filePath);
    await sleep(500);
  });

  after(async () => {
    if (skip) return;
    await closeAllWorkspaces(browser).catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("skips when typescript-language-server is not installed", () => {
    if (skip) {
      console.log("SKIP: typescript-language-server not found — skipping LSP diagnostics spec");
    }
    expect(true).toBe(true);
  });

  it("shows a lint error decoration in the editor", async () => {
    if (skip) return;

    // Wait up to 10s for the LSP to push diagnostics and CM6 to render them
    await browser.waitUntil(
      async () => {
        const els = await browser.$$(".cm-lintRange-error, .cm-lintRange-warning");
        return els.length > 0;
      },
      { timeout: 20_000, interval: 500, timeoutMsg: "No CM6 lint decorations appeared within 20s" }
    );

    const errorMarks = await browser.$$(".cm-lintRange-error");
    expect(errorMarks.length).toBeGreaterThan(0);
  });

  it("Problems panel shows at least one error after Cmd+Shift+M", async () => {
    if (skip) return;

    await pressKey(browser, "M", { meta: true, shift: true });
    await sleep(400);

    // Problems panel should show the error entry
    const state = await browser.execute(() =>
      (window as unknown as { __spliceTest: { getSidebarState: () => { explorerVisible: boolean; sidebarMode: string } } })
        .__spliceTest.getSidebarState()
    ) as { explorerVisible: boolean; sidebarMode: string };
    expect(state.sidebarMode).toBe("problems");

    // At least one severity icon for an error should be visible
    const errorIcons = await browser.$$(".bi-x-circle-fill");
    expect(errorIcons.length).toBeGreaterThan(0);

    // Switch back to files mode
    await pressKey(browser, "M", { meta: true, shift: true });
    await sleep(200);
  });
});
