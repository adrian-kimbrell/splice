/**
 * Spec 05 – Stress: 20 rapid splits, state integrity, no errors
 *
 * Lighter than the standalone stress-test.py (which does 100 terminals)
 * but fast enough to run in CI. Validates that rapid splits don't produce
 * console errors and that state stays consistent.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { api } from "../e2e/dev-api.js";

function getSplicePid(): number {
  try {
    return parseInt(
      execSync("pgrep -x splice || pgrep -x Splice").toString().trim().split("\n")[0],
      10
    );
  } catch { return -1; }
}

function getRssMb(pid: number): number {
  try {
    const kb = parseInt(execSync(`ps -o rss= -p ${pid}`).toString().trim(), 10) || 0;
    return kb / 1024;
  } catch { return 0; }
}

describe("Rapid split stress (20 terminals)", () => {
  let wsDir: string;
  const TARGET = 20;

  beforeAll(async () => {
    await api.reset();
    await api.waitForReset();
    wsDir = mkdtempSync(join(tmpdir(), "splice-stress-"));
    await api.openFolder(wsDir);
    await api.waitForWorkspace({ timeoutMs: 8000 });
    await new Promise(r => setTimeout(r, 500));
  });

  afterAll(async () => {
    await api.reset().catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it(`spawns ${TARGET} terminals without errors`, async () => {
    const directions = ["vertical", "horizontal"] as const;
    for (let i = 1; i < TARGET; i++) {
      await api.splitPane(directions[i % 2]);
      await new Promise(r => setTimeout(r, 100));
    }

    const state = await api.waitFor(
      s => s.workspaces[0]?.terminalIds.length >= TARGET,
      { label: `${TARGET} terminals`, timeoutMs: 30_000 }
    );
    expect(state.workspaces[0].terminalIds.length).toBe(TARGET);

    const errors = await api.assertNoErrors({ failOnError: false });
    if (errors.length > 0) {
      console.error("Console errors during stress:", errors.map(e => e.message));
    }
    expect(errors.length).toBe(0);
  });

  it("state serialization stays under 2s with 20 terminals", async () => {
    const t0 = Date.now();
    await api.state();
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(2000);
  });

  it("all panes have distinct IDs in DOM", async () => {
    const panes = await api.domQuery("[data-pane-id]");
    const ids = panes.map(p => p.attrs["data-pane-id"]).filter(Boolean);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(TARGET);
  });
});

describe("Memory / FD leak (open/close × 10)", () => {
  let pid: number;
  let rssBefore: number;

  beforeAll(async () => {
    await api.reset();
    await api.waitForReset();
    pid = getSplicePid();
    rssBefore = getRssMb(pid);
    console.log(`  Baseline RSS: ${rssBefore.toFixed(1)} MB  PID=${pid}`);
  });

  afterAll(async () => {
    await api.assertNoErrors();
  });

  it("RSS growth under 100 MB after 10 open/close cycles", async () => {
    for (let i = 0; i < 10; i++) {
      const dir = mkdtempSync(join(tmpdir(), `splice-mem-${i}-`));
      await api.openFolder(dir);
      await api.waitForWorkspace({ timeoutMs: 6000 });
      await api.reset();
      await api.waitForReset({ timeoutMs: 4000 });
      rmSync(dir, { recursive: true, force: true });
    }

    await new Promise(r => setTimeout(r, 1500)); // let PTYs clean up
    const rssAfter = getRssMb(pid);
    const delta = rssAfter - rssBefore;
    console.log(`  RSS after: ${rssAfter.toFixed(1)} MB  delta: ${delta.toFixed(1)} MB`);
    expect(delta).toBeLessThan(100);
  });
});
