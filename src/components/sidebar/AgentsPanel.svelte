<script lang="ts">
  /**
   * Agents: every Claude and Codex session across all workspaces in this window,
   * most urgent first. Click a row to go to that terminal.
   */
  import { workspaceManager } from "../../lib/stores/workspace.svelte";
  import { attentionStore } from "../../lib/stores/attention.svelte";
  import { claudeStore } from "../../lib/stores/claude.svelte";
  import { agentActivity, watchAgentActivity } from "../../lib/stores/agents.svelte";
  import { buildAgentGroups, shortAge, STATE_LABEL, type AgentRow } from "../../lib/agents/agent-list";
  import { focusPaneContent } from "../../lib/utils/pane-focus";

  $effect(() => watchAgentActivity());

  const groups = $derived(
    buildAgentGroups(workspaceManager.workspaceList, attentionStore.notifications, claudeStore.status, agentActivity.byTerminal),
  );

  function open(row: AgentRow) {
    workspaceManager.switchWorkspace(row.workspaceId);
    workspaceManager.setActivePaneId(row.paneId, row.workspaceId);
    attentionStore.clear(row.terminalId);
    requestAnimationFrame(() => focusPaneContent(row.paneId));
  }

  function detail(row: AgentRow): string {
    const parts = [row.kind === "codex" ? "Codex" : "Claude"];
    if (row.model) parts.push(row.model);
    if (row.contextPct != null) parts.push(`${Math.round(row.contextPct)}% context`);
    return parts.join(" · ");
  }
</script>

<div class="flex flex-col h-full text-xs" data-testid="agents-panel">
  <div class="flex items-center px-2 py-1.5 text-txt-dim">
    <span class="font-medium uppercase tracking-wide text-[10px]">Agents</span>
  </div>

  {#if groups.length === 0}
    <div class="px-3 py-6 text-txt-dim text-center leading-relaxed">
      No agents yet.<br />
      Start <code>claude</code> or <code>codex</code> in a terminal and it appears here.
    </div>
  {:else}
    <div class="flex-1 overflow-y-auto">
      {#each groups as group (group.workspaceId)}
        <div class="agent-group" class:current={group.workspaceId === workspaceManager.activeWorkspaceId}>{group.workspaceName}</div>
        {#each group.rows as row (row.terminalId)}
          <button class="agent-row" data-state={row.state} data-terminal-id={row.terminalId} title={row.message ?? STATE_LABEL[row.state]} onclick={() => open(row)}>
            <span class="agent-dot" class:pulse={row.state === "working"}></span>
            <span class="flex-1 min-w-0">
              <span class="block truncate agent-title">{row.title}</span>
              <span class="block truncate text-txt-dim text-[10px]">{detail(row)}</span>
            </span>
            <span class="agent-state shrink-0">
              {STATE_LABEL[row.state]}{#if row.since != null}<span class="text-txt-dim agent-age">· {shortAge(row.since, agentActivity.now)}</span>{/if}
            </span>
          </button>
        {/each}
      {/each}
    </div>
  {/if}
</div>

<style>
  .agent-group {
    padding: 8px 8px 3px;
    font-size: 10px;
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .agent-group.current {
    color: var(--accent);
  }
  .agent-row {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    padding: 5px 8px;
    text-align: left;
    cursor: pointer;
    --state-color: var(--text-dim);
  }
  .agent-row:hover {
    background: var(--bg-hover);
  }
  .agent-row[data-state="permission"] { --state-color: var(--ansi-red); }
  .agent-row[data-state="done"] { --state-color: var(--ansi-yellow); }
  .agent-row[data-state="working"] { --state-color: var(--git-added); }
  .agent-row[data-state="exited"] { opacity: 0.55; }
  .agent-title {
    color: var(--text-bright);
  }
  .agent-state {
    font-size: 10px;
    color: var(--state-color);
  }
  .agent-age {
    margin-left: 4px;
  }
  .agent-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--state-color);
  }
  .agent-row[data-state="idle"] .agent-dot,
  .agent-row[data-state="exited"] .agent-dot {
    background: transparent;
    border: 1px solid var(--text-dim);
  }
  .agent-dot.pulse {
    animation: agent-pulse 1.4s ease-in-out infinite;
  }
  @keyframes agent-pulse {
    50% { opacity: 0.35; }
  }
  @media (prefers-reduced-motion: reduce) {
    .agent-dot.pulse { animation: none; }
  }
</style>
