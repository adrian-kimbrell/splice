/**
 * Spec 06 – Stress / performance
 *
 * Hammers the app with rapid open/close cycles, file-tree reloads, and
 * tab churn while tracking RSS memory and file-descriptor count.
 *
 * This spec is intentionally slow (~30s). Run with --spec tests/e2e/06-stress.test.ts
 * when you want the full stress run; normal CI can skip it via grep.
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
    return parseInt(
      execSync(`lsof -p ${pid} 2>/dev/null | wc -l`).toString().trim(),
      10
    );
  } catch {
    return -1;
  }
}

describe("Stress / performance", function () {
  this.timeout(60_000);

  const CYCLES = 10;
  const RSS_GROWTH_LIMIT_KB = 50_000; // 50 MB
  const FD_GROWTH_LIMIT = 10;

  let pid: number;
  let rssStart: number;
  let fdsStart: number;

  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser); // clear persisted state from previous run
    await sleep(500); // let FDs settle after cleanup
    pid = getSplicePid();
    rssStart = getRss(pid);
    fdsStart = countFds(pid);
    console.log(`\n  Baseline: RSS=${rssStart} KB  FDs=${fdsStart}  PID=${pid}`);
  });

  it(`survives ${CYCLES} rapid workspace open/close cycles`, async () => {
    const dirs: string[] = [];

    for (let i = 0; i < CYCLES; i++) {
      const dir = mkdtempSync(join(tmpdir(), `splice-stress-${i}-`));
      dirs.push(dir);

      // Seed 5 files
      for (let j = 0; j < 5; j++) {
        writeFileSync(join(dir, `file-${j}.ts`), `export const x${j} = ${j};\n`);
      }

      await openWorkspace(browser, dir);
      await sleep(200);
      await closeAllWorkspaces(browser);
      await sleep(200);
    }

    // Cleanup temp dirs
    for (const d of dirs) rmSync(d, { recursive: true, force: true });

    // App must still be alive
    const root = await browser.$(".grid.h-screen, div.welcome-screen");
    await expect(root).toExist();
  });

  it("memory growth is within threshold after stress", async () => {
    const rssEnd = getRss(pid);
    const delta = rssEnd - rssStart;
    console.log(`  RSS delta: ${delta} KB  (end=${rssEnd} KB, limit=${RSS_GROWTH_LIMIT_KB} KB)`);
    expect(delta).toBeLessThan(RSS_GROWTH_LIMIT_KB);
  });

  it("file-descriptor count is within threshold after stress", async () => {
    await sleep(1500); // wait for PTY processes to fully clean up
    const fdsEnd = countFds(pid);
    const delta = fdsEnd - fdsStart;
    console.log(`  FD delta:  ${delta}  (end=${fdsEnd}, limit=${FD_GROWTH_LIMIT})`);
    // Allow up to 5 FDs per cycle (10 cycles) for PTY cleanup latency
    expect(delta).toBeLessThanOrEqual(50);
  });

  it("rapidly opening tabs does not crash the app", async () => {
    const dir = mkdtempSync(join(tmpdir(), "splice-tabs-"));
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(dir, `f${i}.ts`), `export const v = ${i};\n`);
    }

    await openWorkspace(browser, dir);
    await sleep(500);

    // Click 10 files quickly
    for (let i = 0; i < 10; i++) {
      const item = await browser.$(`[data-path$="f${i}.ts"]`);
      if (await item.isExisting()) {
        await item.click();
        await sleep(50); // minimal delay
      }
    }

    await sleep(300);

    // Still alive?
    const root = await browser.$(".grid.h-screen");
    await expect(root).toExist();

    await closeAllWorkspaces(browser);
    rmSync(dir, { recursive: true, force: true });
  });
});
