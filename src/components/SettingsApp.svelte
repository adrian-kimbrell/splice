<script lang="ts">
  import { onMount } from "svelte";
  import SettingsPane from "./panes/SettingsPane.svelte";
  import { initSettings, settings } from "../lib/stores/settings.svelte";
  import { applyTheme } from "../lib/theme/themes";
  import type { Settings } from "../lib/stores/settings.svelte";

  onMount(async () => {
    await initSettings();
    applyTheme(settings.appearance.theme);

    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      const { listen } = await import("@tauri-apps/api/event");
      await listen<Settings>("settings-changed", (event) => {
        const updated = event.payload;
        if (updated.appearance) {
          Object.assign(settings.appearance, updated.appearance);
          applyTheme(settings.appearance.theme);
        }
        if (updated.general) Object.assign(settings.general, updated.general);
        if (updated.editor) Object.assign(settings.editor, updated.editor);
        if (updated.terminal) Object.assign(settings.terminal, updated.terminal);
      });
    }
  });

  // Keep theme in sync when changed from within the settings window itself
  $effect(() => {
    applyTheme(settings.appearance.theme);
  });
</script>

<div class="h-screen flex flex-col overflow-hidden bg-editor">
  <SettingsPane />
</div>
