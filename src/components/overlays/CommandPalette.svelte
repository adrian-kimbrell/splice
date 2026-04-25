<script lang="ts">
  import { ui } from "../../lib/stores/ui.svelte";
  import { workspaceManager } from "../../lib/stores/workspace.svelte";
  import { openSettingsWindow } from "../../lib/utils/settings-window";
  import { dispatchEditorAction } from "../../lib/stores/editor-actions.svelte";
  import { settings, debouncedSaveSettings } from "../../lib/stores/settings.svelte";
  import { recentFiles } from "../../lib/stores/recent-files.svelte";
  import { fade, fly } from "svelte/transition";
  import { cubicOut } from "svelte/easing";

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

  // When filter is empty, prepend recent files as commands
  const recentFileCommands = $derived<Command[]>(
    recentFiles.slice(0, 10).map((path) => ({
      name: path.split("/").pop() ?? path,
      shortcut: "",
      action() {
        (async () => {
          if (!workspaceManager.activeWorkspace) workspaceManager.createEmptyWorkspace();
          try {
            const { readFile } = await import("../../lib/ipc/commands");
            const content = await readFile(path);
            const name = path.split("/").pop() ?? "untitled";
            workspaceManager.openFileInWorkspace({ name, path, content });
          } catch (e) { console.error("Failed to open recent file:", e); }
        })();
      },
    })),
  );

  const filtered = $derived(
    filterLower === ""
      ? [...recentFileCommands, ...COMMANDS]
      : [...recentFileCommands, ...COMMANDS].filter((c) =>
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
    transition:fade={{ duration: 150 }}
    class="fixed inset-0 z-100 flex justify-center pt-[15vh]"
    style="background: var(--backdrop-md); backdrop-filter: blur(3px);"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-label="Command Palette"
    onclick={handleBackdropClick}
    onkeydown={handleKeyDown}
  >
    <div
      transition:fly={{ y: -10, duration: 200, easing: cubicOut }}
      class="bg-palette border border-border w-[500px] max-h-[340px] flex flex-col self-start"
      style="border-radius: 6px; box-shadow: var(--shadow-xl), 0 0 0 1px var(--overlay-xs);"
    >
      <input
        bind:this={inputEl}
        bind:value={filter}
        class="border-none border-b border-border text-txt-bright text-sm px-4 py-3 outline-none"
        style="font-family: var(--ui-font); background: var(--bg-input); border-radius: 6px 6px 0 0;"
        placeholder="Type a command…"
        spellcheck="false"
        role="combobox"
        aria-expanded="true"
        aria-controls="command-palette-list"
        aria-activedescendant={filtered[selectedIndex] ? `cmd-${selectedIndex}` : undefined}
      />
      <div class="overflow-y-auto flex-1" role="listbox" id="command-palette-list" style="border-radius: 0 0 6px 6px;">
        {#each filtered as cmd, i (cmd.name)}
          <div
            id="cmd-{i}"
            class="py-2 cursor-pointer text-[13px] text-txt flex justify-between items-center"
            class:text-txt-bright={i === selectedIndex}
            style:background={i === selectedIndex ? 'var(--bg-selected)' : ''}
            style:border-left={i === selectedIndex ? '2px solid var(--accent)' : '2px solid transparent'}
            style:padding-left={i === selectedIndex ? '14px' : '16px'}
            style:padding-right="16px"
            style:transition="background 80ms, border-color 80ms, padding 80ms cubic-bezier(0.4,0,0.2,1)"
            role="option"
            tabindex="-1"
            aria-selected={i === selectedIndex}
            onmouseenter={() => { selectedIndex = i; }}
            onclick={() => executeCommand(cmd)}
            onkeydown={(e) => { if (e.key === "Enter") executeCommand(cmd); }}
          >
            <span>{cmd.name}</span>
            <span class="text-txt-dim text-[11px]" style="font-family: var(--ui-font);">{cmd.shortcut}</span>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}
