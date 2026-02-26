<script lang="ts">
  import FileTree from "./FileTree.svelte";
  import SearchPanel from "./SearchPanel.svelte";
  import type { FileEntry } from "../../lib/stores/files.svelte";
  import { workspaceManager } from "../../lib/stores/workspace.svelte";
  import { ui } from "../../lib/stores/ui.svelte";

  let {
    entries,
    onFileClick,
    onFileDoubleClick,
    selectedPath,
    hasFolder = true,
    hasWorkspace = true,
    side = "left",
    rootPath = "",
  }: {
    entries: FileEntry[];
    onFileClick: (entry: FileEntry) => void;
    onFileDoubleClick?: (entry: FileEntry) => void;
    selectedPath: string | null;
    hasFolder?: boolean;
    hasWorkspace?: boolean;
    side?: "left" | "right";
    rootPath?: string;
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
        ui.explorerVisible = true;
      }
    } catch (e) {
      console.error("Failed to open folder:", e);
    }
  }
</script>

<div class="bg-sidebar border-border flex flex-col overflow-hidden" class:border-r={side === "left"} class:border-l={side === "right"} style="grid-column: {side === 'left' ? 1 : 5}; grid-row: 1">
  <div class="flex-1 overflow-auto flex flex-col">
    {#if ui.sidebarMode === "search"}
      <SearchPanel />
    {:else if hasFolder}
      <FileTree {entries} {onFileClick} {onFileDoubleClick} {selectedPath} {rootPath} />
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
