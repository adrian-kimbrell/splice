<script lang="ts">
  import FileTree from "./FileTree.svelte";
  import type { FileEntry } from "../../lib/stores/files.svelte";
  import { workspaceManager } from "../../lib/stores/workspace.svelte";
  import { ui } from "../../lib/stores/ui.svelte";

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
        if (!workspaceManager.activeWorkspace) {
          workspaceManager.createEmptyWorkspace();
        }
        await workspaceManager.openFolderInWorkspace(selected as string);
        ui.leftSidebarVisible = true;
        ui.rightSidebarVisible = false;
      }
    } catch (e) {
      console.error("Failed to open folder:", e);
    }
  }
</script>

<div class="bg-sidebar border-r border-border flex flex-col overflow-hidden" style="grid-column: 1; grid-row: 1">
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
        <button
          class="w-full px-3 py-1.5 text-xs text-txt rounded cursor-pointer border border-border hover:text-txt-bright hover:border-txt-dim transition-all duration-75"
          style="background: transparent;"
          onclick={handleOpenFolder}
        >
          Open Project
        </button>
      </div>
    {/if}
  </div>
</div>
