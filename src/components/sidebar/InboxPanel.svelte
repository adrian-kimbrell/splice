<script lang="ts">
  /**
   * Inbox: items sent to the user through the MCP `inbox_add` tool, by a local
   * agent or by an outside source using the remote token. Nothing here runs on
   * its own; each item waits for the user to read it, hand it to an agent, or
   * delete it.
   */
  import { inbox, deleteInboxItem, clearInbox, startAgentOnInboxItem } from "../../lib/stores/inbox.svelte";
  import { writeToClipboard } from "../../lib/ipc/commands";
  import { pushToast } from "../../lib/stores/toasts.svelte";

  let expandedId = $state<string | null>(null);

  const items = $derived([...inbox.items].reverse());

  function age(createdAt: number): string {
    const mins = Math.max(0, Math.floor((Date.now() / 1000 - createdAt) / 60));
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  async function copy(body: string) {
    try {
      await writeToClipboard(body);
      pushToast("Copied", "info", 1500);
    } catch {
      pushToast("Could not copy", "error");
    }
  }
</script>

<div class="flex flex-col h-full text-xs" data-testid="inbox-panel">
  <div class="flex items-center px-2 py-1.5 text-txt-dim">
    <span class="font-medium uppercase tracking-wide text-[10px]">Inbox</span>
    {#if items.length > 0}
      <button class="ml-auto hover:text-txt" title="Delete every item" onclick={() => clearInbox()}>Clear all</button>
    {/if}
  </div>

  {#if items.length === 0}
    <div class="px-3 py-6 text-txt-dim text-center leading-relaxed">
      Nothing here yet.<br />
      Agents and outside sources can send items with the <code>inbox_add</code> tool.
    </div>
  {:else}
    <div class="flex-1 overflow-y-auto">
      {#each items as item (item.id)}
        {@const open = expandedId === item.id}
        <div class="inbox-item" class:open data-inbox-id={item.id}>
          <button class="inbox-head" onclick={() => { expandedId = open ? null : item.id; }}>
            <i class="bi {open ? 'bi-chevron-down' : 'bi-chevron-right'} text-[9px] shrink-0 mt-0.5"></i>
            <span class="flex-1 min-w-0">
              <span class="block truncate text-txt-bright">{item.title}</span>
              <span class="block truncate text-txt-dim text-[10px]">
                {item.source}{#if item.remote}<span class="remote-tag" title="Arrived with the remote-access token">remote</span>{/if}
                · {age(item.created_at)}
              </span>
            </span>
          </button>
          {#if open}
            <pre class="inbox-body">{item.body || "(no content)"}</pre>
            <div class="inbox-actions">
              <button class="inbox-btn primary" title="Open a new terminal in this workspace and start Claude with this item as its brief" onclick={() => startAgentOnInboxItem(item.id, "claude")}>
                <i class="bi bi-play-fill"></i> Start Claude
              </button>
              <button class="inbox-btn" title="Start Codex with this item" onclick={() => startAgentOnInboxItem(item.id, "codex")}>Codex</button>
              <button class="inbox-btn" title="Copy the content" onclick={() => copy(item.body)}><i class="bi bi-clipboard"></i></button>
              <button class="inbox-btn danger" title="Delete" onclick={() => deleteInboxItem(item.id)}><i class="bi bi-trash"></i></button>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .inbox-item {
    border-bottom: 1px solid var(--border);
  }
  .inbox-head {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    width: 100%;
    padding: 6px 8px;
    text-align: left;
    color: var(--text-dim);
    cursor: pointer;
  }
  .inbox-head:hover {
    background: var(--bg-hover);
  }
  .remote-tag {
    margin-left: 5px;
    padding: 0 4px;
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 9px;
    color: var(--ansi-yellow);
  }
  .inbox-body {
    margin: 0 8px 6px 20px;
    padding: 6px 8px;
    max-height: 260px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--ui-font);
    font-size: 11px;
    line-height: 1.45;
    color: var(--text);
    background: var(--bg-input);
    border-radius: 4px;
    user-select: text;
  }
  .inbox-actions {
    display: flex;
    gap: 4px;
    margin: 0 8px 8px 20px;
  }
  .inbox-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-dim);
    cursor: pointer;
  }
  .inbox-btn:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  .inbox-btn.primary {
    color: var(--accent);
    border-color: var(--accent);
  }
  .inbox-btn.danger:hover {
    color: var(--ansi-red);
  }
</style>
