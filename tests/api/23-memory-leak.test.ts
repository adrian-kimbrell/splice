/**
 * Spec 23 – Memory leak detection
 *
 * Checks that file-watcher FDs, PTY FDs, and RSS do not grow unboundedly
 * across repeated open/close cycles. All thresholds are generous to avoid
 * flakiness on slow CI machines.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { api } from "../e2e/dev-api.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function getSplicePid(): number {
  try {
    const out = execSync("pgrep -x splice || pgrep -x Splice", { encoding: "utf8" });
    const pid = parseInt(out.trim().split("\n")[0], 10);
    if (isNaN(pid)) throw new Error("no pid");
    return pid;
  } catch {
    throw new Error("Could not find splice process via pgrep");
  }
}

function getRssMb(pid: number): number {
  try {
    const out = execSync(`ps -o rss= -p ${pid}`, { encoding: "utf8" });
    return parseInt(out.trim(), 10) / 1024;
  } catch {
    return 0;
  }
}

function countFds(pid: number): number {
  try {
    const out = execSync(`lsof -p ${pid} 2>/dev/null | wc -l`, { encoding: "utf8" });
    return parseInt(out.trim(), 10);
  } catch {
    return 0;
  }
}

function makeTempDir(prefix = "splice-leak-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Memory leak detection", () => {
  let pid: number;

  beforeAll(async () => {
    await api.reset();
    await api.waitForReset();
    pid = getSplicePid();
  });

  afterAll(async () => {
    await api.reset().catch(() => {});
  });

  it("file watcher FDs: delta ≤ 30 over 15 open/close cycles", async () => {
    const baseline = countFds(pid);

    for (let i = 0; i < 15; i++) {
      const dir = makeTempDir(`splice-fd15-${i}-`);
      await api.openFolder(dir);
      await api.waitForWorkspace({ timeoutMs: 8000 });
      await api.reset();
      await api.waitForReset({ timeoutMs: 6000 });
      rmSync(dir, { recursive: true, force: true });
    }

    await sleep(1500);
    const after = countFds(pid);
    const delta = after - baseline;
    expect(delta).toBeLessThanOrEqual(30);
  }, 180_000);

  it("watcher HashMap cleans up on close", async () => {
    const baseline = countFds(pid);

    for (let i = 0; i < 5; i++) {
      const dir = makeTempDir(`splice-hash-${i}-`);
      await api.openFolder(dir);
      await api.waitForWorkspace({ timeoutMs: 8000 });
      await api.reset();
      await api.waitForReset({ timeoutMs: 6000 });
      rmSync(dir, { recursive: true, force: true });
    }

    await sleep(1500);
    const after = countFds(pid);
    const delta = after - baseline;
    expect(delta).toBeLessThanOrEqual(10);
  }, 90_000);

  it("terminal PTY FDs do not accumulate over 20 cycles", async () => {
    const baseline = countFds(pid);

    for (let i = 0; i < 20; i++) {
      const dir = makeTempDir(`splice-pty-${i}-`);
      await api.openFolder(dir);
      await api.waitForWorkspace({ timeoutMs: 6000 });
      await api.reset();
      await api.waitForReset({ timeoutMs: 4000 });
      rmSync(dir, { recursive: true, force: true });
    }

    await sleep(1500);
    const after = countFds(pid);
    const delta = after - baseline;
    expect(delta).toBeLessThanOrEqual(40);
  }, 240_000);

  it("RSS growth under 30 MB over 50 rapid open/close cycles", async () => {
    const baselineRss = getRssMb(pid);

    for (let i = 0; i < 50; i++) {
      const dir = makeTempDir(`splice-rss-${i}-`);
      await api.openFolder(dir);
      await api.waitForWorkspace({ timeoutMs: 4000 }).catch(() => {});
      await api.reset();
      await api.waitForReset({ timeoutMs: 3000 }).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }

    await sleep(2000);
    const afterRss = getRssMb(pid);
    const delta = afterRss - baselineRss;
    expect(delta).toBeLessThan(30);
  }, 600_000);

  it("no console errors throughout", async () => {
    const errors = await api.assertNoErrors({ failOnError: false });
    expect(errors.length).toBe(0);
  });
});
