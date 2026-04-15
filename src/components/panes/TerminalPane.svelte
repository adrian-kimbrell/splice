<script lang="ts">
  import TerminalTitlebar from "../terminal/TerminalTitlebar.svelte";
  import CanvasTerminal from "../terminal/CanvasTerminal.svelte";
  import TerminalSearch from "../terminal/TerminalSearch.svelte";
  import type { SplitDirection } from "../../lib/stores/layout.svelte";
  import { attentionStore } from "../../lib/stores/attention.svelte";
  import { registerPaneContent, unregisterPaneContent } from "../../lib/stores/drag.svelte";
  import type { TerminalSearchMatch } from "../../lib/ipc/commands";

  let {
    title,
    cwd = "",
    gitBranch = "",
    terminalId = 0,
    paneId = "",
    active = false,
    onSplit,
    onClose,
    onAction,
  }: {
    title: string;
    cwd?: string;
    gitBranch?: string;
    terminalId?: number;
    paneId?: string;
    active?: boolean;
    onSplit?: (direction: SplitDirection, side: "before" | "after") => void;
    onClose?: () => void;
    onAction?: (action: string) => void;
  } = $props();

  const notification = $derived(attentionStore.notifications[terminalId] ?? null);
  let searchVisible = $state(false);
  let searchMatchesList = $state<TerminalSearchMatch[]>([]);
  let searchActiveIdx = $state(-1);
  let contentAreaEl = $state<HTMLDivElement>();

  $effect(() => {
    if (!contentAreaEl || !paneId) return;
    registerPaneContent(paneId, contentAreaEl);
    return () => unregisterPaneContent(paneId);
  });

  function handleKeyDown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "f") {
      e.preventDefault();
      searchVisible = !searchVisible;
    }
  }

  function handleSearchNavigate(match: TerminalSearchMatch) {
    // Negative row = scrollback; offset to show it = -match.row.
    // Visible row (>= 0) = snap to live view (offset 0).
    const targetOffset = match.row < 0 ? -match.row : 0;
    import("../../lib/ipc/commands").then(({ setTerminalScrollOffset }) => {
      setTerminalScrollOffset(terminalId, targetOffset).catch(console.error);
    });
  }

  function handleMatchesChange(matches: TerminalSearchMatch[], activeIndex: number) {
    searchMatchesList = matches;
    searchActiveIdx = activeIndex;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="flex flex-col overflow-hidden bg-editor flex-1 min-w-0 min-h-0"
  class:flash-permission={notification?.type === 'permission'}
  class:flash-idle={notification?.type === 'idle'}
  onkeydown={handleKeyDown}
>
  <TerminalTitlebar {title} {cwd} {gitBranch} {paneId} {onSplit} {onClose} {onAction} {notification} />
  <div bind:this={contentAreaEl} class="flex-1 flex flex-col overflow-hidden min-h-0">
    <TerminalSearch
      {terminalId}
      visible={searchVisible}
      onClose={() => { searchVisible = false; searchMatchesList = []; searchActiveIdx = -1; }}
      onNavigate={handleSearchNavigate}
      onMatchesChange={handleMatchesChange}
    />
    <CanvasTerminal
      {terminalId}
      active={active}
      searchMatches={searchMatchesList}
      searchActiveIndex={searchActiveIdx}
    />
  </div>
</div>

<style>
  .flash-permission {
    animation: pulse-permission 1.2s ease-in-out infinite;
  }
  .flash-idle {
    animation: pulse-idle 1.8s ease-in-out infinite;
  }
  @keyframes pulse-permission {
    0%, 100% { background-color: var(--bg-editor); }
    50% { background-color: rgba(224, 108, 117, 0.06); }
  }
  @keyframes pulse-idle {
    0%, 100% { background-color: var(--bg-editor); }
    50% { background-color: rgba(229, 192, 123, 0.05); }
  }
</style>
