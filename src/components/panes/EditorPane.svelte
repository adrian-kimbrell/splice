<script lang="ts">
  import TabBar from "./TabBar.svelte";
  import CodeMirrorEditor from "./CodeMirrorEditor.svelte";
  import Breadcrumbs from "./Breadcrumbs.svelte";
  import ImagePreview from "./ImagePreview.svelte";
  import MarkdownPreview from "./MarkdownPreview.svelte";
  import type { SplitDirection } from "../../lib/stores/layout.svelte";

  let {
    tabs,
    activeTab,
    content,
    filePath,
    paneId,
    rootPath = "",
    onTabClick,
    onTabClose,
    onTabDoubleClick,
    onSplit,
    onClose,
    onContentChange,
    onSave,
    onAutoSave,
    onAction,
    onTogglePreview,
  }: {
    tabs: { name: string; path: string; preview?: boolean; dirty?: boolean }[];
    activeTab: string | null;
    content: string;
    filePath: string;
    paneId: string;
    rootPath?: string;
    onTabClick: (path: string) => void;
    onTabClose?: (path: string) => void;
    onTabDoubleClick?: (path: string) => void;
    onSplit?: (direction: SplitDirection, side: "before" | "after") => void;
    onClose?: () => void;
    onContentChange?: (content: string) => void;
    onSave?: () => void;
    onAutoSave?: () => void;
    onAction?: (action: string) => void;
    onTogglePreview?: () => void;
  } = $props();

  const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".bmp"]);

  function isImageFile(path: string): boolean {
    const dot = path.lastIndexOf(".");
    if (dot < 0) return false;
    return IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase());
  }

  let previewMode = $state<"editor" | "preview">("editor");

  // Reset preview mode when file changes
  $effect(() => {
    filePath;
    previewMode = "editor";
  });

  function isMdFile(path: string): boolean {
    return path.endsWith(".md") || path.endsWith(".markdown");
  }
</script>

<div class="flex flex-col overflow-hidden bg-editor flex-1 min-w-0">
  <TabBar {tabs} {activeTab} {paneId} {onTabClick} {onTabClose} {onTabDoubleClick} {onSplit} {onClose} {onAction}
    showPreviewToggle={isMdFile(filePath)}
    {previewMode}
    onTogglePreview={() => { previewMode = previewMode === "editor" ? "preview" : "editor"; }}
  />
  {#if filePath && rootPath && !filePath.startsWith("untitled-")}
    <Breadcrumbs {filePath} {rootPath} />
  {/if}
  <div class="flex-1 overflow-hidden">
    {#if filePath}
      {#if isImageFile(filePath)}
        <ImagePreview {filePath} />
      {:else if isMdFile(filePath) && previewMode === "preview"}
        <MarkdownPreview {content} />
      {:else}
        <CodeMirrorEditor {content} {filePath} {paneId} {onContentChange} {onSave} {onAutoSave} />
      {/if}
    {/if}
  </div>
</div>
