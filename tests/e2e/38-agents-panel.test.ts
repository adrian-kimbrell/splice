/**
 * Spec 38 – Agents panel
 *
 * One list of every agent session across workspaces: the state follows the
 * terminal (nothing running, quiet program, attention notification), and a
 * click on a row goes to that terminal in its workspace.
 */

import { mkdtempSync, rmSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadApp, openWorkspace, closeAllWorkspaces, sleep, api } from "./helpers.js";

type TestApi = {
  setAgentSession: (terminalId: number, agent: "claude" | "codex") => boolean;
  getActiveWorkspaceId: () => string;
  switchToWorkspace: (id: string) => void;
  getWorkspaceIds: () => string[];
  getTerminalIds: () => number[];
};

/** [workspace heading, title, detail, state text] per row, in display order. */
async function rows(): Promise<{ terminalId: number; state: string; text: string }[]> {
  return browser.execute(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="agents-panel"] .agent-row')].map((r) => ({
      terminalId: Number(r.dataset.terminalId),
      state: r.dataset.state ?? "",
      text: (r.textContent ?? "").replace(/\s+/g, " ").trim(),
    })),
  );
}

async function stateOf(terminalId: number): Promise<string | undefined> {
  return (await rows()).find((r) => r.terminalId === terminalId)?.state;
}

describe("Agents panel", () => {
  let dirA: string;
  let dirB: string;
  let termA: number;
  let termB: number;
  let wsA: string;

  // Read from this window directly: /dev/state can be answered by another window.
  const terminalIds = () => browser.execute(() => (window as unknown as { __spliceTest: TestApi }).__spliceTest.getTerminalIds());

  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser);
    await sleep(300);
    dirA = realpathSync(mkdtempSync(join(tmpdir(), "splice-agents-a-")));
    dirB = realpathSync(mkdtempSync(join(tmpdir(), "splice-agents-b-")));
    await openWorkspace(browser, dirA);
    await sleep(1200);
    [termA] = await terminalIds();
    expect(typeof termA).toBe("number");
    wsA = await browser.execute(() => (window as unknown as { __spliceTest: TestApi }).__spliceTest.getActiveWorkspaceId());
    await openWorkspace(browser, dirB);
    await sleep(1200);
    termB = (await terminalIds()).find((id) => id !== termA)!;
    expect(typeof termB).toBe("number");
  });

  after(async () => {
    await api.runTerminal("\u0003", termA).catch(() => {});
    await api.runTerminal("\u0003", termB).catch(() => {});
    await api.setUi({ sidebarMode: "files" } as never).catch(() => {});
    await closeAllWorkspaces(browser).catch(() => {});
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it("is empty until a terminal hosts an agent session", async () => {
    await (await browser.$('[data-testid="agents-tab"]')).click();
    await (await browser.$('[data-testid="agents-panel"]')).waitForExist({ timeout: 5000 });
    expect(await rows()).toEqual([]);
  });

  it("lists agents from every workspace with their live state", async () => {
    // Workspace A: a session reported by a hook, with a quiet program in the terminal.
    await browser.execute((a: number) => {
      (window as unknown as { __spliceTest: TestApi }).__spliceTest.setAgentSession(a, "claude");
    }, termA);
    await api.runTerminal("sleep 300\r", termA);
    // Workspace B: no session reported at all, only a program named codex in the
    // foreground. It must be listed from the process alone. A symlink, not a copy:
    // macOS kills a copied system binary on launch.
    await api.runTerminal(`ln -s /bin/sleep '${dirB}/codex' && '${dirB}/codex' 300\r`, termB);

    try {
      await browser.waitUntil(async () => (await stateOf(termA)) === "idle" && (await stateOf(termB)) === "idle", { timeout: 15000 });
    } catch {
      throw new Error(`states never settled (A=${termA}, B=${termB}): ${JSON.stringify(await rows())}`);
    }
    const list = await rows();
    expect(list.find((r) => r.terminalId === termA)!.text).toContain("Claude");
    expect(list.find((r) => r.terminalId === termB)!.text).toContain("Codex");

    if (process.env.SPLICE_E2E_SHOTS) {
      await api.notify(termB, "idle", "done");
      await sleep(400);
      await Promise.race([browser.saveScreenshot(join(process.env.SPLICE_E2E_SHOTS, "agents-panel.png")).catch(() => {}), sleep(5000)]);
      await browser.execute(() => undefined);
    }
  });

  it("shows a permission request first and goes to that terminal on click", async () => {
    await api.notify(termA, "permission", "Claude needs your permission to use Bash");
    await browser.waitUntil(async () => (await stateOf(termA)) === "permission", { timeout: 5000 });
    expect((await rows()).find((r) => r.terminalId === termA)!.text).toContain("Needs permission");

    // Workspace B is active; the row belongs to workspace A.
    const row = await browser.$(`[data-testid="agents-panel"] .agent-row[data-terminal-id="${termA}"]`);
    await row.click();
    await browser.waitUntil(
      async () => (await browser.execute(() => (window as unknown as { __spliceTest: TestApi }).__spliceTest.getActiveWorkspaceId())) === wsA,
      { timeout: 5000, timeoutMsg: "clicking the row did not switch to the agent's workspace" },
    );
    // Going there acknowledges the notification.
    await browser.waitUntil(async () => (await stateOf(termA)) === "idle", { timeout: 8000 });
  });

  it("drops an agent that was only seen running once it exits, and keeps one with a session", async () => {
    await api.runTerminal("\u0003", termB);
    await api.runTerminal("\u0003", termA);
    await browser.waitUntil(async () => (await stateOf(termB)) === undefined && (await stateOf(termA)) === "exited", {
      timeout: 10000,
      timeoutMsg: "the exited agents did not settle",
    });
  });
});
