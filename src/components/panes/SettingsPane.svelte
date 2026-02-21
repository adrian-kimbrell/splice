<script lang="ts">
  import { settings, debouncedSaveSettings } from "../../lib/stores/settings.svelte";
  import { themes } from "../../lib/theme/themes";
  import { onMount } from "svelte";

  // --- Data-driven settings definitions ---

  type SettingControl =
    | { type: "toggle" }
    | { type: "number"; min: number; max: number; step?: number }
    | { type: "select"; options: (string | { label: string; value: string | number })[] };

  interface SettingDef {
    key: string;
    category: string;
    title: string;
    description: string;
    control: SettingControl;
  }

  const categories = ["General", "Appearance", "Editor", "Terminal", "Keymap"];

  const settingDefs: SettingDef[] = [
    // General
    { key: "general.auto_save", category: "General", title: "Auto Save", description: "Controls whether files are saved automatically.", control: { type: "select", options: [{ label: "Off", value: "off" }, { label: "On Focus Change", value: "onFocusChange" }, { label: "After Delay", value: "afterDelay" }] } },
    { key: "general.auto_save_delay", category: "General", title: "Auto Save Delay", description: "Delay in milliseconds before auto-saving after a change.", control: { type: "number", min: 100, max: 10000, step: 100 } },
    { key: "general.restore_previous_session", category: "General", title: "Restore Previous Session", description: "Reopen the previous workspace on startup.", control: { type: "toggle" } },

    // Appearance
    { key: "appearance.theme", category: "Appearance", title: "Theme", description: "The color theme for the editor and UI.", control: { type: "select", options: Object.keys(themes) } },
    { key: "appearance.ui_scale", category: "Appearance", title: "UI Scale", description: "Zoom level for the entire interface.", control: { type: "select", options: Array.from({ length: 16 }, (_, i) => { const v = 50 + i * 10; return { label: `${v}%`, value: v }; }) } },
    { key: "appearance.explorer_side", category: "Appearance", title: "Explorer Side", description: "Which side the file explorer appears on. Workspaces panel moves to the opposite side.", control: { type: "select", options: [{ label: "Left", value: "left" }, { label: "Right", value: "right" }] } },
    { key: "appearance.show_status_bar", category: "Appearance", title: "Show Status Bar", description: "Show or hide the bottom status bar.", control: { type: "toggle" } },

    // Editor
    { key: "editor.font_family", category: "Editor", title: "Font Family", description: "The font used in the code editor.", control: { type: "select", options: ["Menlo", "Consolas", "Fira Code", "JetBrains Mono", "SF Mono"] } },
    { key: "editor.font_size", category: "Editor", title: "Font Size", description: "Font size in pixels for the editor.", control: { type: "number", min: 8, max: 24 } },
    { key: "editor.tab_size", category: "Editor", title: "Tab Size", description: "Number of spaces per indentation level.", control: { type: "number", min: 1, max: 8 } },
    { key: "editor.insert_spaces", category: "Editor", title: "Insert Spaces", description: "Use spaces instead of tabs for indentation.", control: { type: "toggle" } },
    { key: "editor.word_wrap", category: "Editor", title: "Word Wrap", description: "Wrap long lines to fit the editor width.", control: { type: "toggle" } },
    { key: "editor.line_numbers", category: "Editor", title: "Line Numbers", description: "Show line numbers in the gutter.", control: { type: "toggle" } },
    { key: "editor.minimap", category: "Editor", title: "Minimap", description: "Show a minimap overview of the file.", control: { type: "toggle" } },
    { key: "editor.bracket_matching", category: "Editor", title: "Bracket Matching", description: "Highlight matching brackets when the cursor is near one.", control: { type: "toggle" } },
    { key: "editor.auto_close_brackets", category: "Editor", title: "Auto Close Brackets", description: "Automatically insert closing brackets, quotes, etc.", control: { type: "toggle" } },
    { key: "editor.highlight_active_line", category: "Editor", title: "Highlight Active Line", description: "Highlight the line where the cursor is positioned.", control: { type: "toggle" } },
    { key: "editor.scroll_past_end", category: "Editor", title: "Scroll Past End", description: "Allow scrolling beyond the last line of the file.", control: { type: "toggle" } },

    // Terminal
    { key: "terminal.default_shell", category: "Terminal", title: "Default Shell", description: "The shell to use when opening new terminals.", control: { type: "select", options: ["/bin/zsh", "/bin/bash", "/bin/fish"] } },
    { key: "terminal.font_family", category: "Terminal", title: "Font Family", description: "The font used in the terminal.", control: { type: "select", options: ["Menlo", "Consolas", "Fira Code", "JetBrains Mono", "SF Mono"] } },
    { key: "terminal.font_size", category: "Terminal", title: "Font Size", description: "Font size in pixels for the terminal.", control: { type: "number", min: 8, max: 24 } },
    { key: "terminal.cursor_style", category: "Terminal", title: "Cursor Style", description: "The shape of the terminal cursor.", control: { type: "select", options: ["Block", "Underline", "Bar"] } },
    { key: "terminal.cursor_blink", category: "Terminal", title: "Cursor Blink", description: "Whether the terminal cursor blinks.", control: { type: "toggle" } },
    { key: "terminal.scrollback_lines", category: "Terminal", title: "Scrollback Lines", description: "Number of lines to keep in the scrollback buffer.", control: { type: "number", min: 100, max: 100000, step: 1000 } },
    { key: "terminal.copy_on_select", category: "Terminal", title: "Copy on Select", description: "Automatically copy text when selected in the terminal.", control: { type: "toggle" } },
  ];

  const keybindings = [
    { keys: "Cmd N", action: "New File" },
    { keys: "Cmd O", action: "Open Folder" },
    { keys: "Cmd K", action: "Command Palette" },
    { keys: "Cmd ,", action: "Open Settings" },
    { keys: "Cmd B", action: "Toggle Explorer" },
    { keys: "Cmd Z", action: "Toggle Pane Zoom" },
    { keys: "Cmd 1-9", action: "Switch to Pane" },
    { keys: "Cmd Alt Arrow", action: "Navigate Panes" },
    { keys: "Cmd Alt Shift Arrow", action: "Switch Workspace" },
    { keys: "Cmd =", action: "Zoom In" },
    { keys: "Cmd -", action: "Zoom Out" },
    { keys: "Cmd 0", action: "Reset Zoom" },
    { keys: "Escape", action: "Close Overlay / Unzoom" },
  ];

  // --- Search ---
  let searchQuery = $state("");

  const filteredDefs = $derived(
    searchQuery.trim() === ""
      ? settingDefs
      : settingDefs.filter(
          (d) =>
            d.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
            d.description.toLowerCase().includes(searchQuery.toLowerCase()),
        ),
  );

  const visibleCategories = $derived(
    categories.filter((cat) =>
      cat === "Keymap"
        ? searchQuery.trim() === "" || "keymap keyboard shortcuts bindings".includes(searchQuery.toLowerCase())
        : filteredDefs.some((d) => d.category === cat),
    ),
  );

  // --- Category nav + scroll spy ---
  let activeCategory = $state("General");
  let contentEl: HTMLElement | undefined = $state();
  let sectionEls: Record<string, HTMLElement> = {};

  function scrollToCategory(cat: string) {
    activeCategory = cat;
    const el = sectionEls[cat];
    if (el && contentEl) {
      contentEl.scrollTo({ top: el.offsetTop - contentEl.offsetTop, behavior: "smooth" });
    }
  }

  function handleContentScroll() {
    if (!contentEl) return;
    const scrollTop = contentEl.scrollTop + contentEl.offsetTop + 40;
    for (let i = visibleCategories.length - 1; i >= 0; i--) {
      const cat = visibleCategories[i];
      const el = sectionEls[cat];
      if (el && el.offsetTop <= scrollTop) {
        activeCategory = cat;
        return;
      }
    }
    if (visibleCategories.length > 0) activeCategory = visibleCategories[0];
  }

  // --- Custom dropdown ---
  let openDropdownKey = $state<string | null>(null);

  function toggleDropdown(key: string) {
    openDropdownKey = openDropdownKey === key ? null : key;
  }

  function closeDropdown() {
    openDropdownKey = null;
  }

  function getOptionLabel(opt: string | { label: string; value: string | number }): string {
    return typeof opt === "string" ? opt : opt.label;
  }

  function getOptionValue(opt: string | { label: string; value: string | number }): string | number {
    return typeof opt === "string" ? opt : opt.value;
  }

  function getDisplayLabel(def: SettingDef): string {
    if (def.control.type !== "select") return "";
    const currentVal = getValue(def.key);
    const match = def.control.options.find((o) => getOptionValue(o) === currentVal);
    return match ? getOptionLabel(match) : String(currentVal);
  }

  // Close dropdown on outside click
  onMount(() => {
    function onClickOutside(e: MouseEvent) {
      if (openDropdownKey === null) return;
      const target = e.target as HTMLElement;
      if (!target.closest(".custom-select")) closeDropdown();
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  });

  // --- Dynamic property access ---
  function getValue(key: string): any {
    const [cat, field] = key.split(".");
    return (settings as any)[cat]?.[field];
  }

  function setValue(key: string, value: any): void {
    const [cat, field] = key.split(".");
    (settings as any)[cat][field] = value;
    emitSettingsChanged();
  }

  // Auto-save settings on any change
  $effect(() => {
    JSON.stringify(settings);
    debouncedSaveSettings();
  });

  // --- Cross-window settings sync ---
  async function emitSettingsChanged(): Promise<void> {
    const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    if (!isTauri) return;
    try {
      const { emit } = await import("@tauri-apps/api/event");
      await emit("settings-changed", JSON.parse(JSON.stringify(settings)));
    } catch (_) {}
  }
</script>

<div class="flex flex-col overflow-hidden bg-editor flex-1 min-w-0 min-h-0">
  <div class="flex flex-1 overflow-hidden min-w-0">
    <!-- Left nav -->
    <nav class="w-[160px] bg-sidebar border-r border-border py-2 shrink-0 flex flex-col gap-0.5 overflow-y-auto overflow-x-hidden">
      <div class="px-2 pb-2">
        <div class="relative">
          <i class="bi bi-search absolute left-2 top-1/2 -translate-y-1/2 text-txt-dim text-[10px]"></i>
          <input
            type="text"
            placeholder="Search..."
            bind:value={searchQuery}
            class="w-full bg-input border border-border text-txt text-xs pl-6 pr-2 py-1 rounded outline-none focus:border-accent"
          />
        </div>
      </div>

      {#each categories as cat}
        {@const isVisible = visibleCategories.includes(cat)}
        <button
          class="flex items-center gap-2 px-3 py-1.5 text-xs text-left border-none bg-transparent cursor-pointer transition-colors w-full"
          class:text-txt-bright={activeCategory === cat && isVisible}
          class:bg-selected={activeCategory === cat && isVisible}
          class:text-txt-dim={activeCategory !== cat || !isVisible}
          class:opacity-30={!isVisible}
          disabled={!isVisible}
          onclick={() => scrollToCategory(cat)}
        >
          {#if cat === "General"}<i class="bi bi-sliders text-[12px]"></i>
          {:else if cat === "Appearance"}<i class="bi bi-palette text-[12px]"></i>
          {:else if cat === "Editor"}<i class="bi bi-code-slash text-[12px]"></i>
          {:else if cat === "Terminal"}<i class="bi bi-terminal text-[12px]"></i>
          {:else if cat === "Keymap"}<i class="bi bi-keyboard text-[12px]"></i>
          {/if}
          {cat}
        </button>
      {/each}
    </nav>

    <!-- Right content -->
    <div
      class="flex-1 overflow-y-auto overflow-x-hidden py-5 pl-5 pr-6 min-w-0"
      bind:this={contentEl}
      onscroll={handleContentScroll}
    >
      {#each visibleCategories as cat}
        <div bind:this={sectionEls[cat]} class="mb-6">
          <div class="text-[11px] font-semibold uppercase tracking-wider text-txt-dim mb-3 pb-1 border-b border-border">
            {cat}
          </div>

          {#if cat === "Keymap"}
            <div class="flex flex-col gap-0">
              {#each keybindings as kb}
                <div class="flex items-center justify-between py-1.5">
                  <span class="text-xs text-txt">{kb.action}</span>
                  <kbd class="bg-input border border-border text-txt-dim text-[11px] px-2 py-0.5 rounded font-mono">{kb.keys}</kbd>
                </div>
              {/each}
            </div>
          {:else}
            {#each filteredDefs.filter((d) => d.category === cat) as def (def.key)}
              <div class="flex items-start justify-between py-2 gap-4">
                <div class="flex-1 min-w-0">
                  <div class="text-xs text-txt-bright">{def.title}</div>
                  <div class="text-[11px] text-txt-dim mt-0.5 leading-tight">{def.description}</div>
                </div>
                <div class="shrink-0">
                  {#if def.control.type === "toggle"}
                    <label class="toggle">
                      <input
                        type="checkbox"
                        checked={getValue(def.key)}
                        onchange={(e) => setValue(def.key, e.currentTarget.checked)}
                      />
                      <span class="track"></span>
                    </label>
                  {:else if def.control.type === "number"}
                    <input
                      type="number"
                      value={getValue(def.key)}
                      min={def.control.min}
                      max={def.control.max}
                      step={def.control.step ?? 1}
                      oninput={(e) => setValue(def.key, Number(e.currentTarget.value))}
                      class="settings-number"
                    />
                  {:else if def.control.type === "select"}
                    <div class="custom-select relative">
                      <button
                        class="settings-select-trigger"
                        onclick={() => toggleDropdown(def.key)}
                      >
                        <span class="truncate">{getDisplayLabel(def)}</span>
                        <i class="bi bi-chevron-down text-[9px] text-txt-dim ml-1 transition-transform" class:rotate-180={openDropdownKey === def.key}></i>
                      </button>
                      {#if openDropdownKey === def.key}
                        <div class="settings-select-menu">
                          {#each def.control.options as opt}
                            {@const val = getOptionValue(opt)}
                            {@const label = getOptionLabel(opt)}
                            {@const isActive = getValue(def.key) === val}
                            <button
                              class="settings-select-option"
                              class:active={isActive}
                              onclick={() => { setValue(def.key, val); closeDropdown(); }}
                            >
                              {label}
                              {#if isActive}
                                <i class="bi bi-check2 text-accent text-[11px] ml-auto"></i>
                              {/if}
                            </button>
                          {/each}
                        </div>
                      {/if}
                    </div>
                  {/if}
                </div>
              </div>
            {/each}
          {/if}
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .settings-number {
    background: var(--bg-input);
    border: 1px solid var(--border);
    color: var(--text-bright);
    font-size: 12px;
    padding: 4px 8px;
    border-radius: 4px;
    outline: none;
    width: 100px;
    color-scheme: dark;
  }
  .settings-number:focus {
    border-color: var(--accent);
  }

  .settings-select-trigger {
    display: flex;
    align-items: center;
    gap: 2px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    color: var(--text-bright);
    font-size: 12px;
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    min-width: 130px;
    text-align: left;
    transition: border-color 100ms;
  }
  .settings-select-trigger:hover {
    border-color: var(--text-dim);
  }

  .settings-select-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    min-width: 100%;
    max-height: 240px;
    overflow-y: auto;
    background: var(--bg-sidebar);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 0;
    z-index: 50;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }

  .settings-select-option {
    display: flex;
    align-items: center;
    width: 100%;
    padding: 5px 10px;
    border: none;
    background: transparent;
    color: var(--text);
    font-size: 12px;
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
  }
  .settings-select-option:hover {
    background: var(--bg-hover);
    color: var(--text-bright);
  }
  .settings-select-option.active {
    color: var(--text-bright);
  }
</style>
