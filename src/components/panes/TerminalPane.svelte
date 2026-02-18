<script lang="ts">
  import TerminalTitlebar from "../terminal/TerminalTitlebar.svelte";
  import XTermWrapper from "../terminal/XTermWrapper.svelte";
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
  }: {
    title: string;
    cwd?: string;
    branch?: string;
    content?: string;
    terminalId?: number;
    active?: boolean;
    onSplit?: (direction: SplitDirection, side: "before" | "after") => void;
    onClose?: () => void;
  } = $props();
</script>

<div class="flex flex-col overflow-hidden bg-editor flex-1 min-w-0 min-h-0">
  <TerminalTitlebar {title} {cwd} {branch} {onSplit} {onClose} />
  <XTermWrapper {terminalId} active={active}>
    {@html content}
  </XTermWrapper>
</div>
