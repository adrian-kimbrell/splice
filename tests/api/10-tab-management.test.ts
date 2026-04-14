/**
 * Spec 10 – Tab management: open 5 files, Cmd+K-W, Cmd+N, Cmd+W, DOM tabs
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { api } from "../e2e/dev-api.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const port = parseInt(readFileSync("/tmp/splice-dev-api.port", "utf8").trim(), 10);

describe("Tab management", () => {
  let wsDir: string;
  const files: string[] = [];

  beforeAll(async () => {
    await api.reset();
    await api.waitForReset();

    wsDir = mkdtempSync(join(tmpdir(), "splice-tabs-"));

    for (let i = 0; i < 8; i++) {
      const p = join(wsDir, `f${i}.ts`);
      writeFileSync(p, `export const f${i} = ${i};\n`);
      files.push(p);
    }

    await api.openFolder(wsDir);
    await api.waitForWorkspace({ timeoutMs: 8000 });
    await sleep(800);

    // Open 5 files
    for (let i = 0; i < 5; i++) {
      await fetch(`http://127.0.0.1:${port}/dev/open-file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: files[i] }),
      });
      await sleep(150);
    }
    await sleep(500);
  });

  afterAll(async () => {
    await api.assertNoErrors();
    await api.reset().catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("opening 5 files creates 5 entries in openFiles", async () => {
    const state = await api.waitFor(
      s => (s.workspaces[0]?.openFiles.length ?? 0) >= 5,
      { label: "5 open files", timeoutMs: 8000 }
    );
    expect(state.workspaces[0].openFiles.length).toBeGreaterThanOrEqual(5);
  });

  it("DOM shows tab elements when files are open", async () => {
    const tabs = await api.waitForDom("[role='tab']", { timeoutMs: 5000 });
    expect(tabs.length).toBeGreaterThanOrEqual(1);
  });

  it("Cmd+K W closes all tabs", async () => {
    await api.keyboard("k", { meta: true });
    await sleep(100);
    await api.keyboard("w");

    const state = await api.waitFor(
      s => (s.workspaces[0]?.openFiles.length ?? 0) === 0,
      { label: "all tabs closed", timeoutMs: 8000 }
    );
    expect(state.workspaces[0].openFiles.length).toBe(0);
  });

  it("Cmd+N creates new untitled tab", async () => {
    const before = (await api.state()).workspaces[0].openFiles.length;
    await api.keyboard("n", { meta: true });

    const state = await api.waitFor(
      s => (s.workspaces[0]?.openFiles.length ?? 0) > before,
      { label: "new untitled tab", timeoutMs: 5000 }
    );

    const hasUntitled = state.workspaces[0].openFiles.some(
      f => f.name.toLowerCase().includes("untitled") || f.path.toLowerCase().includes("untitled")
    );
    expect(hasUntitled).toBe(true);
  });

  it("Cmd+W closes active tab", async () => {
    const before = (await api.state()).workspaces[0].openFiles.length;
    await api.keyboard("w", { meta: true });

    const state = await api.waitFor(
      s => (s.workspaces[0]?.openFiles.length ?? 0) < before,
      { label: "tab closed", timeoutMs: 5000 }
    );

    expect(state.workspaces[0].openFiles.length).toBe(before - 1);
  });

  it("no errors throughout tab operations", async () => {
    const errors = await api.assertNoErrors({ failOnError: false });
    expect(errors.length).toBe(0);
  });
});
