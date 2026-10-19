/**
 * Wiring between Claude Code and the UI: session ids reported by terminals,
 * attention notifications from the hook server, and the live status HUD.
 * Started by App.svelte before workspaces restore, so no session event from
 * a restored terminal's Claude process is missed.
 */
import { listen } from "@tauri-apps/api/event";
import { workspaceManager } from "../stores/workspace.svelte";
import { cancelPendingResume } from "../stores/workspace-session";
import { onAttentionNotify, onClaudeStatus } from "../ipc/events";
import { attentionStore } from "../stores/attention.svelte";
import { claudeStore, statusFromPayload } from "../stores/claude.svelte";
import { installClaudeHook } from "../ipc/commands";
import { log } from "../utils/log";

/**
 * A terminal is "ours" only when it has an active Claude session in THIS
 * instance: several Splice windows can share the same hook port, so events
 * for other instances' terminals arrive here too.
 */
function hasActiveClaudeSession(terminalId: number): boolean {
  return Object.values(workspaceManager.workspaces).some(
    (w) => w.terminalIds.includes(terminalId) && !!w.panes[`term-${terminalId}`]?.claudeSessionId,
  );
}

export async function startClaudeWiring(): Promise<() => void> {
  const unlistenSession = await listen<{ terminal_id: number; session_id: string; claude_pid: number }>(
    "terminal:claude-session",
    ({ payload }) => {
      const ws = Object.values(workspaceManager.workspaces).find((w) => w.terminalIds.includes(payload.terminal_id));
      const paneId = `term-${payload.terminal_id}`;
      if (ws?.panes[paneId]) {
        cancelPendingResume(payload.terminal_id);
        ws.panes[paneId].claudeSessionId = payload.session_id;
        ws.panes[paneId].claudePid = payload.claude_pid;
        workspaceManager.debouncedPersistWorkspace(ws.id);
      }
    },
  );

  installClaudeHook().catch(log.warn);

  const unlistenAttention = await onAttentionNotify((payload) => {
    if (!hasActiveClaudeSession(payload.terminal_id)) return;
    attentionStore.notify({
      terminalId: payload.terminal_id,
      type: payload.notification_type === "permission_prompt" ? "permission" : "idle",
      message: payload.message,
      timestamp: Date.now(),
    });
  });

  // Live Claude status HUD (context-window % + cost in the terminal header).
  const unlistenStatus = await onClaudeStatus((p) => {
    if (!hasActiveClaudeSession(p.terminal_id)) return;
    const status = statusFromPayload(p);
    if (status) claudeStore.setStatus(status);
  });

  return () => {
    unlistenSession();
    unlistenAttention();
    unlistenStatus();
  };
}
