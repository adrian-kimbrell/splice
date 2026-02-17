<script lang="ts">
  import { ui } from "../../lib/stores/ui.svelte";
  import { workspaceManager } from "../../lib/stores/workspace.svelte";

  let { workspaceName = "malloc" }: { workspaceName?: string } = $props();

  async function handleNewTerminal() {
    await workspaceManager.spawnTerminalInWorkspace();
  }
</script>

<div
  class="col-span-full flex items-center px-2 border-b border-border gap-1"
  style="grid-row: 1; height: 35px; background: var(--bg-topbar);"
>
  <!-- Left: search + workspace name -->
  <button
    class="topbar-btn"
    title="Command Palette"
    onclick={() => (ui.commandPaletteOpen = true)}
  >
    <i class="bi bi-search"></i>
  </button>
  <span class="text-xs text-txt-dim ml-1 mr-auto select-none">{workspaceName}</span>

  <!-- Right: actions -->
  <button class="topbar-btn" title="New Workspace" onclick={() => workspaceManager.createEmptyWorkspace()}>
    <i class="bi bi-folder-plus"></i>
  </button>
  <button class="topbar-btn" title="New Terminal" onclick={handleNewTerminal}>
    <i class="bi bi-terminal"></i>
  </button>
  <button
    class="topbar-btn"
    title="Toggle Explorer"
    onclick={() => (ui.leftSidebarVisible = !ui.leftSidebarVisible)}
  >
    <i class="bi bi-layout-sidebar-inset"></i>
  </button>
  <button
    class="topbar-btn"
    title="Toggle Workspaces"
    onclick={() => (ui.rightSidebarVisible = !ui.rightSidebarVisible)}
  >
    <i class="bi bi-layout-sidebar-inset-reverse"></i>
  </button>
  <button
    class="topbar-btn"
    title="Settings"
    onclick={() => (ui.settingsOpen = true)}
  >
    <i class="bi bi-gear"></i>
  </button>
</div>
