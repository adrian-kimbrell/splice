/**
 * Spec 21 – Tab context menu: 3-file open, DOM tab presence, Cmd+K-W, Cmd+N
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { api } from "../e2e/dev-api.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const port = parseInt(readFileSync("/tmp/splice-dev-api.port", "utf8").trim(), 10);
const devPost = (path: string, body: object) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("Tab context menu", () => {
  let wsDir: string;
  const filePaths: string[] = [];

  beforeAll(async () => {
    await api.reset();
    await api.waitForReset();

    wsDir = mkdtempSync(join(tmpdir(), "splice-tabctx-"));
    for (let i = 0; i < 3; i++) {
      const p = join(wsDir, `tab${i}.ts`);
      writeFileSync(p, `export const tab${i} = ${i};\n`);
      filePaths.push(p);
    }

    await api.openFolder(wsDir);
    await api.waitForWorkspace({ timeoutMs: 8000 });
    await sleep(800);

    for (const p of filePaths) {
      await devPost("/dev/open-file", { path: p });
      await sleep(200);
    }
    await sleep(400);
  });

  afterAll(async () => {
    await api.reset().catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("DOM shows tab elements for the open files", async () => {
    const tabs = await api.waitForDom("[role='tab']", { timeoutMs: 6000 });
    expect(tabs.length).toBeGreaterThanOrEqual(3);
  });

  it("each tab has distinct text content", async () => {
    const tabs = await api.domQuery("[role='tab']");
    const texts = tabs.map(t => t.text.trim()).filter(Boolean);
    const unique = new Set(texts);
    // All tab texts should be unique (each file has a distinct name)
    expect(unique.size).toBe(texts.length);
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

  it("Cmd+N creates a new tab after all tabs closed", async () => {
    const before = (await api.state()).workspaces[0].openFiles.length;
    await api.keyboard("n", { meta: true });

    const state = await api.waitFor(
      s => (s.workspaces[0]?.openFiles.length ?? 0) > before,
      { label: "new tab created", timeoutMs: 5000 }
    );
    expect(state.workspaces[0].openFiles.length).toBeGreaterThan(0);
  });

  it("no errors throughout tab context menu operations", async () => {
    const errors = await api.assertNoErrors({ failOnError: false });
    expect(errors.length).toBe(0);
  });
});
