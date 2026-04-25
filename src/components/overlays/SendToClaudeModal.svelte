<script lang="ts">
  import { ui } from "../../lib/stores/ui.svelte";
  import { workspaceManager } from "../../lib/stores/workspace.svelte";

  interface ClaudeTerminal {
    terminalId: number;
    title: string;
  }

  const claudeTerminals = $derived.by<ClaudeTerminal[]>(() => {
    const ws = workspaceManager.activeWorkspace;
    if (!ws) return [];
    return Object.values(ws.panes)
      .filter(p => p.kind === "terminal" && p.claudeSessionId != null && p.terminalId != null)
      .map(p => ({ terminalId: p.terminalId!, title: p.title || `Terminal ${p.terminalId}` }));
  });

  let selectedTerminalId = $state<number | null>(null);
  let prompt = $state("");
  let inputEl = $state<HTMLTextAreaElement>();

  // Auto-select if only one Claude terminal
  $effect(() => {
    const terminals = claudeTerminals;
    if (terminals.length === 1) selectedTerminalId = terminals[0].terminalId;
    else if (terminals.length === 0) selectedTerminalId = null;
  });

  // Focus input when modal opens
  $effect(() => {
    if (ui.sendToClaudeModal && inputEl) {
      setTimeout(() => inputEl?.focus(), 0);
    }
  });

  function close() {
    ui.sendToClaudeModal = null;
    prompt = "";
    selectedTerminalId = null;
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    if ((e.key === "Enter" && e.metaKey) || (e.key === "Enter" && !e.shiftKey && e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  }

  async function send() {
    const modal = ui.sendToClaudeModal;
    if (!modal || !selectedTerminalId || !prompt.trim()) return;

    const { filePath, lineStart, lineEnd, selectedText } = modal;
    const fileName = filePath ? (filePath.split("/").pop() ?? filePath) : "";
    const ext = fileName.includes(".") ? fileName.split(".").pop() ?? "" : "";
    const lineRef = lineStart === lineEnd ? `${lineStart}` : `${lineStart}-${lineEnd}`;

    const codeBlock = selectedText
      ? `In \`${fileName}:${lineRef}\`:\n\`\`\`${ext}\n${selectedText}\n\`\`\``
      : "";

    const message = codeBlock
      ? `${codeBlock}\n\n${prompt.trim()}`
      : prompt.trim();

    const { writeToTerminal } = await import("../../lib/ipc/commands");
    await writeToTerminal(selectedTerminalId, new TextEncoder().encode(message + "\r"));

    close();
  }
</script>

{#if ui.sendToClaudeModal}
  <!-- Backdrop -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center"
    style="background: var(--backdrop-sm)"
    role="dialog"
    aria-modal="true"
    aria-label="Send to Claude"
    tabindex="-1"
    onclick={(e) => { if (e.target === e.currentTarget) close(); }}
    onkeydown={handleKeyDown}
  >
    <div
      class="flex flex-col font-mono text-xs"
      style="background: var(--bg-palette); border: 1px solid var(--border); width: 520px; max-width: 90vw; max-height: 80vh;"
    >
      <!-- Header -->
      <div class="flex items-center justify-between px-4 py-3" style="border-bottom: 1px solid var(--border)">
        <span class="text-txt-bright font-medium tracking-wide uppercase text-[10px]">Send to Claude</span>
        <button
          class="text-txt-dim hover:text-txt-bright transition-colors"
          onclick={close}
          aria-label="Close"
        >
          <i class="bi bi-x text-base"></i>
        </button>
      </div>

      <!-- Code preview -->
      {#if ui.sendToClaudeModal.selectedText}
        {@const modal = ui.sendToClaudeModal}
        {@const fileName = modal.filePath ? (modal.filePath.split("/").pop() ?? modal.filePath) : ""}
        {@const lineRef = modal.lineStart === modal.lineEnd ? `${modal.lineStart}` : `${modal.lineStart}–${modal.lineEnd}`}
        <div style="border-bottom: 1px solid var(--border)">
          <div class="px-4 pt-2 pb-1 text-[10px] text-txt-dim">{fileName}:{lineRef}</div>
          <pre
            class="px-4 pb-3 text-[11px] text-txt overflow-auto"
            style="max-height: 160px; line-height: 1.5; white-space: pre; tab-size: 2;"
          >{modal.selectedText}</pre>
        </div>
      {/if}

      <!-- Terminal picker (only if multiple Claude sessions) -->
      {#if claudeTerminals.length > 1}
        <div class="px-4 py-3" style="border-bottom: 1px solid var(--border)">
          <div class="text-[10px] text-txt-dim uppercase tracking-wide mb-2">Claude session</div>
          <div class="flex flex-col gap-1">
            {#each claudeTerminals as t (t.terminalId)}
              <button
                class="text-left px-3 py-2 text-xs transition-colors"
                style={selectedTerminalId === t.terminalId
                  ? "background: var(--bg-selected); color: var(--text-bright); border: 1px solid var(--accent);"
                  : "background: var(--bg-input); color: var(--text); border: 1px solid transparent;"}
                onclick={() => (selectedTerminalId = t.terminalId)}
              >
                <i class="bi bi-terminal mr-2 text-txt-dim"></i>{t.title}
              </button>
            {/each}
          </div>
        </div>
      {:else if claudeTerminals.length === 0}
        <div class="px-4 py-3 text-txt-dim text-[11px]" style="border-bottom: 1px solid var(--border)">
          <i class="bi bi-exclamation-circle mr-1"></i>No Claude sessions running in this workspace.
        </div>
      {/if}

      <!-- Prompt input -->
      <div class="px-4 py-3">
        <textarea
          bind:this={inputEl}
          bind:value={prompt}
          class="w-full resize-none outline-none text-xs text-txt bg-transparent placeholder-txt-dim"
          style="min-height: 64px; max-height: 160px; line-height: 1.6;"
          placeholder="What should Claude do with this?"
          onkeydown={handleKeyDown}
          rows={3}
        ></textarea>
      </div>

      <!-- Footer -->
      <div class="flex items-center justify-between px-4 py-3" style="border-top: 1px solid var(--border)">
        <span class="text-txt-dim text-[10px]">⌘↵ to send · Esc to cancel</span>
        <button
          class="px-4 py-1.5 text-[11px] font-medium transition-colors"
          style={selectedTerminalId && prompt.trim() && claudeTerminals.length > 0
            ? "background: var(--accent); color: var(--bg-editor); cursor: pointer;"
            : "background: var(--bg-input); color: var(--text-dim); cursor: default;"}
          disabled={!selectedTerminalId || !prompt.trim() || claudeTerminals.length === 0}
          onclick={send}
        >
          Send
        </button>
      </div>
    </div>
  </div>
{/if}
