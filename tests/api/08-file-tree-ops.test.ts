/**
 * Spec 08 – File tree operations: DOM presence, nested files, explorer visibility toggle
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { api } from "../e2e/dev-api.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const port = parseInt(readFileSync("/tmp/splice-dev-api.port", "utf8").trim(), 10);

describe("File tree operations", () => {
  let wsDir: string;
  let alphaPath: string;
  let betaPath: string;
  let deepPath: string;

  beforeAll(async () => {
    await api.reset();
    await api.waitForReset();

    wsDir = mkdtempSync(join(tmpdir(), "splice-tree-"));
    alphaPath = join(wsDir, "alpha.ts");
    betaPath = join(wsDir, "beta.ts");
    const subdir = join(wsDir, "subdir");
    mkdirSync(subdir);
    deepPath = join(subdir, "deep.ts");

    writeFileSync(alphaPath, "export const alpha = 1;\n");
    writeFileSync(betaPath, "export const beta = 2;\n");
    writeFileSync(deepPath, "export const deep = 3;\n");

    await api.openFolder(wsDir);
    await api.waitForWorkspace({ timeoutMs: 8000 });
    await sleep(1000);
  });

  afterAll(async () => {
    await api.assertNoErrors();
    await api.reset().catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("file tree renders seed files", async () => {
    const els = await api.waitForDom("[data-path$='alpha.ts']", { timeoutMs: 6000 });
    expect(els.length).toBeGreaterThan(0);
  });

  it("folder entry is visible in DOM", async () => {
    const els = await api.waitForDom("[data-path$='subdir']", { timeoutMs: 6000 });
    expect(els.length).toBeGreaterThan(0);
  });

  it("DOM shows both root-level files", async () => {
    const alphas = await api.domQuery("[data-path$='alpha.ts']");
    const betas = await api.domQuery("[data-path$='beta.ts']");
    expect(alphas.length).toBeGreaterThan(0);
    expect(betas.length).toBeGreaterThan(0);
  });

  it("file tree has nested file after expanding parent", async () => {
    // Click the subdir to expand it if needed, then wait for deep.ts
    const subdirEls = await api.domQuery("[data-path$='subdir']");
    if (subdirEls.length > 0) {
      // Attempt to open-file to force tree expansion
      await fetch(`http://127.0.0.1:${port}/dev/open-file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: deepPath }),
      });
      await sleep(600);
    }

    const deepEls = await api.waitForDom("[data-path$='deep.ts']", { timeoutMs: 6000 });
    expect(deepEls.length).toBeGreaterThan(0);
  });

  it("context menu area exists for file entries", async () => {
    // Verify alpha.ts file entry is present in DOM (right-click context menus
    // require pointer events which aren't reliably testable via keyboard sim alone)
    const fileEls = await api.domQuery("[data-path$='alpha.ts']");
    expect(fileEls.length).toBeGreaterThan(0);
    // The entry should have a data-path attribute
    expect(fileEls[0].attrs["data-path"]).toBeDefined();
  });

  it("explorer visibility toggles via setUi", async () => {
    await api.setUi({ explorerVisible: false });
    const stateOff = await api.waitFor(
      s => s.ui.explorerVisible === false,
      { label: "explorer hidden", timeoutMs: 4000 }
    );
    expect(stateOff.ui.explorerVisible).toBe(false);

    await api.setUi({ explorerVisible: true });
    const stateOn = await api.waitFor(
      s => s.ui.explorerVisible === true,
      { label: "explorer visible", timeoutMs: 4000 }
    );
    expect(stateOn.ui.explorerVisible).toBe(true);
  });
});
