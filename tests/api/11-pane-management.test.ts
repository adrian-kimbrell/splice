/**
 * Spec 11 – Pane management: splits, zoom, layout, DOM pane count
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { api } from "../e2e/dev-api.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const port = parseInt(readFileSync("/tmp/splice-dev-api.port", "utf8").trim(), 10);

describe("Pane management", () => {
  let wsDir: string;

  beforeAll(async () => {
    await api.reset();
    await api.waitForReset();

    wsDir = mkdtempSync(join(tmpdir(), "splice-panes-"));
    writeFileSync(join(wsDir, "main.ts"), "export const main = true;\n");

    await api.openFolder(wsDir);
    await api.waitForWorkspace({ timeoutMs: 8000 });
    await sleep(800);

    // Open a file so there's an editor pane available
    await fetch(`http://127.0.0.1:${port}/dev/open-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: join(wsDir, "main.ts") }),
    });
    await sleep(500);
  });

  afterAll(async () => {
    await api.assertNoErrors();
    await api.reset().catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("starts with 1 terminal pane", async () => {
    const state = await api.state();
    const ws = state.workspaces[0];
    const termPanes = ws.panes.filter(p => p.kind === "terminal");
    expect(termPanes.length).toBeGreaterThanOrEqual(1);
    expect(ws.terminalIds.length).toBeGreaterThanOrEqual(1);
  });

  it("vertical split adds a new terminal pane", async () => {
    const before = (await api.state()).workspaces[0].terminalIds.length;
    await api.splitPane("vertical");

    const state = await api.waitFor(
      s => (s.workspaces[0]?.terminalIds.length ?? 0) > before,
      { label: "second terminal after vertical split", timeoutMs: 8000 }
    );
    expect(state.workspaces[0].terminalIds.length).toBe(before + 1);
  });

  it("Cmd+Z toggles zoom on a pane", async () => {
    // Focus a pane by ensuring we have one
    await api.keyboard("z", { meta: true });

    const stateZoomed = await api.waitFor(
      s => s.ui.zoomedPaneId !== null,
      { label: "pane zoomed", timeoutMs: 5000 }
    );
    expect(stateZoomed.ui.zoomedPaneId).not.toBeNull();

    // Toggle off
    await api.keyboard("z", { meta: true });
    const stateUnzoomed = await api.waitFor(
      s => s.ui.zoomedPaneId === null,
      { label: "pane unzoomed", timeoutMs: 5000 }
    );
    expect(stateUnzoomed.ui.zoomedPaneId).toBeNull();
  });

  it("3 more splits result in at least 4 terminals total", async () => {
    const current = (await api.state()).workspaces[0].terminalIds.length;
    const target = current + 3;

    for (let i = 0; i < 3; i++) {
      await api.splitPane(i % 2 === 0 ? "vertical" : "horizontal");
      await sleep(200);
    }

    const state = await api.waitFor(
      s => (s.workspaces[0]?.terminalIds.length ?? 0) >= target,
      { label: `${target} terminals`, timeoutMs: 15000 }
    );
    expect(state.workspaces[0].terminalIds.length).toBeGreaterThanOrEqual(4);
  });

  it("layout has nested split nodes at root", async () => {
    const state = await api.state();
    const layout = state.workspaces[0].layout as { type: string };
    expect(layout.type).toBe("split");
  });

  it("DOM pane count is at least as many as state terminal count", async () => {
    const state = await api.state();
    const termCount = state.workspaces[0].terminalIds.length;

    const panes = await api.waitForDom("[data-pane-id]", { timeoutMs: 5000 });
    expect(panes.length).toBeGreaterThanOrEqual(termCount);
  });

  it("all DOM panes have distinct IDs", async () => {
    const panes = await api.domQuery("[data-pane-id]");
    const ids = panes.map(p => p.attrs["data-pane-id"]).filter(Boolean);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});
