/**
 * Spec 18 – File tree extended: seeded files, folder visibility, explorer toggle
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { api } from "../e2e/dev-api.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("File tree extended", () => {
  let wsDir: string;

  beforeAll(async () => {
    await api.reset();
    await api.waitForReset();

    wsDir = mkdtempSync(join(tmpdir(), "splice-filetree-"));
    const subdir = join(wsDir, "subdir");
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(subdir, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(wsDir, "b.ts"), "export const b = 2;\n");

    await api.openFolder(wsDir);
    await api.waitForWorkspace({ timeoutMs: 8000 });
    // Ensure explorer is visible at start
    await api.setUi({ explorerVisible: true });
    await sleep(800);
  });

  afterAll(async () => {
    await api.assertNoErrors();
    await api.reset().catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("file tree renders the root-level seed file", async () => {
    const items = await api.waitForDom("[data-path$='b.ts']", { timeoutMs: 6000 }).catch(() => []);
    if (items.length === 0) {
      // Fallback: look for any tree item containing b.ts text
      const treeItems = await api.domQuery("[role='treeitem']");
      const hasBTs = treeItems.some(el => el.text.includes("b.ts"));
      expect(hasBTs).toBe(true);
    } else {
      expect(items.length).toBeGreaterThan(0);
    }
  });

  it("folder entry is visible in the tree", async () => {
    const folderItems = await api.domQuery("[data-path$='subdir']");
    if (folderItems.length === 0) {
      // Fallback: look for treeitem text
      const treeItems = await api.domQuery("[role='treeitem']");
      const hasSubdir = treeItems.some(el => el.text.includes("subdir"));
      expect(hasSubdir).toBe(true);
    } else {
      expect(folderItems.length).toBeGreaterThan(0);
    }
  });

  it("explorer visibility can be toggled off via setUi", async () => {
    await api.setUi({ explorerVisible: false });

    const state = await api.waitFor(
      s => s.ui.explorerVisible === false,
      { label: "explorer hidden", timeoutMs: 5000 }
    );
    expect(state.ui.explorerVisible).toBe(false);

    // Restore
    await api.setUi({ explorerVisible: true });
    await api.waitFor(s => s.ui.explorerVisible === true, { label: "explorer restored", timeoutMs: 5000 });
  });

  it("file tree is hidden in DOM when explorer is toggled off", async () => {
    await api.setUi({ explorerVisible: false });
    await sleep(300);

    const tree = await api.domQuery("[role='tree']");
    const visibleTree = tree.filter(el => el.visible);
    expect(visibleTree.length).toBe(0);

    // Restore
    await api.setUi({ explorerVisible: true });
    await sleep(300);
  });

  it("file tree is visible in DOM when explorer is toggled on", async () => {
    await api.setUi({ explorerVisible: true });
    await sleep(300);

    const tree = await api.domQuery("[role='tree']");
    expect(tree.length).toBeGreaterThan(0);
  });

  it("no errors", async () => {
    const errors = await api.assertNoErrors({ failOnError: false });
    expect(errors.length).toBe(0);
  });
});
