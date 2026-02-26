/**
 * Spec 16 – Advanced stress tests
 *
 * Heavy pane-split/close cycles, rapid file-open churn, many-tab overflow,
 * and workspace-churn combined with memory and FD tracking.
 *
 * These tests are intentionally slow. Run with:
 *   wdio run wdio.config.ts --spec tests/e2e/suite.ts
 * or use --grep to filter individual tests.
 */

import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { loadApp, openWorkspace, closeAllWorkspaces, sleep } from "./helpers";

function getSplicePid(): number {
  try {
    return parseInt(
      execSync("pgrep -x splice || pgrep -x Splice").toString().trim().split("\n")[0],
      10
    );
  } catch {
    return -1;
  }
}

function getRss(pid: number): number {
  try {
    return parseInt(execSync(`ps -o rss= -p ${pid}`).toString().trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function countFds(pid: number): number {
  try {
    return parseInt(execSync(`lsof -p ${pid} 2>/dev/null | wc -l`).toString().trim(), 10);
  } catch {
    return -1;
  }
}

describe("Advanced stress / performance", function () {
  (this as unknown as { timeout: (ms: number) => void }).timeout(120_000);

  const SPLIT_CYCLES = 15;
  const FILE_CHURN_COUNT = 30;
  const WORKSPACE_CYCLES = 8;

  let pid: number;
  let rssStart: number;
  let fdsStart: number;

  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser);
    await sleep(800);
    pid = getSplicePid();
    rssStart = getRss(pid);
    fdsStart = countFds(pid);
    console.log(`\n  [stress16] Baseline: RSS=${rssStart} KB  FDs=${fdsStart}  PID=${pid}`);
  });

  // ── Pane split/close churn ─────────────────────────────────────────────────

  it(`survives ${SPLIT_CYCLES} rapid split/close cycles`, async () => {
    const wsDir = mkdtempSync(join(tmpdir(), "splice-stress16-split-"));
    writeFileSync(join(wsDir, "main.ts"), "const x = 1;\n");

    await openWorkspace(browser, wsDir);
    await sleep(600);

    // Open a file so the editor pane has the split button
    const fileItem = await browser.$('[data-path$="main.ts"]');
    if (await fileItem.isExisting()) {
      await browser.execute((path: string) => {
        void (
          window as unknown as {
            __spliceTest: { openFilePinned: (p: string) => Promise<void> };
          }
        ).__spliceTest.openFilePinned(path);
      }, join(wsDir, "main.ts"));
      await sleep(300);
    }

    for (let i = 0; i < SPLIT_CYCLES; i++) {
      // Split right
      const splitBtn = await browser.$("button[title='Split Pane']");
      if (await splitBtn.isExisting()) {
        await splitBtn.click();
        await sleep(150);
        const item = await browser.$("button.split-dropdown-item");
        if (await item.isExisting()) {
          await item.click();
          await sleep(200);
        }
      }

      // Close the newest pane
      const closeBtns = await browser.$$("button.pane-action-btn.close");
      if (closeBtns.length > 0) {
        await closeBtns[closeBtns.length - 1].click();
        await sleep(150);
      }
    }

    const root = await browser.$(".grid.h-screen");
    await expect(root).toExist();

    await closeAllWorkspaces(browser);
    rmSync(wsDir, { recursive: true, force: true });
  });

  // ── Rapid file open/close churn ───────────────────────────────────────────

  it(`survives rapid open/close of ${FILE_CHURN_COUNT} files`, async () => {
    const wsDir = mkdtempSync(join(tmpdir(), "splice-stress16-files-"));
    for (let i = 0; i < FILE_CHURN_COUNT; i++) {
      writeFileSync(join(wsDir, `f${i}.ts`), `export const v${i} = ${i};\n`);
    }

    await openWorkspace(browser, wsDir);
    await sleep(600);

    // Open all files in rapid succession using the test API
    for (let i = 0; i < FILE_CHURN_COUNT; i++) {
      await browser.execute((path: string) => {
        void (
          window as unknown as {
            __spliceTest: { openFilePinned: (p: string) => Promise<void> };
          }
        ).__spliceTest.openFilePinned(path);
      }, join(wsDir, `f${i}.ts`));
      await sleep(20);
    }
    await sleep(500);

    // All tabs should be open (or the browser hasn't crashed)
    const tabs = await browser.$$('[role="tab"]');
    expect(tabs.length).toBeGreaterThan(0);

    // Close all tabs
    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "k",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    await sleep(100);
    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "KeyW",
          bubbles: true,
          cancelable: true,
        })
      );
    });
    await sleep(400);

    const root = await browser.$(".grid.h-screen");
    await expect(root).toExist();

    await closeAllWorkspaces(browser);
    rmSync(wsDir, { recursive: true, force: true });
  });

  // ── Many-tab overflow test ─────────────────────────────────────────────────

  it("tab bar handles 20 open tabs without overflow crash", async () => {
    const wsDir = mkdtempSync(join(tmpdir(), "splice-stress16-tabbar-"));
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(wsDir, `tab${i}.ts`), `export const t${i} = ${i};\n`);
    }

    await openWorkspace(browser, wsDir);
    await sleep(600);

    for (let i = 0; i < 20; i++) {
      await browser.execute((path: string) => {
        void (
          window as unknown as {
            __spliceTest: { openFilePinned: (p: string) => Promise<void> };
          }
        ).__spliceTest.openFilePinned(path);
      }, join(wsDir, `tab${i}.ts`));
      await sleep(15);
    }
    await sleep(400);

    // Tab bar element should still be present (it scrolls, doesn't break)
    const tabBar = await browser.$('[role="tablist"], .tab-bar, div.flex.bg-tab');
    await expect(tabBar).toExist();

    await closeAllWorkspaces(browser);
    rmSync(wsDir, { recursive: true, force: true });
  });

  // ── Multiple workspace churn ───────────────────────────────────────────────

  it(`survives ${WORKSPACE_CYCLES} workspace open/close/switch cycles`, async () => {
    const dirs: string[] = [];

    for (let i = 0; i < WORKSPACE_CYCLES; i++) {
      const dir = mkdtempSync(join(tmpdir(), `splice-stress16-ws${i}-`));
      dirs.push(dir);
      for (let j = 0; j < 3; j++) {
        writeFileSync(join(dir, `f${j}.ts`), `export const v = ${j};\n`);
      }

      await openWorkspace(browser, dir);
      await sleep(150);

      // Switch to a previous workspace if there are multiple
      const ids = await browser.execute(() => {
        return (
          window as unknown as { __spliceTest: { getWorkspaceIds: () => string[] } }
        ).__spliceTest.getWorkspaceIds();
      }) as string[];
      if (ids.length > 1) {
        await browser.execute((id: string) => {
          (
            window as unknown as { __spliceTest: { switchToWorkspace: (id: string) => void } }
          ).__spliceTest.switchToWorkspace(id);
        }, ids[0]);
        await sleep(100);
      }
    }

    const root = await browser.$(".grid.h-screen, div.welcome-screen");
    await expect(root).toExist();

    await closeAllWorkspaces(browser);
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  // ── Split + file churn combined ────────────────────────────────────────────

  it("combined split + file churn does not leak panes", async () => {
    const wsDir = mkdtempSync(join(tmpdir(), "splice-stress16-combo-"));
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(wsDir, `c${i}.ts`), `export const x = ${i};\n`);
    }

    await openWorkspace(browser, wsDir);
    await sleep(600);

    // Open file, split, open file in new pane, close new pane — repeat 5×
    await browser.execute((path: string) => {
      void (
        window as unknown as {
          __spliceTest: { openFilePinned: (p: string) => Promise<void> };
        }
      ).__spliceTest.openFilePinned(path);
    }, join(wsDir, "c0.ts"));
    await sleep(300);

    const basePanes = (await browser.$$("[data-pane-id]")).length;

    for (let i = 1; i <= 5; i++) {
      const splitBtn = await browser.$("button[title='Split Pane']");
      if (await splitBtn.isExisting()) {
        await splitBtn.click();
        await sleep(150);
        const item = await browser.$("button.split-dropdown-item");
        if (await item.isExisting()) { await item.click(); await sleep(200); }
      }

      await browser.execute((path: string) => {
        void (
          window as unknown as {
            __spliceTest: { openFilePinned: (p: string) => Promise<void> };
          }
        ).__spliceTest.openFilePinned(path);
      }, join(wsDir, `c${i}.ts`));
      await sleep(100);

      const closeBtns = await browser.$$("button.pane-action-btn.close");
      if (closeBtns.length > 0) {
        await closeBtns[closeBtns.length - 1].click();
        await sleep(200);
      }
    }

    const finalPanes = (await browser.$$("[data-pane-id]")).length;
    // Should be back to base pane count (no pane leak)
    expect(finalPanes).toBe(basePanes);

    await closeAllWorkspaces(browser);
    rmSync(wsDir, { recursive: true, force: true });
  });

  // ── Resource tracking ──────────────────────────────────────────────────────

  it("RSS memory growth is within 60 MB after all stress cycles", async () => {
    const rssEnd = getRss(pid);
    const delta = rssEnd - rssStart;
    console.log(`  [stress16] RSS delta: ${delta} KB  (end=${rssEnd} KB  limit=60000 KB)`);
    expect(delta).toBeLessThan(60_000);
  });

  it("file descriptor count is within threshold after all stress cycles", async () => {
    await sleep(2000); // extra wait for PTY cleanup
    const fdsEnd = countFds(pid);
    const delta = fdsEnd - fdsStart;
    console.log(`  [stress16] FD delta:  ${delta}  (end=${fdsEnd}  limit=80)`);
    expect(delta).toBeLessThanOrEqual(80);
  });
});
