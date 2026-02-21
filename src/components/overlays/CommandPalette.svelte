<script lang="ts">
  import { ui } from "../../lib/stores/ui.svelte";
  import { workspaceManager } from "../../lib/stores/workspace.svelte";
  import { openSettingsWindow } from "../../lib/utils/settings-window";
  import { dispatchEditorAction } from "../../lib/stores/editor-actions.svelte";
  import { settings, debouncedSaveSettings } from "../../lib/stores/settings.svelte";
  import { recentFiles } from "../../lib/stores/recent-files.svelte";

  interface Command {
    name: string;
    shortcut: string;
    action: () => void;
  }

  const COMMANDS: Command[] = [
    { name: "Open File…", shortcut: "⌘O", action() { document.dispatchEvent(new CustomEvent("splice:open-file")); } },
    { name: "Toggle Sidebar", shortcut: "⌘B", action() { ui.explorerVisible = !ui.explorerVisible; } },
    { name: "New Terminal", shortcut: "", action() { workspaceManager.spawnTerminalInWorkspace(); } },
    { name: "Find in Files", shortcut: "⇧⌘F", action() { ui.sidebarMode = "search"; ui.explorerVisible = true; } },
    { name: "Go to Line…", shortcut: "⌘G", action() { dispatchEditorAction("goto-line"); } },
    { name: "Preferences: Open Settings", shortcut: "⌘,", action() { openSettingsWindow(); } },
    { name: "Format Document", shortcut: "⇧⌥F", action() { dispatchEditorAction("format-document"); } },
    { name: "Save All", shortcut: "⌥⌘S", action() { workspaceManager.saveAllDirtyFiles(); } },
    { name: "Toggle Word Wrap", shortcut: "", action() { dispatchEditorAction("toggle-word-wrap"); } },
    { name: "Zoom In", shortcut: "⌘=", action() { settings.appearance.ui_scale = Math.min(200, settings.appearance.ui_scale + 10); debouncedSaveSettings(); } },
    { name: "Zoom Out", shortcut: "⌘-", action() { settings.appearance.ui_scale = Math.max(50, settings.appearance.ui_scale - 10); debouncedSaveSettings(); } },
    { name: "Reset Zoom", shortcut: "⌘0", action() { settings.appearance.ui_scale = 100; debouncedSaveSettings(); } },
  ];

  let filter = $state("");
  let inputEl = $state<HTMLInputElement>();
  let selectedIndex = $state(0);

  const filterLower = $derived(filter.toLowerCase());
  const filtered = $derived(
    COMMANDS.filter((c) =>
      c.name.toLowerCase().includes(filterLower),
    ),
  );

  // Reset selection when filter changes
  $effect(() => {
    filterLower; // track
    selectedIndex = 0;
  });

  function close() {
    ui.commandPaletteOpen = false;
    filter = "";
    selectedIndex = 0;
  }

  function executeCommand(cmd: Command) {
    close();
    cmd.action();
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  function handleKeyDown(e: KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        selectedIndex = Math.min(selectedIndex + 1, filtered.length - 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        selectedIndex = Math.max(selectedIndex - 1, 0);
        break;
      case "Enter":
        if (filtered[selectedIndex]) {
          executeCommand(filtered[selectedIndex]);
        }
        break;
      case "Escape":
        close();
        break;
    }
  }

  $effect(() => {
    if (ui.commandPaletteOpen && inputEl) {
      inputEl.focus();
    }
  });
</script>

{#if ui.commandPaletteOpen}
  <div
    class="fixed inset-0 bg-black/50 z-100 flex justify-center pt-[15vh]"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-label="Command Palette"
    onclick={handleBackdropClick}
    onkeydown={handleKeyDown}
  >
    <div
      class="bg-palette border border-border w-[500px] max-h-[340px] flex flex-col shadow-[0_8px_32px_rgba(0,0,0,0.5)] self-start"
    >
      <input
        bind:this={inputEl}
        bind:value={filter}
        class="bg-input border-none border-b border-border text-txt-bright text-sm px-4 py-3 outline-none"
        style="font-family: var(--ui-font)"
        placeholder="Type a command…"
        spellcheck="false"
        role="combobox"
        aria-expanded="true"
        aria-controls="command-palette-list"
        aria-activedescendant={filtered[selectedIndex] ? `cmd-${selectedIndex}` : undefined}
      />
      <div class="overflow-y-auto flex-1" role="listbox" id="command-palette-list">
        {#each filtered as cmd, i (cmd.name)}
          <div
            id="cmd-{i}"
            class="px-4 py-2 cursor-pointer text-[13px] text-txt flex justify-between"
            class:bg-selected={i === selectedIndex}
            class:text-txt-bright={i === selectedIndex}
            class:hover:bg-selected={i !== selectedIndex}
            class:hover:text-txt-bright={i !== selectedIndex}
            role="option"
            tabindex="-1"
            aria-selected={i === selectedIndex}
            onmouseenter={() => { selectedIndex = i; }}
            onclick={() => executeCommand(cmd)}
            onkeydown={(e) => { if (e.key === "Enter") executeCommand(cmd); }}
          >
            <span>{cmd.name}</span>
            <span class="text-txt-dim text-[11px]">{cmd.shortcut}</span>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}
