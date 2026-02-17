<script lang="ts">
  import FileTree from "./FileTree.svelte";
  import type { FileEntry } from "../../lib/stores/files.svelte";
  import { workspaceManager } from "../../lib/stores/workspace.svelte";

  let {
    entries,
    onFileClick,
    selectedPath,
    hasFolder = true,
    hasWorkspace = true,
  }: {
    entries: FileEntry[];
    onFileClick: (entry: FileEntry) => void;
    selectedPath: string | null;
    hasFolder?: boolean;
    hasWorkspace?: boolean;
  } = $props();

  async function handleOpenFolder() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
      if (selected) {
        await workspaceManager.openFolderInWorkspace(selected as string);
      }
    } catch (e) {
      console.error("Failed to open folder:", e);
    }
  }
</script>

<div class="bg-sidebar border-r border-border flex flex-col overflow-hidden" style="grid-column: 1; grid-row: 2">
  <div class="sidebar-header"><span class="truncate">Explorer</span></div>
  <div class="flex-1 overflow-y-auto flex flex-col">
    {#if hasFolder}
      <FileTree {entries} {onFileClick} {selectedPath} />
    {:else if hasWorkspace}
      <div class="flex flex-col items-center justify-center px-4 h-full text-center">
        <i class="bi bi-folder-plus text-2xl text-txt-dim mb-3 block"></i>
        <p class="text-xs text-txt-dim mb-3">No folder opened in this workspace.</p>
        <button
          class="px-3 py-1.5 text-xs bg-accent text-white rounded cursor-pointer border-none hover:brightness-110 transition-all duration-75"
          onclick={handleOpenFolder}
        >
          Open Folder
        </button>
      </div>
    {:else}
      <div class="flex flex-col items-center justify-center px-4 h-full text-center">
        <i class="bi bi-window-stack text-2xl text-txt-dim mb-3 block"></i>
        <p class="text-xs text-txt-dim">Open a workspace to get started.</p>
      </div>
    {/if}
  </div>
</div>
