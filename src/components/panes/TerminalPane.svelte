<script lang="ts">
  import TerminalTitlebar from "../terminal/TerminalTitlebar.svelte";
  import CanvasTerminal from "../terminal/CanvasTerminal.svelte";
  import type { SplitDirection } from "../../lib/stores/layout.svelte";

  let {
    title,
    cwd = "",
    branch = "",
    content = "",
    terminalId = 0,
    active = false,
    onSplit,
    onClose,
    onAction,
  }: {
    title: string;
    cwd?: string;
    branch?: string;
    content?: string;
    terminalId?: number;
    active?: boolean;
    onSplit?: (direction: SplitDirection, side: "before" | "after") => void;
    onClose?: () => void;
    onAction?: (action: string) => void;
  } = $props();
</script>

<div class="flex flex-col overflow-hidden bg-editor flex-1 min-w-0 min-h-0">
  <TerminalTitlebar {title} {cwd} {branch} {onSplit} {onClose} {onAction} />
  <CanvasTerminal {terminalId} active={active}>
    {@html content}
  </CanvasTerminal>
</div>
