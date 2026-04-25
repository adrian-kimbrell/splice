<script lang="ts">
  import { settings, debouncedSaveSettings } from "../../lib/stores/settings.svelte";
  import { themeNames } from "../../lib/theme/themes";
  import { customThemeMap, loadCustomThemes, registerCustomTheme, unregisterCustomTheme } from "../../lib/theme/custom-themes.svelte";
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

  const allThemeNames = $derived([...themeNames, ...Object.keys(customThemeMap)]);

  const categoryIcons: Record<string, string> = {
    General: "bi-sliders",
    Appearance: "bi-palette",
    Editor: "bi-code-slash",
    Terminal: "bi-terminal",
    Keymap: "bi-keyboard",
  };

  const settingDefs: SettingDef[] = [
    // General
    { key: "general.auto_save", category: "General", title: "Auto Save", description: "Controls whether files are saved automatically.", control: { type: "select", options: [{ label: "Off", value: "off" }, { label: "On Focus Change", value: "onFocusChange" }, { label: "After Delay", value: "afterDelay" }] } },
    { key: "general.auto_save_delay", category: "General", title: "Auto Save Delay", description: "Delay in milliseconds before auto-saving after a change.", control: { type: "number", min: 100, max: 10000, step: 100 } },
    { key: "general.restore_previous_session", category: "General", title: "Restore Previous Session", description: "Reopen the previous workspace on startup.", control: { type: "toggle" } },
    { key: "general.claude_notifications", category: "General", title: "Claude Notifications", description: "Send a macOS notification when Claude is waiting for input and Splice is in the background.", control: { type: "toggle" } },

    // Appearance
    { key: "appearance.theme", category: "Appearance", title: "Theme", description: "The color theme for the editor and UI.", control: { type: "select", options: themeNames } },
    { key: "appearance.ui_scale", category: "Appearance", title: "UI Scale", description: "Zoom level for the entire interface.", control: { type: "select", options: Array.from({ length: 13 }, (_, i) => { const v = 80 + i * 10; return { label: `${v}%`, value: v }; }) } },
    { key: "appearance.explorer_side", category: "Appearance", title: "Explorer Side", description: "Which side the file explorer appears on.", control: { type: "select", options: [{ label: "Left", value: "left" }, { label: "Right", value: "right" }] } },
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
    { keys: "⌘ N", action: "New File" },
    { keys: "⌘ O", action: "Open Folder" },
    { keys: "⌘ P", action: "Command Palette" },
    { keys: "⌘ B", action: "Toggle Explorer" },
    { keys: "⌘ ,", action: "Open Settings" },
    { keys: "⌘ Z", action: "Toggle Pane Zoom" },
    { keys: "⌘ 1–9", action: "Switch to Pane" },
    { keys: "⌘ ⌥ ↑↓←→", action: "Navigate Panes" },
    { keys: "⌘ ⌥ ⇧ ↑↓", action: "Switch Workspace" },
    { keys: "⌘ =", action: "Zoom In" },
    { keys: "⌘ –", action: "Zoom Out" },
    { keys: "⌘ 0", action: "Reset Zoom" },
    { keys: "Esc", action: "Close Overlay / Unzoom" },
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

  // --- Theme import/delete handlers ---
  async function handleImportTheme() {
    const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    if (!isTauri) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const filePath = await open({
        filters: [{ name: "Theme", extensions: ["json"] }],
        multiple: false,
      });
      if (!filePath) return;
      const { importTheme } = await import("../../lib/ipc/commands");
      const { applyTheme } = await import("../../lib/theme/themes");
      const theme = await importTheme(filePath as string);
      registerCustomTheme(theme.name, theme.colors as any);
      setValue("appearance.theme", theme.name);
      await applyTheme(theme.name);
    } catch (e: any) {
      console.error("Import failed:", e);
      alert("Failed to import theme: " + (e?.message ?? e));
    }
  }

  async function handleDeleteCustomTheme(name: string) {
    try {
      const { deleteCustomTheme } = await import("../../lib/ipc/commands");
      await deleteCustomTheme(name);
      unregisterCustomTheme(name);
      // If this was the active theme, switch to default
      if (getValue("appearance.theme") === name) {
        const { applyTheme } = await import("../../lib/theme/themes");
        setValue("appearance.theme", "Splice Default");
        await applyTheme("Splice Default");
      }
    } catch (e) {
      console.error("Failed to delete custom theme:", e);
    }
  }

  onMount(() => {
    loadCustomThemes();
  });
</script>

<div class="settings-root">
  <!-- Sidebar nav -->
  <aside class="settings-nav">
    <div class="settings-search-wrap">
      <i class="bi bi-search settings-search-icon"></i>
      <input
        type="text"
        placeholder="Search settings…"
        bind:value={searchQuery}
        class="settings-search"
      />
    </div>

    <nav class="settings-nav-list">
      {#each categories as cat}
        {@const isVisible = visibleCategories.includes(cat)}
        <button
          class="settings-nav-item"
          class:active={activeCategory === cat && isVisible}
          class:dimmed={!isVisible}
          disabled={!isVisible}
          onclick={() => scrollToCategory(cat)}
        >
          <i class="bi {categoryIcons[cat]} settings-nav-icon"></i>
          <span>{cat}</span>
        </button>
      {/each}
    </nav>
  </aside>

  <!-- Content -->
  <main
    class="settings-content"
    bind:this={contentEl}
    onscroll={handleContentScroll}
  >
    {#each visibleCategories as cat}
      <section bind:this={sectionEls[cat]} class="settings-section">
        <h2 class="settings-section-title">
          <i class="bi {categoryIcons[cat]}"></i>
          {cat}
        </h2>

        {#if cat === "Keymap"}
          <div class="keymap-grid">
            {#each keybindings as kb}
              <div class="keymap-row">
                <span class="keymap-action">{kb.action}</span>
                <kbd class="keymap-kbd">{kb.keys}</kbd>
              </div>
            {/each}
          </div>
        {:else}
          <div class="settings-rows">
            {#each filteredDefs.filter((d) => d.category === cat) as def, i (def.key)}
              {@const isLast = i === filteredDefs.filter((d) => d.category === cat).length - 1}
              <div class="setting-row" class:no-border={isLast}>
                <div class="setting-label">
                  <span class="setting-title">{def.title}</span>
                  <span class="setting-desc">{def.description}</span>
                </div>
                <div class="setting-control">
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
                        <span class="truncate">{def.key === "appearance.theme" ? String(getValue(def.key)) : getDisplayLabel(def)}</span>
                        <i class="bi bi-chevron-down chevron" class:open={openDropdownKey === def.key}></i>
                      </button>
                      {#if openDropdownKey === def.key}
                        <div class="settings-select-menu">
                          {#if def.key === "appearance.theme"}
                            {#each allThemeNames as opt}
                              {@const isActive = getValue(def.key) === opt}
                              <button
                                class="settings-select-option"
                                class:active={isActive}
                                onclick={() => { setValue(def.key, opt); import("../../lib/theme/themes").then(({ applyTheme }) => applyTheme(opt)); closeDropdown(); }}
                              >
                                <span>{opt}</span>
                                {#if isActive}
                                  <i class="bi bi-check2 check-icon"></i>
                                {/if}
                              </button>
                            {/each}
                          {:else}
                            {#each def.control.options as opt}
                              {@const val = getOptionValue(opt)}
                              {@const label = getOptionLabel(opt)}
                              {@const isActive = getValue(def.key) === val}
                              <button
                                class="settings-select-option"
                                class:active={isActive}
                                onclick={() => setValue(def.key, val)}
                              >
                                <span>{label}</span>
                                {#if isActive}
                                  <i class="bi bi-check2 check-icon"></i>
                                {/if}
                              </button>
                            {/each}
                          {/if}
                        </div>
                      {/if}
                    </div>
                  {/if}
                </div>
              </div>
              {#if def.key === "appearance.theme"}
                <div class="import-theme-row">
                  <button class="import-theme-btn" onclick={handleImportTheme}>
                    <i class="bi bi-upload"></i>
                    Import Theme
                  </button>
                  {#if Object.keys(customThemeMap).length > 0}
                    <div class="custom-theme-chips">
                      {#each Object.keys(customThemeMap) as cname}
                        <span class="custom-theme-chip">
                          {cname}
                          <button class="chip-delete" onclick={() => handleDeleteCustomTheme(cname)} title="Remove theme">×</button>
                        </span>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}
            {/each}
          </div>
        {/if}
      </section>
    {/each}
  </main>
</div>

<style>
  .settings-root {
    display: flex;
    height: 100%;
    overflow: hidden;
    background: var(--bg-editor);
  }

  /* ── Sidebar ── */
  .settings-nav {
    width: 185px;
    flex-shrink: 0;
    background: var(--bg-sidebar);
    display: flex;
    flex-direction: column;
    padding: 16px 8px 16px;
    gap: 4px;
    overflow-y: auto;
    border-right: 1px solid var(--border);
  }

  .settings-search-wrap {
    position: relative;
    margin-bottom: 8px;
  }

  .settings-search-icon {
    position: absolute;
    left: 9px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--text-dim);
    font-size: 11px;
    pointer-events: none;
  }

  .settings-search {
    width: 100%;
    background: var(--bg-input);
    border: 1px solid var(--border);
    color: var(--text);
    font-size: 12px;
    padding: 6px 8px 6px 28px;
    border-radius: 6px;
    outline: none;
    box-sizing: border-box;
    transition: border-color 100ms;
  }
  .settings-search:focus {
    border-color: var(--accent);
  }
  .settings-search::placeholder {
    color: var(--text-dim);
  }

  .settings-nav-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .settings-nav-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 10px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-dim);
    font-size: 13px;
    cursor: pointer;
    text-align: left;
    transition: background 80ms, color 80ms;
  }
  .settings-nav-item:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text);
  }
  .settings-nav-item.active {
    background: var(--bg-selected);
    color: var(--text-bright);
  }
  .settings-nav-item.dimmed {
    opacity: 0.3;
    cursor: default;
  }

  .settings-nav-icon {
    font-size: 13px;
    flex-shrink: 0;
  }

  /* ── Content ── */
  .settings-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 24px 32px;
    min-width: 0;
  }

  .settings-section {
    margin-bottom: 40px;
  }

  .settings-section-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-bright);
    margin: 0 0 16px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
  }

  /* ── Rows ── */
  .settings-rows {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: 8px;
  }

  .setting-row:first-child {
    border-radius: 8px 8px 0 0;
  }
  .setting-row:last-child {
    border-radius: 0 0 8px 8px;
  }
  .setting-row:only-child {
    border-radius: 8px;
  }

  .setting-row {
    display: flex;
    align-items: center;
    gap: 24px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-sidebar);
    transition: background 80ms;
  }
  .setting-row:hover {
    background: color-mix(in srgb, var(--bg-hover) 60%, var(--bg-sidebar));
  }
  .setting-row.no-border {
    border-bottom: none;
  }

  .setting-label {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .setting-title {
    font-size: 13px;
    color: var(--text-bright);
    line-height: 1.3;
  }

  .setting-desc {
    font-size: 11px;
    color: var(--text-dim);
    line-height: 1.4;
  }

  .setting-control {
    flex-shrink: 0;
  }

  /* ── Number input ── */
  .settings-number {
    background: var(--bg-input);
    border: 1px solid var(--border);
    color: var(--text-bright);
    font-size: 13px;
    padding: 5px 8px;
    border-radius: 6px;
    outline: none;
    width: 86px;
    text-align: center;
    color-scheme: dark;
    transition: border-color 100ms;
  }
  .settings-number:focus {
    border-color: var(--accent);
  }

  /* ── Select ── */
  .settings-select-trigger {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    color: var(--text-bright);
    font-size: 13px;
    padding: 7px 12px;
    border-radius: 6px;
    cursor: pointer;
    min-width: 180px;
    text-align: left;
    transition: border-color 100ms;
  }
  .settings-select-trigger:hover {
    border-color: var(--text-dim);
  }

  .chevron {
    font-size: 9px;
    color: var(--text-dim);
    flex-shrink: 0;
    transition: transform 150ms;
  }
  .chevron.open {
    transform: rotate(180deg);
  }

  .settings-select-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    min-width: 100%;
    max-height: 480px;
    overflow-y: auto;
    background: var(--bg-sidebar);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 4px;
    z-index: 50;
    box-shadow: var(--shadow-lg);
  }

  .settings-select-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 8px 12px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--text);
    font-size: 13px;
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
    transition: background 60ms;
  }
  .settings-select-option:hover {
    background: var(--bg-hover);
    color: var(--text-bright);
  }
  .settings-select-option.active {
    color: var(--text-bright);
  }

  .check-icon {
    color: var(--accent);
    font-size: 12px;
    flex-shrink: 0;
  }

  /* ── Keymap ── */
  .keymap-grid {
    border: 1px solid var(--border);
    border-radius: 8px;
  }

  .keymap-row:first-child {
    border-radius: 8px 8px 0 0;
  }
  .keymap-row:last-child {
    border-radius: 0 0 8px 8px;
  }

  .keymap-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-sidebar);
    gap: 16px;
  }
  .keymap-row:last-child {
    border-bottom: none;
  }

  .keymap-action {
    font-size: 13px;
    color: var(--text-bright);
  }

  .keymap-kbd {
    font-size: 11px;
    font-family: var(--font-family, monospace);
    color: var(--text-dim);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 3px 8px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .import-theme-row {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 6px 16px 10px;
  }

  .import-theme-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-dim);
    font-size: var(--ui-body);
    cursor: pointer;
    font-family: var(--ui-font);
    width: fit-content;
  }

  .import-theme-btn:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .custom-theme-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .custom-theme-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px 2px 10px;
    background: var(--bg-tab);
    border: 1px solid var(--border);
    border-radius: 100px;
    font-size: var(--ui-label);
    color: var(--text-dim);
  }

  .chip-delete {
    background: none;
    border: none;
    color: var(--text-dim);
    cursor: pointer;
    padding: 0 2px;
    font-size: 13px;
    line-height: 1;
    display: flex;
    align-items: center;
  }

  .chip-delete:hover {
    color: var(--ansi-red);
  }
</style>
