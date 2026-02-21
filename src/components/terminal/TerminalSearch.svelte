<script lang="ts">
  import type { TerminalSearchMatch } from "../../lib/ipc/commands";

  let {
    terminalId,
    visible = false,
    onClose,
    onNavigate,
  }: {
    terminalId: number;
    visible?: boolean;
    onClose?: () => void;
    onNavigate?: (match: TerminalSearchMatch) => void;
  } = $props();

  let query = $state("");
  let caseSensitive = $state(false);
  let matches = $state<TerminalSearchMatch[]>([]);
  let currentIndex = $state(0);
  let inputEl = $state<HTMLInputElement>();

  async function doSearch() {
    if (!query) {
      matches = [];
      currentIndex = 0;
      return;
    }
    try {
      const { searchTerminal } = await import("../../lib/ipc/commands");
      matches = await searchTerminal(terminalId, query, caseSensitive);
      currentIndex = matches.length > 0 ? matches.length - 1 : 0; // Start at last (most recent)
      if (matches.length > 0) onNavigate?.(matches[currentIndex]);
    } catch {
      matches = [];
    }
  }

  function prev() {
    if (matches.length === 0) return;
    currentIndex = (currentIndex - 1 + matches.length) % matches.length;
    onNavigate?.(matches[currentIndex]);
  }

  function next() {
    if (matches.length === 0) return;
    currentIndex = (currentIndex + 1) % matches.length;
    onNavigate?.(matches[currentIndex]);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      onClose?.();
    } else if (e.key === "Enter") {
      if (e.shiftKey) prev();
      else next();
    }
  }

  $effect(() => {
    if (visible && inputEl) {
      inputEl.focus();
      inputEl.select();
    }
  });

  $effect(() => {
    query;
    caseSensitive;
    doSearch();
  });
</script>

{#if visible}
  <div class="flex items-center gap-2 px-3 py-1.5 bg-palette border-b border-border text-xs shrink-0">
    <input
      bind:this={inputEl}
      bind:value={query}
      class="bg-input text-txt text-xs px-2 py-1 border border-border rounded outline-none focus:border-accent flex-1 min-w-0"
      placeholder="Search terminal…"
      spellcheck="false"
      onkeydown={handleKeyDown}
    />
    <button
      class="px-1.5 py-0.5 rounded text-txt-dim hover:text-txt hover:bg-hover text-[10px]"
      class:text-accent={caseSensitive}
      title="Case Sensitive"
      onclick={() => { caseSensitive = !caseSensitive; }}
    >Aa</button>
    <span class="text-txt-dim whitespace-nowrap">
      {matches.length > 0 ? `${currentIndex + 1}/${matches.length}` : "No results"}
    </span>
    <button class="text-txt-dim hover:text-txt" title="Previous" onclick={prev}>
      <i class="bi bi-chevron-up" style="font-size: 12px;"></i>
    </button>
    <button class="text-txt-dim hover:text-txt" title="Next" onclick={next}>
      <i class="bi bi-chevron-down" style="font-size: 12px;"></i>
    </button>
    <button class="text-txt-dim hover:text-txt" title="Close" onclick={onClose}>
      <i class="bi bi-x" style="font-size: 14px;"></i>
    </button>
  </div>
{/if}
