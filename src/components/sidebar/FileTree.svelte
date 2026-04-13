<script lang="ts">
  import FileTreeItem from "./FileTreeItem.svelte";
  import type { FileEntry } from "../../lib/stores/files.svelte";
  import { workspaceManager } from "../../lib/stores/workspace.svelte";
  import { ui } from "../../lib/stores/ui.svelte";
  import { fileClipboard } from "../../lib/stores/file-clipboard.svelte";
  import { untrack } from "svelte";

  let {
    entries,
    onFileClick,
    onFileDoubleClick,
    selectedPath,
    rootPath = "",
    sshWorkspaceId = null,
  }: {
    entries: FileEntry[];
    onFileClick: (entry: FileEntry) => void;
    onFileDoubleClick?: (entry: FileEntry) => void;
    selectedPath: string | null;
    rootPath?: string;
    sshWorkspaceId?: string | null;
  } = $props();

  const rootName = $derived(rootPath ? rootPath.split("/").filter(Boolean).pop() ?? "" : "");

  let rootExpanded = $state(true);
  let collapseGeneration = $state(0);
  let refreshGeneration = $state(0);

  // When the root file tree is reloaded (either from internal ops or the external
  // FSEvents watcher), bump refreshGeneration so expanded subdirectory items
  // re-read their children via readDirTree.
  $effect(() => {
    const _watch = entries;
    untrack(() => { refreshGeneration++; });
  });

  let treeEl = $state<HTMLDivElement>();
  let focusedPath = $state<string | null>(null);

  // --- Context menu state ---
  let ctxMenuEl = $state<HTMLDivElement | null>(null);

  // --- Inline prompt state ---
  let promptMode = $state<"new-file" | "new-folder" | "rename" | null>(null);
  let promptValue = $state("");
  let promptDir = $state("");
  let promptRenameEntry = $state<FileEntry | null>(null);
  let promptRenamePath = $state("");
  let promptInputEl = $state<HTMLInputElement | null>(null);

  const promptLabel = $derived(
    promptMode === "new-file" ? "File name:" :
    promptMode === "new-folder" ? "Folder name:" :
    promptMode === "rename" ? "New name:" : ""
  );

  // --- Inline create state (new file/folder in tree) ---
  let inlineCreateDir = $state<string | null>(null);
  let inlineCreateType = $state<"file" | "folder" | null>(null);

  function autoFocus(node: HTMLInputElement) {
    requestAnimationFrame(() => node.focus());
  }

  function startInlineCreate(type: "file" | "folder", dir: string) {
    inlineCreateDir = dir;
    inlineCreateType = type;
    // Auto-expand root if collapsed
    if (dir === rootPath && !rootExpanded) {
      rootExpanded = true;
    }
  }

  function cancelInlineCreate() {
    inlineCreateDir = null;
    inlineCreateType = null;
  }

  async function submitInlineCreate(value: string) {
    const trimmed = value.trim();
    if (!trimmed) { cancelInlineCreate(); return; }
    const dir = inlineCreateDir!;
    const type = inlineCreateType!;
    cancelInlineCreate();
    if (type === "file") {
      await doCreateFile(dir, trimmed);
    } else {
      await doCreateFolder(dir, trimmed);
    }
  }

  function openPrompt(mode: "new-file" | "new-folder" | "rename", defaultValue: string, dir: string, entry?: FileEntry, renamePath?: string) {
    promptMode = mode;
    promptValue = defaultValue;
    promptDir = dir;
    promptRenameEntry = entry ?? null;
    promptRenamePath = renamePath ?? "";
    // Focus the input after it renders
    requestAnimationFrame(() => {
      promptInputEl?.focus();
      promptInputEl?.select();
    });
  }

  function closePrompt() {
    promptMode = null;
    promptValue = "";
    promptDir = "";
    promptRenameEntry = null;
    promptRenamePath = "";
  }

  async function submitPrompt() {
    const value = promptValue.trim();
    if (!value) { closePrompt(); return; }
    const mode = promptMode;
    const dir = promptDir;
    const renameEntry = promptRenameEntry;
    const renamePath = promptRenamePath;
    closePrompt();

    if (mode === "new-file") {
      await doCreateFile(dir, value);
    } else if (mode === "new-folder") {
      await doCreateFolder(dir, value);
    } else if (mode === "rename" && renameEntry) {
      await doRename(renamePath, value, renameEntry);
    }
  }

  function getVisibleItems(el: HTMLDivElement): HTMLElement[] {
    return Array.from(el.querySelectorAll<HTMLElement>('[role="treeitem"]'));
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (!treeEl) return;
    const items = getVisibleItems(treeEl);
    if (items.length === 0) return;

    const currentIdx = items.findIndex(el => el.dataset.path === focusedPath);
    let handled = true;

    switch (e.key) {
      case "ArrowDown": {
        const next = Math.min(currentIdx + 1, items.length - 1);
        focusedPath = items[next].dataset.path ?? null;
        items[next].focus();
        break;
      }
      case "ArrowUp": {
        const prev = Math.max(currentIdx - 1, 0);
        focusedPath = items[prev].dataset.path ?? null;
        items[prev].focus();
        break;
      }
      case "Home": {
        focusedPath = items[0].dataset.path ?? null;
        items[0].focus();
        break;
      }
      case "End": {
        const last = items[items.length - 1];
        focusedPath = last.dataset.path ?? null;
        last.focus();
        break;
      }
      case "Enter":
      case " ": {
        if (currentIdx >= 0) {
          items[currentIdx].click();
        }
        break;
      }
      default:
        handled = false;
    }

    if (handled) e.preventDefault();
  }

  // --- Context menu helpers ---

  type MenuTarget = {
    kind: "file" | "folder" | "root" | "empty";
    path: string;
    parentDir: string;
    entry?: FileEntry;
  };

  function removeCtxMenu() {
    if (ctxMenuEl) {
      ctxMenuEl.remove();
      ctxMenuEl = null;
    }
  }

  function handleDocClick(e: MouseEvent) {
    if (ctxMenuEl && !ctxMenuEl.contains(e.target as Node)) {
      removeCtxMenu();
    }
  }

  function handleItemContextMenu(e: MouseEvent, entry: FileEntry) {
    const target: MenuTarget = entry.is_dir
      ? { kind: "folder", path: entry.path, parentDir: entry.path, entry }
      : { kind: "file", path: entry.path, parentDir: entry.path.substring(0, entry.path.lastIndexOf("/")), entry };
    showContextMenu(e, target);
  }

  function handleTreeContextMenu(e: MouseEvent) {
    // Only fires for empty space or root folder (items stopPropagation)
    e.preventDefault();
    const target: MenuTarget = { kind: "empty", path: rootPath, parentDir: rootPath };
    showContextMenu(e, target);
  }

  function handleRootContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const target: MenuTarget = { kind: "root", path: rootPath, parentDir: rootPath };
    showContextMenu(e, target);
  }

  type MenuItem = {
    label: string;
    shortcut?: string;
    action?: () => void;
    separator?: boolean;
    disabled?: boolean;
  };

  function showContextMenu(e: MouseEvent, target: MenuTarget) {
    removeCtxMenu();

    const items: MenuItem[] = buildMenuItems(target);
    const menu = document.createElement("div");
    menu.className = "tab-ctx-menu split-dropdown";
    menu.style.position = "fixed";
    menu.style.top = `${e.clientY}px`;
    menu.style.left = `${e.clientX}px`;
    menu.style.transform = "none";

    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement("div");
        sep.className = "split-dropdown-sep";
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement("button");
      btn.className = "split-dropdown-item" + (item.disabled ? " disabled" : "");
      btn.disabled = !!item.disabled;
      btn.textContent = item.label;
      if (item.shortcut) {
        const kbd = document.createElement("kbd");
        kbd.textContent = item.shortcut;
        btn.appendChild(kbd);
      }
      if (!item.disabled && item.action) {
        const action = item.action;
        btn.addEventListener("click", () => {
          removeCtxMenu();
          action();
        });
      }
      menu.appendChild(btn);
    }

    document.body.appendChild(menu);
    ctxMenuEl = menu;

    // Clamp to viewport
    requestAnimationFrame(() => {
      if (!menu.parentNode) return;
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        menu.style.left = `${window.innerWidth - rect.width - 4}px`;
      }
      if (rect.bottom > window.innerHeight) {
        menu.style.top = `${window.innerHeight - rect.height - 4}px`;
      }
    });
  }

  function buildMenuItems(target: MenuTarget): MenuItem[] {
    const { kind, path, parentDir } = target;
    const isFileOrFolder = kind === "file" || kind === "folder";
    const isFile = kind === "file";
    const items: MenuItem[] = [];

    // New File / New Folder — always shown
    items.push({
      label: "New File",
      shortcut: "\u2318N",
      action: () => startInlineCreate("file", isFileOrFolder ? parentDir : rootPath),
    });
    items.push({
      label: "New Folder",
      shortcut: "\u2325\u2318N",
      action: () => startInlineCreate("folder", isFileOrFolder ? parentDir : rootPath),
    });

    if (kind !== "empty") {
      items.push({ separator: true, label: "" });
      items.push({
        label: "Reveal in Finder",
        shortcut: "\u2325\u2318R",
        action: () => actionRevealInFinder(path),
      });
      items.push({
        label: "Open in Default App",
        action: () => actionOpenInDefaultApp(path),
      });
      items.push({
        label: "Open in Terminal",
        action: () => actionOpenInTerminal(kind === "file" ? parentDir : path),
      });
    }

    items.push({ separator: true, label: "" });
    items.push({
      label: "Find in Folder\u2026",
      shortcut: "\u2325\u2318F",
      action: () => { ui.sidebarMode = "search"; },
    });

    if (isFileOrFolder) {
      items.push({ separator: true, label: "" });
      items.push({
        label: "Cut",
        shortcut: "\u2318X",
        disabled: path === rootPath,
        action: () => fileClipboard.set({ op: "cut", path }),
      });
      items.push({
        label: "Copy",
        shortcut: "\u2318C",
        disabled: path === rootPath,
        action: () => fileClipboard.set({ op: "copy", path }),
      });
      items.push({
        label: "Duplicate",
        shortcut: "\u2318D",
        action: () => actionDuplicate(path),
      });
      items.push({
        label: "Paste",
        shortcut: "\u2318V",
        disabled: !fileClipboard.value,
        action: () => actionPaste(kind === "file" ? parentDir : path),
      });

      items.push({ separator: true, label: "" });
      items.push({
        label: "Copy Path",
        shortcut: "\u2325\u2318C",
        action: () => navigator.clipboard.writeText(path),
      });
      items.push({
        label: "Copy Relative Path",
        shortcut: "\u2325\u21E7\u2318C",
        action: () => navigator.clipboard.writeText(path.replace(rootPath + "/", "")),
      });

      items.push({ separator: true, label: "" });
      items.push({
        label: "Rename",
        shortcut: "F2",
        action: () => openPrompt("rename", target.entry!.name, "", target.entry!, path),
      });
    }

    if (kind === "root") {
      items.push({ separator: true, label: "" });
      items.push({
        label: "Copy Path",
        shortcut: "\u2325\u2318C",
        action: () => navigator.clipboard.writeText(path),
      });
    }

    items.push({ separator: true, label: "" });
    if (isFileOrFolder) {
      items.push({
        label: "Delete",
        action: () => actionDelete(path, isFile),
      });
      items.push({ separator: true, label: "" });
    }
    items.push({
      label: "Collapse All",
      shortcut: "\u2318\u2190",
      action: actionCollapseAll,
    });

    return items;
  }

  // --- Actions ---

  async function refreshTree() {
    const wsId = workspaceManager.activeWorkspaceId;
    if (wsId) await workspaceManager.loadFileTree(wsId);
    // Bump refresh generation so expanded FileTreeItems reload their children
    refreshGeneration++;
  }

  async function doCreateFile(dir: string, name: string) {
    try {
      const { createFileAt } = await import("../../lib/ipc/commands");
      const newPath = await createFileAt(dir, name);
      await refreshTree();
      workspaceManager.openFileInWorkspace({
        name,
        path: newPath,
        content: "",
        preview: false,
      });
    } catch (e) {
      console.error("Failed to create file:", e);
    }
  }

  async function doCreateFolder(dir: string, name: string) {
    try {
      const { createDirectoryAt } = await import("../../lib/ipc/commands");
      await createDirectoryAt(dir, name);
      await refreshTree();
    } catch (e) {
      console.error("Failed to create folder:", e);
    }
  }

  async function actionRevealInFinder(path: string) {
    try {
      const { revealInFileManager } = await import("../../lib/ipc/commands");
      await revealInFileManager(path);
    } catch (e) {
      console.error("Failed to reveal in Finder:", e);
    }
  }

  async function actionOpenInDefaultApp(path: string) {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(path);
    } catch (e) {
      console.error("Failed to open in default app:", e);
    }
  }

  async function actionOpenInTerminal(dir: string) {
    await workspaceManager.spawnTerminalInWorkspace(undefined, dir);
  }

  async function actionDuplicate(path: string) {
    try {
      const { duplicatePath } = await import("../../lib/ipc/commands");
      await duplicatePath(path);
      await refreshTree();
    } catch (e) {
      console.error("Failed to duplicate:", e);
    }
  }

  async function actionPaste(destDir: string) {
    const cb = fileClipboard.value;
    if (!cb) return;
    const basename = cb.path.split("/").pop() ?? "";
    const dest = destDir + "/" + basename;
    try {
      if (cb.op === "copy") {
        const { copyPath } = await import("../../lib/ipc/commands");
        await copyPath(cb.path, dest);
        await refreshTree();
      } else {
        // cut = move
        const { renamePath } = await import("../../lib/ipc/commands");
        await renamePath(cb.path, dest);
        await refreshTree();
        fileClipboard.clear();
      }
    } catch (e) {
      console.error("Failed to paste:", e);
    }
  }

  async function doRename(path: string, newName: string, entry: FileEntry) {
    const oldName = entry.name;
    if (newName === oldName) return;
    const parentDir = path.substring(0, path.lastIndexOf("/"));
    const newPath = parentDir + "/" + newName;
    try {
      const { renamePath } = await import("../../lib/ipc/commands");
      await renamePath(path, newPath);
      await refreshTree();
      // Update open file references
      const ws = workspaceManager.activeWorkspace;
      if (ws) {
        if (entry.is_dir) {
          // Rename affects all files under this directory
          const oldPrefix = path + "/";
          const newPrefix = newPath + "/";
          for (const openFile of ws.openFiles) {
            if (openFile.path.startsWith(oldPrefix)) {
              const oldFilePath = openFile.path;
              const updatedPath = newPrefix + oldFilePath.substring(oldPrefix.length);
              delete ws.openFileIndex[oldFilePath];
              openFile.path = updatedPath;
              openFile.name = updatedPath.split("/").pop() ?? openFile.name;
              ws.openFileIndex[updatedPath] = openFile;
              for (const pane of Object.values(ws.panes)) {
                if (pane.kind !== "editor" || !pane.filePaths) continue;
                const idx = pane.filePaths.indexOf(oldFilePath);
                if (idx !== -1) pane.filePaths[idx] = updatedPath;
                if (pane.activeFilePath === oldFilePath) pane.activeFilePath = updatedPath;
              }
            }
          }
        } else {
          const file = ws.openFileIndex[path];
          if (file) {
            delete ws.openFileIndex[path];
            file.path = newPath;
            file.name = newName;
            ws.openFileIndex[newPath] = file;
            for (const pane of Object.values(ws.panes)) {
              if (pane.kind !== "editor" || !pane.filePaths) continue;
              const idx = pane.filePaths.indexOf(path);
              if (idx !== -1) pane.filePaths[idx] = newPath;
              if (pane.activeFilePath === path) pane.activeFilePath = newPath;
            }
          }
        }
      }
    } catch (e) {
      console.error("Failed to rename:", e);
    }
  }

  async function actionDelete(path: string, isFile: boolean) {
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      const confirmed = await ask(
        `Are you sure you want to delete "${path.split("/").pop()}"?`,
        { title: "Delete", kind: "warning" },
      );
      if (!confirmed) return;
      const { deletePath } = await import("../../lib/ipc/commands");
      await deletePath(path);
      await refreshTree();
      // Close deleted files if open
      const ws = workspaceManager.activeWorkspace;
      if (ws) {
        if (isFile) {
          workspaceManager.closeFileInWorkspace(path);
        } else {
          // Close all files under deleted directory
          const prefix = path + "/";
          const toClose = ws.openFiles.filter(f => f.path.startsWith(prefix)).map(f => f.path);
          for (const p of toClose) {
            workspaceManager.closeFileInWorkspace(p);
          }
        }
      }
    } catch (e) {
      console.error("Failed to delete:", e);
    }
  }

  function actionCollapseAll() {
    collapseGeneration++;
    rootExpanded = true;
  }
</script>

<svelte:document onclick={handleDocClick} />

{#if promptMode === "rename"}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-[200]"
    onclick={(e) => { if (e.target === e.currentTarget) closePrompt(); }}
    onkeydown={(e) => { if (e.key === "Escape") closePrompt(); }}
  >
    <div
      class="fixed z-[201] rounded shadow-lg"
      style="top: 50%; left: 50%; transform: translate(-50%, -50%); min-width: 280px; background: var(--bg-palette); border: 1px solid var(--border);"
    >
      <div class="px-3 pt-3 pb-1 text-xs" style="color: var(--text-dim);">
        {promptLabel}
      </div>
      <div class="px-3 pb-3">
        <input
          bind:this={promptInputEl}
          bind:value={promptValue}
          class="w-full px-2 py-1.5 text-xs rounded outline-none"
          style="background: var(--bg-input); color: var(--text-bright); border: 1px solid var(--border);"
          onfocus={(e) => (e.target as HTMLInputElement).select()}
          onkeydown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); submitPrompt(); }
            if (e.key === "Escape") { e.preventDefault(); closePrompt(); }
          }}
        />
      </div>
    </div>
  </div>
{/if}

<div
  bind:this={treeEl}
  class="py-1.5 flex-1 min-w-max"
  role="tree"
  tabindex="0"
  onkeydown={handleKeyDown}
  oncontextmenu={handleTreeContextMenu}
>
  {#if rootName}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_interactive_supports_focus a11y_role_has_required_aria_props -->
    <div
      class="tree-item root-folder"
      style="padding-left: 8px; padding-right: 8px;"
      onclick={() => rootExpanded = !rootExpanded}
      oncontextmenu={handleRootContextMenu}
      role="treeitem"
      tabindex="0"
      aria-expanded={rootExpanded}
      aria-selected={false}
    >
      <i
        class="bi tree-chevron w-4 text-center text-xs text-txt-dim shrink-0 transition-transform duration-100"
        class:bi-chevron-down={rootExpanded}
        class:bi-chevron-right={!rootExpanded}
      ></i>
      <i class="bi bi-folder2 tree-file-icon folder text-lg mr-1.5 shrink-0"></i>
      <span class="text-txt-bright font-semibold whitespace-nowrap" title={rootPath}>{rootName}</span>
    </div>
  {/if}
  {#if rootExpanded}
    {#each entries as entry (entry.path)}
      <FileTreeItem
        {entry}
        depth={rootName ? 1 : 0}
        {onFileClick}
        {onFileDoubleClick}
        onContextMenu={handleItemContextMenu}
        {selectedPath}
        {focusedPath}
        {collapseGeneration}
        {refreshGeneration}
        {inlineCreateDir}
        {inlineCreateType}
        {sshWorkspaceId}
        onInlineCreateSubmit={submitInlineCreate}
        onInlineCreateCancel={cancelInlineCreate}
      />
    {/each}
    {#if inlineCreateDir === rootPath && inlineCreateType}
      <div
        class="tree-item"
        style="padding-left: {8 + (rootName ? 1 : 0) * 16}px; padding-right: 8px;"
      >
        <span class="w-4 shrink-0"></span>
        <i class="bi {inlineCreateType === 'folder' ? 'bi-folder2' : 'bi-file-earmark'} tree-file-icon {inlineCreateType === 'folder' ? 'folder' : ''} text-lg mr-1.5 shrink-0"></i>
        <input
          use:autoFocus
          class="flex-1 min-w-0 px-1 py-0 text-xs outline-none"
          style="background: var(--bg-input); color: var(--text-bright); border: 1px solid var(--accent); line-height: 20px;"
          onkeydown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); submitInlineCreate((e.target as HTMLInputElement).value); }
            if (e.key === "Escape") { e.preventDefault(); cancelInlineCreate(); }
          }}
          onblur={cancelInlineCreate}
        />
      </div>
    {/if}
  {/if}
</div>
