<script lang="ts">
  import TerminalTitlebar from "../terminal/TerminalTitlebar.svelte";
  import CanvasTerminal from "../terminal/CanvasTerminal.svelte";
  import type { SplitDirection } from "../../lib/stores/layout.svelte";
  import { attentionStore } from "../../lib/stores/attention.svelte";

  let {
    title,
    cwd = "",
    terminalId = 0,
    active = false,
    onSplit,
    onClose,
    onAction,
  }: {
    title: string;
    cwd?: string;
    terminalId?: number;
    active?: boolean;
    onSplit?: (direction: SplitDirection, side: "before" | "after") => void;
    onClose?: () => void;
    onAction?: (action: string) => void;
  } = $props();

  const notification = $derived(attentionStore.notifications[terminalId] ?? null);
</script>

<div
  class="flex flex-col overflow-hidden bg-editor flex-1 min-w-0 min-h-0"
  class:flash-permission={notification?.type === 'permission'}
  class:flash-idle={notification?.type === 'idle'}
>
  <TerminalTitlebar {title} {cwd} {onSplit} {onClose} {onAction} {notification} />
  <CanvasTerminal {terminalId} active={active} />
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
