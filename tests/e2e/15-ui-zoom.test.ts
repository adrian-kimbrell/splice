/**
 * Spec 15 – UI zoom
 *
 * Verifies that Cmd+= / Cmd+- / Cmd+0 adjust document.documentElement.style.zoom
 * by the expected 10% steps and that the scale is clamped to [50, 200].
 */

import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadApp, openWorkspace, closeAllWorkspaces, pressKey, sleep } from "./helpers";

/** Read the current zoom level as a number (100 = 100%). */
async function getZoomScale(): Promise<number> {
  return await browser.execute(() => {
    const zoom = document.documentElement.style.zoom;
    if (!zoom) return 100;
    return Math.round(parseFloat(zoom) * 100);
  }) as number;
}

/** Set zoom directly via settings to reset to a known baseline. */
async function resetZoom(): Promise<void> {
  await browser.execute(() => {
    // Reset via Cmd+0 equivalent (set ui_scale = 100)
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "0",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
  });
  await sleep(200);
}

describe("UI zoom", () => {
  let wsDir: string;

  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser);
    await sleep(300);
    wsDir = mkdtempSync(join(tmpdir(), "splice-zoom-"));
    await openWorkspace(browser, wsDir);
    await sleep(800);
    await resetZoom(); // start at 100%
  });

  after(async () => {
    await resetZoom(); // leave app at 100% for subsequent tests
    await closeAllWorkspaces(browser).catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("initial zoom is 100%", async () => {
    const scale = await getZoomScale();
    expect(scale).toBe(100);
  });

  it("Cmd+= zooms in by 10%", async () => {
    await pressKey(browser, "=", { meta: true });
    await sleep(200);

    const scale = await getZoomScale();
    expect(scale).toBe(110);
  });

  it("another Cmd+= zooms in to 120%", async () => {
    await pressKey(browser, "=", { meta: true });
    await sleep(200);

    const scale = await getZoomScale();
    expect(scale).toBe(120);
  });

  it("Cmd+- zooms out by 10%", async () => {
    await pressKey(browser, "-", { meta: true });
    await sleep(200);

    const scale = await getZoomScale();
    expect(scale).toBe(110);
  });

  it("Cmd+0 resets zoom to 100%", async () => {
    await pressKey(browser, "0", { meta: true });
    await sleep(200);

    const scale = await getZoomScale();
    expect(scale).toBe(100);
  });

  it("zooming out repeatedly is clamped at 50%", async () => {
    // Press Cmd+- 10 times (100 → 50)
    for (let i = 0; i < 10; i++) {
      await pressKey(browser, "-", { meta: true });
      await sleep(50);
    }
    await sleep(200);

    const scale = await getZoomScale();
    expect(scale).toBe(50);

    // Another Cmd+- should not go below 50
    await pressKey(browser, "-", { meta: true });
    await sleep(200);
    const scaleClamped = await getZoomScale();
    expect(scaleClamped).toBe(50);

    await resetZoom();
  });

  it("zooming in repeatedly is clamped at 200%", async () => {
    // Press Cmd+= 15 times (100 → 200, clamped)
    for (let i = 0; i < 15; i++) {
      await pressKey(browser, "=", { meta: true });
      await sleep(50);
    }
    await sleep(200);

    const scale = await getZoomScale();
    expect(scale).toBe(200);

    // Another Cmd+= should not exceed 200
    await pressKey(browser, "=", { meta: true });
    await sleep(200);
    const scaleClamped = await getZoomScale();
    expect(scaleClamped).toBe(200);

    await resetZoom();
  });

  it("zoom change updates document.documentElement.style.zoom", async () => {
    await pressKey(browser, "=", { meta: true });
    await sleep(200);

    const zoom = await browser.execute(
      () => document.documentElement.style.zoom
    ) as string;

    // Should be a CSS value like "1.1" representing 110%
    expect(parseFloat(zoom)).toBeGreaterThan(1.0);

    await resetZoom();
  });

  it("UI is still functional after zoom changes", async () => {
    await pressKey(browser, "=", { meta: true });
    await sleep(100);
    await pressKey(browser, "=", { meta: true });
    await sleep(100);
    await pressKey(browser, "-", { meta: true });
    await sleep(100);
    await pressKey(browser, "0", { meta: true });
    await sleep(200);

    // App root should still be present
    const root = await browser.$(".grid.h-screen");
    await expect(root).toExist();

    // File tree should still be visible
    const tree = await browser.$('[role="tree"]');
    await expect(tree).toExist();
  });
});
