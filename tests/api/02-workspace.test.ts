/**
 * Spec 02 – Workspace open / close lifecycle
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { api } from "../e2e/dev-api.js";

function makeTempWorkspace(prefix = "splice-api-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, "hello.ts"), "export const hello = 'world';\n");
  writeFileSync(join(dir, "README.md"), "# Test workspace\n");
  return dir;
}

describe("Workspace lifecycle", () => {
  let wsDir: string;

  beforeAll(async () => {
    await api.reset();
    await api.waitForReset();
    wsDir = makeTempWorkspace();
  });

  afterAll(async () => {
    await api.assertNoErrors();
    await api.reset().catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("opens a workspace via dev API", async () => {
    await api.openFolder(wsDir);
    const state = await api.waitForWorkspace({ timeoutMs: 8000 });
    expect(state.workspaces.length).toBe(1);
  });

  it("workspace root path matches the opened directory", async () => {
    const state = await api.state();
    expect(state.workspaces[0].rootPath).toBe(wsDir);
  });

  it("workspace name matches the folder name", async () => {
    const state = await api.state();
    const folderName = wsDir.split("/").pop()!;
    expect(state.workspaces[0].name).toContain(folderName.substring(0, 8));
  });

  it("workspace has at least one terminal", async () => {
    const state = await api.state();
    const ws = state.workspaces[0];
    expect(ws.terminalIds.length).toBeGreaterThanOrEqual(1);
    expect(ws.activeTerminalId).not.toBeNull();
  });

  it("workspace panes include a terminal pane", async () => {
    const state = await api.state();
    const termPanes = state.workspaces[0].panes.filter(p => p.kind === "terminal");
    expect(termPanes.length).toBeGreaterThanOrEqual(1);
    expect(termPanes[0].terminalId).not.toBeNull();
  });

  it("DOM shows a pane element", async () => {
    const panes = await api.waitForDom("[data-pane-id]");
    expect(panes.length).toBeGreaterThan(0);
  });

  it("DOM shows the file tree", async () => {
    const tree = await api.waitForDom('[role="tree"]', { timeoutMs: 5000 });
    expect(tree.length).toBeGreaterThan(0);
  });

  it("workspace appears in the sidebar DOM", async () => {
    const groups = await api.domQuery(".workspace-group");
    expect(groups.length).toBeGreaterThan(0);
  });

  it("closing workspace removes it from state", async () => {
    await api.reset();
    const state = await api.waitForReset();
    expect(state.workspaces.length).toBe(0);
  });

  it("sidebar DOM clears after close", async () => {
    const deadline = Date.now() + 4000;
    let groups = await api.domQuery(".workspace-group");
    while (groups.length > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 150));
      groups = await api.domQuery(".workspace-group");
    }
    expect(groups.length).toBe(0);
  });
});

describe("Watcher accumulation (open/close × 5)", () => {
  afterAll(async () => {
    await api.assertNoErrors();
  });

  it("no console errors after 5 open/close cycles", async () => {
    for (let i = 0; i < 5; i++) {
      const dir = makeTempWorkspace(`splice-leak-${i}-`);
      await api.openFolder(dir);
      await api.waitForWorkspace({ timeoutMs: 6000 });
      await api.reset();
      await api.waitForReset({ timeoutMs: 4000 });
      rmSync(dir, { recursive: true, force: true });
    }
    const errors = await api.assertNoErrors({ failOnError: false });
    expect(errors.length).toBe(0);
  });
});
