<script lang="ts">
  /**
   * EditorPane.svelte -- A single editor pane within the PaneGrid.
   *
   * Renders a TabBar, optional Breadcrumbs path trail, and one of:
   *   - CodeMirrorEditor for text files (with readonly support)
   *   - ImagePreview for recognized image extensions (.png, .jpg, .svg, etc.)
   *   - MarkdownPreview / HtmlPreview when the user toggles preview mode on .md/.html files
   *
   * This component does NOT own file state. Tabs, content, and the active file path are
   * received as props from App.svelte (via workspace-view-helpers). Content mutations
   * flow back through onContentChange, onSave, and onAutoSave callbacks.
   *
   * Tab management: onTabClick selects, onTabClose removes, onTabDoubleClick promotes
   * a preview tab to a pinned tab. Tab context actions (close others, close to right,
   * toggle readonly/pin) are forwarded to the parent via onTabContextAction.
   *
   * The pane registers its content area element with the drag store so PaneGrid can
   * compute drop zones for tab drag-and-drop.
   */
  import TabBar from "./TabBar.svelte";
  import CodeMirrorEditor from "./CodeMirrorEditor.svelte";
  import Breadcrumbs from "./Breadcrumbs.svelte";
  import ImagePreview from "./ImagePreview.svelte";
  import MarkdownPreview from "./MarkdownPreview.svelte";
  import HtmlPreview from "./HtmlPreview.svelte";
  import type { SplitDirection } from "../../lib/stores/layout.svelte";
  import { registerPaneContent, unregisterPaneContent } from "../../lib/stores/drag.svelte";
  import { onMount } from "svelte";

  let {
    tabs,
    activeTab,
    content,
    filePath,
    paneId,
    rootPath = "",
    gitBranch = "",
    readOnly = false,
    onTabClick,
    onTabClose,
    onTabDoubleClick,
    onSplit,
    onClose,
    onContentChange,
    onSave,
    onAutoSave,
    onAction,
    onTabContextAction,
    onTogglePreview,
  }: {
    tabs: { name: string; path: string; preview?: boolean; dirty?: boolean; pinned?: boolean; readOnly?: boolean }[];
    activeTab: string | null;
    content: string;
    filePath: string;
    paneId: string;
    rootPath?: string;
    gitBranch?: string;
    readOnly?: boolean;
    onTabClick: (path: string) => void;
    onTabClose?: (path: string) => void;
    onTabDoubleClick?: (path: string) => void;
    onSplit?: (direction: SplitDirection, side: "before" | "after") => void;
    onClose?: () => void;
    onContentChange?: (content: string) => void;
    onSave?: () => void;
    onAutoSave?: () => void;
    onAction?: (action: string) => void;
    onTabContextAction?: (action: string, path: string) => void;
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

  function isHtmlFile(path: string): boolean {
    return path.endsWith(".html") || path.endsWith(".htm");
  }

  let contentAreaEl = $state<HTMLDivElement>();

  $effect(() => {
    if (!contentAreaEl || !paneId) return;
    registerPaneContent(paneId, contentAreaEl);
    return () => unregisterPaneContent(paneId);
  });
</script>

<div class="flex flex-col overflow-hidden bg-editor flex-1 min-w-0">
  <TabBar {tabs} {activeTab} {paneId} {gitBranch} {onTabClick} {onTabClose} {onTabDoubleClick} {onSplit} {onClose} {onAction} {onTabContextAction}
    showPreviewToggle={isMdFile(filePath) || isHtmlFile(filePath)}
    {previewMode}
    onTogglePreview={() => { previewMode = previewMode === "editor" ? "preview" : "editor"; }}
  />
  {#if filePath && rootPath && !filePath.startsWith("untitled-")}
    <Breadcrumbs {filePath} {rootPath} />
  {/if}
  <div bind:this={contentAreaEl} class="flex-1 overflow-hidden">
    {#if filePath}
      {#if isImageFile(filePath)}
        <ImagePreview {filePath} />
      {:else if isMdFile(filePath) && previewMode === "preview"}
        <MarkdownPreview {content} />
      {:else if isHtmlFile(filePath) && previewMode === "preview"}
        <HtmlPreview {filePath} {content} />
      {:else}
        <CodeMirrorEditor {content} {filePath} {paneId} readonly={readOnly} {onContentChange} {onSave} {onAutoSave} />
      {/if}
    {/if}
  </div>
</div>
