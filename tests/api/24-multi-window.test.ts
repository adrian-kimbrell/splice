/**
 * Spec 24 – Multi-window
 *
 * Verifies basic state consistency: app structure, workspace lifecycle, and
 * that repeated resets leave state clean. Multi-window in the full sense
 * requires Tauri window creation APIs not yet exposed over HTTP; these tests
 * cover the observable single-window state path instead.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { api } from "../e2e/dev-api.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function makeTempWorkspace(prefix = "splice-mwin-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, "index.ts"), "export {};\n");
  return dir;
}

describe("Multi-window", () => {
  let wsDir: string;

  beforeAll(async () => {
    await api.reset();
    await api.waitForReset();
    wsDir = makeTempWorkspace();
  });

  afterAll(async () => {
    await api.reset().catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("app loads with valid state", async () => {
    const state = await api.state();
    expect(Array.isArray(state.workspaces)).toBe(true);
    expect(typeof state.ui.explorerVisible).toBe("boolean");
    expect(typeof state.ui.workspacesVisible).toBe("boolean");
    expect(typeof state.ui.zenMode).toBe("boolean");
    expect(typeof state.ui.explorerWidth).toBe("number");
  });

  it("opening a workspace does not crash", async () => {
    await api.openFolder(wsDir);
    const state = await api.waitForWorkspace({ timeoutMs: 8000 });
    expect(state.workspaces.length).toBe(1);
  });

  it("workspace has correct structure", async () => {
    const state = await api.state();
    const ws = state.workspaces[0];
    expect(ws).toBeDefined();
    expect(ws.terminalIds.length).toBeGreaterThanOrEqual(1);
    expect(ws.panes.length).toBeGreaterThanOrEqual(1);
    expect(ws.rootPath).toBe(wsDir);
  });

  it("reset clears all workspaces", async () => {
    await api.reset();
    const state = await api.waitForReset({ timeoutMs: 8000 });
    expect(state.workspaces.length).toBe(0);
  });

  it("state is consistent across multiple resets", async () => {
    for (let i = 0; i < 3; i++) {
      await api.reset();
      const state = await api.waitForReset({ timeoutMs: 6000 });
      expect(state.workspaces.length).toBe(0);
      await sleep(200);
    }

    const errors = await api.assertNoErrors({ failOnError: false });
    expect(errors.length).toBe(0);
  });
});
