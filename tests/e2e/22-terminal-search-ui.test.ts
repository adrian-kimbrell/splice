/**
 * Spec 22 – Terminal search UI
 *
 * Opens the terminal search bar with Ctrl+F, types a query, checks match count,
 * and closes the bar.
 */

import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadApp, openWorkspace, closeAllWorkspaces, sleep } from "./helpers";

/** Get the terminal ID from the first terminal pane in the active workspace. */
async function getTerminalId(): Promise<number | null> {
  return await browser.execute(() => {
    const wm = (window as unknown as { workspaceManager?: { activeWorkspace?: { terminalIds?: number[] } } }).workspaceManager;
    const ids = wm?.activeWorkspace?.terminalIds;
    return ids && ids.length > 0 ? ids[0] : null;
  }) as number | null;
}

/** Trigger the terminal search bar via Ctrl+F on the canvas element. */
async function openTerminalSearch(): Promise<void> {
  await browser.execute(() => {
    // Fall back to the TerminalPane root div if canvas is not available
    const target = document.querySelector("canvas[tabindex]") ?? document.querySelector("[data-pane-id]");
    if (!target) throw new Error("Terminal canvas not found");
    target.dispatchEvent(new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }));
  });
}

/** Click the close button inside the terminal search bar (not the pane close button). */
async function closeTerminalSearch(): Promise<void> {
  await browser.execute(() => {
    const input = document.querySelector('input[placeholder="Search terminal…"]');
    const container = input?.parentElement;
    // The search bar close btn is the last button in the container (no extra class)
    const btns = container?.querySelectorAll('button[title="Close"]');
    if (btns && btns.length > 0) {
      (btns[btns.length - 1] as HTMLElement).click();
    }
  });
}

describe("Terminal search UI", () => {
  let wsDir: string;
  let marker: string;

  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser);
    await sleep(300);
    wsDir = mkdtempSync(join(tmpdir(), "splice-termsrch-"));
    await openWorkspace(browser, wsDir);
    await sleep(1500); // let PTY fully start

    // Write a distinctive marker to the terminal for searching
    marker = `splice_srch_${Date.now()}`;
    const tid = await getTerminalId();
    if (tid !== null) {
      await browser.execute(
        (id: number, text: string) => {
          const encoder = new TextEncoder();
          const data = encoder.encode(text);
          void (window as unknown as { __TAURI__: { invoke: (...a: unknown[]) => Promise<unknown> } })
            .__TAURI__.invoke("write_to_terminal", { id, data: Array.from(data) });
        },
        tid,
        `echo ${marker}\r`
      );
      await sleep(800);
    }
  });

  after(async () => {
    // Ensure search bar is closed
    const searchInput = await browser.$('input[placeholder="Search terminal…"]');
    if (await searchInput.isExisting()) {
      await closeTerminalSearch();
      await sleep(200);
    }
    await closeAllWorkspaces(browser).catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("terminal search bar opens with Ctrl+F on the canvas", async () => {
    const canvas = await browser.$("canvas[tabindex]");
    await expect(canvas).toExist();

    await openTerminalSearch();

    const searchInput = await browser.$('input[placeholder="Search terminal…"]');
    await searchInput.waitForExist({ timeout: 2_000 });
  });

  it("typing a query shows match count or no-results", async () => {
    // Set search query via execute to avoid focus side effects
    await browser.execute((q: string) => {
      const input = document.querySelector('input[placeholder="Search terminal…"]') as HTMLInputElement | null;
      if (!input) return;
      input.value = q;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, marker);
    await sleep(800);

    // Use execute() to read the span text — avoids :has() / ~ selector WebKit limitations
    const countText = await browser.execute(() => {
      const input = document.querySelector('input[placeholder="Search terminal…"]');
      if (!input) return "";
      // Walk siblings of the input inside the search bar container
      const container = input.parentElement;
      if (!container) return "";
      const spans = container.querySelectorAll("span");
      for (const span of Array.from(spans)) {
        const t = span.textContent ?? "";
        if (t.includes("/") || t.includes("No results")) return t;
      }
      // Fallback: return full container text
      return container.textContent ?? "";
    }) as string;

    const hasCount = countText.includes("/") || countText.includes("No results");
    expect(hasCount).toBe(true);
  });

  it("closing the search bar hides the input", async () => {
    await closeTerminalSearch();
    await sleep(300);

    const searchInput = await browser.$('input[placeholder="Search terminal…"]');
    const exists = await searchInput.isExisting();
    expect(exists).toBe(false);
  });

  it("search bar can be reopened after closing", async () => {
    await openTerminalSearch();

    const searchInput = await browser.$('input[placeholder="Search terminal…"]');
    await searchInput.waitForExist({ timeout: 2_000 });

    // Clean up
    await closeTerminalSearch();
    await sleep(200);
  });
});
