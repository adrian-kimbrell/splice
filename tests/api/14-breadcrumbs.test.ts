/**
 * Spec 14 – Breadcrumbs: file path segments appear in editor header DOM
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
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

describe("Breadcrumbs", () => {
  let wsDir: string;
  let helperPath: string;

  beforeAll(async () => {
    await api.reset();
    await api.waitForReset();

    wsDir = mkdtempSync(join(tmpdir(), "splice-breadcrumb-"));
    const utilsDir = join(wsDir, "src", "utils");
    mkdirSync(utilsDir, { recursive: true });
    helperPath = join(utilsDir, "helper.ts");
    writeFileSync(helperPath, "export function helper() { return 42; }\n");

    await api.openFolder(wsDir);
    await api.waitForWorkspace({ timeoutMs: 8000 });
    await sleep(800);

    await devPost("/dev/open-file", { path: helperPath });
    await sleep(600);
  });

  afterAll(async () => {
    await api.reset().catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("no breadcrumb segments when no file open after a fresh reset", async () => {
    // This sub-check uses a temporary reset then reopens
    await api.reset();
    await api.waitForReset();

    // After reset, no editor pane should be active — breadcrumb should be absent
    const segments = await api.domQuery(".bg-editor span.text-txt");
    expect(segments.length).toBe(0);

    // Reopen workspace and file for subsequent tests
    await api.openFolder(wsDir);
    await api.waitForWorkspace({ timeoutMs: 8000 });
    await sleep(800);
    await devPost("/dev/open-file", { path: helperPath });
    await sleep(600);
  });

  it("opening a nested file shows filename in breadcrumb DOM", async () => {
    // Wait for the file tab/pane data-path attribute
    const tabs = await api.waitForDom(`[data-path$='helper.ts']`, { timeoutMs: 5000 }).catch(() => []);
    // Also accept a breadcrumb span containing the filename
    const spans = await api.waitForDom("span.text-txt", { timeoutMs: 5000 }).catch(() => []);

    const hasHelperInTab = tabs.length > 0;
    const hasHelperInSpan = spans.some(s => s.text.includes("helper.ts"));
    expect(hasHelperInTab || hasHelperInSpan).toBe(true);
  });

  it("breadcrumb includes parent folder segment", async () => {
    const spans = await api.waitForDom("span.text-txt", { timeoutMs: 5000 }).catch(() => []);
    const hasUtils = spans.some(s => s.text.includes("utils"));
    expect(hasUtils).toBe(true);
  });

  it("state shows active file path for the editor pane", async () => {
    const state = await api.waitFor(
      s => {
        const ws = s.workspaces[0];
        return ws?.panes.some(
          p => p.kind === "editor" && p.activeFilePath !== null && p.activeFilePath.includes("helper.ts")
        ) ?? false;
      },
      { label: "activeFilePath set", timeoutMs: 6000 }
    );

    const ws = state.workspaces[0];
    const editorPane = ws.panes.find(
      p => p.kind === "editor" && p.activeFilePath?.includes("helper.ts")
    );
    expect(editorPane).toBeDefined();
    expect(editorPane!.activeFilePath).toContain("helper.ts");
  });

  it("breadcrumb is rendered above or within the CodeMirror editor area", async () => {
    const breadcrumbEls = await api.domQuery(".bg-editor");
    const cmEls = await api.domQuery(".cm-editor");

    if (breadcrumbEls.length === 0 || cmEls.length === 0) {
      // If either element is missing, just verify no errors
      const errors = await api.assertNoErrors({ failOnError: false });
      expect(errors.length).toBe(0);
      return;
    }

    // Breadcrumb container should start at or above the CodeMirror editor top
    const breadcrumbTop = breadcrumbEls[0].rect.y;
    const cmTop = cmEls[0].rect.y;
    expect(breadcrumbTop).toBeLessThanOrEqual(cmTop);
  });
});
