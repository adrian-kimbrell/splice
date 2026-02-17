<script lang="ts">
  import { ui } from "../../lib/stores/ui.svelte";

  const COMMANDS = [
    { name: "Open File…", shortcut: "⌘P" },
    { name: "Toggle Sidebar", shortcut: "⌘B" },
    { name: "New Terminal", shortcut: "⌘`" },
    { name: "Split Editor Right", shortcut: "⌘\\" },
    { name: "Find in Files", shortcut: "⇧⌘F" },
    { name: "Go to Line…", shortcut: "⌘G" },
    { name: "Change Language Mode", shortcut: "" },
    { name: "Preferences: Open Settings", shortcut: "⌘," },
    { name: "Git: Commit", shortcut: "" },
    { name: "View: Toggle Terminal", shortcut: "⌘J" },
    { name: "Format Document", shortcut: "⇧⌥F" },
    { name: "Rename Symbol", shortcut: "F2" },
  ];

  let filter = $state("");
  let inputEl = $state<HTMLInputElement>();

  const filtered = $derived(
    COMMANDS.filter((c) =>
      c.name.toLowerCase().includes(filter.toLowerCase()),
    ),
  );

  function close() {
    ui.commandPaletteOpen = false;
    filter = "";
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  $effect(() => {
    if (ui.commandPaletteOpen && inputEl) {
      inputEl.focus();
    }
  });
</script>

{#if ui.commandPaletteOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 bg-black/50 z-100 flex justify-center pt-[15vh]"
    onclick={handleBackdropClick}
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
      />
      <div class="overflow-y-auto flex-1">
        {#each filtered as cmd (cmd.name)}
          <div
            class="px-4 py-2 cursor-pointer text-[13px] text-txt flex justify-between hover:bg-selected hover:text-txt-bright"
          >
            <span>{cmd.name}</span>
            <span class="text-txt-dim text-[11px]">{cmd.shortcut}</span>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}
