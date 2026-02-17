<script lang="ts">
  import FileTreeItem from "./FileTreeItem.svelte";
  import type { FileEntry } from "../../lib/stores/files.svelte";

  let {
    entries,
    onFileClick,
    selectedPath,
  }: {
    entries: FileEntry[];
    onFileClick: (entry: FileEntry) => void;
    selectedPath: string | null;
  } = $props();
</script>

<div class="py-1.5">
  {#each entries as entry (entry.name)}
    <FileTreeItem {entry} {onFileClick} {selectedPath} />
  {/each}
</div>
