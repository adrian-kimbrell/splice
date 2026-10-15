<script lang="ts">
  /**
   * WelcomeScreen -- shown when no workspace is open.
   *
   * Offers the common first actions (new file, open folder, terminal, command
   * palette), recent projects, and settings. Extracted from App.svelte; the
   * `.welcome-*` styles live in app.css because the compact empty-workspace
   * buttons in App.svelte share them.
   */
  import { workspaceManager } from "../lib/stores/workspace.svelte";
  import { ui } from "../lib/stores/ui.svelte";
  import { recentProjects } from "../lib/stores/recent-projects.svelte";
  import { getRandomTagline } from "../lib/utils/taglines";

  let {
    onNewFile,
    onOpenFolder,
  }: {
    onNewFile: () => void;
    onOpenFolder: () => void;
  } = $props();

  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const tagline = getRandomTagline();
</script>

<div class="welcome-screen flex-1 flex items-center justify-center">
  <div class="welcome-container">
    <div class="welcome-header">
      <div style="width: 64px; height: 64px; background-color: var(--accent); -webkit-mask-image: url('/logo.png'); -webkit-mask-size: contain; -webkit-mask-repeat: no-repeat; -webkit-mask-position: center; mask-image: url('/logo.png'); mask-size: contain; mask-repeat: no-repeat; mask-position: center;" aria-label="Splice"></div>
      <div>
        <div class="text-txt-bright text-xl font-medium">Splice</div>
        <div class="text-txt-dim text-xs">{tagline}</div>
      </div>
    </div>

    <fieldset class="welcome-section">
      <legend class="welcome-legend">Get Started</legend>
      <button class="welcome-item" onclick={onNewFile}>
        <i class="bi bi-file-earmark-plus"></i>
        <span>New File</span>
        <kbd>Cmd N</kbd>
      </button>
      {#if isTauri}
        <button class="welcome-item" onclick={onOpenFolder}>
          <i class="bi bi-folder2-open"></i>
          <span>Open Folder</span>
          <kbd>Cmd O</kbd>
        </button>
        <button class="welcome-item" onclick={() => workspaceManager.spawnTerminalInWorkspace()}>
          <i class="bi bi-terminal"></i>
          <span>Open Terminal</span>
        </button>
      {/if}
      <button class="welcome-item" onclick={() => (ui.commandPaletteOpen = true)}>
        <i class="bi bi-command"></i>
        <span>Command Palette</span>
        <kbd>Cmd P</kbd>
      </button>
    </fieldset>

    {#if recentProjects.length > 0 && !ui.prMode}
      <fieldset class="welcome-section">
        <legend class="welcome-legend">Recent</legend>
        {#each recentProjects.slice(0, 5) as projectPath}
          <button class="welcome-item" onclick={() => {
            workspaceManager.createWorkspaceFromDirectory(projectPath);
          }}>
            <i class="bi bi-folder2" style="flex-shrink: 0;"></i>
            <span style="flex: none;">{projectPath.split("/").filter(Boolean).pop()}</span>
            <span class="text-txt-dim text-[10px] truncate" style="flex: 1; min-width: 0;">{projectPath}</span>
          </button>
        {/each}
      </fieldset>
    {/if}

    <fieldset class="welcome-section">
      <legend class="welcome-legend">Configure</legend>
      <button class="welcome-item" onclick={() => ui.settingsDrawerOpen = true}>
        <i class="bi bi-gear"></i>
        <span>Open Settings</span>
        <kbd>Cmd ,</kbd>
      </button>
    </fieldset>
  </div>
</div>
