/**
 * Spec 32 – SSH connect error handling
 *
 * NOTE: Actual SSH connection testing requires the Tauri IPC `ssh_connect`
 * command which is not exposed via the HTTP dev API. These tests verify that
 * the app remains stable and functional in the area around SSH features —
 * normal workspace operations before and after reset — without attempting a
 * real SSH connection.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { api } from "../e2e/dev-api.js";

function makeTempWorkspace(prefix = "splice-ssh-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, "main.ts"), "export {};\n");
  return dir;
}

describe("SSH connect error handling", () => {
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

  it("app remains functional after reset", async () => {
    await api.reset();
    const state = await api.waitForReset({ timeoutMs: 8000 });
    expect(state.workspaces.length).toBe(0);
    expect(state.ui).toBeDefined();
  });

  it("opening a workspace after reset works", async () => {
    await api.openFolder(wsDir);
    const state = await api.waitForWorkspace({ timeoutMs: 8000 });
    expect(state.workspaces.length).toBe(1);
  });

  it("state is valid after workspace operations", async () => {
    const state = await api.state();
    const ws = state.workspaces[0];
    expect(ws).toBeDefined();
    expect(ws.terminalIds.length).toBeGreaterThanOrEqual(1);
    expect(ws.rootPath).toBe(wsDir);
  });

  it("no console errors from normal operations", async () => {
    const errors = await api.assertNoErrors({ failOnError: false });
    expect(errors.length).toBe(0);
  });
});
