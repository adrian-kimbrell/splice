/**
 * Spec 33 – Image viewer zoom
 *
 * Opens a PNG and checks the viewer's zoom controls: toolbar buttons, ⌘= / ⌘− / ⌘0
 * while the viewer is focused (which must not touch the editor font size), and the
 * double-click fit ↔ 1:1 toggle.
 */

import { mkdtempSync, copyFileSync, rmSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadApp, openWorkspace, closeAllWorkspaces, sleep } from "./helpers";

const VIEWPORT = ".image-viewport";
const PCT = ".image-toolbar .zoom-pct";

async function percent(): Promise<number> {
  const text = await (await browser.$(PCT)).getText();
  return parseInt(text, 10);
}

/** Dispatch a key chord on the focused viewer, the way a real keypress bubbles from it. */
async function chordOnViewer(key: string): Promise<void> {
  await browser.execute((sel: string, k: string) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) throw new Error("viewer not found");
    el.focus();
    el.dispatchEvent(new KeyboardEvent("keydown", {
      key: k, code: k === "=" ? "Equal" : k === "-" ? "Minus" : "Digit0",
      metaKey: true, bubbles: true, cancelable: true,
    }));
  }, VIEWPORT, key);
  await sleep(150);
}

async function editorFontSize(): Promise<number> {
  const s = await browser.execute(() =>
    (window as unknown as { __spliceTest: { getSettings: () => { editor: { font_size: number } } } })
      .__spliceTest.getSettings()
  );
  return s.editor.font_size;
}

describe("Image viewer zoom", () => {
  let wsDir: string;
  let imagePath: string;
  let fontBefore: number;

  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser);
    await sleep(300);

    wsDir = realpathSync(mkdtempSync(join(tmpdir(), "splice-image-zoom-")));
    imagePath = join(wsDir, "icon.png"); // 128×128, fits at 100%
    copyFileSync(join(process.cwd(), "src-tauri/icons/128x128.png"), imagePath);

    await openWorkspace(browser, wsDir);
    await sleep(800);
    fontBefore = await editorFontSize();

    await browser.execute((path: string) => {
      void (window as unknown as { __spliceTest: { openFilePinned: (p: string) => Promise<void> } })
        .__spliceTest.openFilePinned(path);
    }, imagePath);
    await (await browser.$(`${VIEWPORT} img`)).waitForExist({ timeout: 5_000 });
    await browser.waitUntil(async () => (await browser.$$(PCT)).length > 0 && (await percent()) > 0,
      { timeout: 5_000, timeoutMsg: "zoom toolbar never showed a percentage" });
  });

  after(async () => {
    await closeAllWorkspaces(browser).catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("opens in fit mode at 100% for an image smaller than the pane", async () => {
    expect(await percent()).toBe(100);
    const fit = await browser.$('.image-toolbar button[aria-label="Fit to window"]');
    expect(await fit.getAttribute("class")).toContain("is-active");
  });

  it("toolbar + and − change the zoom, Fit restores it", async () => {
    await (await browser.$('.image-toolbar button[aria-label="Zoom in"]')).click();
    await sleep(150);
    expect(await percent()).toBe(125);
    await (await browser.$('.image-toolbar button[aria-label="Zoom in"]')).click();
    await sleep(150);
    expect(await percent()).toBe(156);
    await (await browser.$('.image-toolbar button[aria-label="Zoom out"]')).click();
    await sleep(150);
    expect(await percent()).toBe(125);
    await (await browser.$('.image-toolbar button[aria-label="Fit to window"]')).click();
    await sleep(150);
    expect(await percent()).toBe(100);
  });

  it("⌘= / ⌘− / ⌘0 zoom the focused viewer and leave the editor font alone", async () => {
    await chordOnViewer("=");
    expect(await percent()).toBe(125);
    await chordOnViewer("=");
    await chordOnViewer("=");
    expect(await percent()).toBe(195);
    await chordOnViewer("-");
    expect(await percent()).toBe(156);
    await chordOnViewer("0");
    expect(await percent()).toBe(100);
    expect(await editorFontSize()).toBe(fontBefore);
  });

  it("a zoomed image is laid out at natural size × zoom", async () => {
    await chordOnViewer("=");
    await chordOnViewer("=");
    const width = await browser.execute((sel: string) =>
      (document.querySelector(`${sel} img`) as HTMLImageElement).getBoundingClientRect().width, VIEWPORT);
    expect(Math.round(width)).toBe(Math.round(128 * 1.25 * 1.25));
    await chordOnViewer("0");
  });

  it("double-click toggles between fit and 1:1", async () => {
    // The embedded WebDriver does not synthesise dblclick from the actions API;
    // dispatch the DOM event the browser would produce.
    const dblclick = () => browser.execute((sel: string) => {
      document.querySelector(sel)?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    }, VIEWPORT);
    await dblclick();
    await sleep(150);
    const actual = await browser.$('.image-toolbar button[aria-label="Actual size"]');
    expect(await actual.getAttribute("class")).toContain("is-active");
    await dblclick();
    await sleep(150);
    const fit = await browser.$('.image-toolbar button[aria-label="Fit to window"]');
    expect(await fit.getAttribute("class")).toContain("is-active");
  });

  it("app is still healthy", async () => {
    await expect(await browser.$("#app-root")).toExist();
  });
});
