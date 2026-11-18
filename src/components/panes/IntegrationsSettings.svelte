<script lang="ts">
  /**
   * The parts of Settings → Integrations that are not plain toggles: where the
   * MCP server is registered, the remote-access token, and outbound webhooks.
   * The three toggles themselves are ordinary rows in SettingsPane.
   */
  import { onMount } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import { settings } from "../../lib/stores/settings.svelte";
  import {
    mcpStatus, mcpReregister, mcpRegenerateRemoteToken,
    webhooksList, webhookSave, webhookDelete, webhookSend, writeToClipboard,
    type McpStatus, type CliRegistration, type WebhookSummary, type WebhookAuth,
  } from "../../lib/ipc/commands";
  import { pushToast } from "../../lib/stores/toasts.svelte";

  let status = $state<McpStatus | null>(null);
  let hooks = $state<WebhookSummary[]>([]);
  let registering = $state(false);

  let formName = $state("");
  let formUrl = $state("");
  let formKey = $state("");
  let formAuth = $state<WebhookAuth>("bearer");
  let formError = $state("");
  let sending = $state<string | null>(null);

  const enabled = $derived(settings.general.mcp_enabled);
  const remote = $derived(enabled && settings.general.mcp_remote_access);

  async function refresh() {
    try {
      status = await mcpStatus();
      hooks = await webhooksList();
    } catch { /* not running under Tauri */ }
  }

  // The toggles save through a 500 ms debounce; re-read the status after it lands.
  $effect(() => {
    void enabled; void remote;
    registering = enabled;
    const t = setTimeout(refresh, 900);
    // The CLIs normally answer within a few seconds and Rust then emits
    // `mcp:registration`. Never leave the button disabled if that event is missed.
    const giveUp = setTimeout(() => { registering = false; void refresh(); }, 40_000);
    return () => { clearTimeout(t); clearTimeout(giveUp); };
  });

  onMount(() => {
    void refresh();
    let unlisten: (() => void) | undefined;
    listen("mcp:registration", () => { registering = false; void refresh(); })
      .then((u) => { unlisten = u; })
      .catch(() => {});
    return () => unlisten?.();
  });

  function describe(name: string, reg: CliRegistration | undefined): { text: string; tone: "ok" | "warn" | "dim" } {
    if (!reg || reg.state === "none") return { text: registering ? `${name}: registering…` : `${name}: not registered`, tone: "dim" };
    if (reg.state === "registered") return { text: `${name}: registered`, tone: "ok" };
    if (reg.state === "failed") return { text: `${name}: failed (${reg.detail})`, tone: "warn" };
    return { text: `${name}: CLI not installed`, tone: "dim" };
  }

  const claudeLine = $derived(describe("Claude Code", status?.registration.claude));
  const codexLine = $derived(describe("Codex", status?.registration.codex));

  async function retry() {
    registering = true;
    await mcpReregister().catch(() => { registering = false; });
  }

  async function copy(text: string, what: string) {
    try {
      await writeToClipboard(text);
      pushToast(`${what} copied`, "info", 1500);
    } catch {
      pushToast("Could not copy", "error");
    }
  }

  async function regenerate() {
    try {
      await mcpRegenerateRemoteToken();
      await refresh();
      pushToast("New remote token created. The old one no longer works.", "info");
    } catch (e) {
      pushToast(`Could not create a token: ${e}`, "error");
    }
  }

  async function saveHook() {
    formError = "";
    try {
      await webhookSave(formName, formUrl, formKey, formAuth);
      formName = ""; formUrl = ""; formKey = ""; formAuth = "bearer";
      hooks = await webhooksList();
    } catch (e) {
      formError = String(e);
    }
  }

  async function removeHook(name: string) {
    await webhookDelete(name).catch(() => {});
    hooks = await webhooksList();
  }

  async function testHook(name: string) {
    sending = name;
    try {
      const out = await webhookSend(name, "Test message from Splice.");
      pushToast(`“${name}” answered HTTP ${out.status}`, "info");
    } catch (e) {
      pushToast(`“${name}”: ${e}`, "error", 8000);
    } finally {
      sending = null;
    }
  }
</script>

<div class="integrations" data-testid="integrations-settings">
  {#if enabled}
    <div class="block">
      <div class="block-title">Agent registration</div>
      <div class="reg-line tone-{claudeLine.tone}">{claudeLine.text}</div>
      <div class="reg-line tone-{codexLine.tone}">{codexLine.text}</div>
      <div class="hint">
        New agent sessions pick the tools up automatically; sessions already running need a restart.
        {#if status && status.port > 0}Local endpoint: <code>http://127.0.0.1:{status.port}/mcp</code>.{/if}
      </div>
      <button class="btn" onclick={retry} disabled={registering}>{registering ? "Registering…" : "Register again"}</button>
    </div>
  {/if}

  {#if remote && status?.remote_token}
    <div class="block">
      <div class="block-title">Remote access</div>
      <div class="hint">
        Point a tunnel (Cloudflare Tunnel, Tailscale Funnel) at <code>http://127.0.0.1:{status.port}</code> and give the outside
        agent the tunnel URL ending in <code>/mcp</code> plus this header. This token can only add inbox items{settings.general.mcp_remote_read ? " and list terminals" : ""}.
      </div>
      <div class="token-row">
        <code class="token">Authorization: Bearer {status.remote_token}</code>
        <button class="btn" onclick={() => copy(`Authorization: Bearer ${status!.remote_token}`, "Header")}>Copy</button>
        <button class="btn" onclick={regenerate} title="Create a new token; the current one stops working">Regenerate</button>
      </div>
    </div>
  {/if}

  <div class="block">
    <div class="block-title">Outbound webhooks</div>
    <div class="hint">
      Endpoints Splice can send a message to, such as a Grok Bot routine with a webhook trigger. Agents use them through the
      <code>send_webhook</code> tool when the MCP server is on. Keys are stored in an owner-only file and never shown again.
    </div>
    {#each hooks as hook (hook.name)}
      <div class="hook-row">
        <span class="hook-name">{hook.name}</span>
        <span class="hook-host">{hook.host}{hook.has_key ? "" : " · no key"}</span>
        <button class="btn" onclick={() => testHook(hook.name)} disabled={sending === hook.name}>{sending === hook.name ? "Sending…" : "Send test"}</button>
        <button class="btn" onclick={() => removeHook(hook.name)} title="Remove"><i class="bi bi-trash"></i></button>
      </div>
    {/each}
    <div class="hook-form">
      <input class="field name" placeholder="Name (e.g. grok-bot)" bind:value={formName} />
      <input class="field url" placeholder="https://… webhook URL" bind:value={formUrl} />
      <input class="field key" type="password" placeholder="Key / secret" bind:value={formKey} />
      <select class="field auth" bind:value={formAuth} title="Which header carries the key">
        <option value="bearer">Authorization: Bearer</option>
        <option value="x-webhook-secret">X-Webhook-Secret</option>
        <option value="none">No header</option>
      </select>
      <button class="btn" onclick={saveHook} disabled={!formName.trim() || !formUrl.trim()}>Add</button>
    </div>
    {#if formError}<div class="reg-line tone-warn">{formError}</div>{/if}
  </div>
</div>

<style>
  .integrations {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 10px;
  }
  .block {
    padding: 12px 16px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-sidebar);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .block-title {
    font-size: 13px;
    color: var(--text-bright);
  }
  .hint {
    font-size: 11px;
    line-height: 1.5;
    color: var(--text-dim);
  }
  code {
    font-size: 11px;
    color: var(--text);
    user-select: text;
  }
  .reg-line {
    font-size: 12px;
  }
  .tone-ok { color: var(--git-added); }
  .tone-warn { color: var(--ansi-yellow); }
  .tone-dim { color: var(--text-dim); }
  .btn {
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-dim);
    font-size: 12px;
    cursor: pointer;
    width: fit-content;
  }
  .btn:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .token-row, .hook-row, .hook-form {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .token {
    flex: 1;
    min-width: 0;
    padding: 5px 8px;
    background: var(--bg-input);
    border-radius: 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hook-name {
    font-size: 12px;
    color: var(--text-bright);
  }
  .hook-host {
    flex: 1;
    font-size: 11px;
    color: var(--text-dim);
  }
  .field {
    background: var(--bg-input);
    border: 1px solid var(--border);
    color: var(--text-bright);
    font-size: 12px;
    padding: 5px 8px;
    border-radius: 6px;
    outline: none;
    min-width: 0;
  }
  .field.name { width: 150px; }
  .field.url { flex: 1; min-width: 180px; }
  .field.key { width: 140px; }
</style>
