/**
 * Spec 32 – SSH Connection Error Handling
 *
 * Verifies that attempting to connect to an unreachable SSH host:
 *   1. Returns an error rather than hanging or panicking
 *   2. Leaves the app in a usable state
 *
 * Does NOT require a running SSH server — it intentionally targets an invalid
 * host to exercise the error path. Happy-path SSH tests (connect, SFTP ops,
 * remote terminal) require a local sshd and are not part of this spec.
 */

import { loadApp, closeAllWorkspaces, sleep } from "./helpers";

type SpliceTest = {
  sshConnectTest: (id: string, cfg: Record<string, unknown>) => Promise<{ ok: boolean; err?: string }>;
  sshPingTest: (id: string) => Promise<{ ok: boolean; value?: boolean; err?: string }>;
};

describe("SSH connect — error handling", () => {
  before(async () => {
    await loadApp(browser);
    await closeAllWorkspaces(browser);
    await sleep(300);
  });

  after(async () => {
    await closeAllWorkspaces(browser).catch(() => {});
  });

  it("ssh_connect returns an error for an unreachable host", async () => {
    const workspaceId = `ssh-test-${Date.now()}`;

    // Fire via __spliceTest (uses @tauri-apps/api/core invoke — same as app code)
    // 256.256.256.256 is an invalid IP the OS rejects immediately
    const result = await browser.executeAsync(
      (wsId: string, done: (r: { ok: boolean; err?: string }) => void) => {
        (window as unknown as { __spliceTest: SpliceTest })
          .__spliceTest.sshConnectTest(wsId, {
            host: "256.256.256.256",
            port: 22,
            user: "testuser",
            key_path: null,
            remote_path: "/tmp",
          })
          .then(done)
          .catch((e: unknown) => done({ ok: false, err: String(e) }));
      },
      workspaceId
    ) as { ok: boolean; err?: string };

    expect(result.ok).toBe(false);
    expect(result.err).toBeTruthy();
  });

  it("app remains functional after a failed SSH connect", async () => {
    const root = await browser.$(".grid.h-screen, div.welcome-screen");
    await expect(root).toExist();
  });

  it("ssh_ping errors for a workspace with no active session", async () => {
    const workspaceId = `ssh-ping-${Date.now()}`;

    const result = await browser.executeAsync(
      (wsId: string, done: (r: { ok: boolean; value?: boolean; err?: string }) => void) => {
        (window as unknown as { __spliceTest: SpliceTest })
          .__spliceTest.sshPingTest(wsId)
          .then(done)
          .catch((e: unknown) => done({ ok: false, err: String(e) }));
      },
      workspaceId
    ) as { ok: boolean; value?: boolean; err?: string };

    // Either the command errors (no session) or returns false — both are acceptable
    if (result.ok) {
      expect(result.value).toBe(false);
    } else {
      expect(result.err).toBeTruthy();
    }
  });
});
