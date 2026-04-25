<script lang="ts">
  import { workspaceManager } from "../../lib/stores/workspace.svelte";
  import type { GitLogEntry } from "../../lib/ipc/commands";

  let entries = $state<GitLogEntry[]>([]);
  let loading = $state(false);
  let error = $state("");
  let noRepo = $state(false);

  const rootPath = $derived(workspaceManager.activeWorkspace?.rootPath ?? "");

  function relativeTime(timestamp: number): string {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    if (diff < 2592000) return `${Math.floor(diff / 604800)}w ago`;
    return `${Math.floor(diff / 2592000)}mo ago`;
  }

  async function loadLog() {
    if (!rootPath) return;
    loading = true;
    error = "";
    noRepo = false;
    try {
      const { gitLog } = await import("../../lib/ipc/commands");
      entries = await gitLog(rootPath, 200);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("not a git repository")) {
        noRepo = true;
        entries = [];
      } else {
        error = msg;
        entries = [];
      }
    } finally {
      loading = false;
    }
  }

  let lastLoadedRoot = "";
  $effect(() => {
    if (rootPath && rootPath !== lastLoadedRoot) {
      lastLoadedRoot = rootPath;
      loadLog();
    }
  });

  // Simple lane assignment for graph visualization
  interface GraphNode {
    entry: GitLogEntry;
    column: number;
    lines: { from: number; to: number; color: string }[];
  }

  const LANE_COLORS = [
    "var(--accent)",
    "var(--ansi-yellow)",
    "var(--ansi-red)",
    "#c678dd",
    "#61afef",
    "#d19a66",
    "#56b6c2",
  ];

  const graphNodes = $derived.by((): GraphNode[] => {
    if (entries.length === 0) return [];

    const nodes: GraphNode[] = [];
    // Track which lanes are occupied by which commit hash
    let activeLanes: (string | null)[] = [];

    for (const entry of entries) {
      // Find which lane this commit is in
      let col = activeLanes.indexOf(entry.hash);
      if (col === -1) {
        // New branch — find first empty lane or add new one
        col = activeLanes.indexOf(null);
        if (col === -1) {
          col = activeLanes.length;
          activeLanes.push(null);
        }
      }

      // Clear this lane
      activeLanes[col] = null;

      // Place parents in lanes
      const lines: { from: number; to: number; color: string }[] = [];
      for (let i = 0; i < entry.parents.length; i++) {
        const parent = entry.parents[i];
        let parentLane = activeLanes.indexOf(parent);
        if (parentLane === -1) {
          if (i === 0) {
            // First parent goes in same column
            parentLane = col;
          } else {
            // Merge parent — find empty lane
            parentLane = activeLanes.indexOf(null);
            if (parentLane === -1) {
              parentLane = activeLanes.length;
              activeLanes.push(null);
            }
          }
        }
        activeLanes[parentLane] = parent;
        lines.push({
          from: col,
          to: parentLane,
          color: LANE_COLORS[parentLane % LANE_COLORS.length],
        });
      }

      // Trim trailing nulls from activeLanes
      while (activeLanes.length > 0 && activeLanes[activeLanes.length - 1] === null) {
        activeLanes.pop();
      }

      nodes.push({ entry, column: col, lines });
    }

    return nodes;
  });

  const maxColumns = $derived(Math.max(1, ...graphNodes.map(n => n.column + 1)));
  const graphWidth = $derived(maxColumns * 16 + 8);
</script>

<div class="flex flex-col h-full overflow-hidden" style="font-size: 13px;">
  {#if loading}
    <div class="px-3 py-6 text-txt-dim text-center">Loading...</div>
  {:else if noRepo}
    <div class="px-3 py-6 text-txt-dim text-center">No git repository</div>
  {:else if error}
    <div class="px-3 py-6 text-txt-dim text-center">{error}</div>
  {:else if graphNodes.length === 0}
    <div class="px-3 py-6 text-txt-dim text-center">No commits found</div>
  {:else}
    <div class="flex-1 overflow-y-auto">
      {#each graphNodes as node, i (node.entry.hash)}
        <div class="flex items-start hover:bg-selected px-1 py-px" style="min-height: 22px;">
          <!-- Graph column -->
          <svg width={graphWidth} height="22" class="shrink-0" style="min-width: {graphWidth}px;">
            <!-- Draw continuing lanes -->
            {#each node.lines as line}
              {#if line.from === line.to}
                <!-- Straight down -->
                <line x1={line.from * 16 + 8} y1="0" x2={line.to * 16 + 8} y2="22" stroke={line.color} stroke-width="1.5" />
              {:else}
                <!-- Merge/branch curve -->
                <path
                  d="M {line.from * 16 + 8} 11 C {line.from * 16 + 8} 18, {line.to * 16 + 8} 15, {line.to * 16 + 8} 22"
                  fill="none" stroke={line.color} stroke-width="1.5"
                />
              {/if}
            {/each}
            <!-- Commit dot -->
            <circle cx={node.column * 16 + 8} cy="11" r="3.5" fill={LANE_COLORS[node.column % LANE_COLORS.length]} />
          </svg>
          <!-- Commit info -->
          <div class="flex-1 min-w-0 flex items-baseline gap-1.5 py-0.5">
            <span class="font-mono text-accent text-\[11px\] shrink-0">{node.entry.short_hash}</span>
            <span class="truncate text-txt flex-1" title={node.entry.message}>{node.entry.message}</span>
            <span class="text-txt-dim text-\[11px\] shrink-0 whitespace-nowrap">{relativeTime(node.entry.timestamp)}</span>
          </div>
        </div>
        <!-- Ref badges -->
        {#if node.entry.refs}
          <div class="flex gap-1 ml-1 mb-0.5" style="padding-left: {graphWidth}px;">
            {#each node.entry.refs.split(", ").filter(Boolean) as ref}
              <span class="px-1 py-px rounded text-[9px] font-medium"
                style="background: {ref.startsWith('tag:') ? 'var(--git-modified-bg)' : 'var(--accent-muted)'}; color: {ref.startsWith('tag:') ? 'var(--ansi-yellow)' : 'var(--accent)'};"
              >
                {ref.replace('HEAD -> ', '').replace('tag: ', '')}
              </span>
            {/each}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>
