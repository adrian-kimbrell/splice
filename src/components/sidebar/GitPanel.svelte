<script lang="ts">
  import { log } from "../../lib/utils/log";
  import { workspaceManager } from "../../lib/stores/workspace.svelte";
  import { refreshGitStatus, getGitEntry, stageFiles, unstageFiles, discardFiles } from "../../lib/stores/git.svelte";
  import type { GitFileStatus } from "../../lib/ipc/commands";
  import { pushToast } from "../../lib/stores/toasts.svelte";
  import GitLog from "./GitLog.svelte";

  let commitMessage = $state("");
  let committing = $state(false);
  let activeTab = $state<"changes" | "log">("changes");

  const wsId = $derived(workspaceManager.activeWorkspaceId ?? "");
  const rootPath = $derived(workspaceManager.activeWorkspace?.rootPath ?? "");
  const gitEntry = $derived(wsId ? getGitEntry(wsId) : null);

  const stagedFiles = $derived(gitEntry?.stagedFiles ?? []);
  const unstagedFiles = $derived(gitEntry?.unstagedFiles ?? []);
  const untrackedFiles = $derived(gitEntry?.untrackedFiles ?? []);
  const hasStaged = $derived(stagedFiles.length > 0);
  const hasUnstaged = $derived(unstagedFiles.length > 0);
  const hasUntracked = $derived(untrackedFiles.length > 0);
  const hasAnyChanges = $derived(hasStaged || hasUnstaged || hasUntracked);

  function statusLabel(file: GitFileStatus, staged: boolean): string {
    const c = staged ? file.index_status : file.worktree_status;
    switch (c) {
      case "M": return "M";
      case "A": return "A";
      case "D": return "D";
      case "R": return "R";
      case "C": return "C";
      case "U": return "U";
      case "?": return "?";
      default: return c;
    }
  }

  function statusColor(file: GitFileStatus, staged: boolean): string {
    const c = staged ? file.index_status : file.worktree_status;
    switch (c) {
      case "M": return "var(--ansi-yellow)";
      case "A": return "var(--git-added)";
      case "D": return "var(--ansi-red)";
      case "R": return "var(--git-added)";
      case "U": return "var(--ansi-red)";
      case "?": return "var(--text-dim)";
      default: return "var(--text)";
    }
  }

  async function doRefresh() {
    if (wsId && rootPath) {
      await refreshGitStatus(wsId, rootPath);
    }
  }

  // IPC, status refresh and failure toasts live in the git store.
  const stageFile = (filePath: string) => stageFiles(wsId, rootPath, [filePath]);
  const unstageFile = (filePath: string) => unstageFiles(wsId, rootPath, [filePath]);
  const stagePaths = (paths: string[]) => stageFiles(wsId, rootPath, paths);
  const unstageAll = () => unstageFiles(wsId, rootPath, stagedFiles.map(f => f.path));
  const discardFile = (filePath: string) => discardFiles(wsId, rootPath, [filePath]);

  async function doCommit() {
    const msg = commitMessage.trim();
    if (!msg || !hasStaged) return;
    committing = true;
    try {
      const { gitCommit } = await import("../../lib/ipc/commands");
      const hash = await gitCommit(rootPath, msg);
      commitMessage = "";
      pushToast(`Committed ${hash.slice(0, 7)}`);
      await doRefresh();
      // Also refresh git branch in case HEAD changed
      workspaceManager.fetchGitBranch(wsId);
    } catch (e) {
      log.error("Failed to commit:", e);
      pushToast(`Commit failed: ${e}`);
    } finally {
      committing = false;
    }
  }

  async function openDiff(filePath: string, staged: boolean) {
    try {
      const { gitDiffFile } = await import("../../lib/ipc/commands");
      const diff = await gitDiffFile(rootPath, filePath, staged);
      workspaceManager.openDiffInWorkspace(filePath, diff.old_content, diff.new_content, staged);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("Binary file")) {
        pushToast(`Cannot diff binary file: ${filePath.split("/").pop()}`);
      } else {
        pushToast(`Failed to open diff: ${e}`);
      }
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      doCommit();
    }
  }
</script>

<div class="flex flex-col h-full overflow-hidden" style="font-size: 13px;">
  {#if !rootPath}
    <div class="px-3 py-6 text-txt-dim text-center">No folder opened</div>
  {:else}
    <!-- Tab toggle -->
    <div class="flex shrink-0 border-b border-border">
      <button
        class="flex-1 py-1.5 text-center text-[11px] font-medium cursor-pointer transition-colors duration-75"
        class:text-accent={activeTab === "changes"}
        class:text-txt-dim={activeTab !== "changes"}
        style:border-bottom={activeTab === "changes" ? "1px solid var(--accent)" : "1px solid transparent"}
        onclick={() => activeTab = "changes"}
      >
        Changes
      </button>
      <button
        class="flex-1 py-1.5 text-center text-[11px] font-medium cursor-pointer transition-colors duration-75"
        class:text-accent={activeTab === "log"}
        class:text-txt-dim={activeTab !== "log"}
        style:border-bottom={activeTab === "log" ? "1px solid var(--accent)" : "1px solid transparent"}
        onclick={() => activeTab = "log"}
      >
        Log
      </button>
    </div>

    {#if activeTab === "log"}
      <GitLog />
    {:else if !hasAnyChanges}
    <div class="px-3 py-6 text-txt-dim text-center">No changes detected</div>
  {:else}
    <!-- Commit area -->
    <div class="px-2 pt-2 pb-1 shrink-0">
      <textarea
        bind:value={commitMessage}
        class="w-full px-2 py-1.5 rounded outline-none resize-none"
        style="background: var(--bg-input); color: var(--text-bright); border: 1px solid var(--border); min-height: 52px; max-height: 100px;"
        placeholder="Commit message"
        rows="2"
        onkeydown={handleKeyDown}
      ></textarea>
      <button
        class="w-full mt-1 px-2 py-1 rounded cursor-pointer transition-all duration-75"
        style="background: var(--accent); color: var(--accent-fg); font-weight: 500;"
        style:opacity={(!hasStaged || !commitMessage.trim() || committing) ? "0.4" : "1"}
        disabled={!hasStaged || !commitMessage.trim() || committing}
        onclick={doCommit}
      >
        {committing ? "Committing..." : `Commit (${stagedFiles.length})`}
      </button>
    </div>

    <div class="flex-1 overflow-y-auto min-h-0">
      <!-- Staged Changes -->
      {#if hasStaged}
        <div class="mt-1">
          <div class="flex items-center px-2 py-1 text-[11px] font-medium text-txt-dim">
            <span class="flex-1">STAGED CHANGES ({stagedFiles.length})</span>
            <button
              class="text-txt-dim hover:text-txt-bright cursor-pointer px-1"
              title="Unstage All"
              onclick={unstageAll}
            >
              <i class="bi bi-dash-lg text-[11px]"></i>
            </button>
          </div>
          {#each stagedFiles as file (file.path + ":staged")}
            <div class="group flex items-center px-2 py-0.5 hover:bg-selected cursor-pointer" onclick={() => openDiff(file.path, true)}>
              <span class="w-4 text-center shrink-0 font-mono text-[11px]" style="color: {statusColor(file, true)}">{statusLabel(file, true)}</span>
              <span class="flex-1 min-w-0 truncate ml-1 text-[13px]" style="color: var(--text)" title={file.path}>{file.path}</span>
              <button
                class="opacity-0 group-hover:opacity-100 text-txt-dim hover:text-txt-bright cursor-pointer px-0.5"
                title="Unstage"
                onclick={(e: MouseEvent) => { e.stopPropagation(); unstageFile(file.path); }}
              >
                <i class="bi bi-dash text-[11px]"></i>
              </button>
            </div>
          {/each}
        </div>
      {/if}

      <!-- Unstaged Changes -->
      {#if hasUnstaged}
        <div class="mt-1">
          <div class="flex items-center px-2 py-1 text-[11px] font-medium text-txt-dim">
            <span class="flex-1">CHANGES ({unstagedFiles.length})</span>
            <button
              class="text-txt-dim hover:text-txt-bright cursor-pointer px-1"
              title="Stage All Modified"
              onclick={() => stagePaths(unstagedFiles.map(f => f.path))}
            >
              <i class="bi bi-plus-lg text-[11px]"></i>
            </button>
          </div>
          {#each unstagedFiles as file (file.path + ":unstaged")}
            <div class="group flex items-center px-2 py-0.5 hover:bg-selected cursor-pointer" onclick={() => openDiff(file.path, false)}>
              <span class="w-4 text-center shrink-0 font-mono text-[11px]" style="color: {statusColor(file, false)}">{statusLabel(file, false)}</span>
              <span class="flex-1 min-w-0 truncate ml-1 text-[13px]" style="color: var(--text)" title={file.path}>{file.path}</span>
              <div class="flex opacity-0 group-hover:opacity-100">
                <button
                  class="text-txt-dim hover:text-txt-bright cursor-pointer px-0.5"
                  title="Discard Changes"
                  onclick={(e: MouseEvent) => { e.stopPropagation(); discardFile(file.path); }}
                >
                  <i class="bi bi-arrow-counterclockwise text-[11px]"></i>
                </button>
                <button
                  class="text-txt-dim hover:text-txt-bright cursor-pointer px-0.5"
                  title="Stage"
                  onclick={(e: MouseEvent) => { e.stopPropagation(); stageFile(file.path); }}
                >
                  <i class="bi bi-plus text-[11px]"></i>
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}

      <!-- Untracked Files -->
      {#if hasUntracked}
        <div class="mt-1">
          <div class="flex items-center px-2 py-1 text-[11px] font-medium text-txt-dim">
            <span class="flex-1">UNTRACKED ({untrackedFiles.length})</span>
            <button
              class="text-txt-dim hover:text-txt-bright cursor-pointer px-1"
              title="Stage All Untracked"
              onclick={() => stagePaths(untrackedFiles.map(f => f.path))}
            >
              <i class="bi bi-plus-lg text-[11px]"></i>
            </button>
          </div>
          {#each untrackedFiles as file (file.path + ":untracked")}
            <div class="group flex items-center px-2 py-0.5 hover:bg-selected cursor-pointer" onclick={() => openDiff(file.path, false)}>
              <span class="w-4 text-center shrink-0 font-mono text-[11px]" style="color: var(--text-dim)">?</span>
              <span class="flex-1 min-w-0 truncate ml-1 text-[13px]" style="color: var(--text-dim)" title={file.path}>{file.path}</span>
              <button
                class="opacity-0 group-hover:opacity-100 text-txt-dim hover:text-txt-bright cursor-pointer px-0.5"
                title="Stage"
                onclick={(e: MouseEvent) => { e.stopPropagation(); stageFile(file.path); }}
              >
                <i class="bi bi-plus text-[11px]"></i>
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
    {/if}
  {/if}
</div>
