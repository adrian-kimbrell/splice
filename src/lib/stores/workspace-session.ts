import { log } from "../utils/log";
import type { Workspace } from "./workspace-types";
import { type RustWorkspace, type RustPaneInfo, checkPidAlive, getTerminalCwd, gitDiffFile, killTerminal, readFile, saveWorkspace, spawnTerminal, writeToTerminal } from "../ipc/commands";
import { validateLayout } from "./workspace-tab-ops";
import { onTerminalGrid } from "../ipc/events";
import { remapLayout, findFirstLeaf, frontendToRustLayout, buildSshExtraArgs, addOpenFile, newWorkspace } from "./workspace-types";
import { collectLeafIds, removeNodeFromTree } from "./layout.svelte";
import { effectiveSettings, defaultViewMode } from "./settings.svelte";
import { SIDEBAR_MIN_WIDTH, SIDEBAR_DEFAULT_WIDTH } from "./ui.svelte";

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
      { minWait: staggerMs, stableMs: 600, hardTimeout: staggerMs + 6_000 },
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
        } catch (e) { log.warn("claude --resume injection failed:", e); }
      }, extra);
      pending.timers.push(t);
    }
  })();
}

export async function persistWorkspaceImpl(ws: Workspace, activeFilePath: string | null): Promise<void> {
  // A workspace whose last pane was closed still exists (root, name, icon) and must
  // be saved as "no panes"; skipping the save left the previous record on disk and
  // its terminals came back on the next launch.
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!isTauri) return;

  // Capture layout and panes before the first await. layoutSnapshot is a reference
  // alias (not a copy), so it reflects the tree as-of-now. panesSnapshot is a
  // shallow object copy — it freezes the set of pane IDs but not pane contents.
  const layoutSnapshot = ws.layout; // null when every pane has been closed
  const panesSnapshot = { ...ws.panes };
  const layoutLeafIds = layoutSnapshot ? collectLeafIds(layoutSnapshot) : new Set<string>();

  try {

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

    // Persist all panes referenced in the layout tree.
    // Diff panes have no Rust PaneType so they're stored as a special sentinel in file_paths:
    // ["diff-pane-v1", "<staged|unstaged>", "<filePath>"]
    // This lets restore re-fetch the git diff and recreate the pane.
    const panes = Object.values(panesSnapshot)
      .filter(pane => layoutLeafIds.has(pane.id))
      .map((pane) => {
        const claudeSessionId = pane.kind === "terminal" ? (pane.claudeSessionId ?? null) : null;
        const claudePid = pane.kind === "terminal" ? (pane.claudePid ?? null) : null;
        const terminalId = pane.kind === "terminal" ? (pane.terminalId ?? null) : null;
        const isDiff = pane.kind === "diff";
        return {
          id: pane.id,
          pane_type: pane.kind === "terminal"
            ? { Terminal: { shell: effectiveSettings.terminal.default_shell, cwd: terminalCwdMap.get(pane.id) ?? ws.rootPath } }
            : { Editor: { file_path: isDiff ? "" : (pane.activeFilePath ?? "") } },
          title: pane.title,
          file_paths: isDiff
            ? ["diff-pane-v1", pane.diffStaged ? "staged" : "unstaged", pane.diffFilePath ?? ""]
            : (pane.filePaths ?? []),
          active_file_path: isDiff ? null : (pane.activeFilePath ?? null),
          claude_session_id: claudeSessionId,
          claude_pid: claudePid,
          terminal_id: terminalId,
        };
      });

    await saveWorkspace({
      id: ws.id,
      name: ws.name,
      root_path: ws.rootPath,
      layout: layoutSnapshot ? frontendToRustLayout(layoutSnapshot) : null,
      panes,
      terminal_ids: ws.terminalIds,
      open_file_paths: ws.openFiles.map((f) => f.path),
      active_file_path: activeFilePath,
      active_pane_id: ws.activePaneId,
      explorer_visible: ws.explorerVisible,
      explorer_width: ws.explorerWidth,
      expanded_paths: ws.expandedPaths ? [...ws.expandedPaths] : [],
      ssh_config: ws.sshConfig
        ? {
            host: ws.sshConfig.host,
            port: ws.sshConfig.port,
            user: ws.sshConfig.user,
            key_path: ws.sshConfig.keyPath,
            remote_path: ws.sshConfig.remotePath,
          }
        : null,
      icon: ws.icon ?? null,
      view_mode: ws.viewMode ?? null,
    } as RustWorkspace);
  } catch (e) {
    log.error("Failed to persist workspace:", e);
  }
}

/**
 * Rebuild a workspace from its persisted record.
 *
 * `register` is called with the bare skeleton before any file or pane is added
 * and must return the instance to populate. The manager uses it to insert the
 * skeleton into its `$state` map and hand back the live proxy: files added to a
 * plain object that is proxied afterwards end up as two independent proxies in
 * `openFiles` and `openFileIndex` (see `addOpenFile`), and a dirty flag set
 * through one was invisible through the other.
 */
export async function restoreWorkspaceImpl(
  rws: RustWorkspace,
  resumeStartIndex: number,
  allocateTermNum: () => number,
  register: (skeleton: Workspace) => Workspace = (w) => w,
): Promise<{ ws: Workspace; resumeCount: number }> {

  const idMap = new Map<string, string>();
  // Each Claude resume injection is staggered so they don't all hit the shell at once.
  const resume = { count: 0, startIndex: resumeStartIndex };

  const ws: Workspace = register(newWorkspace({
    id: rws.id,
    name: rws.name,
    rootPath: rws.root_path,
    explorerVisible: rws.explorer_visible ?? true,
    explorerWidth: Math.max(SIDEBAR_MIN_WIDTH.explorer, rws.explorer_width ?? SIDEBAR_DEFAULT_WIDTH.explorer),
    expandedPaths: new Set(rws.expanded_paths ?? []),
    sshConfig: rws.ssh_config
      ? {
          host: rws.ssh_config.host,
          port: rws.ssh_config.port,
          user: rws.ssh_config.user,
          keyPath: rws.ssh_config.key_path,
          remotePath: rws.ssh_config.remote_path,
        }
      : null,
    icon: rws.icon ?? null,
    viewMode: rws.view_mode ?? defaultViewMode(),
  }));

  for (const paneInfo of rws.panes) {
    // SSH workspaces restore through the same path as local ones (spawnTerminal
    // handles SSH via its extra args); they used to skip pane restoration entirely.
    const paneId = isTerminalPane(paneInfo)
      ? await restoreTerminalPane(ws, rws, paneInfo, allocateTermNum, resume)
      : isDiffPane(paneInfo)
        ? await restoreDiffPane(ws, rws, paneInfo)
        : await restoreEditorPane(ws, rws, paneInfo);
    // A pane that could not be restored is left out of idMap, so the layout
    // remap below treats its leaf as missing and prunes it.
    if (paneId) idMap.set(paneInfo.id, paneId);
  }

  restoreLayout(ws, rws, idMap);
  killOrphanedTerminals(ws);
  validateLayout(ws);

  return { ws, resumeCount: resume.count };
}

function isTerminalPane(paneInfo: RustPaneInfo): boolean {
  const pt = paneInfo.pane_type as Record<string, unknown> | null;
  return pt != null && "Terminal" in pt;
}

/** Diff panes are persisted as Editor panes with a marker triple in file_paths. */
function isDiffPane(paneInfo: RustPaneInfo): boolean {
  return paneInfo.file_paths.length === 3 && paneInfo.file_paths[0] === "diff-pane-v1";
}

interface ResumeCounter {
  /** Number of Claude resumes scheduled so far in this workspace. */
  count: number;
  /** Resumes already scheduled by earlier workspaces in the same launch. */
  startIndex: number;
}

/**
 * Respawn a terminal pane's PTY (one retry) and schedule its Claude session
 * resume. Returns the new pane id, or null when both spawn attempts failed.
 */
async function restoreTerminalPane(
  ws: Workspace,
  rws: RustWorkspace,
  paneInfo: RustPaneInfo,
  allocateTermNum: () => number,
  resume: ResumeCounter,
): Promise<string | null> {
  const pt = paneInfo.pane_type as { Terminal?: { cwd?: string } };
  const savedCwd = pt.Terminal?.cwd ? pt.Terminal.cwd : null;

  // SSH workspaces spawn `/usr/bin/ssh` with the SshConfig-derived extra args
  // (matching the live-spawn path); local workspaces use the default shell.
  // The saved terminal_id is passed through so the Rust side keeps the id.
  const isSsh = ws.sshConfig != null;
  const shell = isSsh ? "/usr/bin/ssh" : effectiveSettings.terminal.default_shell;
  const cwd = isSsh ? "/" : (savedCwd || rws.root_path || "/");
  const extraArgs = isSsh ? buildSshExtraArgs(ws.sshConfig!) : undefined;
  const savedTerminalId = paneInfo.terminal_id ?? undefined;

  let terminalId: number;
  try {
    try {
      terminalId = await spawnTerminal(shell, cwd, 80, 24, extraArgs, savedTerminalId);
    } catch (firstErr) {
      log.warn(
        `Terminal spawn failed for pane ${paneInfo.id} in workspace "${rws.name}" (cwd=${cwd}), retrying once in 250ms:`,
        firstErr,
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      terminalId = await spawnTerminal(shell, cwd, 80, 24, extraArgs, savedTerminalId);
    }
  } catch (e) {
    log.error(
      `Failed to spawn terminal during restore (after retry) for pane ${paneInfo.id} in workspace "${rws.name}" (title="${paneInfo.title}"):`,
      e,
    );
    return null;
  }

  const paneId = `term-${terminalId}`;
  ws.terminalIds.push(terminalId);
  ws.activeTerminalId = terminalId;
  ws.panes[paneId] = { id: paneId, kind: "terminal", title: paneInfo.title, terminalId };
  allocateTermNum(); // advance the counter for each restored terminal

  if (paneInfo.claude_session_id) scheduleResumeForPane(terminalId, paneInfo, rws, resume);
  return paneId;
}

/**
 * Schedule `claude --resume` for a restored terminal. The first 8 sessions are
 * 600 ms apart; beyond that they go in waves of 8 offset by 8 s, so the slot
 * within a wave stays tight while total time never runs away (and the base
 * delay stays well below the hard timeout for any realistic count).
 */
function scheduleResumeForPane(terminalId: number, paneInfo: RustPaneInfo, rws: RustWorkspace, resume: ResumeCounter): void {
  const sessionId = paneInfo.claude_session_id!;
  // A suspicious id still gets a usable terminal: skip the injection, keep the shell.
  if (!isValidSessionId(sessionId)) {
    log.warn(
      `Refusing to inject suspicious session ID for pane ${paneInfo.id} in workspace "${rws.name}": ${sessionId}. Spawning fresh terminal instead.`,
    );
    return;
  }
  const idx = resume.startIndex + resume.count;
  const wave = Math.floor(idx / 8);
  const slot = idx % 8;
  const baseDelay = 500 + wave * 8_000 + slot * 600;
  resume.count++;
  // savedPid is null: restore always spawns a fresh PTY, so the old Claude is
  // dead whatever the saved PID says; passing it risks a recycled PID cancelling
  // the resume.
  scheduleClaudeResume(terminalId, sessionId, null, baseDelay, {
    checkPidAlive,
    writeToTerminal,
    subscribeToFrames: onTerminalGrid,
  });
}

/** Re-fetch the diff from git. Null when the file was committed or discarded meanwhile. */
async function restoreDiffPane(ws: Workspace, rws: RustWorkspace, paneInfo: RustPaneInfo): Promise<string | null> {
  const staged = paneInfo.file_paths[1] === "staged";
  const filePath = paneInfo.file_paths[2];
  const paneId = `diff-${crypto.randomUUID().slice(0, 8)}`;
  try {
    const diff = await gitDiffFile(rws.root_path, filePath, staged);
    ws.panes[paneId] = {
      id: paneId,
      kind: "diff",
      title: filePath.split("/").pop() ?? filePath,
      diffFilePath: filePath,
      diffOldContent: diff.old_content,
      diffNewContent: diff.new_content,
      diffStaged: staged,
      diffPreview: false,
    };
    return paneId;
  } catch (e) {
    log.warn(`Failed to restore diff pane for "${filePath}":`, e);
    return null;
  }
}

/** Reopen the pane's files. Null when none of them could be read (a blank pane is never restored). */
async function restoreEditorPane(ws: Workspace, rws: RustWorkspace, paneInfo: RustPaneInfo): Promise<string | null> {
  const paneId = `editor-${crypto.randomUUID().slice(0, 8)}`;
  const filePaths: string[] = [];
  for (const path of paneInfo.file_paths) {
    if (path.startsWith("untitled-")) {
      if (!ws.openFileIndex[path]) addOpenFile(ws, { name: path, path, content: "" });
      filePaths.push(path);
      continue;
    }
    try {
      const content = await readFile(path);
      const name = path.split("/").pop() ?? path;
      if (!ws.openFileIndex[path]) addOpenFile(ws, { name, path, content });
      filePaths.push(path);
    } catch (e) {
      // The file may be gone. Not surfaced to the user, but traced so restore
      // weirdness stays debuggable.
      log.debug(
        `Skipping missing/unreadable file during restore: "${path}" (workspace "${rws.name}", pane ${paneInfo.id}):`,
        e,
      );
    }
  }
  // Blank editor panes are artifacts of diff panes once persisted as empty
  // Editor entries; a real editor pane always has at least one file.
  if (filePaths.length === 0) return null;

  const activeFilePath =
    paneInfo.active_file_path && filePaths.includes(paneInfo.active_file_path)
      ? paneInfo.active_file_path
      : (filePaths[0] ?? null);
  ws.panes[paneId] = { id: paneId, kind: "editor", title: paneInfo.title, filePaths, activeFilePath };
  return paneId;
}

/** Remap the saved layout onto the new pane ids and drop leaves whose pane did not come back. */
function restoreLayout(ws: Workspace, rws: RustWorkspace, idMap: Map<string, string>): void {
  if (rws.layout) {
    try {
      ws.layout = remapLayout(rws.layout, idMap);
    } catch (e) {
      log.warn("Failed to remap workspace layout:", e);
      const firstPaneId = Object.keys(ws.panes)[0];
      if (firstPaneId) ws.layout = { type: "leaf", paneId: firstPaneId };
    }
    if (ws.layout) {
      const paneIds = new Set(Object.keys(ws.panes));
      for (const leafId of [...collectLeafIds(ws.layout)].filter((id) => !paneIds.has(id))) {
        ws.layout = removeNodeFromTree(ws.layout!, leafId).tree; // null once every pane is gone
      }
    }
  }
  ws.activePaneId = (rws.active_pane_id && idMap.get(rws.active_pane_id)) ?? findFirstLeaf(ws.layout);
}

/** Kill PTYs whose pane ended up outside the layout (its leaf was pruned). */
function killOrphanedTerminals(ws: Workspace): void {
  if (!ws.layout) return;
  const layoutLeafIds = collectLeafIds(ws.layout);
  for (const [paneId, pane] of Object.entries(ws.panes)) {
    if (!layoutLeafIds.has(paneId) && pane.kind === "terminal" && pane.terminalId != null) {
      killTerminal(pane.terminalId).catch((e) => log.warn("Failed to kill orphaned terminal:", pane.terminalId, e));
    }
  }
}

