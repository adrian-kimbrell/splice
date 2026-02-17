<script lang="ts">
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
</script>

<div class="flex flex-col overflow-hidden min-w-0 min-h-0" style="flex: 1">
  {@render children()}
</div>
