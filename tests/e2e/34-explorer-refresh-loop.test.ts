/**
 * Spec 34 – Explorer does not refresh in a loop inside a git repository
 *
 * Every explorer refresh runs `git status`, which by default takes
 * `.git/index.lock` and rewrites `.git/index`. The recursive watcher on the
 * workspace saw those writes and scheduled another refresh, so the tree reloaded
 * every ~200 ms forever in any git workspace. Two things stop it: git runs with
 * GIT_OPTIONAL_LOCKS=0, and changes inside hidden directories are ignored by the
 * tree watcher. This spec counts `tree:changed` events via the dev log buffer.
 */

import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { loadApp, openWorkspace, closeAllWorkspaces, sleep } from "./helpers";
import { api } from "./dev-api.js";

const MARK = "[watch] tree:changed";

async function treeChangedCount(): Promise<number> {
  const logs = await api.logs();
  return logs.filter((l) => l.message.includes(MARK)).length;
}

describe("Explorer refresh loop guard", () => {
  let wsDir: string;

  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser);
    await sleep(300);

    wsDir = realpathSync(mkdtempSync(join(tmpdir(), "splice-refresh-loop-")));
    writeFileSync(join(wsDir, "README.md"), "# loop\n");
    execSync("git init -q && git add . && git -c user.email=e2e@splice -c user.name=e2e commit -qm init", { cwd: wsDir });

    // `log.debug` is silent in the e2e build until the level is raised.
    await browser.execute(() => {
      (window as unknown as { __spliceLog: { setLevel: (l: string) => void } }).__spliceLog.setLevel("debug");
    });

    await openWorkspace(browser, wsDir);
    await sleep(1000);
  });

  after(async () => {
    await browser.execute(() => {
      (window as unknown as { __spliceLog: { setLevel: (l: string) => void } }).__spliceLog.setLevel("warn");
    }).catch(() => {});
    await closeAllWorkspaces(browser).catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("an idle git workspace produces no tree refreshes", async () => {
    const before = await treeChangedCount();
    await sleep(2500);
    const after = await treeChangedCount();
    // The old code looped at ~5 Hz here, so this would have been ~12.
    expect(after - before).toBe(0);
  });

  it("a write inside .git does not refresh the tree", async () => {
    const before = await treeChangedCount();
    writeFileSync(join(wsDir, ".git", "E2E_MARKER"), "x\n");
    await sleep(1000);
    expect((await treeChangedCount()) - before).toBe(0);
  });

  it("a visible change refreshes the tree once and then stays quiet", async () => {
    const before = await treeChangedCount();
    writeFileSync(join(wsDir, "new-file.txt"), "hello\n");
    await browser.waitUntil(async () => (await treeChangedCount()) > before,
      { timeout: 3_000, timeoutMsg: "no tree:changed after creating a visible file" });
    // The refresh that follows runs `git status`; with optional locks off it must
    // not write into .git and so must not schedule another refresh.
    await sleep(2000);
    const after = await treeChangedCount();
    expect(after - before).toBeLessThanOrEqual(2);

    const row = await browser.$('[data-path$="/new-file.txt"]');
    await row.waitForExist({ timeout: 3_000 });
  });
});
