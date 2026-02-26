/**
 * Spec 23 – Memory leak detection
 *
 * Six focused tests, each isolating one subsystem that is a known leak risk.
 * Tests 3b–3d rely on the `get_debug_stats` Tauri command which is only
 * compiled in `--features e2e` builds. Those tests skip gracefully when
 * `getDebugStats()` returns null (non-e2e build).
 *
 * Intended run time: ~4 minutes (dominated by PTY warm-up/teardown sleeps).
 */

import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { loadApp, openWorkspace, closeAllWorkspaces, sleep } from "./helpers";

// ── Local helpers ──────────────────────────────────────────────────────────

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

function getRss(pid: number): number {
  try {
    return parseInt(execSync(`ps -o rss= -p ${pid}`).toString().trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function makeTmpDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

interface DebugStats {
  terminal_count: number;
  watcher_count: number;
  workspace_count: number;
  lsp_session_count: number;
}

/**
 * Fire the async `getDebugStats()` invoke in the browser, wait for the result
 * to appear in `window.__debugStatsCache`, then read and return it.
 *
 * browser.execute() runs scripts synchronously so we can't await a Promise
 * directly. Instead we fire-and-forget, store the result in a window global,
 * and poll for it from Node.js via waitUntil.
 */
async function getDebugStats(): Promise<DebugStats | null> {
  // Clear stale cached result
  await browser.execute(() => {
    delete (window as unknown as Record<string, unknown>).__debugStatsCache;
  });

  // Fire the async Tauri invoke; store result on window when done
  await browser.execute(() => {
    void (
      window as unknown as {
        __spliceTest: { getDebugStats: () => Promise<unknown> };
      }
    ).__spliceTest
      .getDebugStats()
      .then((r) => {
        (window as unknown as Record<string, unknown>).__debugStatsCache =
          r !== null && r !== undefined ? r : "__null__";
      })
      .catch(() => {
        (window as unknown as Record<string, unknown>).__debugStatsCache = "__null__";
      });
  });

  // Poll until the result lands
  await browser.waitUntil(
    async () => {
      const cached = await browser.execute(
        () => (window as unknown as Record<string, unknown>).__debugStatsCache
      );
      return cached !== undefined;
    },
    { timeout: 5_000, interval: 100, timeoutMsg: "getDebugStats timed out" }
  );

  // Read and clear
  const raw = await browser.execute(() => {
    const val = (window as unknown as Record<string, unknown>).__debugStatsCache;
    delete (window as unknown as Record<string, unknown>).__debugStatsCache;
    return val;
  });

  return raw === "__null__" ? null : (raw as DebugStats);
}

// ── Suite ──────────────────────────────────────────────────────────────────

describe("Memory leak detection", function () {
  (this as unknown as { timeout: (ms: number) => void }).timeout(300_000);

  let pid: number;

  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser);
    await sleep(1000);
    pid = getSplicePid();
    console.log(`\n  [mem23] PID=${pid}`);
  });

  // ── 3a. File watcher FD accumulation (15 cycles) ──────────────────────
  //
  // Budget: 5 FDs/cycle — each open+close involves a PTY master FD, watcher
  // kqueue FDs, and WebKit IPC sockets. Spec 06 allows 5/cycle; we match that.
  // 1200ms open-wait ensures PTY registers with workspace before close fires.

  it("3a: file watcher FDs do not accumulate over 15 open/close cycles", async () => {
    const CYCLES = 15;
    const FD_BUDGET = CYCLES * 5; // 5 FDs per cycle ceiling

    await sleep(500);
    const fdBaseline = countFds(pid);

    for (let i = 0; i < CYCLES; i++) {
      const dir = makeTmpDir(`splice-mem23a-${i}-`);
      writeFileSync(join(dir, "a.ts"), `export const x = ${i};\n`);
      await openWorkspace(browser, dir);
      await sleep(1200); // long enough for PTY to spawn and register before close
      await closeAllWorkspaces(browser);
      await sleep(800);
      rmSync(dir, { recursive: true, force: true });
    }

    const fdFinal = countFds(pid);
    const delta = fdFinal - fdBaseline;
    console.log(`  [3a] FD delta: ${delta} over ${CYCLES} cycles  (baseline=${fdBaseline} final=${fdFinal} budget=${FD_BUDGET})`);
    expect(delta).toBeLessThan(FD_BUDGET);
  });

  // ── 3b. Watcher HashMap cleanup after close (relative count) ─────────
  //
  // Directly verifies that state.watchers removes the workspace watcher on
  // close. Uses a relative measurement (before vs after) to tolerate orphaned
  // watchers left by previous specs.

  it("3b: watcher HashMap cleans up workspace watcher on close", async () => {
    const dir = makeTmpDir("splice-mem23b-");
    writeFileSync(join(dir, "main.ts"), "export const x = 1;\n");

    // Record count before this test's workspace opens
    const statsBefore = await getDebugStats();
    if (!statsBefore) {
      console.log("  [3b] getDebugStats returned null (non-e2e build) — skipping");
      rmSync(dir, { recursive: true, force: true });
      return;
    }
    const countBefore = statsBefore.watcher_count;

    await openWorkspace(browser, dir);
    await sleep(300);

    const statsOpen = await getDebugStats();
    console.log(`  [3b] watcher_count: before=${countBefore} open=${statsOpen?.watcher_count}`);
    expect(statsOpen?.watcher_count).toBeGreaterThan(countBefore);

    await closeAllWorkspaces(browser);
    await sleep(800);

    const statsClosed = await getDebugStats();
    console.log(`  [3b] watcher_count after close: ${statsClosed?.watcher_count}  (expected=${countBefore})`);
    expect(statsClosed?.watcher_count).toBe(countBefore);

    rmSync(dir, { recursive: true, force: true });
  });

  // ── 3c. Terminal HashMap cleanup after close (relative count) ─────────
  //
  // Verifies that close_workspace removes the workspace's terminal from
  // state.terminals. Uses a relative measurement (before vs after) to avoid
  // sensitivity to terminals leaked by earlier tests.

  it("3c: terminal HashMap cleans up workspace terminal on close", async () => {
    const dir = makeTmpDir("splice-mem23c-");
    writeFileSync(join(dir, "main.ts"), "export const x = 1;\n");

    // Record count before this test's workspace opens
    const statsBefore = await getDebugStats();
    if (!statsBefore) {
      console.log("  [3c] getDebugStats returned null (non-e2e build) — skipping");
      rmSync(dir, { recursive: true, force: true });
      return;
    }
    const countBefore = statsBefore.terminal_count;

    await openWorkspace(browser, dir);
    await sleep(2000); // allow PTY to spawn fully

    const statsOpen = await getDebugStats();
    console.log(`  [3c] terminal_count: before=${countBefore} open=${statsOpen?.terminal_count}`);
    expect(statsOpen?.terminal_count).toBeGreaterThan(countBefore);

    await closeAllWorkspaces(browser);
    await sleep(2000); // allow PTY to exit

    const statsClosed = await getDebugStats();
    console.log(`  [3c] terminal_count after close: ${statsClosed?.terminal_count}  (expected=${countBefore})`);
    expect(statsClosed?.terminal_count).toBe(countBefore);

    rmSync(dir, { recursive: true, force: true });
  });

  // ── 3d. Repeated open/close cycles — terminal HashMap stays bounded ────
  //
  // Runs 5 workspace open/close cycles. Each cycle should add exactly 1
  // terminal then remove it. Verifies there is no accumulation across cycles.
  // Uses relative measurement anchored to the count before this test starts.

  it("3d: terminal HashMap stays bounded across repeated open/close cycles", async () => {
    const CYCLES = 5;

    const statsBefore = await getDebugStats();
    if (!statsBefore) {
      console.log("  [3d] getDebugStats returned null (non-e2e build) — skipping");
      return;
    }
    const countBefore = statsBefore.terminal_count;
    console.log(`  [3d] baseline terminal_count: ${countBefore}`);

    for (let i = 0; i < CYCLES; i++) {
      const dir = makeTmpDir(`splice-mem23d-${i}-`);
      writeFileSync(join(dir, "main.ts"), `const x = ${i};\n`);

      await openWorkspace(browser, dir);
      await sleep(2000); // allow PTY to spawn

      const statsOpen = await getDebugStats();
      console.log(`  [3d] cycle ${i}: terminal_count after open = ${statsOpen?.terminal_count}`);
      expect(statsOpen?.terminal_count).toBeGreaterThan(countBefore);

      await closeAllWorkspaces(browser);
      await sleep(2000); // allow PTY to exit

      const statsClose = await getDebugStats();
      console.log(`  [3d] cycle ${i}: terminal_count after close = ${statsClose?.terminal_count}`);
      expect(statsClose?.terminal_count).toBe(countBefore);

      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── 3e. PTY FD isolation (tight budget, 20 cycles) ────────────────────
  //
  // Budget: 5 FDs/cycle (same reasoning as 3a). The longer sleep (1s/1.5s)
  // gives PTY master FDs time to be released by the OS.

  it("3e: PTY file descriptors do not accumulate over 20 open/close cycles", async () => {
    const CYCLES = 20;
    const FD_BUDGET = CYCLES * 5; // 5 FDs per cycle ceiling

    await sleep(500);
    const fdBaseline = countFds(pid);

    for (let i = 0; i < CYCLES; i++) {
      const dir = makeTmpDir(`splice-mem23e-${i}-`);
      writeFileSync(join(dir, "a.ts"), `export const y = ${i};\n`);
      await openWorkspace(browser, dir);
      await sleep(1000); // allow PTY master + child to open
      await closeAllWorkspaces(browser);
      await sleep(1500); // allow PTY master FD to be released
      rmSync(dir, { recursive: true, force: true });
    }

    const fdFinal = countFds(pid);
    const delta = fdFinal - fdBaseline;
    console.log(`  [3e] FD delta: ${delta} over ${CYCLES} cycles  (baseline=${fdBaseline} final=${fdFinal} budget=${FD_BUDGET})`);
    expect(delta).toBeLessThan(FD_BUDGET);
  });

  // ── 3f. Sustained RSS over 50 rapid cycles (tight 25 MB budget) ───────
  //
  // Rapid cycles with no PTY wait — catches allocator fragmentation and
  // object accumulation in non-terminal code paths.

  it("3f: RSS growth stays under 25 MB over 50 rapid open/close cycles", async () => {
    const CYCLES = 50;
    const RSS_LIMIT_KB = 25_000;

    const rssBaseline = getRss(pid);
    console.log(`  [3f] RSS baseline: ${rssBaseline} KB`);

    for (let i = 0; i < CYCLES; i++) {
      const dir = makeTmpDir(`splice-mem23f-${i}-`);
      writeFileSync(join(dir, "a.ts"), `export const z = ${i};\n`);
      await openWorkspace(browser, dir);
      await sleep(200);
      await closeAllWorkspaces(browser);
      await sleep(300);
      rmSync(dir, { recursive: true, force: true });
    }

    await sleep(2000); // settle
    const rssFinal = getRss(pid);
    const delta = rssFinal - rssBaseline;
    console.log(`  [3f] RSS delta: ${delta} KB  (final=${rssFinal} KB  limit=${RSS_LIMIT_KB} KB)`);
    expect(delta).toBeLessThan(RSS_LIMIT_KB);
  });
});
