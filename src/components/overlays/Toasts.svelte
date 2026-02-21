<script lang="ts">
  import { toasts, removeToast } from "../../lib/stores/toasts.svelte";

  const iconMap: Record<string, string> = {
    info: "bi-info-circle",
    success: "bi-check-circle",
    error: "bi-exclamation-circle",
    warning: "bi-exclamation-triangle",
  };
</script>

{#if toasts.length > 0}
  <div class="fixed bottom-12 right-4 z-[200] flex flex-col gap-2 pointer-events-none">
    {#each toasts as toast (toast.id)}
      <button
        class="toast pointer-events-auto toast-{toast.kind}"
        onclick={() => removeToast(toast.id)}
      >
        <i class="bi {iconMap[toast.kind]}"></i>
        <span>{toast.message}</span>
      </button>
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
    font-size: 12px;
    color: var(--text-bright);
    background: var(--bg-palette);
    border: 1px solid var(--border);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    cursor: pointer;
    animation: toast-in 200ms ease-out;
    min-width: 200px;
    max-width: 400px;
    text-align: left;
  }
  .toast:hover {
    background: var(--bg-hover);
  }
  .toast-success i { color: var(--ansi-green); }
  .toast-error i { color: var(--ansi-red); }
  .toast-warning i { color: var(--ansi-yellow); }
  .toast-info i { color: var(--accent); }

  @keyframes toast-in {
    from { opacity: 0; transform: translateX(20px); }
    to   { opacity: 1; transform: translateX(0); }
  }
</style>
