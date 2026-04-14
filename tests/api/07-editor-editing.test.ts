/**
 * Spec 07 – Editor editing: open files, dirty state, save, Cmd+N/W/K-W
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { api } from "../e2e/dev-api.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const port = parseInt(readFileSync("/tmp/splice-dev-api.port", "utf8").trim(), 10);

describe("Editor editing", () => {
  let wsDir: string;
  let helloPath: string;
  let otherPath: string;

  beforeAll(async () => {
    await api.reset();
    await api.waitForReset();

    wsDir = mkdtempSync(join(tmpdir(), "splice-editor-"));
    helloPath = join(wsDir, "hello.ts");
    otherPath = join(wsDir, "other.ts");
    writeFileSync(helloPath, "export const hello = 'world';\n");
    writeFileSync(otherPath, "export const other = 42;\n");

    await api.openFolder(wsDir);
    await api.waitForWorkspace({ timeoutMs: 8000 });
    await sleep(800);

    // Open hello.ts in the editor
    await fetch(`http://127.0.0.1:${port}/dev/open-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: helloPath }),
    });
    await sleep(600);
  });

  afterAll(async () => {
    await api.assertNoErrors();
    await api.reset().catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("opening a file shows it in openFiles state", async () => {
    const state = await api.state();
    const openFiles = state.workspaces[0].openFiles;
    const found = openFiles.some(f => f.path === helloPath || f.name === "hello.ts");
    expect(found).toBe(true);
  });

  it("typing in the editor marks the file dirty", async () => {
    await api.setFileContent("new content for dirty test");
    const state = await api.waitFor(
      s => {
        const ws = s.workspaces[0];
        return ws?.openFiles.some(f => f.isDirty) ?? false;
      },
      { label: "file dirty", timeoutMs: 5000 }
    );
    const dirtyFile = state.workspaces[0].openFiles.find(f => f.isDirty);
    expect(dirtyFile).toBeDefined();
  });

  it("Cmd+S saves the file and clears dirty indicator", async () => {
    await api.setFileContent("saved content");
    await sleep(200);
    await api.keyboard("s", { meta: true });

    const state = await api.waitFor(
      s => {
        const ws = s.workspaces[0];
        const file = ws?.openFiles.find(f => f.name === "hello.ts");
        return file !== undefined && !file.isDirty;
      },
      { label: "file saved", timeoutMs: 6000 }
    );

    const file = state.workspaces[0].openFiles.find(f => f.name === "hello.ts");
    expect(file?.isDirty).toBe(false);

    // Verify the disk contents were updated
    const diskContent = readFileSync(helloPath, "utf8");
    expect(diskContent).toContain("saved content");
  });

  it("Cmd+N creates a new untitled file", async () => {
    const before = (await api.state()).workspaces[0].openFiles.length;
    await api.keyboard("n", { meta: true });

    const state = await api.waitFor(
      s => {
        const ws = s.workspaces[0];
        return ws?.openFiles.length > before;
      },
      { label: "new untitled tab", timeoutMs: 5000 }
    );

    const hasUntitled = state.workspaces[0].openFiles.some(
      f => f.name.toLowerCase().includes("untitled") || f.path.toLowerCase().includes("untitled")
    );
    expect(hasUntitled).toBe(true);
  });

  it("Cmd+W closes the active tab", async () => {
    const before = (await api.state()).workspaces[0].openFiles.length;
    await api.keyboard("w", { meta: true });

    const state = await api.waitFor(
      s => {
        const ws = s.workspaces[0];
        return ws?.openFiles.length < before;
      },
      { label: "tab closed", timeoutMs: 5000 }
    );

    expect(state.workspaces[0].openFiles.length).toBe(before - 1);
  });

  it("Cmd+K then W chord closes all tabs", async () => {
    // Ensure at least one file is open before testing close-all
    const stateCheck = await api.state();
    if (stateCheck.workspaces[0].openFiles.length === 0) {
      await fetch(`http://127.0.0.1:${port}/dev/open-file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: helloPath }),
      });
      await sleep(500);
    }

    await api.keyboard("k", { meta: true });
    await sleep(100);
    await api.keyboard("w");

    const state = await api.waitFor(
      s => {
        const ws = s.workspaces[0];
        return (ws?.openFiles.length ?? 0) === 0;
      },
      { label: "all tabs closed", timeoutMs: 6000 }
    );

    expect(state.workspaces[0].openFiles.length).toBe(0);
  });

  it("re-dirtying then closing prompts or discards without crash", async () => {
    // Open a file and dirty it, then reset — app should not crash
    await fetch(`http://127.0.0.1:${port}/dev/open-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: otherPath }),
    });
    await sleep(500);

    await api.setFileContent("unsaved dirty content");
    await sleep(200);

    // reset will close everything; should not produce JS errors
    await api.reset();
    await api.waitForReset({ timeoutMs: 6000 });

    const errors = await api.assertNoErrors({ failOnError: false });
    expect(errors.length).toBe(0);
  });
});
