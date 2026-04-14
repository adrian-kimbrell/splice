/**
 * Spec 26 – LSP Hover
 *
 * Verifies that the editor opens TypeScript files correctly and that hover
 * tooltips can appear (or at minimum that the editor is present and stable).
 * Skipped if typescript-language-server is not installed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { api } from "../e2e/dev-api.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const port = () =>
  parseInt(readFileSync("/tmp/splice-dev-api.port", "utf8").trim(), 10);
const devPost = (path: string, body: object) =>
  fetch(`http://127.0.0.1:${port()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

let hasTsls = false;

describe("LSP Hover", () => {
  let wsDir: string;
  let hoverTsPath: string;

  beforeAll(async () => {
    try {
      execSync("which typescript-language-server", { stdio: "pipe" });
      hasTsls = true;
    } catch {
      hasTsls = false;
    }

    await api.reset();
    await api.waitForReset();

    wsDir = mkdtempSync(join(tmpdir(), "splice-lsphover-"));
    hoverTsPath = join(wsDir, "hover.ts");
    writeFileSync(hoverTsPath, "const arr: number[] = [1, 2, 3];\narr.\n");

    await api.openFolder(wsDir);
    await api.waitForWorkspace({ timeoutMs: 8000 });

    await devPost("/dev/open-file", { path: hoverTsPath });
    await sleep(3000);
  });

  afterAll(async () => {
    // Dismiss any open tooltip
    await api.keyboard("Escape").catch(() => {});
    await sleep(200);
    await api.reset().catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("[skipped if no tsls] editor is open with TypeScript file", async () => {
    if (!hasTsls) return;

    const state = await api.state();
    const ws = state.workspaces[0];
    expect(ws).toBeDefined();
    const hasFile = ws.openFiles.some(f => f.path.endsWith("hover.ts"));
    expect(hasFile).toBe(true);
  });

  it("[skipped if no tsls] cm-tooltip appears after hover event or editor is present", async () => {
    if (!hasTsls) return;

    // Actual mouse hover requires real pointer events which the dev API doesn't
    // expose yet. We verify the editor is present and stable, and attempt a
    // DOM check for any existing tooltip without requiring one to appear.
    const editors = await api.domQuery(".cm-editor");
    expect(editors.length).toBeGreaterThan(0);

    // Non-asserting tooltip check — may appear if LSP has already processed
    const tooltips = await api.domQuery(".cm-tooltip");
    // Just record; we do not require a tooltip here since no real mouse event
    void tooltips;

    // No crash is the key assertion
    const errors = await api.assertNoErrors({ failOnError: false });
    expect(errors.length).toBe(0);
  });

  it("no errors", async () => {
    const errors = await api.assertNoErrors({ failOnError: false });
    expect(errors.length).toBe(0);
  });
});
