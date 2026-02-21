<script lang="ts">
  import { onMount } from "svelte";
  import SettingsPane from "./panes/SettingsPane.svelte";
  import { initSettings } from "../lib/stores/settings.svelte";

  onMount(() => {
    initSettings();
  });
</script>

<div class="h-screen flex flex-col overflow-hidden bg-editor">
  <SettingsPane />
</div>
