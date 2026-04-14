/**
 * Spec 04 – Pane splitting and layout
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { api } from "../e2e/dev-api.js";

describe("Pane split", () => {
  let wsDir: string;

  beforeAll(async () => {
    await api.reset();
    await api.waitForReset();
    wsDir = mkdtempSync(join(tmpdir(), "splice-split-"));
    writeFileSync(join(wsDir, "a.ts"), "export const a = 1;\n");
    await api.openFolder(wsDir);
    await api.waitForWorkspace({ timeoutMs: 8000 });
    await new Promise(r => setTimeout(r, 800));
  });

  afterAll(async () => {
    await api.assertNoErrors();
    await api.reset().catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("starts with one terminal pane", async () => {
    const state = await api.state();
    const ws = state.workspaces[0];
    expect(ws.terminalIds.length).toBe(1);
    expect(ws.panes.filter(p => p.kind === "terminal").length).toBe(1);
  });

  it("split adds a second terminal to state", async () => {
    await api.splitPane("vertical");
    const state = await api.waitFor(
      s => s.workspaces[0]?.terminalIds.length >= 2,
      { label: "second terminal", timeoutMs: 6000 }
    );
    expect(state.workspaces[0].terminalIds.length).toBe(2);
  });

  it("DOM shows two pane elements after split", async () => {
    const panes = await api.waitForDom("[data-pane-id]");
    expect(panes.length).toBeGreaterThanOrEqual(2);
  });

  it("each pane has a distinct data-pane-id", async () => {
    const panes = await api.domQuery("[data-pane-id]");
    const ids = panes.map(p => p.attrs["data-pane-id"]).filter(Boolean);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("layout tree has a split node at root", async () => {
    const state = await api.state();
    const layout = state.workspaces[0].layout as { type: string };
    expect(layout.type).toBe("split");
  });

  it("horizontal split also works", async () => {
    const before = (await api.state()).workspaces[0].terminalIds.length;
    await api.splitPane("horizontal");
    const state = await api.waitFor(
      s => s.workspaces[0]?.terminalIds.length > before,
      { label: "third terminal", timeoutMs: 6000 }
    );
    expect(state.workspaces[0].terminalIds.length).toBe(before + 1);
  });

  it("no console errors throughout split operations", async () => {
    const errors = await api.assertNoErrors({ failOnError: false });
    expect(errors.length).toBe(0);
  });
});
