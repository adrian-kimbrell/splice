/**
 * Typed Node.js wrapper around the Splice dev HTTP API.
 *
 * All functions run purely in Node (no `browser` object needed) so they can
 * be used from test setup/teardown hooks, standalone scripts, or inside test
 * bodies alongside WebDriver assertions.
 *
 * Port is auto-discovered from /tmp/splice-dev-api.port (written at startup).
 */

import { readFileSync } from "fs";

// ---------------------------------------------------------------------------
// Types — mirror what /dev/state returns
// ---------------------------------------------------------------------------

export interface DevState {
  ui: {
    explorerVisible: boolean;
    workspacesVisible: boolean;
    explorerWidth: number;
    workspacesWidth: number;
    sidebarMode: string;
    zenMode: boolean;
    prMode: boolean;
    zoomedPaneId: string | null;
  };
  activeWorkspaceId: string | null;
  workspaces: DevWorkspace[];
  notifications: DevNotification[];
}

export interface DevWorkspace {
  id: string;
  name: string;
  rootPath: string | null;
  gitBranch: string | null;
  activeTerminalId: number | null;
  terminalIds: number[];
  terminals: DevTerminal[];
  openFiles: DevFile[];
  layout: unknown;
  panes: DevPane[];
}

export interface DevTerminal {
  id: number;
  paneId: string;
  cwd: string | null;
  recentOutput: string[];
}

export interface DevFile {
  path: string;
  name: string;
  isDirty: boolean;
}

export interface DevPane {
  id: string;
  kind: "editor" | "terminal";
  title: string;
  terminalId: number | null;
  activeFilePath: string | null;
  filePaths: string[];
}

export interface DevNotification {
  terminalId: number;
  type: string;
  message: string;
  timestamp: number;
}

export interface LogEntry {
  level: "error" | "warn" | "log";
  message: string;
  ts_ms: number;
}

export interface DomElement {
  tagName: string;
  id: string | null;
  classes: string[];
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  attrs: Record<string, string>;
  visible: boolean;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function getPort(): number {
  try {
    return parseInt(readFileSync("/tmp/splice-dev-api.port", "utf8").trim(), 10);
  } catch {
    return 19990;
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const port = getPort();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`dev-api ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------

export const api = {
  /** Check the dev server is reachable. */
  ping(): Promise<{ ok: boolean }> {
    return req("GET", "/dev/ping");
  },

  /** Full app state snapshot. Useful for assertions on internal state. */
  state(): Promise<DevState> {
    return req("GET", "/dev/state");
  },

  /**
   * Drain the frontend console log buffer.
   * Destructive — buffer is cleared on each call.
   */
  logs(): Promise<LogEntry[]> {
    return req("GET", "/dev/logs");
  },

  /** Close all workspaces and reset UI state to defaults. */
  reset(): Promise<{ ok: boolean }> {
    return req("POST", "/dev/reset", {});
  },

  /** Open a directory as a new workspace. */
  openFolder(path: string): Promise<{ ok: boolean }> {
    return req("POST", "/dev/open-folder", { path });
  },

  /** Split the active pane. */
  splitPane(direction: "vertical" | "horizontal"): Promise<{ ok: boolean }> {
    return req("POST", "/dev/split-pane", { direction });
  },

  /** Write a command to a terminal PTY. */
  runTerminal(cmd: string, terminalId?: number): Promise<{ ok: boolean }> {
    return req("POST", "/dev/run-terminal", { cmd, terminalId });
  },

  /**
   * Query DOM elements by CSS selector.
   * Returns an array of matched elements with their tag, classes, text, bounding rect, and attrs.
   * Empty array if nothing matches.
   */
  domQuery(selector: string): Promise<DomElement[]> {
    return req("POST", "/dev/dom-query", { selector });
  },

  /**
   * Like domQuery but returns the first match, or null if nothing matched.
   */
  async domFirst(selector: string): Promise<DomElement | null> {
    const results = await api.domQuery(selector);
    return results[0] ?? null;
  },

  /**
   * Poll domQuery until at least one element matches (or timeout).
   */
  async waitForDom(
    selector: string,
    opts: { timeoutMs?: number; intervalMs?: number; visible?: boolean } = {}
  ): Promise<DomElement[]> {
    const { timeoutMs = 5000, intervalMs = 150, visible = false } = opts;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const results = await api.domQuery(selector);
      const matches = visible ? results.filter(el => el.visible) : results;
      if (matches.length > 0) return matches;
      await sleep(intervalMs);
    }
    throw new Error(`dev-api: timed out waiting for DOM selector "${selector}" after ${timeoutMs}ms`);
  },

  /**
   * Dispatch a synthetic KeyboardEvent to the app's document.
   * Mirrors the old wdio pressKey() helper — no WebDriver needed.
   */
  keyboard(
    key: string,
    mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean; code?: string } = {}
  ): Promise<{ ok: boolean }> {
    return req("POST", "/dev/keyboard", { key, ...mods });
  },

  /**
   * Replace the active editor file's in-memory content (marks dirty).
   * Use to set up content before testing save/dirty/LSP flows.
   */
  setFileContent(content: string): Promise<{ ok: boolean }> {
    return req("POST", "/dev/set-file-content", { content });
  },

  /** Set UI fields (explorerVisible, zenMode, etc.). */
  setUi(fields: Partial<DevState["ui"]>): Promise<{ ok: boolean }> {
    return req("POST", "/dev/ui", fields);
  },

  /** Resize the window. */
  resize(width: number, height: number): Promise<{ ok: boolean }> {
    return req("POST", "/dev/resize", { width, height });
  },

  // ---------------------------------------------------------------------------
  // Polling helpers
  // ---------------------------------------------------------------------------

  /**
   * Poll `api.state()` until `predicate` returns true or `timeoutMs` elapses.
   * Rejects with a descriptive error on timeout.
   */
  async waitFor(
    predicate: (s: DevState) => boolean,
    options: { timeoutMs?: number; intervalMs?: number; label?: string } = {}
  ): Promise<DevState> {
    const { timeoutMs = 8000, intervalMs = 200, label = "condition" } = options;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await api.state();
      if (predicate(s)) return s;
      await sleep(intervalMs);
    }
    throw new Error(`dev-api: timed out waiting for ${label} after ${timeoutMs}ms`);
  },

  /** Wait until at least one workspace exists. */
  waitForWorkspace(opts?: { timeoutMs?: number }): Promise<DevState> {
    return api.waitFor(s => s.workspaces.length > 0, { label: "workspace", ...opts });
  },

  /** Wait until all workspaces are gone. */
  waitForReset(opts?: { timeoutMs?: number }): Promise<DevState> {
    return api.waitFor(s => s.workspaces.length === 0, { label: "reset", ...opts });
  },

  /**
   * Drain logs and return only error/warn entries.
   * Throws if any errors are present and `failOnError` is true (default).
   */
  async assertNoErrors(opts: { failOnError?: boolean } = {}): Promise<LogEntry[]> {
    const { failOnError = true } = opts;
    const entries = await api.logs();
    const problems = entries.filter(e => {
      if (e.level !== "error" && e.level !== "warn") return false;
      // Benign Tauri race: async op completes after workspace reset clears JS callbacks
      if (e.message.includes("Couldn't find callback id")) return false;
      return true;
    });
    if (failOnError && problems.length > 0) {
      const lines = problems.map(e => `  [${e.level.toUpperCase()}] ${e.message}`).join("\n");
      throw new Error(`Frontend console errors detected:\n${lines}`);
    }
    return problems;
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
