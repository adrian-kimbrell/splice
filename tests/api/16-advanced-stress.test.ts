/**
 * Spec 16 – Advanced stress: rapid split/close cycles, 20-file open, workspace cycling, RSS
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { api } from "../e2e/dev-api.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const port = parseInt(readFileSync("/tmp/splice-dev-api.port", "utf8").trim(), 10);
const devPost = (path: string, body: object) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

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

function getRssMb(pid: number): number {
  try {
    const kb = parseInt(execSync(`ps -o rss= -p ${pid}`).toString().trim(), 10) || 0;
    return kb / 1024;
  } catch {
    return 0;
  }
}

describe("Advanced stress", () => {
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
    await api.reset().catch(() => {});
  });

  it("survives 15 rapid split/close cycles", async () => {
    const directions = ["vertical", "horizontal"] as const;

    for (let i = 0; i < 15; i++) {
      const wsDir = mkdtempSync(join(tmpdir(), `splice-stress-split-${i}-`));
      try {
        await api.openFolder(wsDir);
        await api.waitForWorkspace({ timeoutMs: 8000 });
        await sleep(300);

        await api.splitPane(directions[i % 2]);
        await sleep(150);

        await api.reset();
        await api.waitForReset({ timeoutMs: 6000 });
      } finally {
        rmSync(wsDir, { recursive: true, force: true });
      }
    }

    const errors = await api.assertNoErrors({ failOnError: false });
    expect(errors.length).toBe(0);
  });

  it("survives rapid open/close of 20 files", async () => {
    const wsDir = mkdtempSync(join(tmpdir(), "splice-stress-files-"));
    const filePaths: string[] = [];

    try {
      for (let i = 0; i < 20; i++) {
        const p = join(wsDir, `file${i}.ts`);
        writeFileSync(p, `export const f${i} = ${i};\n`);
        filePaths.push(p);
      }

      await api.openFolder(wsDir);
      await api.waitForWorkspace({ timeoutMs: 8000 });
      await sleep(800);

      for (const p of filePaths) {
        await devPost("/dev/open-file", { path: p });
        await sleep(30);
      }

      await sleep(500);

      const errors = await api.assertNoErrors({ failOnError: false });
      expect(errors.length).toBe(0);

      await api.reset();
      await api.waitForReset({ timeoutMs: 6000 });
    } finally {
      rmSync(wsDir, { recursive: true, force: true });
    }
  });

  it("survives 8 workspace open/close/switch cycles", async () => {
    const dirs: string[] = [];
    try {
      for (let i = 0; i < 8; i++) {
        const wsDir = mkdtempSync(join(tmpdir(), `splice-stress-ws-${i}-`));
        dirs.push(wsDir);

        await api.openFolder(wsDir);
        await api.waitForWorkspace({ timeoutMs: 8000 });
        await sleep(200);

        await api.reset();
        await api.waitForReset({ timeoutMs: 6000 });
      }

      const errors = await api.assertNoErrors({ failOnError: false });
      expect(errors.length).toBe(0);
    } finally {
      for (const d of dirs) {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });

  it("RSS memory growth under 100 MB after all cycles", async () => {
    await sleep(1500); // allow PTYs and GC to settle
    const rssAfter = getRssMb(pid);
    const delta = rssAfter - rssBefore;
    console.log(`  RSS after: ${rssAfter.toFixed(1)} MB  delta: ${delta.toFixed(1)} MB`);
    expect(delta).toBeLessThan(100);
  });

  it("combined stress: no pane state corruption after split+reset+reopen", async () => {
    const wsDir = mkdtempSync(join(tmpdir(), "splice-stress-combined-"));
    try {
      await api.openFolder(wsDir);
      await api.waitForWorkspace({ timeoutMs: 8000 });
      await sleep(500);

      // Split 5 times
      for (let i = 0; i < 5; i++) {
        await api.splitPane(i % 2 === 0 ? "vertical" : "horizontal");
        await sleep(100);
      }

      // Reset
      await api.reset();
      await api.waitForReset({ timeoutMs: 8000 });

      // Reopen the same workspace
      await api.openFolder(wsDir);
      const state = await api.waitForWorkspace({ timeoutMs: 8000 });

      // After a fresh open, should have exactly 1 terminal (not the 6 from before)
      expect(state.workspaces[0].terminalIds.length).toBe(1);
    } finally {
      rmSync(wsDir, { recursive: true, force: true });
    }
  });

  it("no console errors throughout", async () => {
    const errors = await api.assertNoErrors({ failOnError: false });
    expect(errors.length).toBe(0);
  });
});
