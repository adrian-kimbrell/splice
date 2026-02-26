<script lang="ts">
  import type { TerminalSearchMatch } from "../../lib/ipc/commands";

  let {
    terminalId,
    visible = false,
    onClose,
    onNavigate,
    onMatchesChange,
  }: {
    terminalId: number;
    visible?: boolean;
    onClose?: () => void;
    onNavigate?: (match: TerminalSearchMatch) => void;
    onMatchesChange?: (matches: TerminalSearchMatch[], activeIndex: number) => void;
  } = $props();

  let query = $state("");
  let caseSensitive = $state(false);
  let matches = $state<TerminalSearchMatch[]>([]);
  let currentIndex = $state(0);
  let inputEl = $state<HTMLInputElement>();
  let searchGen = 0; // incremented on each search; stale results are discarded

  async function doSearch() {
    if (!query) {
      matches = [];
      currentIndex = 0;
      onMatchesChange?.([], -1);
      return;
    }
    matches = [];
    currentIndex = 0;
    const gen = ++searchGen;
    try {
      const { searchTerminal } = await import("../../lib/ipc/commands");
      const result = await searchTerminal(terminalId, query, caseSensitive);
      if (gen !== searchGen) return; // a newer search superseded this one
      matches = result;
      currentIndex = matches.length > 0 ? matches.length - 1 : 0; // Start at last (most recent)
      onMatchesChange?.(matches, matches.length > 0 ? currentIndex : -1);
      if (matches.length > 0) onNavigate?.(matches[currentIndex]);
    } catch {
      if (gen === searchGen) {
        matches = [];
        onMatchesChange?.([], -1);
      }
    }
  }

  function prev() {
    if (matches.length === 0) return;
    currentIndex = (currentIndex - 1 + matches.length) % matches.length;
    onMatchesChange?.(matches, currentIndex);
    onNavigate?.(matches[currentIndex]);
  }

  function next() {
    if (matches.length === 0) return;
    currentIndex = (currentIndex + 1) % matches.length;
    onMatchesChange?.(matches, currentIndex);
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
    terminalId;   // re-search when the active terminal changes
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
      <i class="bi bi-chevron-up" style="font-size: var(--ui-body);"></i>
    </button>
    <button class="text-txt-dim hover:text-txt" title="Next" onclick={next}>
      <i class="bi bi-chevron-down" style="font-size: var(--ui-body);"></i>
    </button>
    <button class="text-txt-dim hover:text-txt" title="Close" onclick={onClose}>
      <i class="bi bi-x" style="font-size: var(--ui-btn);"></i>
    </button>
  </div>
{/if}
