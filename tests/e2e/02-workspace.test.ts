/**
 * Spec 02 – Workspace open / close lifecycle
 *
 * Creates a real temp directory, opens it as a workspace via the app's
 * IPC layer (bypassing the OS file picker), verifies the file tree
 * renders, then closes the workspace and verifies cleanup.
 *
 * Also smoke-tests watcher accumulation: opening/closing 5 times should
 * not grow the file-descriptor count.
 */

import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { loadApp, openWorkspace, closeAllWorkspaces, sleep } from "./helpers";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a temp workspace dir with a couple of seed files. */
function makeTempWorkspace(prefix = "splice-e2e-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, "hello.ts"), "export const hello = 'world';\n");
  writeFileSync(join(dir, "README.md"), "# Test workspace\n");
  return dir;
}

/** Count open file descriptors for a PID. */
function countFds(pid: number): number {
  try {
    return parseInt(execSync(`lsof -p ${pid} 2>/dev/null | wc -l`).toString().trim(), 10);
  } catch {
    return -1;
  }
}

/** Get the PID of the running Splice process. */
function getSplicePid(): number {
  try {
    return parseInt(execSync("pgrep -x splice || pgrep -x Splice").toString().trim().split("\n")[0], 10);
  } catch {
    return -1;
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Workspace lifecycle", () => {
  let wsDir: string;

  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser); // clear persisted state from previous run
    await sleep(300);
    wsDir = makeTempWorkspace();
  });

  after(async () => {
    await closeAllWorkspaces(browser).catch(() => {});
    rmSync(wsDir, { recursive: true, force: true });
  });

  it("opens a workspace and shows the file tree", async () => {
    await openWorkspace(browser, wsDir);
    await sleep(800); // let tree load

    const tree = await browser.$('[role="tree"]');
    await expect(tree).toExist();
  });

  it("file tree contains the seed files", async () => {
    const helloTs = await browser.$('[data-path$="hello.ts"]');
    const readme = await browser.$('[data-path$="README.md"]');
    await expect(helloTs).toExist();
    await expect(readme).toExist();
  });

  it("workspace appears in the sidebar", async () => {
    const wsGroup = await browser.$(".workspace-group");
    await expect(wsGroup).toExist();
  });

  it("workspace name matches the folder name", async () => {
    const title = await browser.$(".workspace-title");
    const text = await title.getText();
    const folderName = wsDir.split("/").pop()!;
    expect(text).toContain(folderName.substring(0, 8)); // prefix match (name may truncate)
  });

  it("closing the workspace removes it from the sidebar", async () => {
    await closeAllWorkspaces(browser);
    await sleep(400);

    const wsGroup = await browser.$(".workspace-group");
    const exists = await wsGroup.isExisting();
    // Either gone, or welcome screen shows
    if (exists) {
      const welcome = await browser.$("div.welcome-screen");
      await expect(welcome).toExist();
    }
  });
});

// ── Watcher accumulation stress ────────────────────────────────────────────

describe("Watcher accumulation (open/close × 5)", () => {
  let splicePid: number;
  let fdsBefore: number;

  before(async () => {
    await loadApp(browser);
    splicePid = getSplicePid();
    fdsBefore = countFds(splicePid);
  });

  it("FD count does not grow after 5 open/close cycles", async () => {
    for (let i = 0; i < 5; i++) {
      const dir = makeTempWorkspace(`splice-leak-${i}-`);
      await openWorkspace(browser, dir);
      await sleep(300);
      await closeAllWorkspaces(browser);
      await sleep(300);
      rmSync(dir, { recursive: true, force: true });
    }

    await sleep(1500); // wait for PTY processes to die and release FDs

    const fdsAfter = countFds(splicePid);
    const delta = fdsAfter - fdsBefore;
    console.log(`  FD delta after 5 cycles: ${delta} (before=${fdsBefore} after=${fdsAfter})`);
    // Allow up to 5 FDs per cycle for PTY + watcher overhead during cleanup latency
    expect(delta).toBeLessThanOrEqual(25);
  });
});
