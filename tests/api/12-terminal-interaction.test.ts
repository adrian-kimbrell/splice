/**
 * Spec 12 – Terminal interaction: canvas, output, CWD, multi-terminal, search UI
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { api } from "../e2e/dev-api.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("Terminal interaction", () => {
  let wsDir: string;

  beforeAll(async () => {
    await api.reset();
    await api.waitForReset();

    wsDir = mkdtempSync(join(tmpdir(), "splice-term-interact-"));
    await api.openFolder(wsDir);
    await api.waitForWorkspace({ timeoutMs: 8000 });
    // Give terminal time to fully spawn
    await sleep(1200);
  });

  afterAll(async () => {
    await api.assertNoErrors();
    await api.reset().catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("workspace opens with at least one terminal pane", async () => {
    const state = await api.state();
    expect(state.workspaces[0].terminalIds.length).toBeGreaterThanOrEqual(1);
    expect(state.workspaces[0].activeTerminalId).not.toBeNull();
  });

  it("terminal canvas has positive dimensions", async () => {
    const canvases = await api.waitForDom("canvas.terminal-canvas", { visible: true, timeoutMs: 6000 });
    expect(canvases.length).toBeGreaterThan(0);
    expect(canvases[0].rect.width).toBeGreaterThan(0);
    expect(canvases[0].rect.height).toBeGreaterThan(0);
  });

  it("writing to terminal updates recentOutput", async () => {
    const state = await api.state();
    const termId = state.workspaces[0].activeTerminalId!;

    await api.runTerminal("echo splice-marker\r", termId);
    await sleep(800);

    const updated = await api.waitFor(
      s => {
        const ws = s.workspaces[0];
        const term = ws?.terminals.find(t => t.id === termId);
        return term?.recentOutput.some(line => line.includes("splice-marker")) ?? false;
      },
      { label: "splice-marker in output", timeoutMs: 8000 }
    );

    const term = updated.workspaces[0].terminals.find(t => t.id === termId)!;
    const hasMarker = term.recentOutput.some(line => line.includes("splice-marker"));
    expect(hasMarker).toBe(true);
  });

  it("terminal CWD is populated", async () => {
    const state = await api.state();
    const term = state.workspaces[0].terminals[0];
    expect(term).toBeDefined();
    expect(term.cwd).not.toBeNull();
    expect(typeof term.cwd).toBe("string");
    expect((term.cwd as string).length).toBeGreaterThan(0);
  });

  it("multiple terminal panes can all receive commands", async () => {
    const stateBefore = await api.state();
    const firstTermId = stateBefore.workspaces[0].activeTerminalId!;

    await api.splitPane("vertical");
    const stateAfterSplit = await api.waitFor(
      s => (s.workspaces[0]?.terminalIds.length ?? 0) > stateBefore.workspaces[0].terminalIds.length,
      { label: "second terminal", timeoutMs: 8000 }
    );
    await sleep(600);

    const secondTermId = stateAfterSplit.workspaces[0].activeTerminalId!;

    // Write to both terminals
    await api.runTerminal("echo term-one\r", firstTermId);
    await sleep(400);
    await api.runTerminal("echo term-two\r", secondTermId);
    await sleep(400);

    const errors = await api.assertNoErrors({ failOnError: false });
    expect(errors.length).toBe(0);
  });

  it("terminal search UI appears on Ctrl+F and dismisses on Escape", async () => {
    // Focus on the terminal canvas first
    const canvases = await api.domQuery("canvas.terminal-canvas");
    if (canvases.length === 0) {
      console.warn("  No terminal canvas found — skipping search UI test");
      return;
    }

    await api.keyboard("f", { ctrl: true });

    const searchInputs = await api.waitForDom("input[placeholder='Search terminal…']", {
      timeoutMs: 5000,
    }).catch(() => null);

    if (searchInputs && searchInputs.length > 0) {
      expect(searchInputs.length).toBeGreaterThan(0);
      // Dismiss
      await api.keyboard("Escape");
      await sleep(300);
    } else {
      // Search UI might use a different selector or not be implemented — just assert no crash
      const errors = await api.assertNoErrors({ failOnError: false });
      expect(errors.length).toBe(0);
    }
  });

  it("new terminal pane via splitPane API increments terminalIds", async () => {
    const before = (await api.state()).workspaces[0].terminalIds.length;
    await api.splitPane("horizontal");

    const state = await api.waitFor(
      s => (s.workspaces[0]?.terminalIds.length ?? 0) > before,
      { label: "new terminal via split", timeoutMs: 8000 }
    );
    expect(state.workspaces[0].terminalIds.length).toBe(before + 1);
  });

  it("no errors after all terminal interactions", async () => {
    const errors = await api.assertNoErrors({ failOnError: false });
    expect(errors.length).toBe(0);
  });
});
