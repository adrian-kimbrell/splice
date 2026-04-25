<script lang="ts">
  import { toasts, removeToast } from "../../lib/stores/toasts.svelte";
  import { fly } from "svelte/transition";
  import { cubicOut } from "svelte/easing";

  const iconMap: Record<string, string> = {
    info: "bi-info-circle",
    success: "bi-check-circle",
    error: "bi-exclamation-circle",
    warning: "bi-exclamation-triangle",
  };

  const accentMap: Record<string, string> = {
    info: "var(--accent)",
    success: "var(--ansi-green, #98c379)",
    error: "var(--ansi-red)",
    warning: "var(--ansi-yellow)",
  };
</script>

{#if toasts.length > 0}
  <div class="fixed bottom-12 right-4 z-[200] flex flex-col gap-2 pointer-events-none">
    {#each toasts as toast (toast.id)}
      <div
        in:fly={{ x: 20, duration: 200, easing: cubicOut }}
        out:fly={{ x: 20, duration: 150, easing: cubicOut }}
        class="toast pointer-events-auto toast-{toast.kind}"
        style:border-left="3px solid {accentMap[toast.kind] ?? 'var(--border)'}"
      >
        <i class="bi {iconMap[toast.kind]}"></i>
        <span class="toast-message">{toast.message}</span>
        {#if toast.action}
          <button class="toast-action" onclick={() => { toast.action?.onClick(); removeToast(toast.id); }}>
            {toast.action.label}
          </button>
        {/if}
        <button class="toast-dismiss" onclick={() => removeToast(toast.id)}>✕</button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .toast {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-radius: 6px;
    font-size: var(--ui-body);
    color: var(--text-bright);
    background: var(--bg-palette);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-lg);
    min-width: 200px;
    max-width: 420px;
    text-align: left;
    transition: background 120ms;
  }
  .toast:hover {
    background: var(--bg-hover);
  }
  .toast-message {
    flex: 1;
  }
  .toast-success i { color: var(--ansi-green, #98c379); }
  .toast-error i { color: var(--ansi-red); }
  .toast-warning i { color: var(--ansi-yellow); }
  .toast-info i { color: var(--accent); }

  .toast-action {
    margin-left: 4px;
    padding: 2px 10px;
    background: var(--accent, #00ff88);
    color: #000;
    border: none;
    border-radius: 3px;
    font-size: var(--ui-label);
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: opacity 120ms;
  }
  .toast-action:hover { opacity: 0.85; }

  .toast-dismiss {
    margin-left: 2px;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    opacity: 0.5;
    font-size: var(--ui-md);
    padding: 0 2px;
    line-height: 1;
    transition: opacity 120ms;
  }
  .toast-dismiss:hover { opacity: 1; }
</style>
