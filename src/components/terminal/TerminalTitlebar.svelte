<script lang="ts">
  import { ui } from "../../lib/stores/ui.svelte";
  import { effectiveSettings } from "../../lib/stores/settings.svelte";
  import type { SplitDirection } from "../../lib/stores/layout.svelte";
  import PaneHeaderActions from "../shared/PaneHeaderActions.svelte";
  import type { PaneHeaderAction } from "../../lib/actions";
  import type { AttentionNotification } from "../../lib/stores/attention.svelte";
  import { beginDrag, getDragActive, isDragging } from "../../lib/stores/drag.svelte";
  import { workspaceManager } from "../../lib/stores/workspace.svelte";
  import { claudeStore } from "../../lib/stores/claude.svelte";
  import { formatRelativeTime, tickingNow } from "../../lib/utils/relative-time.svelte";

  let {
    title,
    cwd = "",
    gitBranch = "",
    paneId = "",
    notification = null,
    onSplit,
    onClose,
    onAction,
    onRename,
  }: {
    title: string;
    cwd?: string;
    gitBranch?: string;
    paneId?: string;
    notification?: AttentionNotification | null;
    onSplit?: (direction: SplitDirection, side: "before" | "after") => void;
    onClose?: () => void;
    onAction?: (action: PaneHeaderAction) => void;
    onRename?: (title: string) => void;
  } = $props();

  // Inline title rename (double-click the title). Commits on Enter/blur, cancels on Esc.
  let editing = $state(false);
  let editValue = $state("");

  function startRename() {
    if (!onRename) return;
    editValue = title;
    editing = true;
  }
  function commitRename() {
    if (!editing) return;
    editing = false;
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== title) onRename?.(trimmed);
  }
  function renameKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") { e.preventDefault(); commitRename(); }
    else if (e.key === "Escape") { e.preventDefault(); editing = false; }
  }
  // Focus + select-all when the input mounts, so the current name is highlighted
  // and typing replaces it. More reliable than the autofocus attribute.
  function focusSelect(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  const isBeingDragged = $derived.by(() => {
    if (!isDragging()) return false;
    const d = getDragActive();
    return d?.kind === "terminal" && d?.sourcePaneId === paneId;
  });

  // "Xm ago" badge shown when the pane hasn't been active for ≥5 min. Re-derives
  // every 30 s via tickingNow() and any time the workspace's pane map changes.
  const lastTouchedLabel = $derived.by(() => {
    const ws = workspaceManager.activeWorkspace;
    const lastTouchedAt = ws?.panes[paneId]?.lastTouchedAt;
    return formatRelativeTime(lastTouchedAt, tickingNow());
  });

  // When `show_full_path` is off, show just the project basename
  // (last path segment); when on, show the full path as-is.
  const displayCwd = $derived.by(() => {
    if (!cwd) return "";
    if (effectiveSettings.terminal.show_full_path) return cwd;
    const segments = cwd.split("/").filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : cwd;
  });

  function handleMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    // The title is a rename target (double-click), not a drag handle — so a
    // double-click doesn't fight the drag logic. Drag still works from the rest
    // of the bar. Only applies when renaming is enabled.
    if (onRename && (e.target as HTMLElement).closest("[data-rename]")) return;
    e.preventDefault();
    beginDrag({ filePath: "", fileName: title, sourcePaneId: paneId, kind: "terminal" }, e);
  }


  // --- Live Claude telemetry for this pane's terminal ---
  const terminalId = $derived(workspaceManager.activeWorkspace?.panes[paneId]?.terminalId ?? null);
  const claudeStatus = $derived(terminalId != null ? claudeStore.status[terminalId] ?? null : null);
  // Color the context-window readout as it fills toward compaction.
  const ctxColor = $derived.by(() => {
    const pct = claudeStatus?.contextPct;
    if (pct == null) return "var(--text-dim)";
    if (pct >= 85) return "var(--ansi-red)";
    if (pct >= 70) return "var(--ansi-yellow)";
    return "var(--text-dim)";
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="flex items-center px-2.5 bg-tab-active border-b border-border text-xs shrink-0 select-none overflow-hidden min-w-0 transition-opacity duration-100"
  style="height: var(--titlebar-height); min-height: var(--titlebar-height);{isBeingDragged ? ' opacity: 0.35;' : ''}"
  onmousedown={handleMouseDown}
>
  {#if editing}
    <input
      class="terminal-rename-input font-medium mr-2 min-w-0"
      bind:value={editValue}
      onkeydown={renameKeydown}
      onblur={commitRename}
      onmousedown={(e) => e.stopPropagation()}
      ondblclick={(e) => e.stopPropagation()}
      use:focusSelect
    />
  {:else}
    <span
      data-rename
      class="text-txt-bright font-medium whitespace-nowrap mr-2 overflow-hidden text-ellipsis min-w-0"
      class:cursor-text={!!onRename}
      title={onRename ? "Double-click to rename" : undefined}
      ondblclick={(e) => { e.stopPropagation(); startRename(); }}
      role="button"
      tabindex="-1"
    >{title}</span>
  {/if}
  {#if notification}
    <span
      class="attention-bell shrink-0 mr-2 flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded"
      style="color: {notification.type === 'permission' ? 'var(--ansi-red)' : 'var(--ansi-yellow)'}; background: {notification.type === 'permission' ? 'var(--git-deleted-bg)' : 'var(--git-modified-bg)'};"
    >
      <i class="bi bi-claude" style="font-size: var(--ui-xs);"></i>
      {notification.type === 'permission' ? 'permission' : 'waiting'}
    </span>
  {/if}
  <span class="flex-1 min-w-0"></span>
  <span
    class="flex items-center gap-3 text-txt-dim text-[11px] whitespace-nowrap overflow-hidden min-w-0"
  >
    {#if gitBranch}
      <span class="overflow-hidden text-ellipsis shrink-0"><i class="bi bi-git mr-1 text-[11px]"></i>{gitBranch}</span>
    {/if}
    {#if displayCwd}
      <span class="overflow-hidden text-ellipsis" title={cwd}
        ><i class="bi bi-folder2 mr-1 text-[11px]"></i>{displayCwd}</span
      >
    {/if}
    {#if lastTouchedLabel}
      <span class="shrink-0 opacity-70" title="Last active in this pane"
        ><i class="bi bi-clock-history mr-1 text-[10px]"></i>{lastTouchedLabel}</span
      >
    {/if}
    {#if claudeStatus?.model}
      <span class="shrink-0" title="Model in this terminal's agent session">
        <i class="bi bi-cpu mr-1 text-[10px]"></i>{claudeStatus.model}
      </span>
    {/if}
    {#if claudeStatus?.contextPct != null}
      <span class="shrink-0" style="color: {ctxColor};" title="Claude context window used">
        <i class="bi bi-pie-chart mr-1 text-[10px]"></i>{Math.round(claudeStatus.contextPct)}%
      </span>
    {/if}
    {#if claudeStatus?.costUsd != null}
      <span class="shrink-0 opacity-80" title="Claude session cost">${claudeStatus.costUsd.toFixed(2)}</span>
    {/if}
  </span>
  <span class="flex items-center gap-0.5 ml-2.5 shrink-0">
    {#if ui.zoomedPaneId}
      <span class="text-[10px] uppercase tracking-wide text-accent mr-1 font-medium">Zoomed</span>
    {/if}
    <PaneHeaderActions {onAction} {onSplit} {onClose} />
  </span>
</div>

<style>
  .terminal-rename-input {
    font-size: var(--ui-body);
    color: var(--text-bright);
    background: var(--bg-input);
    border: 1px solid var(--accent);
    border-radius: 3px;
    padding: 0 5px;
    height: 20px;
    max-width: 200px;
    outline: none;
  }

  .attention-bell {
    animation: bell-pulse 1.2s ease-in-out infinite;
  }
  @keyframes bell-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }
</style>
