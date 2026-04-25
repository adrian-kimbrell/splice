<script lang="ts">
  import { marked } from "marked";
  import DOMPurify from "dompurify";

  let {
    content,
  }: {
    content: string;
  } = $props();

  let html = $state("");

  $effect(() => {
    html = DOMPurify.sanitize(marked.parse(content, { async: false }) as string);
  });
</script>

<div class="markdown-preview overflow-auto h-full p-6">
  {@html html}
</div>

<style>
  .markdown-preview {
    color: var(--text);
    font-family: var(--ui-font);
    font-size: 14px;
    line-height: 1.6;
  }
  .markdown-preview :global(h1) {
    font-size: 2em;
    font-weight: 600;
    margin: 0.67em 0;
    padding-bottom: 0.3em;
    border-bottom: 1px solid var(--border);
    color: var(--text-bright);
  }
  .markdown-preview :global(h2) {
    font-size: 1.5em;
    font-weight: 600;
    margin: 0.83em 0;
    padding-bottom: 0.3em;
    border-bottom: 1px solid var(--border);
    color: var(--text-bright);
  }
  .markdown-preview :global(h3) {
    font-size: 1.25em;
    font-weight: 600;
    margin: 1em 0;
    color: var(--text-bright);
  }
  .markdown-preview :global(h4),
  .markdown-preview :global(h5),
  .markdown-preview :global(h6) {
    font-weight: 600;
    margin: 1em 0;
    color: var(--text-bright);
  }
  .markdown-preview :global(p) {
    margin: 1em 0;
  }
  .markdown-preview :global(a) {
    color: var(--accent);
    text-decoration: none;
  }
  .markdown-preview :global(a:hover) {
    text-decoration: underline;
  }
  .markdown-preview :global(code) {
    background: var(--overlay-sm);
    padding: 2px 5px;
    border-radius: 3px;
    font-family: var(--font-family);
    font-size: 0.9em;
  }
  .markdown-preview :global(pre) {
    background: var(--overlay-xs);
    padding: 12px 16px;
    border-radius: 6px;
    overflow-x: auto;
    margin: 1em 0;
  }
  .markdown-preview :global(pre code) {
    background: none;
    padding: 0;
  }
  .markdown-preview :global(blockquote) {
    border-left: 3px solid var(--accent);
    padding-left: 12px;
    margin: 1em 0;
    color: var(--text-dim);
  }
  .markdown-preview :global(ul),
  .markdown-preview :global(ol) {
    padding-left: 2em;
    margin: 1em 0;
  }
  .markdown-preview :global(li) {
    margin: 0.3em 0;
  }
  .markdown-preview :global(hr) {
    border: none;
    border-top: 1px solid var(--border);
    margin: 2em 0;
  }
  .markdown-preview :global(table) {
    border-collapse: collapse;
    width: 100%;
    margin: 1em 0;
  }
  .markdown-preview :global(th),
  .markdown-preview :global(td) {
    border: 1px solid var(--border);
    padding: 6px 12px;
    text-align: left;
  }
  .markdown-preview :global(th) {
    background: var(--overlay-xs);
    font-weight: 600;
  }
  .markdown-preview :global(img) {
    max-width: 100%;
  }
</style>
