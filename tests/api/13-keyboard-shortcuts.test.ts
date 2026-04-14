/**
 * Spec 13 – Keyboard shortcuts: Cmd+N/W/B/P/Shift+F/K-W chord
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

describe("Keyboard shortcuts", () => {
  let wsDir: string;
  let samplePath: string;

  beforeAll(async () => {
    await api.reset();
    await api.waitForReset();

    wsDir = mkdtempSync(join(tmpdir(), "splice-kbd-"));
    samplePath = join(wsDir, "sample.ts");
    writeFileSync(samplePath, "export const sample = true;\n");

    await api.openFolder(wsDir);
    await api.waitForWorkspace({ timeoutMs: 8000 });
    await sleep(800);

    await devPost("/dev/open-file", { path: samplePath });
    await sleep(600);
  });

  afterAll(async () => {
    await api.reset().catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("Cmd+N creates a new untitled file", async () => {
    const before = (await api.state()).workspaces[0].openFiles.length;
    await api.keyboard("n", { meta: true });

    const state = await api.waitFor(
      s => (s.workspaces[0]?.openFiles.length ?? 0) > before,
      { label: "new untitled file", timeoutMs: 6000 }
    );

    const hasUntitled = state.workspaces[0].openFiles.some(
      f => /untitled/i.test(f.name) || /untitled/i.test(f.path)
    );
    expect(hasUntitled).toBe(true);
  });

  it("Cmd+W closes the active tab", async () => {
    const before = (await api.state()).workspaces[0].openFiles.length;
    await api.keyboard("w", { meta: true });

    const state = await api.waitFor(
      s => (s.workspaces[0]?.openFiles.length ?? 0) < before,
      { label: "tab closed", timeoutMs: 6000 }
    );

    expect(state.workspaces[0].openFiles.length).toBe(before - 1);
  });

  it("Cmd+B hides the explorer sidebar", async () => {
    // Ensure explorer is visible first
    await api.setUi({ explorerVisible: true });
    await sleep(200);

    await api.keyboard("b", { meta: true });

    const state = await api.waitFor(
      s => s.ui.explorerVisible === false,
      { label: "explorer hidden", timeoutMs: 5000 }
    );
    expect(state.ui.explorerVisible).toBe(false);
  });

  it("Cmd+B toggles explorer back on", async () => {
    await api.keyboard("b", { meta: true });

    const state = await api.waitFor(
      s => s.ui.explorerVisible === true,
      { label: "explorer visible", timeoutMs: 5000 }
    );
    expect(state.ui.explorerVisible).toBe(true);
  });

  it("Cmd+P opens command palette", async () => {
    await api.keyboard("p", { meta: true });

    const inputs = await api.waitForDom('input[placeholder="Type a command…"]', {
      timeoutMs: 3000,
    });
    expect(inputs.length).toBeGreaterThan(0);
  });

  it("Escape closes the command palette", async () => {
    await api.keyboard("Escape");
    await sleep(300);

    const inputs = await api.domQuery('input[placeholder="Type a command…"]');
    expect(inputs.length).toBe(0);
  });

  it("Cmd+Shift+F opens search sidebar", async () => {
    await api.keyboard("f", { meta: true, shift: true });

    const state = await api.waitFor(
      s => s.ui.sidebarMode === "search",
      { label: "search sidebar", timeoutMs: 5000 }
    );
    expect(state.ui.sidebarMode).toBe("search");
  });

  it("Cmd+K then W chord closes all tabs", async () => {
    // Ensure at least one file is open
    const check = await api.state();
    if ((check.workspaces[0]?.openFiles.length ?? 0) === 0) {
      await devPost("/dev/open-file", { path: samplePath });
      await sleep(500);
    }

    await api.keyboard("k", { meta: true });
    await sleep(100);
    await api.keyboard("w");

    const state = await api.waitFor(
      s => (s.workspaces[0]?.openFiles.length ?? 0) === 0,
      { label: "all tabs closed", timeoutMs: 8000 }
    );
    expect(state.workspaces[0].openFiles.length).toBe(0);
  });

  it("no errors throughout", async () => {
    const errors = await api.assertNoErrors({ failOnError: false });
    expect(errors.length).toBe(0);
  });
});
