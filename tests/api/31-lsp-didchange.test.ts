/**
 * Spec 31 – LSP didChange diagnostics update on edit
 *
 * Verifies that after editing a file via setFileContent, the LSP server
 * receives a textDocument/didChange notification and updates diagnostics
 * accordingly. Skipped if typescript-language-server is not installed.
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

describe("LSP didChange diagnostics update on edit", () => {
  let wsDir: string;
  let changeTsPath: string;

  beforeAll(async () => {
    try {
      execSync("which typescript-language-server", { stdio: "pipe" });
      hasTsls = true;
    } catch {
      hasTsls = false;
    }

    await api.reset();
    await api.waitForReset();

    wsDir = mkdtempSync(join(tmpdir(), "splice-lspdc-"));
    changeTsPath = join(wsDir, "change.ts");
    writeFileSync(changeTsPath, "const x: string = 123;\n");

    await api.openFolder(wsDir);
    await api.waitForWorkspace({ timeoutMs: 8000 });

    await devPost("/dev/open-file", { path: changeTsPath });
    await sleep(3000);
  });

  afterAll(async () => {
    await api.reset().catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("[skipped if no tsls] initial lint error is visible", async () => {
    if (!hasTsls) return;

    const decorations = await api.waitForDom(".cm-lintRange-error", {
      timeoutMs: 8000,
    });
    expect(decorations.length).toBeGreaterThan(0);
  });

  it("[skipped if no tsls] fixing content clears errors", async () => {
    if (!hasTsls) return;

    await api.setFileContent("const x: string = 'hello';\n");
    await sleep(2000);

    const decorations = await api.domQuery(".cm-lintRange-error");
    expect(decorations.length).toBe(0);
  });

  it("[skipped if no tsls] re-introducing error restores lint", async () => {
    if (!hasTsls) return;

    await api.setFileContent("const x: string = 999;\n");
    await sleep(2000);

    const decorations = await api.waitForDom(".cm-lintRange-error", {
      timeoutMs: 5000,
    });
    expect(decorations.length).toBeGreaterThan(0);
  });

  it("no errors", async () => {
    const errors = await api.assertNoErrors({ failOnError: false });
    expect(errors.length).toBe(0);
  });
});
