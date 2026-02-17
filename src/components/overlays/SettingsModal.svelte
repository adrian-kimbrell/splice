<script lang="ts">
  import { ui } from "../../lib/stores/ui.svelte";
  import { settings } from "../../lib/stores/settings.svelte";

  function close() {
    ui.settingsOpen = false;
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  const navItems = [
    { id: "editor" as const, icon: "bi-code-slash", label: "Editor" },
    {
      id: "appearance" as const,
      icon: "bi-palette",
      label: "Appearance",
    },
    { id: "terminal" as const, icon: "bi-terminal", label: "Terminal" },
  ];
</script>

{#if ui.settingsOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 bg-black/55 z-200 flex justify-center items-center backdrop-blur-sm"
    onclick={handleBackdropClick}
  >
    <div
      class="bg-sidebar border border-border rounded-lg w-[560px] max-h-[70vh] flex flex-col shadow-[0_16px_48px_rgba(0,0,0,0.6)] overflow-hidden"
    >
      <!-- Header -->
      <div
        class="flex items-center justify-between h-8 px-4 border-b border-border shrink-0"
      >
        <span class="text-[13px] font-semibold text-txt-bright">Settings</span>
        <button
          class="bg-transparent border-none text-txt-dim text-base cursor-pointer p-1 rounded flex items-center hover:text-txt-bright hover:bg-hover"
          onclick={close}
          aria-label="Close settings"
        >
          <i class="bi bi-x-lg"></i>
        </button>
      </div>

      <!-- Body -->
      <div class="flex flex-1 overflow-hidden">
        <!-- Nav -->
        <nav
          class="w-[140px] bg-editor border-r border-border py-2 shrink-0 flex flex-col gap-px"
        >
          {#each navItems as item (item.id)}
            <button
              class="flex items-center gap-2 px-3 py-1.5 text-xs text-left border-none bg-transparent cursor-pointer hover:bg-hover transition-colors w-full"
              class:text-txt-bright={ui.settingsPanel === item.id}
              class:bg-selected={ui.settingsPanel === item.id}
              class:text-txt-dim={ui.settingsPanel !== item.id}
              onclick={() => (ui.settingsPanel = item.id)}
            >
              <i class="bi {item.icon} text-[13px]"></i>{item.label}
            </button>
          {/each}
        </nav>

        <!-- Content -->
        <div class="flex-1 overflow-y-auto p-4">
          {#if ui.settingsPanel === "editor"}
            <div
              class="text-[10px] font-semibold uppercase tracking-wider text-txt-dim mb-2.5"
            >
              Editor
            </div>
            <div class="flex items-center justify-between py-1.5">
              <span class="text-xs text-txt">Font Family</span>
              <select
                bind:value={settings.editor.font_family}
                class="bg-input border border-border text-txt-bright text-xs px-2 py-1 rounded outline-none min-w-[120px] focus:border-accent"
              >
                <option>Menlo</option>
                <option>Consolas</option>
                <option>Fira Code</option>
                <option>JetBrains Mono</option>
                <option>SF Mono</option>
              </select>
            </div>
            <div class="flex items-center justify-between py-1.5">
              <span class="text-xs text-txt">Font Size</span>
              <input
                type="number"
                bind:value={settings.editor.font_size}
                min="8"
                max="24"
                class="bg-input border border-border text-txt-bright text-xs px-2 py-1 rounded outline-none w-[120px] focus:border-accent"
              />
            </div>
            <div class="flex items-center justify-between py-1.5">
              <span class="text-xs text-txt">Tab Size</span>
              <input
                type="number"
                bind:value={settings.editor.tab_size}
                min="1"
                max="8"
                class="bg-input border border-border text-txt-bright text-xs px-2 py-1 rounded outline-none w-[120px] focus:border-accent"
              />
            </div>
            <div class="flex items-center justify-between py-1.5">
              <span class="text-xs text-txt">Word Wrap</span>
              <label class="toggle"
                ><input
                  type="checkbox"
                  bind:checked={settings.editor.word_wrap}
                /><span class="track"></span></label
              >
            </div>
            <div class="flex items-center justify-between py-1.5">
              <span class="text-xs text-txt">Line Numbers</span>
              <label class="toggle"
                ><input
                  type="checkbox"
                  bind:checked={settings.editor.line_numbers}
                /><span class="track"></span></label
              >
            </div>
            <div class="flex items-center justify-between py-1.5">
              <span class="text-xs text-txt">Minimap</span>
              <label class="toggle"
                ><input
                  type="checkbox"
                  bind:checked={settings.editor.minimap}
                /><span class="track"></span></label
              >
            </div>
          {:else if ui.settingsPanel === "appearance"}
            <div
              class="text-[10px] font-semibold uppercase tracking-wider text-txt-dim mb-2.5"
            >
              Appearance
            </div>
            <div class="flex items-center justify-between py-1.5">
              <span class="text-xs text-txt">Theme</span>
              <select
                bind:value={settings.appearance.theme}
                class="bg-input border border-border text-txt-bright text-xs px-2 py-1 rounded outline-none min-w-[120px] focus:border-accent"
              >
                <option>One Dark</option>
                <option>Dracula</option>
                <option>Nord</option>
                <option>Solarized Dark</option>
                <option>GitHub Light</option>
              </select>
            </div>
            <div class="flex items-center justify-between py-1.5">
              <span class="text-xs text-txt">UI Scale</span>
              <select
                bind:value={settings.appearance.ui_scale}
                class="bg-input border border-border text-txt-bright text-xs px-2 py-1 rounded outline-none min-w-[120px] focus:border-accent"
              >
                <option value={90}>90%</option>
                <option value={100}>100%</option>
                <option value={110}>110%</option>
                <option value={120}>120%</option>
              </select>
            </div>
            <div class="flex items-center justify-between py-1.5">
              <span class="text-xs text-txt">Show Status Bar</span>
              <label class="toggle"
                ><input
                  type="checkbox"
                  bind:checked={settings.appearance.show_status_bar}
                /><span class="track"></span></label
              >
            </div>
          {:else if ui.settingsPanel === "terminal"}
            <div
              class="text-[10px] font-semibold uppercase tracking-wider text-txt-dim mb-2.5"
            >
              Terminal
            </div>
            <div class="flex items-center justify-between py-1.5">
              <span class="text-xs text-txt">Default Shell</span>
              <select
                bind:value={settings.terminal.default_shell}
                class="bg-input border border-border text-txt-bright text-xs px-2 py-1 rounded outline-none min-w-[120px] focus:border-accent"
              >
                <option>/bin/zsh</option>
                <option>/bin/bash</option>
                <option>/bin/fish</option>
              </select>
            </div>
            <div class="flex items-center justify-between py-1.5">
              <span class="text-xs text-txt">Font Size</span>
              <input
                type="number"
                bind:value={settings.terminal.font_size}
                min="8"
                max="24"
                class="bg-input border border-border text-txt-bright text-xs px-2 py-1 rounded outline-none w-[120px] focus:border-accent"
              />
            </div>
            <div class="flex items-center justify-between py-1.5">
              <span class="text-xs text-txt">Cursor Style</span>
              <select
                bind:value={settings.terminal.cursor_style}
                class="bg-input border border-border text-txt-bright text-xs px-2 py-1 rounded outline-none min-w-[120px] focus:border-accent"
              >
                <option>Block</option>
                <option>Underline</option>
                <option>Bar</option>
              </select>
            </div>
            <div class="flex items-center justify-between py-1.5">
              <span class="text-xs text-txt">Cursor Blink</span>
              <label class="toggle"
                ><input
                  type="checkbox"
                  bind:checked={settings.terminal.cursor_blink}
                /><span class="track"></span></label
              >
            </div>
            <div class="flex items-center justify-between py-1.5">
              <span class="text-xs text-txt">Scrollback Lines</span>
              <input
                type="number"
                bind:value={settings.terminal.scrollback_lines}
                min="100"
                max="100000"
                step="1000"
                class="bg-input border border-border text-txt-bright text-xs px-2 py-1 rounded outline-none w-[120px] focus:border-accent"
              />
            </div>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}
