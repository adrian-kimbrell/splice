/**
 * The inbox: items sent to the user by agents and outside sources through the
 * MCP `inbox_add` tool. Rust owns the data (`inbox.json`); this store mirrors it
 * and is refreshed on the `inbox:changed` event.
 */
import { inboxList, inboxDelete, inboxClear, inboxHandoff, type InboxItem } from "../ipc/commands";
import { spawnAgent } from "../agents/spawn-agent";
import type { AgentKind } from "./layout.svelte";
import { pushToast } from "./toasts.svelte";
import { log } from "../utils/log";

export const inbox = $state({ items: [] as InboxItem[] });

export async function refreshInbox(): Promise<void> {
  try {
    inbox.items = await inboxList();
  } catch (e) {
    log.warn("inbox refresh failed:", e);
  }
}

export async function deleteInboxItem(id: string): Promise<void> {
  inbox.items = inbox.items.filter((i) => i.id !== id);
  await inboxDelete(id).catch((e) => log.warn("inbox delete failed:", e));
}

export async function clearInbox(): Promise<void> {
  inbox.items = [];
  await inboxClear().catch((e) => log.warn("inbox clear failed:", e));
}

/** Start an agent in a new terminal of the active workspace with this item as its brief. */
export async function startAgentOnInboxItem(id: string, agent: AgentKind = "claude"): Promise<void> {
  try {
    const command = await inboxHandoff(id, agent);
    await spawnAgent({ target: "new_terminal", agent, command });
  } catch (e) {
    pushToast(`Could not start the agent: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}
