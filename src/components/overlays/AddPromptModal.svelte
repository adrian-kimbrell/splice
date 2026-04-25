<script lang="ts">
  import { ui } from "../../lib/stores/ui.svelte";
  import { addSavedPrompt, savedPrompts, deleteSavedPrompt } from "../../lib/stores/prompts.svelte";

  let name = $state("");
  let text = $state("");
  let nameEl = $state<HTMLInputElement>();
  let view = $state<"list" | "add">("list");

  $effect(() => {
    if (ui.addPromptModal) {
      view = savedPrompts.length === 0 ? "add" : "list";
      name = "";
      text = "";
      setTimeout(() => nameEl?.focus(), 0);
    }
  });

  function close() {
    ui.addPromptModal = false;
    name = "";
    text = "";
  }

  function save() {
    if (!name.trim() || !text.trim()) return;
    addSavedPrompt(name, text);
    name = "";
    text = "";
    view = "list";
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
  }
</script>

{#if ui.addPromptModal}
  <!-- Backdrop -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center"
    style="background: rgba(0,0,0,0.5)"
    role="dialog"
    aria-modal="true"
    aria-label="Saved Prompts"
    tabindex="-1"
    onclick={(e) => { if (e.target === e.currentTarget) close(); }}
    onkeydown={handleKeyDown}
  >
    <div
      class="flex flex-col"
      style="background: var(--bg-palette); border: 1px solid var(--border); width: 480px; max-width: 90vw; max-height: 80vh;"
    >
      <!-- Header -->
      <div class="flex items-center justify-between px-4 py-3" style="border-bottom: 1px solid var(--border)">
        <span class="font-medium tracking-wide uppercase text-[10px]" style="color: var(--text-bright)">
          {view === "add" ? "New Prompt" : "Saved Prompts"}
        </span>
        <div class="flex items-center gap-2">
          {#if view === "list"}
            <button
              class="text-[10px] px-2 py-0.5 rounded transition-colors cursor-pointer"
              style="background: var(--accent); color: #000; font-weight: 500;"
              onclick={() => { view = "add"; setTimeout(() => nameEl?.focus(), 0); }}
            >
              + New
            </button>
          {/if}
          <button
            class="transition-colors cursor-pointer"
            style="color: var(--text-dim);"
            onclick={close}
            aria-label="Close"
          >
            <i class="bi bi-x text-base"></i>
          </button>
        </div>
      </div>

      {#if view === "list"}
        <!-- Saved prompts list -->
        {#if savedPrompts.length === 0}
          <div class="px-4 py-8 text-center text-[11px]" style="color: var(--text-dim)">
            No saved prompts yet. Click <strong>+ New</strong> to add one.
          </div>
        {:else}
          <div class="overflow-y-auto flex-1" style="max-height: 400px;">
            {#each savedPrompts as prompt (prompt.id)}
              <div
                class="flex items-start gap-3 px-4 py-3 group"
                style="border-bottom: 1px solid var(--border);"
              >
                <div class="flex-1 min-w-0">
                  <div class="text-[12px] font-medium mb-0.5" style="color: var(--text-bright)">{prompt.name}</div>
                  <div class="text-[11px] truncate" style="color: var(--text-dim)">{prompt.text}</div>
                </div>
                <button
                  class="opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer shrink-0 mt-0.5"
                  style="color: var(--text-dim);"
                  title="Delete"
                  onclick={() => deleteSavedPrompt(prompt.id)}
                >
                  <i class="bi bi-trash text-[11px]"></i>
                </button>
              </div>
            {/each}
          </div>
        {/if}
      {:else}
        <!-- Add prompt form -->
        <div class="px-4 py-4 flex flex-col gap-3">
          <div class="flex flex-col gap-1">
            <label for="prompt-name" class="text-[10px] uppercase tracking-wide" style="color: var(--text-dim)">Name</label>
            <input
              id="prompt-name"
              bind:this={nameEl}
              bind:value={name}
              class="px-3 py-1.5 text-[12px] outline-none rounded"
              style="background: var(--bg-input); border: 1px solid var(--border); color: var(--text-bright);"
              placeholder="e.g. Review this file"
              onkeydown={handleKeyDown}
            />
          </div>
          <div class="flex flex-col gap-1">
            <label for="prompt-text" class="text-[10px] uppercase tracking-wide" style="color: var(--text-dim)">Prompt</label>
            <textarea
              id="prompt-text"
              bind:value={text}
              class="px-3 py-1.5 text-[12px] outline-none resize-none rounded"
              style="background: var(--bg-input); border: 1px solid var(--border); color: var(--text-bright); min-height: 100px; line-height: 1.6;"
              placeholder="Enter the prompt text..."
              onkeydown={handleKeyDown}
              rows={4}
            ></textarea>
          </div>
        </div>

        <!-- Footer -->
        <div class="flex items-center justify-between px-4 py-3" style="border-top: 1px solid var(--border)">
          <div class="flex items-center gap-2">
            {#if savedPrompts.length > 0}
              <button
                class="text-[11px] cursor-pointer transition-colors"
                style="color: var(--text-dim);"
                onclick={() => { view = "list"; }}
              >
                ← Back
              </button>
            {/if}
            <span class="text-[10px]" style="color: var(--text-dim)">⌘↵ to save · Esc to cancel</span>
          </div>
          <button
            class="px-4 py-1.5 text-[11px] font-medium rounded transition-colors cursor-pointer"
            style={name.trim() && text.trim()
              ? "background: var(--accent); color: #000;"
              : "background: var(--bg-input); color: var(--text-dim); cursor: default;"}
            disabled={!name.trim() || !text.trim()}
            onclick={save}
          >
            Save
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}
