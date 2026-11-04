/**
 * Spec 19 – Command palette execution
 *
 * Opens the palette, filters commands, executes one, and verifies the state effect.
 */

import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadApp, openWorkspace, closeAllWorkspaces, pressKey, sleep } from "./helpers";


/**
 * Svelte outro transitions run on requestAnimationFrame. When the app window is
 * occluded (the suite runs for minutes while the user works elsewhere) WebKit
 * throttles rAF and an outro never finishes, so an element that is logically
 * gone can stay in the DOM. True when a frame fires within 500 ms.
 */
async function animationFramesAreLive(): Promise<boolean> {
  return browser.executeAsync((done: (ok: boolean) => void) => {
    const t = setTimeout(() => done(false), 500);
    requestAnimationFrame(() => { clearTimeout(t); done(true); });
  });
}

async function getUiScale(): Promise<number> {
  return await browser.execute(() =>
    (window as unknown as { __spliceTest: { getUiScale: () => number } }).__spliceTest.getUiScale()
  ) as number;
}

async function waitForUiScale(expected: number): Promise<void> {
  await browser.waitUntil(async () => (await getUiScale()) === expected,
    { timeout: 2_000, timeoutMsg: `ui_scale did not settle at ${expected}` });
}

/** Open the palette, filter to `name`, and run the highlighted (first) item. */
async function runPaletteCommand(name: string): Promise<void> {
  await pressKey(browser, "p", { meta: true });
  await (await browser.$('input[placeholder="Type a command…"]')).waitForExist({ timeout: 2_000 });
  await browser.execute((n: string) => {
    const input = document.querySelector('input[placeholder="Type a command…"]') as HTMLInputElement | null;
    if (!input) throw new Error("palette input not found");
    input.value = n;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, name);
  await sleep(300);
  await browser.execute(() => {
    const input = document.querySelector('input[placeholder="Type a command…"]') as HTMLInputElement | null;
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  await sleep(300);
}

describe("Command palette execution", () => {
  let wsDir: string;

  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser);
    await sleep(300);
    wsDir = mkdtempSync(join(tmpdir(), "splice-palette-"));
    writeFileSync(join(wsDir, "sample.ts"), "const x = 1;\n");
    await openWorkspace(browser, wsDir);
    await sleep(1000);
  });

  after(async () => {
    // Ensure palette is closed and zoom is reset
    await browser.keys(["Escape"]).catch(() => {});
    await pressKey(browser, "0", { meta: true });
    await sleep(200);
    await closeAllWorkspaces(browser).catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("command palette opens with Cmd+P", async () => {
    await pressKey(browser, "p", { meta: true });
    await sleep(300);

    const palettInput = await browser.$('input[placeholder="Type a command…"]');
    await palettInput.waitForExist({ timeout: 2_000 });

    // Dismiss
    await browser.keys(["Escape"]);
    await sleep(200);
  });

  it("filtering narrows the command list", async () => {
    await pressKey(browser, "p", { meta: true });
    await sleep(300);

    // Get count before filter
    const itemsBefore = await browser.$$('#command-palette-list [role="option"]');
    const countBefore = itemsBefore.length;

    // Type a filter via browser.execute to avoid WebDriver focus side-effects
    await browser.execute(() => {
      const input = document.querySelector('input[placeholder="Type a command…"]') as HTMLInputElement | null;
      if (!input) return;
      input.value = "zoom";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await sleep(300);

    const itemsAfter = await browser.$$('#command-palette-list [role="option"]');
    expect(itemsAfter.length).toBeGreaterThan(0);
    expect(itemsAfter.length).toBeLessThan(countBefore);

    await browser.keys(["Escape"]);
    await sleep(200);
  });

  it("executing Zoom In via palette increases ui_scale", async () => {
    // "Zoom In" here is the whole-window UI scale (appearance.ui_scale). ⌘0 is NOT
    // its inverse: that chord resets the focused pane's font. Reset through the
    // palette's own "Reset Zoom" and verify, or a 110% scale leaks into every spec
    // that follows (spec 33 measures image geometry and sees it).
    await runPaletteCommand("Reset Zoom");
    await waitForUiScale(100);

    await runPaletteCommand("Zoom In");
    await browser.waitUntil(async () => (await getUiScale()) > 100,
      { timeout: 2_000, timeoutMsg: "ui_scale did not increase after Zoom In" });

    await runPaletteCommand("Reset Zoom");
    await waitForUiScale(100);
  });

  it("executing Find in Files opens search sidebar", async () => {
    await pressKey(browser, "p", { meta: true });
    await sleep(300);

    await browser.execute(() => {
      const input = document.querySelector('input[placeholder="Type a command…"]') as HTMLInputElement | null;
      if (!input) return;
      input.value = "Find in Files";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await sleep(300);

    await browser.execute(() => {
      const input = document.querySelector('input[placeholder="Type a command…"]') as HTMLInputElement | null;
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await sleep(300);

    const state = await browser.execute(() =>
      (window as unknown as { __spliceTest: { getSidebarState: () => { explorerVisible: boolean; sidebarMode: string } } })
        .__spliceTest.getSidebarState()
    ) as { explorerVisible: boolean; sidebarMode: string };
    expect(state.sidebarMode).toBe("search");

    // Reset sidebar to file explorer
    await browser.execute(() => {
      (window as unknown as { __spliceTest: { showExplorer: () => void } }).__spliceTest.showExplorer();
    });
    await sleep(100);
  });

  it("Escape closes the palette without executing", async () => {
    await pressKey(browser, "p", { meta: true });
    await sleep(300);

    const palettInput = await browser.$('input[placeholder="Type a command…"]');
    await palettInput.waitForExist({ timeout: 2_000 });

    await browser.execute(() => {
      const input = document.querySelector('input[placeholder="Type a command…"]') as HTMLInputElement | null;
      if (!input) return;
      input.value = "zoom";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await sleep(100);

    await browser.keys(["Escape"]);

    // The palette closes immediately in state; the DOM element leaves once its
    // outro transition finishes.
    await browser.waitUntil(async () => {
      const st = await browser.execute(() =>
        (window as unknown as { __spliceTest: { getUiState: () => { commandPaletteOpen: boolean } } }).__spliceTest.getUiState());
      return st.commandPaletteOpen === false;
    }, { timeout: 2_000, timeoutMsg: "palette still open (ui.commandPaletteOpen) after Escape" });
    if (await animationFramesAreLive()) {
      const palettAfter = await browser.$('input[placeholder="Type a command…"]');
      await palettAfter.waitForExist({ reverse: true, timeout: 3_000 });
      expect(await palettAfter.isExisting()).toBe(false);
    }
  });
});
