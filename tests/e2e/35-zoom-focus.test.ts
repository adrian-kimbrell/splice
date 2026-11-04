/**
 * Spec 35 – Zoomed pane keeps keyboard focus
 *
 * When a pane is zoomed, the zoom overlay renders a second copy of it and the
 * grid copy is hidden. Window focus handlers look the active pane up by
 * `data-pane-id`; the overlay used to have none, so focus landed on the hidden
 * grid copy, where `.focus()` is a no-op and the next keystroke went nowhere.
 */

import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadApp, openWorkspace, closeAllWorkspaces, sleep } from "./helpers";
import { api } from "./dev-api";

describe("Zoomed pane focus", () => {
  let wsDir: string;
  let paneId: string;

  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser);
    await sleep(300);

    wsDir = realpathSync(mkdtempSync(join(tmpdir(), "splice-zoom-focus-")));
    const file = join(wsDir, "a.ts");
    writeFileSync(file, "export const a = 1;\n");

    await openWorkspace(browser, wsDir);
    await sleep(800);
    await browser.execute((path: string) => {
      void (window as unknown as { __spliceTest: { openFilePinned: (p: string) => Promise<void> } })
        .__spliceTest.openFilePinned(path);
    }, file);
    await (await browser.$(".cm-content")).waitForExist({ timeout: 5_000 });

    // The pane is created synchronously with the open, but the dev-API snapshot
    // is a separate request; poll it rather than sampling once.
    await browser.waitUntil(async () => {
      const st = await api.state();
      const editor = st.workspaces
        .flatMap((w) => w.panes)
        .find((p) => p.kind === "editor" && p.filePaths.includes(file));
      if (editor) paneId = editor.id;
      return !!editor;
    }, { timeout: 5_000, timeoutMsg: `no editor pane holding ${file} after opening it` });
  });

  after(async () => {
    await api.setUi({ zoomedPaneId: null }).catch(() => {});
    await closeAllWorkspaces(browser).catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("renders the zoomed pane twice, with only the overlay copy visible", async () => {
    await api.setUi({ zoomedPaneId: paneId });
    await sleep(400);
    // The grid copy is hidden with `visibility: hidden`, which offsetParent does not see.
    const copies = await browser.execute((id: string) =>
      Array.from(document.querySelectorAll<HTMLElement>(`[data-pane-id="${id}"]`))
        .map((el) => el.offsetParent !== null && getComputedStyle(el).visibility !== "hidden"), paneId);
    expect(copies.length).toBe(2);
    expect(copies.filter(Boolean).length).toBe(1);
  });

  it("window focus lands in the visible (overlay) copy of the zoomed pane", async () => {
    await browser.execute(() => {
      (document.activeElement as HTMLElement | null)?.blur?.();
      window.dispatchEvent(new Event("focus"));
    });
    await sleep(300);
    const focused = await browser.execute(() => {
      const el = document.activeElement as HTMLElement | null;
      return {
        tag: el?.tagName ?? "",
        isEditor: !!el?.classList.contains("cm-content"),
        visible: !!el && el.offsetParent !== null && getComputedStyle(el).visibility !== "hidden",
        paneId: el?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId ?? null,
      };
    });
    expect(focused.isEditor).toBe(true);
    expect(focused.visible).toBe(true);
    expect(focused.paneId).toBe(paneId);
  });

  it("app is still healthy", async () => {
    await api.setUi({ zoomedPaneId: null });
    await sleep(200);
    const root = await browser.$("#app-root");
    await expect(root).toExist();
  });
});
