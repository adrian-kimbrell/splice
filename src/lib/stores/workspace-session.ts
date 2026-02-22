import type { Workspace } from "./workspace-types";
import type { RustWorkspace } from "../ipc/commands";
import { validateLayout } from "./workspace-tab-ops";
import { remapLayout, findFirstLeaf, frontendToRustLayout } from "./workspace-types";
import { collectLeafIds } from "./layout.svelte";
import { settings } from "./settings.svelte";

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
    const { saveWorkspace } = await import("../ipc/commands");

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
              ? { Terminal: { shell: settings.terminal.default_shell, cwd: ws.rootPath } }
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
  };

  for (const paneInfo of rws.panes) {
    const paneType = paneInfo.pane_type as Record<string, unknown> | null;
    const isTerminal = paneType != null && "Terminal" in paneType;

    if (isTerminal) {
      try {
        const terminalId = await spawnTerminal(
          settings.terminal.default_shell,
          rws.root_path || "/",
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
        // Each additional Claude pane is staggered by 1000ms to avoid concurrent
        // shell initialization + command injection.
        if (paneInfo.claude_session_id) {
          const sessionId = paneInfo.claude_session_id;
          const savedPid = paneInfo.claude_pid ?? null;
          const delay = 2000 + (resumeStartIndex + localClaudeResumeIndex) * 1000;
          localClaudeResumeIndex++;
          setTimeout(async () => {
            // Validate session ID before injecting into the PTY to prevent command injection
            if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
              console.warn("Refusing to inject suspicious session ID:", sessionId);
              return;
            }
            // If the saved Claude PID is still alive, Claude didn't exit when Splice closed.
            // Skip injection to avoid spawning a second overlapping Claude process.
            if (savedPid !== null) {
              try {
                const alive = await checkPidAlive(savedPid);
                if (alive) {
                  console.info(`Claude PID ${savedPid} still alive; skipping --resume for terminal ${terminalId}`);
                  return;
                }
              } catch { /* ignore — if check fails, proceed with resume */ }
            }
            try {
              await writeToTerminal(
                terminalId,
                new TextEncoder().encode(`claude --resume ${sessionId}\n`),
              );
            } catch (e) {
              console.warn("Failed to inject claude --resume:", e);
            }
          }, delay);
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

  // Remap the saved layout using the new terminal IDs
  if (rws.layout) {
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

