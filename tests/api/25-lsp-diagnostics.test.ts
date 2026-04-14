/**
 * Spec 25 – LSP Diagnostics
 *
 * Verifies that CodeMirror lint decorations appear for type errors and clear
 * when the code is fixed. All tests are skipped if typescript-language-server
 * is not installed.
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

describe("LSP Diagnostics", () => {
  let wsDir: string;
  let badTsPath: string;

  beforeAll(async () => {
    // Detect typescript-language-server
    try {
      execSync("which typescript-language-server", { stdio: "pipe" });
      hasTsls = true;
    } catch {
      hasTsls = false;
    }

    await api.reset();
    await api.waitForReset();

    wsDir = mkdtempSync(join(tmpdir(), "splice-lspdiag-"));
    badTsPath = join(wsDir, "bad.ts");
    writeFileSync(badTsPath, 'const x: number = "wrong";\n');

    await api.openFolder(wsDir);
    await api.waitForWorkspace({ timeoutMs: 8000 });

    // Open the file via the dev API
    await devPost("/dev/open-file", { path: badTsPath });
    await sleep(3000);
  });

  afterAll(async () => {
    await api.reset().catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("[skipped if no tsls] workspace opens with TypeScript file", async () => {
    if (!hasTsls) return;

    const state = await api.state();
    const ws = state.workspaces[0];
    expect(ws).toBeDefined();
    const hasFile = ws.openFiles.some(f => f.path.endsWith("bad.ts"));
    expect(hasFile).toBe(true);
  });

  it("[skipped if no tsls] lint error decoration appears in DOM", async () => {
    if (!hasTsls) return;

    const decorations = await api.waitForDom(".cm-lintRange-error", {
      timeoutMs: 8000,
    });
    expect(decorations.length).toBeGreaterThan(0);
  });

  it("[skipped if no tsls] fixing the content clears lint errors", async () => {
    if (!hasTsls) return;

    await api.setFileContent("const x: number = 42;\n");
    await sleep(2000);

    const decorations = await api.domQuery(".cm-lintRange-error");
    expect(decorations.length).toBe(0);
  });

  it("no crash regardless of LSP availability", async () => {
    const errors = await api.assertNoErrors({ failOnError: false });
    expect(errors.length).toBe(0);
  });
});
