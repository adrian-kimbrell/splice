<script lang="ts">
  /**
   * Bottom-right stack of native Claude permission cards.
   *
   * Each card is a blocked PreToolUse request (the Claude process is waiting on
   * Splice's HTTP response). Clicking Allow/Deny resolves it via
   * `resolveClaudePermission`, which unblocks the backend handler so it returns
   * Claude's decision JSON. Cards auto-expire ~26s after arrival (App.svelte),
   * matching the backend's 25s wait, after which Claude falls back to its own flow.
   */
  import { claudeStore } from "../../lib/stores/claude.svelte";
  import { resolveClaudePermission } from "../../lib/ipc/commands";
  import type { ClaudePermissionRequest } from "../../lib/stores/claude.svelte";

  const prompts = $derived(claudeStore.permissionList);

  // Friendly one-liner describing what Claude wants to do.
  function summary(req: ClaudePermissionRequest): string {
    if (req.command) return req.command;
    if (req.filePath) {
      const name = req.filePath.split("/").pop() ?? req.filePath;
      return name;
    }
    return req.toolName || "a tool call";
  }

  async function decide(req: ClaudePermissionRequest, decision: "allow" | "deny") {
    // Remove first so the UI feels instant; the backend resolve is fire-and-forget.
    claudeStore.removePermission(req.id);
    try {
      await resolveClaudePermission(req.id, decision);
    } catch (e) {
      // Already timed out / resolved — nothing to do.
      console.warn("resolveClaudePermission:", e);
    }
  }
</script>

{#if prompts.length > 0}
  <div class="perm-stack">
    {#each prompts as req (req.id)}
      <div class="perm-card font-mono">
        <div class="perm-head">
          <i class="bi bi-claude"></i>
          <span class="perm-title">Claude wants to run</span>
          <span class="perm-tool">{req.toolName}</span>
        </div>
        <pre class="perm-body">{summary(req)}</pre>
        <div class="perm-actions">
          <button class="perm-btn deny" onclick={() => decide(req, "deny")}>Deny</button>
          <button class="perm-btn allow" onclick={() => decide(req, "allow")}>Allow</button>
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .perm-stack {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 380px;
  }
  .perm-card {
    background: var(--bg-palette);
    border: 1px solid var(--accent);
    border-radius: 4px;
    box-shadow: 0 6px 24px var(--backdrop-sm, rgba(0, 0, 0, 0.4));
    overflow: hidden;
    animation: perm-in 120ms ease-out;
  }
  @keyframes perm-in {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .perm-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    font-size: 11px;
    color: var(--txt-bright);
    border-bottom: 1px solid var(--border);
  }
  .perm-head .bi-claude {
    color: var(--accent);
  }
  .perm-tool {
    margin-left: auto;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--accent);
  }
  .perm-body {
    margin: 0;
    padding: 10px 12px;
    font-size: 11px;
    line-height: 1.5;
    color: var(--txt);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 120px;
    overflow: auto;
  }
  .perm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 8px 12px;
    border-top: 1px solid var(--border);
  }
  .perm-btn {
    padding: 4px 14px;
    font-size: 11px;
    font-weight: 500;
    border-radius: 3px;
    cursor: pointer;
    transition: opacity 100ms;
  }
  .perm-btn:hover {
    opacity: 0.85;
  }
  .perm-btn.deny {
    background: var(--bg-input);
    color: var(--txt);
    border: 1px solid var(--border);
  }
  .perm-btn.allow {
    background: var(--accent);
    color: var(--bg-editor);
    border: 1px solid var(--accent);
  }
</style>
