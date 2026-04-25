<script lang="ts">
  import { onDestroy } from "svelte";
  import { MergeView } from "@codemirror/merge";
  import { EditorView } from "@codemirror/view";
  import { EditorState } from "@codemirror/state";
  import { editorTheme, editorHighlighting } from "../../lib/theme/editor-theme";
  import { getLanguageExtension } from "../../lib/editor/language-loader";
  import { workspaceManager } from "../../lib/stores/workspace.svelte";
  import { refreshGitStatus } from "../../lib/stores/git.svelte";
  import { pushToast } from "../../lib/stores/toasts.svelte";
  import { settings } from "../../lib/stores/settings.svelte";

  let {
    filePath,
    oldContent,
    newContent,
    staged,
    rootPath,
    preview = false,
    paneId,
    onClose,
  }: {
    filePath: string;
    oldContent: string;
    newContent: string;
    staged: boolean;
    rootPath: string;
    preview?: boolean;
    paneId: string;
    onClose: () => void;
  } = $props();

  function pinPane() {
    const ws = workspaceManager.activeWorkspace;
    if (ws?.panes[paneId]?.kind === "diff") {
      ws.panes[paneId].diffPreview = false;
    }
  }

  let containerEl = $state<HTMLDivElement>();
  let mergeView: MergeView | null = null;
  let acting = $state(false);

  const fileName = $derived(filePath.split("/").pop() ?? filePath);
  const wsId = $derived(workspaceManager.activeWorkspaceId ?? "");

  async function doRefresh() {
    if (wsId && rootPath) await refreshGitStatus(wsId, rootPath);
  }

  async function stageFile() {
    pinPane();
    acting = true;
    try {
      const { gitStage } = await import("../../lib/ipc/commands");
      await gitStage(rootPath, [filePath]);
      await doRefresh();
      onClose();
    } catch (e) {
      pushToast(`Failed to stage ${fileName}: ${e}`);
    } finally {
      acting = false;
    }
  }

  async function unstageFile() {
    pinPane();
    acting = true;
    try {
      const { gitUnstage } = await import("../../lib/ipc/commands");
      await gitUnstage(rootPath, [filePath]);
      await doRefresh();
      onClose();
    } catch (e) {
      pushToast(`Failed to unstage ${fileName}: ${e}`);
    } finally {
      acting = false;
    }
  }

  async function discardFile() {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    const confirmed = await ask(
      `Discard changes to "${fileName}"? This cannot be undone.`,
      { title: "Discard Changes", kind: "warning" },
    );
    if (!confirmed) return;
    pinPane();
    acting = true;
    try {
      const { gitDiscard } = await import("../../lib/ipc/commands");
      await gitDiscard(rootPath, [filePath]);
      await doRefresh();
      onClose();
    } catch (e) {
      pushToast(`Failed to discard ${fileName}: ${e}`);
    } finally {
      acting = false;
    }
  }

  async function buildMergeView() {
    if (!containerEl) return;

    mergeView?.destroy();
    mergeView = null;

    const langExt = await getLanguageExtension(filePath).catch(() => null);

    // MergeView scrolls as one unit via .cm-mergeView (overflow-y: auto).
    // Override editorTheme's height:100% back to auto so editors size to content.
    const mergeOverride = EditorView.theme({ "&": { height: "auto" } });

    const extensions = [
      editorTheme,
      editorHighlighting,
      mergeOverride,
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
    ];
    if (langExt) extensions.push(langExt);

    mergeView = new MergeView({
      a: { doc: oldContent, extensions: [...extensions] },
      b: { doc: newContent, extensions: [...extensions] },
      parent: containerEl,
      collapseUnchanged: { margin: 3, minSize: 4 },
    });
  }

  // Recreate MergeView whenever content or file changes (e.g. preview pane replacement)
  $effect(() => {
    // Track reactive dependencies
    const _fp = filePath;
    const _old = oldContent;
    const _new = newContent;
    if (containerEl) buildMergeView();
  });

  // Match editor font settings — same as CodeMirrorEditor does
  $effect(() => {
    if (!containerEl) return;
    containerEl.style.setProperty("--font-family", `'${settings.editor.font_family}', monospace`);
    containerEl.style.setProperty("--font-size", `${settings.editor.font_size}px`);
  });

  onDestroy(() => {
    mergeView?.destroy();
  });
</script>

<div class="flex flex-col h-full w-full overflow-hidden" style="background: var(--bg-editor);">
  <!-- Header -->
  <div class="flex items-center gap-2 px-3 shrink-0 border-b border-border" style="height: 32px;">
    <i class="bi bi-file-diff text-txt-dim text-sm"></i>
    <span class="text-xs font-medium truncate flex-1" class:italic={preview} style="color: var(--text-bright);">{fileName}</span>
    <span class="text-[10px] px-1.5 py-px rounded font-medium"
      style="background: {staged ? 'var(--git-added-bg)' : 'var(--git-modified-bg)'}; color: {staged ? 'var(--git-added)' : 'var(--ansi-yellow)'};">
      {staged ? "staged" : "unstaged"}
    </span>

    {#if staged}
      <button
        class="diff-action-btn"
        title="Unstage file"
        disabled={acting}
        onclick={unstageFile}
      >
        <i class="bi bi-dash-lg text-[11px]"></i>
        <span>Unstage</span>
      </button>
    {:else}
      <button
        class="diff-action-btn discard"
        title="Discard changes"
        disabled={acting}
        onclick={discardFile}
      >
        <i class="bi bi-arrow-counterclockwise text-[11px]"></i>
        <span>Discard</span>
      </button>
      <button
        class="diff-action-btn stage"
        title="Stage file"
        disabled={acting}
        onclick={stageFile}
      >
        <i class="bi bi-plus-lg text-[11px]"></i>
        <span>Stage</span>
      </button>
    {/if}

    <button
      class="pane-action-btn close"
      title="Close diff"
      onclick={onClose}
    >
      <i class="bi bi-x text-sm"></i>
    </button>
  </div>
  <!-- Diff viewer -->
  <div bind:this={containerEl} class="flex-1 min-h-0 overflow-hidden diff-container"></div>
</div>

<style>
  .diff-action-btn {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 2px 7px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-dim);
    transition: color 0.1s, background 0.1s, border-color 0.1s;
    white-space: nowrap;
  }
  .diff-action-btn:hover {
    color: var(--text-bright);
    background: var(--bg-selected);
    border-color: var(--text-dim);
  }
  .diff-action-btn.stage:hover {
    color: var(--git-added);
    border-color: var(--git-added-border);
    background: var(--git-added-bg);
  }
  .diff-action-btn.discard:hover {
    color: var(--ansi-red);
    border-color: rgba(var(--ansi-red-rgb, 224,108,117), 0.4);
    background: var(--git-deleted-bg);
  }
  .diff-action-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* MergeView scrolls as one unit — give it a fixed height and let its own
     overflow-y: auto (set by @codemirror/merge) handle scrolling.
     Do NOT override .cm-scroller or individual editor heights — the package
     forces .cm-scroller to overflow-y: visible so the outer div scrolls. */
  .diff-container :global(.cm-mergeView) {
    height: 100%;
    overflow-y: auto;
  }
  /* No line background — it drowns out dim syntax colors (comments, etc).
     Use a left border strip for the line indicator and inline highlight for actual changes. */
  .diff-container :global(.cm-changedLine) {
    background: none !important;
    box-shadow: none !important;
  }
  .diff-container :global(.cm-merge-a .cm-changedLine) {
    box-shadow: inset 3px 0 0 rgba(224, 108, 117, 0.7) !important;
  }
  .diff-container :global(.cm-merge-b .cm-changedLine) {
    box-shadow: inset 3px 0 0 rgba(152, 195, 121, 0.7) !important;
  }
  .diff-container :global(.cm-merge-a .cm-changedText) {
    background: rgba(224, 108, 117, 0.3) !important;
    border-radius: 2px;
  }
  .diff-container :global(.cm-merge-b .cm-changedText) {
    background: rgba(152, 195, 121, 0.3) !important;
    border-radius: 2px;
  }
  .diff-container :global(.cm-merge-gap) {
    background: var(--bg-sidebar);
    border-color: var(--border);
  }
  .diff-container :global(.cm-collapsedLines) {
    background: var(--bg-sidebar);
    color: var(--text-dim);
    border-color: var(--border);
  }
</style>
