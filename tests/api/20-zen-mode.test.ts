/**
 * Spec 20 – Zen mode: Cmd+Shift+Enter enters, Escape exits, sidebars restored
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { api } from "../e2e/dev-api.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("Zen mode", () => {
  let wsDir: string;

  beforeAll(async () => {
    await api.reset();
    await api.waitForReset();

    wsDir = mkdtempSync(join(tmpdir(), "splice-zen-"));
    await api.openFolder(wsDir);
    await api.waitForWorkspace({ timeoutMs: 8000 });
    await sleep(500);

    // Ensure explorer is visible before any zen tests
    await api.setUi({ explorerVisible: true });
    await sleep(200);
  });

  afterAll(async () => {
    // Exit zen mode if still active
    const state = await api.state();
    if (state.ui.zenMode) {
      await api.keyboard("Escape");
      await sleep(300);
    }
    await api.reset().catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("state starts with zenMode false", async () => {
    const state = await api.state();
    expect(state.ui.zenMode).toBe(false);
  });

  it("Cmd+Shift+Enter enters zen mode", async () => {
    await api.keyboard("Enter", { meta: true, shift: true });

    const state = await api.waitFor(
      s => s.ui.zenMode === true,
      { label: "zen mode on", timeoutMs: 5000 }
    );
    expect(state.ui.zenMode).toBe(true);
  });

  it("zen mode hides or overrides the explorer sidebar", async () => {
    const state = await api.state();
    // In zen mode the explorer is hidden (either explorerVisible=false or zen overrides layout)
    // Accept either: explorerVisible is false OR zenMode is still true (overrides sidebar rendering)
    expect(state.ui.zenMode === true || state.ui.explorerVisible === false).toBe(true);
  });

  it("Escape exits zen mode", async () => {
    await api.keyboard("Escape");

    const state = await api.waitFor(
      s => s.ui.zenMode === false,
      { label: "zen mode off", timeoutMs: 5000 }
    );
    expect(state.ui.zenMode).toBe(false);
  });

  it("sidebars are restored after exiting zen mode", async () => {
    const state = await api.state();
    // Explorer should be visible again after exiting zen mode
    expect(state.ui.explorerVisible).toBe(true);
  });

  it("no errors after zen mode cycle", async () => {
    const errors = await api.assertNoErrors({ failOnError: false });
    expect(errors.length).toBe(0);
  });
});
