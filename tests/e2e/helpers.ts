import { type Browser } from "webdriverio";

export const DRIVER_URL = "tauri://localhost";

/** Navigate to the app and wait for the root grid to be present. */
export async function loadApp(browser: Browser): Promise<void> {
  await browser.url(DRIVER_URL);
  await browser.$(".grid.h-screen, [data-pane-id], div.welcome-screen").waitForExist({
    timeout: 10_000,
    timeoutMsg: "App root did not appear within 10s",
  });
}

/**
 * Ask the app's workspaceManager to open a directory programmatically.
 * Uses fire-and-forget (sync execute) since tauri-plugin-webdriver's executeAsync
 * has limited support. Callers should wait for DOM changes after this.
 */
export async function openWorkspace(
  browser: Browser,
  path: string
): Promise<void> {
  await browser.execute((p: string) => {
    void (window as unknown as { __spliceTest: { openWorkspace: (p: string) => Promise<void> } })
      .__spliceTest.openWorkspace(p);
  }, path);
  // Wait until at least one pane or file-tree element appears
  await browser.$("[data-pane-id], [role='tree']").waitForExist({
    timeout: 8_000,
    timeoutMsg: "Workspace did not load within 8s",
  });
}

/** Close all open workspaces and wait for them to disappear. */
export async function closeAllWorkspaces(browser: Browser): Promise<void> {
  await browser.execute(() => {
    void (window as unknown as { __spliceTest: { closeAllWorkspaces: () => Promise<void> } })
      .__spliceTest.closeAllWorkspaces();
  });
  // Wait for all workspace-group elements to disappear
  await browser.waitUntil(
    async () => {
      const groups = await browser.$$(".workspace-group");
      return groups.length === 0;
    },
    { timeout: 6_000, interval: 200, timeoutMsg: "Workspaces did not close within 6s" }
  );
}

/** Wait for at least one pane with [data-pane-id] to exist. */
export async function waitForPane(browser: Browser): Promise<void> {
  await browser.$("[data-pane-id]").waitForExist({
    timeout: 8_000,
    timeoutMsg: "No pane appeared",
  });
}

/** Get the RSS memory (KB) of a process by PID. */
export async function getAppRss(pid: number): Promise<number> {
  const { execSync } = await import("child_process");
  try {
    const out = execSync(`ps -o rss= -p ${pid}`).toString().trim();
    return parseInt(out, 10) || 0;
  } catch {
    return 0;
  }
}

/** Sleep for `ms` milliseconds. */
export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * Dispatch a `keydown` event to `document` — the target for Splice's keybinding handler.
 * On macOS use `meta: true` for Cmd; on Linux/Windows use `ctrl: true`.
 *
 * Also sets `code` automatically for single-letter keys (e.g. "w" → "KeyW") and
 * digits (e.g. "1" → "Digit1"), since some handlers check `e.code` rather than `e.key`.
 */
export async function pressKey(
  browser: Browser,
  key: string,
  mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}
): Promise<void> {
  await browser.execute(
    (k: string, meta: boolean, ctrl: boolean, shift: boolean, alt: boolean) => {
      // Auto-derive the `code` field that some chord handlers rely on.
      let code: string = k;
      if (/^[a-zA-Z]$/.test(k)) code = "Key" + k.toUpperCase();
      else if (/^[0-9]$/.test(k)) code = "Digit" + k;
      // Named keys already have the right code value (Enter, Escape, Space, etc.)

      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: k,
          code,
          metaKey: meta,
          ctrlKey: ctrl,
          shiftKey: shift,
          altKey: alt,
          bubbles: true,
          cancelable: true,
        })
      );
    },
    key,
    mods.meta ?? false,
    mods.ctrl ?? false,
    mods.shift ?? false,
    mods.alt ?? false
  );
}

/**
 * Fire a `contextmenu` event on the DOM element matching `cssSelector`.
 * Use this instead of `element.click({ button: 2 })` which may not trigger
 * `oncontextmenu` handlers in all WebDriver implementations.
 */
export async function rightClickElement(
  browser: Browser,
  cssSelector: string
): Promise<void> {
  await browser.execute((sel: string) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`rightClickElement: no element for "${sel}"`);
    const rect = (el as HTMLElement).getBoundingClientRect();
    el.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      })
    );
  }, cssSelector);
}

/**
 * Click the first `.split-dropdown-item` button whose text starts with `label`.
 * Uses browser.execute() for the click to avoid WebDriver focus side-effects
 * (which can trigger blur events on subsequently created inputs).
 * Waits up to 2 s for the menu to appear.
 */
export async function clickContextMenuItem(
  browser: Browser,
  label: string
): Promise<void> {
  await browser.waitUntil(
    async () => {
      return (await browser.execute((lbl: string) => {
        const items = document.querySelectorAll("button.split-dropdown-item");
        for (const item of Array.from(items)) {
          if ((item as HTMLElement).textContent?.trimStart().startsWith(lbl)) {
            (item as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, label)) as boolean;
    },
    { timeout: 2_000, interval: 100, timeoutMsg: `Context menu item "${label}" did not appear` }
  );
}
