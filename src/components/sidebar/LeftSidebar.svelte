<script lang="ts">
  import FileTree from "./FileTree.svelte";
  import SearchPanel from "./SearchPanel.svelte";
  import type { FileEntry } from "../../lib/stores/files.svelte";
  import { workspaceManager } from "../../lib/stores/workspace.svelte";
  import { ui } from "../../lib/stores/ui.svelte";
  import { diagnosticsStore, getDiagnosticCounts, type LspDiagnostic } from "../../lib/stores/diagnostics.svelte";
  import { lspClient } from "../../lib/lsp/client";
  import { dispatchEditorAction } from "../../lib/stores/editor-actions.svelte";

  let {
    entries,
    onFileClick,
    onFileDoubleClick,
    selectedPath,
    revealPath = null,
    hasFolder = true,
    hasWorkspace = true,
    side = "left",
    rootPath = "",
    sshWorkspaceId = null,
  }: {
    entries: FileEntry[];
    onFileClick: (entry: FileEntry) => void;
    onFileDoubleClick?: (entry: FileEntry) => void;
    selectedPath: string | null;
    revealPath?: string | null;
    hasFolder?: boolean;
    hasWorkspace?: boolean;
    side?: "left" | "right";
    rootPath?: string;
    sshWorkspaceId?: string | null;
  } = $props();

  const counts = $derived(getDiagnosticCounts());

  // Group diagnostics by file path (derived from store)
  const groupedDiagnostics = $derived.by(() => {
    const map = new Map<string, LspDiagnostic[]>();
    for (const [uri, diags] of Object.entries(diagnosticsStore.value)) {
      if (diags.length === 0) continue;
      const path = lspClient.uriToPath(uri);
      map.set(path, diags);
    }
    return map;
  });

  function shortPath(fullPath: string): string {
    const ws = workspaceManager.activeWorkspace;
    if (ws?.rootPath && fullPath.startsWith(ws.rootPath)) {
      return fullPath.slice(ws.rootPath.length + 1);
    }
    return fullPath;
  }

  async function handleDiagnosticClick(filePath: string, line: number) {
    try {
      const { readFile } = await import("../../lib/ipc/commands");
      const content = await readFile(filePath);
      const name = filePath.split("/").pop() ?? "untitled";
      workspaceManager.openFileInWorkspace({ name, path: filePath, content });
      setTimeout(() => dispatchEditorAction("goto-line-number", line + 1), 50);
    } catch (e) {
      console.error("Failed to navigate to diagnostic:", e);
    }
  }

  function severityIcon(sev: number): string {
    switch (sev) {
      case 1: return "bi-x-circle-fill text-red-400";
      case 2: return "bi-exclamation-triangle-fill text-yellow-400";
      case 3: return "bi-info-circle-fill text-blue-400";
      default: return "bi-dot text-txt-dim";
    }
  }

  async function handleOpenFolder() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
      if (selected) {
        if (!workspaceManager.activeWorkspace) {
          workspaceManager.createEmptyWorkspace();
        }
        await workspaceManager.openFolderInWorkspace(selected as string);
        ui.explorerVisible = true;
      }
    } catch (e) {
      console.error("Failed to open folder:", e);
    }
  }
</script>

<div class="bg-sidebar border-border flex flex-col overflow-hidden" class:border-r={side === "left"} class:border-l={side === "right"} style="grid-column: {side === 'left' ? 1 : 5}; grid-row: 1">
  <!-- Tab strip -->
  <div class="flex items-center border-b border-border shrink-0" style="height: 32px;">
    <button
      class="flex items-center justify-center w-8 h-full relative"
      class:text-accent={ui.sidebarMode === "files"}
      class:text-txt-dim={ui.sidebarMode !== "files"}
      title="Files"
      onclick={() => { ui.sidebarMode = "files"; }}
    >
      <i class="bi bi-folder2 text-sm"></i>
    </button>
    <button
      class="flex items-center justify-center w-8 h-full relative"
      class:text-accent={ui.sidebarMode === "search"}
      class:text-txt-dim={ui.sidebarMode !== "search"}
      title="Search (⌘⇧F)"
      onclick={() => { ui.sidebarMode = "search"; }}
    >
      <i class="bi bi-search text-sm"></i>
    </button>
    <button
      class="flex items-center justify-center w-8 h-full relative"
      class:text-accent={ui.sidebarMode === "problems"}
      class:text-txt-dim={ui.sidebarMode !== "problems"}
      title="Problems (⌘⇧M)"
      onclick={() => { ui.sidebarMode = "problems"; }}
    >
      <i class="bi bi-exclamation-triangle text-sm"></i>
      {#if counts.errors > 0 || counts.warnings > 0}
        <span class="absolute top-1 right-0.5 text-[8px] leading-none font-bold"
          class:text-red-400={counts.errors > 0}
          class:text-yellow-400={counts.errors === 0}>
          {counts.errors > 0 ? counts.errors : counts.warnings}
        </span>
      {/if}
    </button>
  </div>

  <div class="flex-1 overflow-auto flex flex-col">
    {#if ui.sidebarMode === "search"}
      <SearchPanel />
    {:else if ui.sidebarMode === "problems"}
      <!-- Problems panel -->
      <div class="flex flex-col h-full overflow-y-auto text-xs">
        {#if groupedDiagnostics.size === 0}
          <div class="px-3 py-6 text-txt-dim text-center">No problems detected</div>
        {:else}
          {#each [...groupedDiagnostics] as [filePath, diags] (filePath)}
            <div class="mb-1">
              <div class="px-2 py-1 text-txt-dim text-[10px] font-medium truncate flex items-center gap-1" title={filePath}>
                <i class="bi bi-file-earmark shrink-0"></i>
                <span class="truncate">{shortPath(filePath)}</span>
                <span class="text-txt-dim/60 ml-auto shrink-0">({diags.length})</span>
              </div>
              {#each diags as diag}
                <button
                  class="w-full text-left px-3 py-0.5 flex items-start gap-1.5 hover:bg-selected cursor-pointer"
                  onclick={() => handleDiagnosticClick(filePath, diag.range.start.line)}
                >
                  <i class="bi {severityIcon(diag.severity)} shrink-0 text-[10px] mt-0.5"></i>
                  <span class="text-txt flex-1 min-w-0 text-xs">{diag.message}</span>
                  <span class="text-txt-dim shrink-0 text-[10px]">:{diag.range.start.line + 1}</span>
                </button>
              {/each}
            </div>
          {/each}
        {/if}
      </div>
    {:else if hasFolder}
      <FileTree {entries} {onFileClick} {onFileDoubleClick} {selectedPath} {revealPath} {rootPath} {sshWorkspaceId} />
    {:else if hasWorkspace}
      <div class="flex flex-col items-center justify-center px-4 h-full text-center">
        <i class="bi bi-folder-plus text-2xl text-txt-dim mb-3 block"></i>
        <p class="text-xs text-txt-dim mb-3">No folder opened in this workspace.</p>
        <button
          class="px-3 py-1.5 text-xs text-accent rounded cursor-pointer border border-accent bg-transparent hover:bg-accent hover:text-white transition-all duration-75"
          style="max-width: 100px;"
          onclick={handleOpenFolder}
        >
          Open Folder
        </button>
      </div>
    {:else}
      <div class="flex flex-col items-center justify-center px-4 h-full text-center">
        <i class="bi bi-folder-plus text-2xl text-txt-dim mb-3 block"></i>
        <p class="text-xs text-txt-dim mb-3">No folder opened.</p>
        <button
          class="px-3 py-1.5 text-xs text-accent rounded cursor-pointer border border-accent bg-transparent hover:bg-accent hover:text-white transition-all duration-75"
          style="max-width: 100px;"
          onclick={handleOpenFolder}
        >
          Open Folder
        </button>
      </div>
    {/if}
  </div>
</div>
