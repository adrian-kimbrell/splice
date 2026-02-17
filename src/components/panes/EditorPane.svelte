<script lang="ts">
  import TabBar from "./TabBar.svelte";
  import CodeMirrorEditor from "./CodeMirrorEditor.svelte";

  let {
    tabs,
    activeTab,
    content,
    filePath,
    paneId,
    onTabClick,
    onTabClose,
    onSplitHorizontal,
    onSplitVertical,
    onClose,
    onContentChange,
  }: {
    tabs: { name: string; path: string }[];
    activeTab: string | null;
    content: string;
    filePath: string;
    paneId: string;
    onTabClick: (path: string) => void;
    onTabClose?: (path: string) => void;
    onSplitHorizontal?: () => void;
    onSplitVertical?: () => void;
    onClose?: () => void;
    onContentChange?: (content: string) => void;
  } = $props();
</script>

<div class="flex flex-col overflow-hidden bg-editor flex-1 min-w-0">
  <TabBar {tabs} {activeTab} {paneId} {onTabClick} {onTabClose} {onSplitHorizontal} {onSplitVertical} {onClose} />
  <div class="flex-1 overflow-hidden">
    {#if filePath}
      <CodeMirrorEditor {content} {filePath} {onContentChange} />
    {/if}
  </div>
</div>
