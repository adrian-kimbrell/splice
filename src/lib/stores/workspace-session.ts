import type { Workspace } from "./workspace-types";
import type { RustWorkspace } from "../ipc/commands";
import { validateLayout } from "./workspace-tab-ops";
import { remapLayout, findFirstLeaf, frontendToRustLayout } from "./workspace-types";
import { collectLeafIds } from "./layout.svelte";
import { settings } from "./settings.svelte";

interface PendingResume {
  timers: ReturnType<typeof setTimeout>[];
  abort: AbortController;
}

/** terminalId → pending resume state (abort controller + retry timers) */
const pendingResumeTimers = new Map<number, PendingResume>();

/** Cancel all pending --resume retries for a terminal (call on session success or terminal kill). */
export function cancelPendingResume(terminalId: number): void {
  const pending = pendingResumeTimers.get(terminalId);
  if (pending) {
    pending.timers.forEach(clearTimeout);
    pending.abort.abort();
    pendingResumeTimers.delete(terminalId);
  }
}

/** Returns true if `id` is a safe Claude session ID (alphanumeric, hyphens, underscores, 1–128 chars). */
export function isValidSessionId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(id);
}

/**
 * Waits until the shell is idle at a prompt by detecting cursor stability.
 * Subscribes to terminal frame events and resolves once the cursor has not
 * moved for `stableMs` after an initial `minWait` period.
 * Falls back to resolving after `hardTimeout` if stability is never reached.
 */
export async function waitForShellReady(
  terminalId: number,
  opts: { minWait: number; stableMs: number; hardTimeout: number },
  deps: {
    subscribeToFrames: (id: number, cb: (data: Uint8Array) => void) => Promise<() => void>;
    signal?: AbortSignal;
  },
): Promise<void> {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((r) => { resolvePromise = r; });

  let unsubscribeFn: (() => void) | null = null;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  let minWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let isDone = false;
  let minWaitDone = false;
  let lastCursorKey = "";

  function cleanup() {
    if (unsubscribeFn) { unsubscribeFn(); unsubscribeFn = null; }
    if (stableTimer !== null) { clearTimeout(stableTimer); stableTimer = null; }
    if (hardTimer !== null) { clearTimeout(hardTimer); hardTimer = null; }
    if (minWaitTimer !== null) { clearTimeout(minWaitTimer); minWaitTimer = null; }
  }

  function done() {
    if (isDone) return;
    isDone = true;
    cleanup();
    resolvePromise();
  }

  if (deps.signal?.aborted) {
    resolvePromise();
    return promise;
  }
  deps.signal?.addEventListener("abort", done, { once: true });

  hardTimer = setTimeout(done, opts.hardTimeout);

  try {
    unsubscribeFn = await deps.subscribeToFrames(terminalId, (data: Uint8Array) => {
    if (isDone || !minWaitDone) return;
    if (data.byteLength < 8) return;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const col = view.getUint16(4, true);
    const row = view.getUint16(6, true);
    const key = `${col}:${row}`;
    if (key !== lastCursorKey) {
      lastCursorKey = key;
      if (stableTimer !== null) clearTimeout(stableTimer);
      stableTimer = setTimeout(done, opts.stableMs);
    }
  });
  } catch {
    // subscribeToFrames failed — hard timeout will resolve
  }

  if (isDone) {
    unsubscribeFn?.();
    unsubscribeFn = null;
    return promise;
  }

  minWaitTimer = setTimeout(() => {
    minWaitDone = true;
    minWaitTimer = null;
    stableTimer = setTimeout(done, opts.stableMs);
  }, opts.minWait);

  return promise;
}

/**
 * Schedule `claude --resume {sessionId}` injection into a terminal.
 * Waits for shell-ready detection (cursor stability after `staggerMs`), then
 * retries 3 times at +0ms, +5000ms, +13000ms.
 * Cancels all retries if `savedPid` is still alive (Claude didn't exit).
 */
export function scheduleClaudeResume(
  terminalId: number,
  sessionId: string,
  savedPid: number | null,
  staggerMs: number,
  deps: {
    checkPidAlive: (pid: number) => Promise<boolean>;
    writeToTerminal: (id: number, data: Uint8Array) => Promise<void>;
    subscribeToFrames: (id: number, cb: (data: Uint8Array) => void) => Promise<() => void>;
  },
): void {
  (async () => {
    const abort = new AbortController();
    pendingResumeTimers.set(terminalId, { timers: [], abort });

    await waitForShellReady(
      terminalId,
      { minWait: staggerMs, stableMs: 400, hardTimeout: 10_000 },
      { subscribeToFrames: deps.subscribeToFrames, signal: abort.signal },
    );

    if (!pendingResumeTimers.has(terminalId)) return; // cancelled

    const pending = pendingResumeTimers.get(terminalId)!;
    const RETRY_EXTRA = [0, 5000, 13000];
    for (const extra of RETRY_EXTRA) {
      const t = setTimeout(async () => {
        if (!pendingResumeTimers.has(terminalId)) return;
        if (savedPid !== null) {
          try {
            const alive = await deps.checkPidAlive(savedPid);
            if (alive) {
              cancelPendingResume(terminalId);
              return;
            }
          } catch { /* ignore — if check fails, proceed with resume */ }
        }
        try {
          await deps.writeToTerminal(terminalId, new TextEncoder().encode(`claude --resume ${sessionId}\n`));
        } catch (e) { console.warn("claude --resume injection failed:", e); }
      }, extra);
      pending.timers.push(t);
    }
  })();
}

export async function persistWorkspaceImpl(ws: Workspace, activeFilePath: string | null): Promise<void> {
  if (!ws.layout) return; // nothing to persist if no panes

  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!isTauri) return;

  // Capture layout and panes before the first await. layoutSnapshot is a reference
  // alias (not a copy), so it reflects the tree as-of-now. panesSnapshot is a
  // shallow object copy — it freezes the set of pane IDs but not pane contents.
  const layoutSnapshot = ws.layout;
  const panesSnapshot = { ...ws.panes };
  const layoutLeafIds = collectLeafIds(layoutSnapshot);

  try {
    const { saveWorkspace, getTerminalCwd } = await import("../ipc/commands");

    // Gather actual terminal CWDs in parallel before building the panes array.
    const terminalCwdMap = new Map<string, string>();
    await Promise.all(
      Object.values(panesSnapshot)
        .filter(p => p.kind === "terminal" && p.terminalId != null)
        .map(async (p) => {
          const cwd = await getTerminalCwd(p.terminalId!).catch(() => null);
          if (cwd) terminalCwdMap.set(p.id, cwd);
        })
    );

    // Only persist panes that are referenced in the layout tree.
    const panes = Object.values(panesSnapshot)
      .filter(pane => layoutLeafIds.has(pane.id))
      .map((pane) => {
        const claudeSessionId = pane.kind === "terminal" ? (pane.claudeSessionId ?? null) : null;
        const claudePid = pane.kind === "terminal" ? (pane.claudePid ?? null) : null;
        return {
          id: pane.id,
          pane_type:
            pane.kind === "terminal"
              ? { Terminal: { shell: settings.terminal.default_shell, cwd: terminalCwdMap.get(pane.id) ?? ws.rootPath } }
              : { Editor: { file_path: pane.activeFilePath ?? "" } },
          title: pane.title,
          file_paths: pane.filePaths ?? [],
          active_file_path: pane.activeFilePath ?? null,
          claude_session_id: claudeSessionId,
          claude_pid: claudePid,
        };
      });

    await saveWorkspace({
      id: ws.id,
      name: ws.name,
      root_path: ws.rootPath,
      layout: frontendToRustLayout(layoutSnapshot),
      panes,
      terminal_ids: ws.terminalIds,
      open_file_paths: ws.openFiles.map((f) => f.path),
      active_file_path: activeFilePath,
      active_pane_id: ws.activePaneId,
      explorer_visible: ws.explorerVisible,
      ssh_config: ws.sshConfig
        ? {
            host: ws.sshConfig.host,
            port: ws.sshConfig.port,
            user: ws.sshConfig.user,
            key_path: ws.sshConfig.keyPath,
            remote_path: ws.sshConfig.remotePath,
          }
        : null,
    } as RustWorkspace);
  } catch (e) {
    console.error("Failed to persist workspace:", e);
  }
}

export async function restoreWorkspaceImpl(
  rws: RustWorkspace,
  resumeStartIndex: number,
  allocateTermNum: () => number,
): Promise<{ ws: Workspace; resumeCount: number }> {
  // Hoist all IPC imports once to avoid repeated dynamic import overhead in loops.
  const { spawnTerminal, readFile, checkPidAlive, writeToTerminal, killTerminal } =
    await import("../ipc/commands");
  const { onTerminalGrid } = await import("../ipc/events");

  const idMap = new Map<string, string>();
  // Each claude resume injection is staggered so they don't all hit the shell at once.
  let localClaudeResumeIndex = 0;

  const ws: Workspace = {
    id: rws.id,
    name: rws.name,
    rootPath: rws.root_path,
    fileTree: [],
    openFiles: [],
    openFileIndex: {},
    terminalIds: [],
    activeTerminalId: null,
    layout: null,
    panes: {},
    activePaneId: null,
    gitBranch: "",
    explorerVisible: rws.explorer_visible ?? true,
    sshConfig: rws.ssh_config
      ? {
          host: rws.ssh_config.host,
          port: rws.ssh_config.port,
          user: rws.ssh_config.user,
          keyPath: rws.ssh_config.key_path,
          remotePath: rws.ssh_config.remote_path,
        }
      : null,
  };

  for (const paneInfo of rws.panes) {
    // SSH workspaces: skip pane restoration — terminals will be spawned as SSH
    // terminals after sshConnect, and files need SFTP (unavailable yet).
    if (rws.ssh_config) continue;

    const paneType = paneInfo.pane_type as Record<string, unknown> | null;
    const isTerminal = paneType != null && "Terminal" in paneType;

    if (isTerminal) {
      try {
        const savedCwd = (() => {
          const pt = paneInfo.pane_type as Record<string, unknown> | null;
          if (pt && "Terminal" in pt) {
            const t = pt.Terminal as { cwd?: string };
            return t.cwd && t.cwd !== "" ? t.cwd : null;
          }
          return null;
        })();

        const terminalId = await spawnTerminal(
          settings.terminal.default_shell,
          savedCwd || rws.root_path || "/",
          80,
          24,
        );
        const paneId = `term-${terminalId}`;
        idMap.set(paneInfo.id, paneId);

        ws.terminalIds.push(terminalId);
        ws.activeTerminalId = terminalId;
        ws.panes[paneId] = {
          id: paneId,
          kind: "terminal",
          title: paneInfo.title,
          terminalId,
        };
        allocateTermNum(); // advance the counter for each restored terminal

        // Resume Claude session after terminal is ready.
        // Base delay of 2000ms lets the shell finish sourcing RC files (PATH setup).
        // Each additional Claude pane is staggered by 300ms to avoid concurrent
        // shell initialization + command injection.
        if (paneInfo.claude_session_id) {
          const sessionId = paneInfo.claude_session_id;

          if (!isValidSessionId(sessionId)) {
            console.warn("Refusing to inject suspicious session ID:", sessionId);
          } else {
            const baseDelay = 500 + (resumeStartIndex + localClaudeResumeIndex) * 300;
            localClaudeResumeIndex++;
            // Pass null for savedPid: on restore we always spawn a fresh PTY, so
            // the old Claude is guaranteed dead regardless of what the saved PID
            // value is. Passing savedPid here risks PID reuse (the OS recycled
            // that PID for an unrelated process) causing the resume to be wrongly
            // cancelled.
            scheduleClaudeResume(terminalId, sessionId, null, baseDelay, {
              checkPidAlive,
              writeToTerminal,
              subscribeToFrames: onTerminalGrid,
            });
          }
        }
      } catch (e) {
        console.error("Failed to spawn terminal during restore:", e);
      }
    } else {
      // Editor pane: restore open files
      const paneId = `editor-${crypto.randomUUID().slice(0, 8)}`;
      idMap.set(paneInfo.id, paneId);

      const filePaths: string[] = [];
      for (const path of paneInfo.file_paths) {
        if (path.startsWith("untitled-")) {
          if (!ws.openFileIndex[path]) {
            const file = { name: path, path, content: "" };
            ws.openFiles.push(file);
            ws.openFileIndex[path] = file;
          }
          filePaths.push(path);
        } else {
          try {
            const content = await readFile(path);
            const name = path.split("/").pop() ?? path;
            if (!ws.openFileIndex[path]) {
              const file = { name, path, content };
              ws.openFiles.push(file);
              ws.openFileIndex[path] = file;
            }
            filePaths.push(path);
          } catch {
            // File may no longer exist — skip it silently
          }
        }
      }

      const activeFilePath =
        paneInfo.active_file_path && filePaths.includes(paneInfo.active_file_path)
          ? paneInfo.active_file_path
          : (filePaths[0] ?? null);

      ws.panes[paneId] = {
        id: paneId,
        kind: "editor",
        title: paneInfo.title,
        filePaths,
        activeFilePath,
      };
    }
  }

  // Remap the saved layout using the new terminal IDs (not needed for SSH workspaces
  // since all panes were skipped; layout stays null and will be built post-connect).
  if (rws.layout && !rws.ssh_config) {
    try {
      ws.layout = remapLayout(rws.layout, idMap);
    } catch (e) {
      console.warn("Failed to remap workspace layout:", e);
      // Fall back to first pane as leaf if layout is corrupt
      const firstPaneId = Object.keys(ws.panes)[0];
      if (firstPaneId) ws.layout = { type: "leaf", paneId: firstPaneId };
    }
  }

  // Set active pane
  ws.activePaneId =
    (rws.active_pane_id && idMap.get(rws.active_pane_id)) ?? findFirstLeaf(ws.layout);

  // Kill any spawned terminals whose pane ended up orphaned (not in the layout).
  if (ws.layout) {
    const layoutLeafIds = collectLeafIds(ws.layout);
    const orphanedTerminalIds: number[] = [];
    for (const [paneId, pane] of Object.entries(ws.panes)) {
      if (!layoutLeafIds.has(paneId) && pane.kind === "terminal" && pane.terminalId != null) {
        orphanedTerminalIds.push(pane.terminalId);
      }
    }
    if (orphanedTerminalIds.length > 0) {
      for (const tid of orphanedTerminalIds) {
        killTerminal(tid).catch(() => {});
      }
    }
  }

  validateLayout(ws);

  return { ws, resumeCount: localClaudeResumeIndex };
}

