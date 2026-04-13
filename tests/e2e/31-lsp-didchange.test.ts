/**
 * Spec 31 – LSP didChange / Diagnostics Update
 *
 * Verifies that editing a TypeScript file in the editor triggers a didChange
 * notification that causes the language server to re-evaluate diagnostics.
 * Specifically: fix a type error by editing the file and confirm the lint
 * decoration disappears.
 *
 * Skipped when typescript-language-server is not installed.
 */

import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { loadApp, openWorkspace, closeAllWorkspaces, sleep } from "./helpers";

function tslsAvailable(): boolean {
  try {
    execSync("which typescript-language-server", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("LSP didChange — diagnostics update on edit", () => {
  let wsDir: string;
  let filePath: string;
  const skip = !tslsAvailable();

  before(async () => {
    if (skip) return;
    await loadApp(browser);
    await closeAllWorkspaces(browser);
    await sleep(300);

    wsDir = realpathSync(mkdtempSync(join(tmpdir(), "splice-lsp-change-")));
    filePath = join(wsDir, "change.ts");
    // Deliberate type error: boolean value assigned to number
    writeFileSync(filePath, 'const count: number = true;\n');

    await openWorkspace(browser, wsDir);
    await sleep(1000);

    await browser.execute((path: string) => {
      void (window as unknown as { __spliceTest: { openFilePinned: (p: string) => Promise<void> } })
        .__spliceTest.openFilePinned(path);
    }, filePath);
    await sleep(800);
  });

  after(async () => {
    if (skip) return;
    await closeAllWorkspaces(browser).catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("skips when typescript-language-server is not installed", () => {
    if (skip) {
      console.log("SKIP: typescript-language-server not found — skipping LSP didChange spec");
    }
    expect(true).toBe(true);
  });

  it("shows a lint error for the initial type error", async () => {
    if (skip) return;

    await browser.waitUntil(
      async () => (await browser.$$(".cm-lintRange-error, .cm-lintRange-warning")).length > 0,
      { timeout: 20_000, interval: 500, timeoutMsg: "No CM6 lint decorations appeared within 20s" }
    );

    const marks = await browser.$$(".cm-lintRange-error");
    expect(marks.length).toBeGreaterThan(0);
  });

  it("clears lint errors after editing the file to valid TypeScript", async () => {
    if (skip) return;

    // Click into the editor to give CodeMirror focus
    const editor = await browser.$(".cm-editor");
    await editor.waitForExist({ timeout: 5_000 });
    await editor.click();
    await sleep(200);

    // Select all content and replace with valid TypeScript
    await browser.keys(["Meta", "a"]);
    await sleep(100);
    await browser.keys(["Meta", "a"]); // second press ensures full selection in CM6
    await sleep(100);

    // Type the replacement — valid code with no type errors
    await browser.keys("const count: number = 42;");
    await sleep(300);

    // Wait for LSP to receive didChange, re-evaluate, and clear diagnostics
    await browser.waitUntil(
      async () => (await browser.$$(".cm-lintRange-error, .cm-lintRange-warning")).length === 0,
      { timeout: 20_000, interval: 500, timeoutMsg: "Lint decorations did not disappear after fixing the type error" }
    );

    const marks = await browser.$$(".cm-lintRange-error");
    expect(marks.length).toBe(0);

    // Verify the app is still healthy
    const root = await browser.$(".grid.h-screen");
    await expect(root).toExist();
  });
});
