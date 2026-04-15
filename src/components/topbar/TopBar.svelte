<script lang="ts">
  let {
    workspaceName = "Splice",
    language = "",
    branch = "",
  }: {
    workspaceName?: string;
    language?: string;
    branch?: string;
  } = $props();
</script>

<div style="grid-row: 2; display: none;"></div>
