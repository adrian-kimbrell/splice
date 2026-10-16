/**
 * Spec 15 – Pane font zoom
 *
 * Cmd+= / Cmd+- / Cmd+0 change the font size of the focused pane kind: the
 * terminal font when a terminal canvas has focus, the editor font otherwise
 * (`bumpFocusedPaneFont` / `resetFocusedPaneFont` in lib/utils/keybindings.ts).
 * The size is clamped to [FONT_MIN, FONT_MAX] and persisted through settings.
 */

import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadApp, openWorkspace, closeAllWorkspaces, pressKey, sleep } from "./helpers";

interface FontSizes { terminal: number; editor: number }

async function getFontSizes(): Promise<FontSizes> {
  return await browser.execute(() => {
    const s = (window as unknown as { __spliceTest: { getSettings: () => { terminal: { font_size: number }; editor: { font_size: number } } } })
      .__spliceTest.getSettings();
    return { terminal: s.terminal.font_size, editor: s.editor.font_size };
  }) as FontSizes;
}

/** Give keyboard focus to the first terminal canvas so the shortcuts target the terminal font. */
async function focusTerminal(): Promise<void> {
  await browser.execute(() => {
    (document.querySelector("canvas[tabindex]") as HTMLElement | null)?.focus();
  });
  await sleep(100);
}

async function resetFont(): Promise<void> {
  await focusTerminal();
  await pressKey(browser, "0", { meta: true });
  await sleep(150);
}

describe("Pane font zoom", () => {
  let wsDir: string;
  let base: number;
  let editorBase: number;

  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser);
    await sleep(300);
    wsDir = mkdtempSync(join(tmpdir(), "splice-zoom-"));
    await openWorkspace(browser, wsDir);
    await sleep(800);
    await resetFont();
    const sizes = await getFontSizes();
    base = sizes.terminal;
    editorBase = sizes.editor;
  });

  after(async () => {
    await resetFont(); // leave the font at its default for subsequent specs
    await closeAllWorkspaces(browser).catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("Cmd+0 leaves the terminal at a sane default size", async () => {
    expect(base).toBeGreaterThanOrEqual(8);
    expect(base).toBeLessThanOrEqual(32);
  });

  it("Cmd+= grows the focused terminal font by 1", async () => {
    await focusTerminal();
    await pressKey(browser, "=", { meta: true });
    await sleep(150);
    expect((await getFontSizes()).terminal).toBe(base + 1);
  });

  it("another Cmd+= grows it to +2", async () => {
    await pressKey(browser, "=", { meta: true });
    await sleep(150);
    expect((await getFontSizes()).terminal).toBe(base + 2);
  });

  it("Cmd+- shrinks it back to +1", async () => {
    await pressKey(browser, "-", { meta: true });
    await sleep(150);
    expect((await getFontSizes()).terminal).toBe(base + 1);
  });

  it("terminal zoom leaves the editor font untouched", async () => {
    expect((await getFontSizes()).editor).toBe(editorBase);
  });

  it("shrinking repeatedly is clamped at a minimum", async () => {
    for (let i = 0; i < 40; i++) await pressKey(browser, "-", { meta: true });
    await sleep(200);
    const min = (await getFontSizes()).terminal;
    expect(min).toBeLessThan(base);
    await pressKey(browser, "-", { meta: true });
    await sleep(150);
    expect((await getFontSizes()).terminal).toBe(min);
  });

  it("growing repeatedly is clamped at a maximum", async () => {
    for (let i = 0; i < 60; i++) await pressKey(browser, "=", { meta: true });
    await sleep(200);
    const max = (await getFontSizes()).terminal;
    expect(max).toBeGreaterThan(base);
    await pressKey(browser, "=", { meta: true });
    await sleep(150);
    expect((await getFontSizes()).terminal).toBe(max);
  });

  it("Cmd+0 resets the terminal font to the default", async () => {
    await pressKey(browser, "0", { meta: true });
    await sleep(150);
    expect((await getFontSizes()).terminal).toBe(base);
  });

  it("app is functional after the zoom cycle", async () => {
    const root = await browser.$("#app-root");
    await expect(root).toExist();
  });
});
