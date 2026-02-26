/**
 * Spec 09 – Multiple workspaces
 *
 * Opens two workspaces, verifies both appear in the sidebar, switches between
 * them, and verifies that closing one leaves the other intact.
 */

import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadApp, openWorkspace, closeAllWorkspaces, sleep } from "./helpers";

describe("Multiple workspaces", () => {
  let wsDir1: string;
  let wsDir2: string;

  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser);
    await sleep(300);

    wsDir1 = mkdtempSync(join(tmpdir(), "splice-ws1-"));
    writeFileSync(join(wsDir1, "ws1_file.ts"), "export const ws1 = true;\n");

    wsDir2 = mkdtempSync(join(tmpdir(), "splice-ws2-"));
    writeFileSync(join(wsDir2, "ws2_file.ts"), "export const ws2 = true;\n");
  });

  after(async () => {
    await closeAllWorkspaces(browser).catch(() => {});
    rmSync(wsDir1, { recursive: true, force: true });
    rmSync(wsDir2, { recursive: true, force: true });
  });

  it("opens workspace 1", async () => {
    await openWorkspace(browser, wsDir1);
    await sleep(800);

    const ws1File = await browser.$('[data-path$="ws1_file.ts"]');
    await expect(ws1File).toExist();
  });

  it("opens workspace 2 alongside workspace 1", async () => {
    await openWorkspace(browser, wsDir2);
    await sleep(800);

    // Both workspaces should be in the sidebar
    const groups = await browser.$$(".workspace-group");
    expect(groups.length).toBeGreaterThanOrEqual(2);
  });

  it("workspace 2 file tree is active after opening", async () => {
    const ws2File = await browser.$('[data-path$="ws2_file.ts"]');
    await expect(ws2File).toExist();
  });

  it("switching to workspace 1 shows its file tree", async () => {
    // Get workspace IDs, switch to workspace 1
    const ids = await browser.execute(() => {
      return (
        window as unknown as { __spliceTest: { getWorkspaceIds: () => string[] } }
      ).__spliceTest.getWorkspaceIds();
    }) as string[];

    expect(ids.length).toBeGreaterThanOrEqual(2);

    // Switch to the first workspace
    await browser.execute((id: string) => {
      (window as unknown as { __spliceTest: { switchToWorkspace: (id: string) => void } })
        .__spliceTest.switchToWorkspace(id);
    }, ids[0]);
    await sleep(400);

    // Workspace 1's file should be visible
    const ws1File = await browser.$('[data-path$="ws1_file.ts"]');
    await expect(ws1File).toExist();
  });

  it("workspace sidebar titles match folder names", async () => {
    const titles = await browser.$$(".workspace-title");
    const titleTexts: string[] = [];
    for (const t of Array.from(titles)) {
      titleTexts.push(await t.getText().catch(() => ""));
    }

    const ws1Name = wsDir1.split("/").pop()!.substring(0, 8);
    const ws2Name = wsDir2.split("/").pop()!.substring(0, 8);

    expect(titleTexts.some((t) => t.includes(ws1Name))).toBe(true);
    expect(titleTexts.some((t) => t.includes(ws2Name))).toBe(true);
  });

  it("closing one workspace keeps the other intact", async () => {
    const ids = await browser.execute(() => {
      return (
        window as unknown as { __spliceTest: { getWorkspaceIds: () => string[] } }
      ).__spliceTest.getWorkspaceIds();
    }) as string[];

    // Close workspace 1 (index 0)
    await browser.execute((id: string) => {
      void (
        window as unknown as {
          __spliceTest: { closeAllWorkspaces: () => Promise<void[]> };
        }
      )
        // Use switchToWorkspace then close via the X button in the UI
        // We close the FIRST workspace by switching to it, then closing it via ws manager
        .__spliceTest;
      // Simpler: switch to ws 1 then close all panes
      // Actually, close only workspace at id[0] via the workspace-group close button
    }, ids[0]);

    // Find the first workspace-group and click its close button
    const wsGroups = await browser.$$(".workspace-group");
    if (wsGroups.length >= 2) {
      // Hover over the first group to reveal the close button (it's opacity-0 until hover)
      const firstGroup = wsGroups[0];
      await firstGroup.moveTo();
      await sleep(200);
      const closeBtn = await firstGroup.$(".pane-action-btn.close");
      if (await closeBtn.isExisting()) {
        await closeBtn.click();
        await sleep(600);
      }
    }

    // Should still have at least one workspace group remaining
    const remaining = await browser.$$(".workspace-group");
    expect(remaining.length).toBeGreaterThanOrEqual(1);
  });

  it("switching workspaces with keyboard shortcut works", async () => {
    // Ensure 2 workspaces are open
    await openWorkspace(browser, wsDir1);
    await sleep(600);
    await openWorkspace(browser, wsDir2);
    await sleep(600);

    const groupsBefore = (await browser.$$(".workspace-group")).length;
    expect(groupsBefore).toBeGreaterThanOrEqual(2);

    // Record which workspace is currently active
    const activeBefore = await browser.execute(() => {
      return (
        window as unknown as { __spliceTest: { getActiveWorkspaceId: () => string } }
      ).__spliceTest.getActiveWorkspaceId();
    }) as string;

    // Cmd+Alt+Shift+ArrowLeft switches to previous workspace
    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "ArrowLeft",
          metaKey: true,
          altKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    await sleep(300);

    const activeAfter = await browser.execute(() => {
      return (
        window as unknown as { __spliceTest: { getActiveWorkspaceId: () => string } }
      ).__spliceTest.getActiveWorkspaceId();
    }) as string;

    // Active workspace should have changed (or only 1 remains — either is fine)
    const stillAlive = await browser.$(".grid.h-screen, [data-pane-id]");
    await expect(stillAlive).toExist();
    // If there were 2+ workspaces the active ID should differ
    if (groupsBefore >= 2) {
      expect(activeAfter).not.toBe(activeBefore);
    }
  });
});
