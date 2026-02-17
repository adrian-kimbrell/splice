<script lang="ts">
  let {
    workspaceName = "",
    language = "",
  }: {
    workspaceName?: string;
    language?: string;
  } = $props();
</script>

<div
  class="col-span-full bg-statusbar border-t border-border flex items-center px-3 text-[11px] text-txt-dim gap-4"
  style="grid-row: 3"
>
  {#if workspaceName}
    <span class="whitespace-nowrap"><i class="bi bi-folder2-open"></i> {workspaceName}</span>
  {/if}
  <span class="flex-1"></span>
  {#if language}
    <span class="whitespace-nowrap">{language}</span>
  {/if}
</div>
