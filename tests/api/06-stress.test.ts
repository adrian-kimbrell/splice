/**
 * Spec 06 – Stress / performance: rapid open/close cycles, memory, FDs, file open flood
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { api } from "../e2e/dev-api.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const port = parseInt(readFileSync("/tmp/splice-dev-api.port", "utf8").trim(), 10);

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

function getFdCount(pid: number): number {
  try {
    const lines = execSync(`lsof -p ${pid} 2>/dev/null | wc -l`).toString().trim();
    return parseInt(lines, 10) || 0;
  } catch { return 0; }
}

describe("Stress / performance", () => {
  beforeAll(async () => {
    await api.reset();
    await api.waitForReset();
  });

  afterAll(async () => {
    await api.reset().catch(() => {});
  });

  it("survives 10 rapid workspace open/close cycles", async () => {
    for (let i = 0; i < 10; i++) {
      const dir = mkdtempSync(join(tmpdir(), `splice-rapid-${i}-`));
      try {
        await api.openFolder(dir);
        await api.waitForWorkspace({ timeoutMs: 8000 });
        await api.reset();
        await api.waitForReset({ timeoutMs: 6000 });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const errors = await api.assertNoErrors({ failOnError: false });
    expect(errors.length).toBe(0);
  });

  it("memory growth under threshold after stress", async () => {
    const pid = getSplicePid();
    const rssBefore = getRssMb(pid);
    console.log(`  Baseline RSS: ${rssBefore.toFixed(1)} MB  PID=${pid}`);

    for (let i = 0; i < 10; i++) {
      const dir = mkdtempSync(join(tmpdir(), `splice-mem-${i}-`));
      try {
        await api.openFolder(dir);
        await api.waitForWorkspace({ timeoutMs: 8000 });
        await api.reset();
        await api.waitForReset({ timeoutMs: 6000 });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    await sleep(1500); // allow PTYs to clean up
    const rssAfter = getRssMb(pid);
    const delta = rssAfter - rssBefore;
    console.log(`  RSS after: ${rssAfter.toFixed(1)} MB  delta: ${delta.toFixed(1)} MB`);
    expect(delta).toBeLessThan(100);
  });

  it("file-descriptor count within threshold", async () => {
    const pid = getSplicePid();
    const fdBefore = getFdCount(pid);
    console.log(`  FD count before: ${fdBefore}  PID=${pid}`);

    const dir = mkdtempSync(join(tmpdir(), "splice-fd-"));
    try {
      await api.openFolder(dir);
      await api.waitForWorkspace({ timeoutMs: 8000 });
      await api.reset();
      await api.waitForReset({ timeoutMs: 6000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    await sleep(1000);
    const fdAfter = getFdCount(pid);
    const delta = fdAfter - fdBefore;
    console.log(`  FD count after: ${fdAfter}  delta: ${delta}`);
    expect(delta).toBeLessThan(20);
  });

  it("rapidly opening files does not crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "splice-flood-"));
    const files: string[] = [];
    try {
      for (let i = 0; i < 20; i++) {
        const filePath = join(dir, `file${i}.ts`);
        writeFileSync(filePath, `export const v${i} = ${i};\n`);
        files.push(filePath);
      }

      await api.openFolder(dir);
      await api.waitForWorkspace({ timeoutMs: 8000 });

      for (const filePath of files) {
        await fetch(`http://127.0.0.1:${port}/dev/open-file`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: filePath }),
        });
        await sleep(50);
      }

      await sleep(500);
      const state = await api.state();
      expect(state.workspaces[0].openFiles.length).toBeGreaterThan(0);

      const errors = await api.assertNoErrors({ failOnError: false });
      expect(errors.length).toBe(0);
    } finally {
      await api.reset().catch(() => {});
      await api.waitForReset({ timeoutMs: 6000 }).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
