<script lang="ts">
  import TerminalTitlebar from "../terminal/TerminalTitlebar.svelte";
  import XTermWrapper from "../terminal/XTermWrapper.svelte";

  let {
    title,
    cwd = "",
    branch = "",
    content = "",
    terminalId = 0,
    active = false,
    onSplitHorizontal,
    onSplitVertical,
    onClose,
  }: {
    title: string;
    cwd?: string;
    branch?: string;
    content?: string;
    terminalId?: number;
    active?: boolean;
    onSplitHorizontal?: () => void;
    onSplitVertical?: () => void;
    onClose?: () => void;
  } = $props();
</script>

<div class="flex flex-col overflow-hidden bg-editor flex-1 min-w-0 min-h-0">
  <TerminalTitlebar {title} {cwd} {branch} {onSplitHorizontal} {onSplitVertical} {onClose} />
  <XTermWrapper {terminalId} active={active}>
    {@html content}
  </XTermWrapper>
</div>
