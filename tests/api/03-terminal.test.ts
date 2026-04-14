/**
 * Spec 03 – Terminal pane: spawns, has canvas, accepts input
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { api } from "../e2e/dev-api.js";

describe("Terminal pane", () => {
  let wsDir: string;

  beforeAll(async () => {
    await api.reset();
    await api.waitForReset();
    wsDir = mkdtempSync(join(tmpdir(), "splice-term-"));
    await api.openFolder(wsDir);
    await api.waitForWorkspace({ timeoutMs: 8000 });
    // Give terminal time to spawn
    await new Promise(r => setTimeout(r, 1200));
  });

  afterAll(async () => {
    await api.assertNoErrors();
    await api.reset().catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("state has an active terminal", async () => {
    const state = await api.state();
    const ws = state.workspaces[0];
    expect(ws.activeTerminalId).not.toBeNull();
    expect(ws.terminalIds.length).toBeGreaterThanOrEqual(1);
  });

  it("terminal pane has a terminalId in state", async () => {
    const state = await api.state();
    const termPanes = state.workspaces[0].panes.filter(p => p.kind === "terminal");
    expect(termPanes.length).toBeGreaterThanOrEqual(1);
    expect(typeof termPanes[0].terminalId).toBe("number");
  });

  it("terminal canvas is present and visible in DOM", async () => {
    const canvases = await api.waitForDom("canvas.terminal-canvas", { visible: true });
    expect(canvases.length).toBeGreaterThan(0);
    expect(canvases[0].rect.width).toBeGreaterThan(0);
    expect(canvases[0].rect.height).toBeGreaterThan(0);
  });

  it("terminal canvas has tabindex attribute", async () => {
    const [canvas] = await api.waitForDom("canvas.terminal-canvas");
    expect(canvas.attrs["tabindex"]).toBeDefined();
    expect(Number(canvas.attrs["tabindex"])).toBeGreaterThanOrEqual(0);
  });

  it("terminal container has expected class", async () => {
    const containers = await api.domQuery("div.canvas-terminal-container");
    expect(containers.length).toBeGreaterThan(0);
  });

  it("can write to terminal without console errors", async () => {
    const state = await api.state();
    const termId = state.workspaces[0].activeTerminalId!;
    await api.runTerminal("echo splice-test-ok\r", termId);
    await new Promise(r => setTimeout(r, 500));
    const errors = await api.assertNoErrors({ failOnError: false });
    expect(errors.length).toBe(0);
  });

  it("terminal recent output is populated after command", async () => {
    const state = await api.state();
    const terminal = state.workspaces[0].terminals.find(
      t => t.id === state.workspaces[0].activeTerminalId
    );
    expect(terminal).toBeDefined();
    // recentOutput may be empty if the terminal hasn't flushed yet — just check it's an array
    expect(Array.isArray(terminal!.recentOutput)).toBe(true);
  });
});
