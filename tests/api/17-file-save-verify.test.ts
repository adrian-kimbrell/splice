/**
 * Spec 17 – File save verification: setFileContent, Cmd+S, disk persistence
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { api } from "../e2e/dev-api.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const port = parseInt(readFileSync("/tmp/splice-dev-api.port", "utf8").trim(), 10);
const devPost = (path: string, body: object) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("File save verification", () => {
  let wsDir: string;
  let savePath: string;

  beforeAll(async () => {
    await api.reset();
    await api.waitForReset();

    wsDir = mkdtempSync(join(tmpdir(), "splice-save-"));
    savePath = join(wsDir, "save-test.ts");
    writeFileSync(savePath, "ORIGINAL\n");

    await api.openFolder(wsDir);
    await api.waitForWorkspace({ timeoutMs: 8000 });
    await sleep(800);

    await devPost("/dev/open-file", { path: savePath });
    await sleep(600);
  });

  afterAll(async () => {
    await api.reset().catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("setFileContent marks the file dirty", async () => {
    await api.setFileContent("UPDATED");

    const state = await api.waitFor(
      s => s.workspaces[0]?.openFiles.some(f => f.isDirty) ?? false,
      { label: "file dirty", timeoutMs: 5000 }
    );

    const dirtyFile = state.workspaces[0].openFiles.find(f => f.isDirty);
    expect(dirtyFile).toBeDefined();
    expect(dirtyFile!.isDirty).toBe(true);
  });

  it("Cmd+S saves and clears the dirty flag", async () => {
    await api.keyboard("s", { meta: true });

    const state = await api.waitFor(
      s => {
        const file = s.workspaces[0]?.openFiles.find(f => f.name === "save-test.ts");
        return file !== undefined && !file.isDirty;
      },
      { label: "file saved", timeoutMs: 8000 }
    );

    const file = state.workspaces[0].openFiles.find(f => f.name === "save-test.ts");
    expect(file?.isDirty).toBe(false);

    const diskContent = readFileSync(savePath, "utf8");
    expect(diskContent).toContain("UPDATED");
  });

  it("saving unchanged content is idempotent", async () => {
    // File is already saved; press Cmd+S again — should stay not dirty, no errors
    await api.keyboard("s", { meta: true });
    await sleep(300);

    const state = await api.state();
    const file = state.workspaces[0]?.openFiles.find(f => f.name === "save-test.ts");
    // File should still not be dirty
    if (file) {
      expect(file.isDirty).toBe(false);
    }

    const errors = await api.assertNoErrors({ failOnError: false });
    expect(errors.length).toBe(0);
  });

  it("file content on disk matches what was set", async () => {
    const diskContent = readFileSync(savePath, "utf8");
    expect(diskContent).toContain("UPDATED");
  });
});
