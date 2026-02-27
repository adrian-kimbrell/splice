<script lang="ts">
  import { workspaceManager } from "../../lib/stores/workspace.svelte";
  import { dispatchEditorAction } from "../../lib/stores/editor-actions.svelte";
  import type { SearchMatch } from "../../lib/ipc/commands";
  import { onMount } from "svelte";

  let query = $state("");
  let caseSensitive = $state(false);
  let searching = $state(false);
  let results = $state<SearchMatch[]>([]);
  let truncated = $state(false);
  let totalFiles = $state(0);
  let searchError = $state("");
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Replace state
  let replaceMode = $state(false);
  let replaceQuery = $state("");
  let replacing = $state(false);
  let replaceCount = $state(0);
  let replaceMessage = $state("");

  // Group results by file path
  const grouped = $derived.by(() => {
    const map = new Map<string, SearchMatch[]>();
    for (const m of results) {
      const existing = map.get(m.path);
      if (existing) existing.push(m);
      else map.set(m.path, [m]);
    }
    return map;
  });

  function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function scheduleSearch() {
    if (debounceTimer) clearTimeout(debounceTimer);
    searchError = "";
    replaceMessage = "";
    if (!query.trim()) {
      results = [];
      truncated = false;
      totalFiles = 0;
      return;
    }
    debounceTimer = setTimeout(() => doSearch(), 300);
  }

  async function doSearch() {
    const ws = workspaceManager.activeWorkspace;
    if (!ws?.rootPath || !query.trim()) return;

    searching = true;
    searchError = "";
    try {
      const { searchFiles } = await import("../../lib/ipc/commands");
      const result = await searchFiles(ws.rootPath, query, caseSensitive);
      results = result.matches;
      truncated = result.truncated;
      totalFiles = result.total_files_searched;
    } catch (e) {
      searchError = String(e);
      results = [];
    } finally {
      searching = false;
    }
  }

  async function replaceAll() {
    if (!query.trim()) return;
    replacing = true;
    replaceMessage = "";
    let totalReplaced = 0;
    let filesModified = 0;
    try {
      const { readFile, writeFile } = await import("../../lib/ipc/commands");
      // Group by file
      const byFile = new Map<string, SearchMatch[]>();
      for (const m of results) {
        const existing = byFile.get(m.path);
        if (existing) existing.push(m);
        else byFile.set(m.path, [m]);
      }
      const flags = caseSensitive ? "g" : "gi";
      const re = new RegExp(escapeRegex(query), flags);
      for (const [path] of byFile) {
        const content = await readFile(path);
        const newContent = content.replace(re, replaceQuery);
        if (newContent !== content) {
          await writeFile(path, newContent);
          // Count occurrences replaced in this file
          const matches = content.match(re);
          totalReplaced += matches ? matches.length : 0;
          filesModified++;
        }
      }
      replaceCount = totalReplaced;
      replaceMessage = totalReplaced > 0
        ? `Replaced ${totalReplaced} occurrence${totalReplaced !== 1 ? "s" : ""} in ${filesModified} file${filesModified !== 1 ? "s" : ""}`
        : "No replacements made";
      // Re-run search to show updated results
      await doSearch();
    } catch (e) {
      searchError = String(e);
    } finally {
      replacing = false;
    }
  }

  async function handleResultClick(match: SearchMatch) {
    try {
      const { readFile } = await import("../../lib/ipc/commands");
      const content = await readFile(match.path);
      const name = match.path.split("/").pop() ?? "untitled";
      workspaceManager.openFileInWorkspace({ name, path: match.path, content });
      // Jump to the matching line
      dispatchEditorAction("goto-line-number", match.line_number);
    } catch (e) {
      console.error("Failed to open search result:", e);
    }
  }

  function shortPath(fullPath: string): string {
    const ws = workspaceManager.activeWorkspace;
    if (ws?.rootPath && fullPath.startsWith(ws.rootPath)) {
      return fullPath.slice(ws.rootPath.length + 1);
    }
    return fullPath;
  }

  $effect(() => {
    // Re-trigger search when query or caseSensitive changes
    query;
    caseSensitive;
    scheduleSearch();
  });

  // Listen for the splice:open-replace event from keybindings
  onMount(() => {
    const handler = () => { replaceMode = true; };
    document.addEventListener("splice:open-replace", handler);
    return () => document.removeEventListener("splice:open-replace", handler);
  });
</script>

<div class="flex flex-col h-full overflow-hidden">
  <!-- Search input -->
  <div class="px-2 pt-2 pb-1 flex flex-col gap-1.5">
    <div class="flex items-center gap-1">
      <button
        class="px-1 py-1 text-xs text-txt-dim hover:text-txt-bright shrink-0 transition-transform duration-100"
        class:rotate-90={replaceMode}
        title="Toggle Replace"
        onclick={() => { replaceMode = !replaceMode; replaceMessage = ""; }}
      >
        <i class="bi bi-chevron-right text-[10px]"></i>
      </button>
      <input
        type="text"
        bind:value={query}
        class="flex-1 bg-input border border-border text-txt-bright text-xs px-2 py-1.5 outline-none focus:border-accent"
        style="font-family: var(--ui-font)"
        placeholder="Search…"
        spellcheck="false"
      />
      <button
        class="px-1.5 py-1 text-[10px] border border-border cursor-pointer shrink-0"
        class:bg-selected={caseSensitive}
        class:text-txt-bright={caseSensitive}
        class:bg-transparent={!caseSensitive}
        class:text-txt-dim={!caseSensitive}
        title="Match Case"
        onclick={() => { caseSensitive = !caseSensitive; }}
      >Aa</button>
    </div>

    {#if replaceMode}
      <div class="flex items-center gap-1">
        <span class="w-5 shrink-0"></span>
        <input
          type="text"
          bind:value={replaceQuery}
          class="flex-1 bg-input border border-border text-txt-bright text-xs px-2 py-1.5 outline-none focus:border-accent"
          style="font-family: var(--ui-font)"
          placeholder="Replace…"
          spellcheck="false"
        />
        <button
          class="px-2 py-1 text-[10px] border border-border cursor-pointer shrink-0 hover:bg-selected text-txt-dim hover:text-txt-bright disabled:opacity-40"
          disabled={replacing || !query.trim() || results.length === 0}
          onclick={replaceAll}
          title="Replace All"
        >
          {#if replacing}
            <i class="bi bi-arrow-repeat animate-spin"></i>
          {:else}
            All
          {/if}
        </button>
      </div>
    {/if}

    {#if searching}
      <div class="text-[10px] text-txt-dim flex items-center gap-1">
        <i class="bi bi-arrow-repeat animate-spin"></i>
        Searching…
      </div>
    {/if}
    {#if searchError}
      <div class="text-[10px] text-red-400">{searchError}</div>
    {/if}
    {#if replaceMessage}
      <div class="text-[10px] text-txt-dim">{replaceMessage}</div>
    {/if}
  </div>

  <!-- Results -->
  <div class="flex-1 overflow-y-auto text-xs">
    {#if results.length === 0 && !searching && query.trim()}
      <div class="px-3 py-4 text-txt-dim text-center">No results found</div>
    {/if}

    {#each [...grouped] as [filePath, fileMatches] (filePath)}
      <div class="mb-1">
        <div class="px-2 py-1 text-txt-dim text-[10px] font-medium truncate" title={filePath}>
          {shortPath(filePath)}
          <span class="text-txt-dim/60 ml-1">({fileMatches.length})</span>
        </div>
        {#each fileMatches as match (match.line_number + ":" + match.col_start)}
          <button
            class="w-full text-left px-3 py-0.5 hover:bg-selected cursor-pointer flex items-baseline gap-2 min-w-0"
            onclick={() => handleResultClick(match)}
          >
            <span class="text-txt-dim flex-shrink-0 text-[10px] w-6 text-right">{match.line_number}</span>
            <span class="text-txt truncate">{match.line_content.trim()}</span>
          </button>
        {/each}
      </div>
    {/each}

    {#if truncated}
      <div class="px-3 py-2 text-[10px] text-txt-dim text-center border-t border-border">
        Results capped at {results.length}. Refine your search.
      </div>
    {/if}

    {#if results.length > 0 && !truncated}
      <div class="px-3 py-2 text-[10px] text-txt-dim text-center">
        {results.length} result{results.length !== 1 ? "s" : ""} in {totalFiles} file{totalFiles !== 1 ? "s" : ""}
      </div>
    {/if}
  </div>
</div>
