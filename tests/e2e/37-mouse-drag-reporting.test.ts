/**
 * Spec 37 – Drag reports in any-motion mouse mode
 *
 * An app that enables any-motion tracking (DECSET 1003) and selects text itself,
 * as Codex does, needs the motion reports sent while a button is held. Splice
 * used to send them only in button-drag mode (1002), so dragging in Codex
 * selected nothing. Shift+drag must stay with Splice's own selection.
 */

import { mkdtempSync, rmSync, realpathSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadApp, openWorkspace, closeAllWorkspaces, sleep, api } from "./helpers.js";

type Step = { type: "mousedown" | "mousemove" | "mouseup"; fx: number; shift?: boolean };

/** Dispatch mouse events across the terminal canvas; `fx` is a fraction of its width. */
async function mouse(steps: Step[]): Promise<void> {
  await browser.execute((steps: Step[]) => {
    const canvas = Array.from(document.querySelectorAll<HTMLCanvasElement>("canvas[tabindex]"))
      .find((c) => c.getBoundingClientRect().width > 0)!;
    const r = canvas.getBoundingClientRect();
    for (const s of steps) {
      const init = {
        bubbles: true, button: 0, buttons: s.type === "mouseup" ? 0 : 1, detail: 1,
        clientX: r.left + r.width * s.fx, clientY: r.top + r.height / 2, shiftKey: !!s.shift,
      };
      // Press goes to the canvas; motion and release are listened for on window.
      (s.type === "mousedown" ? canvas : window).dispatchEvent(new MouseEvent(s.type, init));
    }
  }, steps);
}

const drag = (shift = false): Step[] => [
  { type: "mousedown", fx: 0.1, shift },
  { type: "mousemove", fx: 0.2, shift },
  { type: "mousemove", fx: 0.3, shift },
  { type: "mousemove", fx: 0.4, shift },
  { type: "mouseup", fx: 0.4, shift },
];

describe("Mouse drag reporting", () => {
  let wsDir: string;
  let out: string;

  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser);
    await sleep(300);
    wsDir = realpathSync(mkdtempSync(join(tmpdir(), "splice-mouse-")));
    out = join(wsDir, "reports.bin");
    await openWorkspace(browser, wsDir);
    await sleep(1500);
    // A first click may be consumed as the window's focus click.
    await mouse([{ type: "mousedown", fx: 0.5 }, { type: "mouseup", fx: 0.5 }]);
    await sleep(600);
  });

  after(async () => {
    await api.runTerminal("\u0003").catch(() => {});
    await closeAllWorkspaces(browser).catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("forwards drag motion to an app in any-motion mode, and keeps Shift+drag local", async () => {
    // Any-motion + SGR on, capture the next 40 raw bytes, then restore the terminal.
    await api.runTerminal(
      `printf '\\033[?1003h\\033[?1006h'; stty raw -echo; dd bs=1 count=40 of='${out}' 2>/dev/null; ` +
      `stty sane; printf '\\033[?1003l\\033[?1006l'\r`,
    );
    await sleep(1200);

    // Shift+drag first: nothing may reach the app.
    await mouse(drag(true));
    await sleep(400);
    expect(existsSync(out) ? readFileSync(out).length : 0).toBe(0);
    await mouse([{ type: "mousedown", fx: 0.9 }, { type: "mouseup", fx: 0.9 }]); // clears the local selection
    // A plain drag: press, motion with the left button held (32), release.
    await mouse(drag());

    await browser.waitUntil(() => existsSync(out) && readFileSync(out).length >= 40, {
      timeout: 8000,
      timeoutMsg: "the app received fewer than 40 bytes of mouse reports",
    });
    const reports = readFileSync(out).toString("latin1");
    expect(reports).toContain("\x1b[<0;");
    // The 40-byte capture can end inside a report, so match its start only.
    expect(reports).toMatch(/\x1b\[<32;\d/);
  });
});
