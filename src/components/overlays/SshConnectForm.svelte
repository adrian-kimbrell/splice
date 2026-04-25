<script lang="ts">
  import type { Workspace, SshConfig } from "../../lib/stores/workspace-types";
  import { workspaceManager } from "../../lib/stores/workspace.svelte";
  import { ui } from "../../lib/stores/ui.svelte";

  let {
    workspace,
    onclose,
  }: {
    workspace: Workspace;
    onclose: () => void;
  } = $props();

  let host = $state("");
  let port = $state(22);
  let user = $state("");
  let remotePath = $state("~");
  let keyPath = $state("");   // empty = use ~/.ssh/config defaults
  let connecting = $state(false);
  let error = $state<string | null>(null);

  // --- Remote folder browser ---
  let browseOpen = $state(false);
  let browseLoading = $state(false);
  let browseCurrent = $state("");
  let browseDirs = $state<Array<{ name: string; path: string }>>([]);
  let browseError = $state<string | null>(null);

  function parentPath(p: string): string {
    if (!p || p === "/") return "/";
    const parts = p.replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts.length === 0) return "/";
    parts.pop();
    return "/" + parts.join("/") || "/";
  }

  async function openBrowser() {
    if (!host.trim()) { error = "Host is required to browse."; return; }
    error = null;
    browseError = null;
    browseOpen = true;
    browseLoading = true;

    const config: SshConfig = {
      host: host.trim(), port,
      user: user.trim(), keyPath: keyPath.trim(),
      remotePath: remotePath.trim() || "~",
    };

    try {
      const { sshConnect } = await import("../../lib/ipc/commands");
      await Promise.race([
        sshConnect(workspace.id, config),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Connection timed out after 25 seconds")), 25_000)
        ),
      ]);
      await browseTo(remotePath.trim() || "~");
    } catch (e) {
      browseError = String(e);
      browseLoading = false;
    }
  }

  async function browseTo(path: string) {
    browseLoading = true;
    browseError = null;
    try {
      const { sftpListDir } = await import("../../lib/ipc/commands");
      const entries = await sftpListDir(workspace.id, path);
      const dirs = entries.filter(e => e.is_dir);
      // Derive the actual current path from returned entry paths (handles ~ expansion)
      if (dirs.length > 0) {
        const first = dirs[0].path;
        browseCurrent = first.substring(0, first.lastIndexOf("/")) || "/";
      } else if (entries.length > 0) {
        const first = entries[0].path;
        browseCurrent = first.substring(0, first.lastIndexOf("/")) || "/";
      } else {
        // Empty dir — try to resolve via parent listing trick
        browseCurrent = path.startsWith("/") ? path : "~";
      }
      browseDirs = dirs.map(e => ({ name: e.name, path: e.path }));
    } catch (e) {
      browseError = String(e);
    } finally {
      browseLoading = false;
    }
  }

  function selectFolder() {
    remotePath = browseCurrent;
    browseOpen = false;
  }

  async function handleConnect() {
    if (!host.trim()) {
      error = "Host is required.";
      return;
    }

    error = null;
    connecting = true;

    const config: SshConfig = {
      host: host.trim(),
      port,
      user: user.trim(),
      keyPath: keyPath.trim(),
      remotePath: remotePath.trim() || "~",
    };

    try {
      const { sshConnect, sftpListDir } = await import("../../lib/ipc/commands");

      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Connection timed out after 25 seconds")), 25_000)
      );
      await Promise.race([sshConnect(workspace.id, config), timeout]);

      workspace.sshConfig = config;
      workspace.rootPath = config.remotePath;
      if (!workspace.nameManuallySet) {
        workspace.name = config.host;
      }

      workspace.fileTree = await sftpListDir(workspace.id, config.remotePath);
      ui.explorerVisible = true;
      workspace.explorerVisible = true;

      await workspaceManager.spawnTerminalInWorkspace(workspace.id);
      workspaceManager.debouncedPersistWorkspace(workspace.id);

      onclose();
    } catch (e) {
      console.error("[SSH] Error:", e);
      error = String(e);
    } finally {
      connecting = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (browseOpen) { browseOpen = false; return; }
      onclose();
    }
    if (e.key === "Enter" && !connecting && !browseOpen) handleConnect();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="ssh-overlay" onkeydown={handleKeydown}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="ssh-backdrop" onclick={onclose}></div>
  <div class="ssh-form" role="dialog" aria-label="Connect to Remote">
    <div class="ssh-header">
      <i class="bi bi-hdd-network" style="font-size: 18px; color: var(--accent);"></i>
      <span class="ssh-title">Connect to Remote</span>
    </div>

    <div class="ssh-fields">
      <label class="ssh-field">
        <span class="ssh-label">Host</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="ssh-input"
          type="text"
          bind:value={host}
          placeholder="example.com"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          autofocus
        />
      </label>

      <div class="ssh-row">
        <label class="ssh-field" style="flex: 1;">
          <span class="ssh-label">Port</span>
          <input
            class="ssh-input"
            type="number"
            bind:value={port}
            min="1"
            max="65535"
          />
        </label>
        <label class="ssh-field" style="flex: 2;">
          <span class="ssh-label">User <span style="opacity:0.5; font-size:0.85em;">(optional)</span></span>
          <input
            class="ssh-input"
            type="text"
            bind:value={user}
            placeholder="From ~/.ssh/config"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
          />
        </label>
      </div>

      <div class="ssh-field">
        <span class="ssh-label">Remote Path</span>
        <div class="ssh-row" style="gap: 6px;">
          <input
            class="ssh-input"
            type="text"
            bind:value={remotePath}
            placeholder="~"
            autocomplete="off"
            style="flex: 1;"
          />
          <button
            type="button"
            class="ssh-btn ssh-btn-browse"
            onclick={openBrowser}
            disabled={!host.trim() || browseLoading}
            title="Browse remote directories"
          >
            <i class="bi bi-folder2-open"></i>
          </button>
        </div>

        {#if browseOpen}
          <div class="browse-panel">
            <div class="browse-nav">
              <button
                type="button"
                class="browse-up"
                onclick={() => browseTo(parentPath(browseCurrent))}
                disabled={browseLoading || browseCurrent === "/"}
                title="Go up"
              >
                <i class="bi bi-arrow-up"></i>
              </button>
              <span class="browse-current">{browseCurrent || "…"}</span>
              <button
                type="button"
                class="browse-select"
                onclick={selectFolder}
                disabled={browseLoading || !browseCurrent}
              >
                Select
              </button>
            </div>
            {#if browseLoading}
              <div class="browse-status"><i class="bi bi-arrow-repeat spin"></i> Loading…</div>
            {:else if browseError}
              <div class="browse-status browse-err"><i class="bi bi-exclamation-circle"></i> {browseError}</div>
            {:else if browseDirs.length === 0}
              <div class="browse-status browse-empty">No subdirectories</div>
            {:else}
              <ul class="browse-list">
                {#each browseDirs as dir}
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <li
                    class="browse-item"
                    onclick={() => browseTo(dir.path)}
                    role="button"
                    tabindex="0"
                    onkeydown={(e) => e.key === "Enter" && browseTo(dir.path)}
                  >
                    <i class="bi bi-folder" style="color: var(--accent); opacity: 0.8;"></i>
                    {dir.name}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
      </div>

      <label class="ssh-field">
        <span class="ssh-label">Key File <span style="opacity:0.5; font-size:0.85em;">(optional)</span></span>
        <input
          class="ssh-input"
          type="text"
          bind:value={keyPath}
          placeholder="From ~/.ssh/config"
          autocomplete="off"
        />
      </label>
    </div>

    {#if error}
      <div class="ssh-error">
        <i class="bi bi-exclamation-circle"></i>
        {error}
      </div>
    {/if}

    <div class="ssh-actions">
      <button type="button" class="ssh-btn ssh-btn-cancel" onclick={onclose} disabled={connecting}>
        Cancel
      </button>
      <button type="button" class="ssh-btn ssh-btn-connect" onclick={handleConnect} disabled={connecting || !host.trim()}>
        {#if connecting}
          <i class="bi bi-arrow-repeat spin"></i> Connecting…
        {:else}
          <i class="bi bi-plug"></i> Connect
        {/if}
      </button>
    </div>
  </div>
</div>

<style>
  .ssh-overlay {
    position: fixed;
    inset: 0;
    z-index: 9000;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .ssh-backdrop {
    position: absolute;
    inset: 0;
    background: var(--backdrop-lg);
    backdrop-filter: blur(3px);
  }
  .ssh-form {
    position: relative;
    z-index: 1;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 24px;
    width: 440px;
    max-width: 90vw;
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .ssh-header {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .ssh-title {
    font-size: var(--ui-body);
    font-weight: 600;
    color: var(--txt-bright);
  }
  .ssh-fields {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .ssh-row {
    display: flex;
    gap: 10px;
  }
  .ssh-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .ssh-label {
    font-size: var(--ui-xs);
    color: var(--txt-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .ssh-input {
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--txt-bright);
    font-size: var(--ui-body);
    padding: 6px 10px;
    outline: none;
    width: 100%;
    box-sizing: border-box;
  }
  .ssh-input:focus {
    border-color: var(--accent);
  }
  .ssh-btn-browse {
    padding: 6px 10px;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--txt-dim);
    cursor: pointer;
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }
  .ssh-btn-browse:hover:not(:disabled) {
    color: var(--txt-bright);
    border-color: var(--accent);
  }
  .ssh-btn-browse:disabled {
    opacity: 0.4;
    cursor: default;
  }
  /* Remote folder browser panel */
  .browse-panel {
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-1);
    overflow: hidden;
    margin-top: 2px;
  }
  .browse-nav {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-2);
  }
  .browse-up {
    background: none;
    border: none;
    color: var(--txt-dim);
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 3px;
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }
  .browse-up:hover:not(:disabled) { color: var(--txt-bright); background: var(--bg-3, var(--border)); }
  .browse-up:disabled { opacity: 0.35; cursor: default; }
  .browse-current {
    flex: 1;
    font-size: var(--ui-xs);
    color: var(--txt-bright);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: monospace;
  }
  .browse-select {
    background: var(--accent);
    border: none;
    border-radius: 3px;
    color: #fff;
    cursor: pointer;
    font-size: var(--ui-xs);
    padding: 3px 8px;
    flex-shrink: 0;
  }
  .browse-select:hover:not(:disabled) { opacity: 0.85; }
  .browse-select:disabled { opacity: 0.4; cursor: default; }
  .browse-list {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    max-height: 160px;
    overflow-y: auto;
  }
  .browse-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    font-size: var(--ui-body);
    color: var(--txt-bright);
    cursor: pointer;
  }
  .browse-item:hover { background: var(--bg-3, rgba(255,255,255,0.05)); }
  .browse-status {
    padding: 10px;
    font-size: var(--ui-xs);
    color: var(--txt-dim);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .browse-err { color: var(--ansi-red); }
  .browse-empty { font-style: italic; }
  .ssh-error {
    font-size: var(--ui-xs);
    color: var(--ansi-red);
    display: flex;
    gap: 6px;
    align-items: flex-start;
    word-break: break-word;
  }
  .ssh-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .ssh-btn {
    padding: 6px 16px;
    border-radius: 4px;
    font-size: var(--ui-body);
    cursor: pointer;
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .ssh-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .ssh-btn-cancel {
    background: transparent;
    color: var(--txt-dim);
  }
  .ssh-btn-cancel:hover:not(:disabled) {
    color: var(--txt-bright);
  }
  .ssh-btn-connect {
    background: var(--accent);
    color: #fff;
    border-color: transparent;
  }
  .ssh-btn-connect:hover:not(:disabled) {
    opacity: 0.85;
  }
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  .spin {
    display: inline-block;
    animation: spin 0.8s linear infinite;
  }
</style>
