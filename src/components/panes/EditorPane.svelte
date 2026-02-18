<script lang="ts">
  import TabBar from "./TabBar.svelte";
  import CodeMirrorEditor from "./CodeMirrorEditor.svelte";
  import type { SplitDirection } from "../../lib/stores/layout.svelte";

  let {
    tabs,
    activeTab,
    content,
    filePath,
    paneId,
    onTabClick,
    onTabClose,
    onSplit,
    onClose,
    onContentChange,
    onAction,
  }: {
    tabs: { name: string; path: string }[];
    activeTab: string | null;
    content: string;
    filePath: string;
    paneId: string;
    onTabClick: (path: string) => void;
    onTabClose?: (path: string) => void;
    onSplit?: (direction: SplitDirection, side: "before" | "after") => void;
    onClose?: () => void;
    onContentChange?: (content: string) => void;
    onAction?: (action: string) => void;
  } = $props();
</script>

<div class="flex flex-col overflow-hidden bg-editor flex-1 min-w-0">
  <TabBar {tabs} {activeTab} {paneId} {onTabClick} {onTabClose} {onSplit} {onClose} {onAction} />
  <div class="flex-1 overflow-hidden">
    {#if filePath}
      <CodeMirrorEditor {content} {filePath} {onContentChange} />
    {/if}
  </div>
</div>
