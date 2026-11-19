/**
 * Start a coding agent in a new terminal and hand it a task.
 *
 * Shared by the MCP `spawn_agent` tool (an agent delegating work) and the inbox
 * ("Start Claude on this"). Rust has already written the brief to a handoff file
 * and built `command`, a shell line that launches the agent with that file's
 * contents as its first prompt; this module only decides where the terminal goes
 * and types the command once the shell is ready.
 */
import { workspaceManager } from "../stores/workspace.svelte";
import { waitForShellReady } from "../stores/workspace-session";
import { onTerminalGrid } from "../ipc/events";
import { writeToTerminal } from "../ipc/commands";
import type { AgentKind } from "../stores/layout.svelte";
import { log } from "../utils/log";

export interface SpawnAgentRequest {
  target: "new_terminal" | "new_workspace";
  /** Canonical folder path; required for `new_workspace`. */
  path?: string | null;
  agent: AgentKind;
  command: string;
  /** The terminal the requesting agent runs in, when known. */
  callerTerminalId?: number | null;
}

export interface SpawnAgentResult {
  terminal_id: number;
  pane_id: string;
  workspace_id: string;
  workspace: string;
}

export interface SpawnAgentDeps {
  writeToTerminal: (id: number, data: Uint8Array) => Promise<void>;
  subscribeToFrames: (id: number, cb: (data: Uint8Array) => void) => Promise<() => void>;
}

const defaultDeps: SpawnAgentDeps = { writeToTerminal, subscribeToFrames: onTerminalGrid };

/** The workspace that owns a terminal in this window, if any. */
export function workspaceIdOfTerminal(terminalId: number): string | null {
  for (const ws of Object.values(workspaceManager.workspaces)) {
    if (ws.terminalIds.includes(terminalId)) return ws.id;
  }
  return null;
}

function paneTitle(agent: AgentKind): string {
  return agent === "codex" ? "Codex task" : "Claude task";
}

/**
 * Create the terminal and schedule the launch. Resolves as soon as the terminal
 * exists; the command is typed in the background once the shell prompt settles,
 * so the caller is not held for the shell's startup time.
 */
export async function spawnAgent(req: SpawnAgentRequest, deps: SpawnAgentDeps = defaultDeps): Promise<SpawnAgentResult> {
  let wsId: string | null;
  let terminalId: number | null;

  if (req.target === "new_workspace") {
    if (!req.path) throw new Error("path is required for a new workspace");
    const existing = Object.values(workspaceManager.workspaces).find((w) => w.rootPath === req.path && !w.sshConfig);
    if (existing) {
      workspaceManager.switchWorkspace(existing.id);
      wsId = existing.id;
      terminalId = await workspaceManager.spawnTerminalInWorkspace(existing.id);
    } else {
      const ws = await workspaceManager.createWorkspaceFromDirectory(req.path);
      if (!ws) throw new Error(`could not open ${req.path} as a workspace`);
      wsId = ws.id;
      terminalId = ws.activeTerminalId;
    }
  } else {
    wsId = (req.callerTerminalId != null ? workspaceIdOfTerminal(req.callerTerminalId) : null)
      ?? workspaceManager.activeWorkspaceId;
    if (!wsId || !workspaceManager.workspaces[wsId]) {
      throw new Error("no workspace is open in Splice; use target new_workspace with a folder path");
    }
    if (workspaceManager.workspaces[wsId]!.sshConfig) {
      // The handoff file lives on this machine; a remote shell could not read it.
      throw new Error("starting an agent in an SSH workspace is not supported; use target new_workspace with a local folder");
    }
    terminalId = await workspaceManager.spawnTerminalInWorkspace(wsId);
  }

  const ws = wsId ? workspaceManager.workspaces[wsId] : undefined;
  if (terminalId == null || !ws) {
    throw new Error("Splice could not create a terminal (the pane split limit may have been reached)");
  }
  const paneId = `term-${terminalId}`;
  workspaceManager.renamePane(paneId, paneTitle(req.agent), ws.id);

  const id = terminalId;
  void (async () => {
    try {
      await waitForShellReady(id, { minWait: 300, stableMs: 500, hardTimeout: 6_000 }, { subscribeToFrames: deps.subscribeToFrames });
      await deps.writeToTerminal(id, new TextEncoder().encode(req.command + "\r"));
    } catch (e) {
      log.warn("spawn-agent: could not start the agent command:", e);
    }
  })();

  return { terminal_id: terminalId, pane_id: paneId, workspace_id: ws.id, workspace: ws.name };
}
