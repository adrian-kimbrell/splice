<script lang="ts">
  import { onMount } from "svelte";
  import LeftSidebar from "./sidebar/LeftSidebar.svelte";
  import RightSidebar from "./sidebar/RightSidebar.svelte";
  import EditorPane from "./panes/EditorPane.svelte";
  import TerminalPane from "./panes/TerminalPane.svelte";
  import PaneGrid from "./panes/PaneGrid.svelte";
  import TopBar from "./topbar/TopBar.svelte";
  import CommandPalette from "./overlays/CommandPalette.svelte";
  import Toasts from "./overlays/Toasts.svelte";
  import { openSettingsWindow } from "../lib/utils/settings-window";
  import { openNewWindow } from "../lib/utils/new-window";
  import { ui } from "../lib/stores/ui.svelte";
  import { initKeybindings, enterZenMode, exitZenMode } from "../lib/utils/keybindings";
  import type { FileEntry } from "../lib/stores/files.svelte";
  import type { PaneConfig, SplitDirection } from "../lib/stores/layout.svelte";
  import { type DropZone, setDropCallback } from "../lib/stores/drag.svelte";
  import type { TabDragData } from "../lib/stores/drag.svelte";
  import { workspaceManager, type Workspace } from "../lib/stores/workspace.svelte";
  import { getLanguageName } from "../lib/utils/language";
  import { settings, initSettings, debouncedSaveSettings, flushSettingsSave } from "../lib/stores/settings.svelte";
  import type { Settings } from "../lib/stores/settings.svelte";
  import { applyTheme } from "../lib/theme/themes";
  import { dispatchEditorAction } from "../lib/stores/editor-actions.svelte";
  import { recentFiles, loadRecentFiles, addRecentFile } from "../lib/stores/recent-files.svelte";
  import { recentProjects, loadRecentProjects } from "../lib/stores/recent-projects.svelte";
  import { pushToast } from "../lib/stores/toasts.svelte";
  import { isUnderRoot } from "../lib/utils/path-utils";
  import { cancelPendingResume } from "../lib/stores/workspace-session";

  // Pre-import commands module for fast access after first load
  let _commands: typeof import("../lib/ipc/commands") | null = null;
  async function getCommands() {
    if (!_commands) _commands = await import("../lib/ipc/commands");
    return _commands;
  }

  function handleSplitPane(paneId: string, direction: SplitDirection, side: "before" | "after" = "after") {
    workspaceManager.splitPane(paneId, direction, side);
  }

  function handlePaneAction(action: string) {
    switch (action) {
      case "new-file":
        workspaceManager.newUntitledFile();
        break;
      case "open-file":
        handleOpenFile();
        break;
      case "search-project":
        // TODO: project search
        break;
      case "search-symbols":
        // TODO: symbol search
        break;
      case "new-terminal":
        workspaceManager.spawnTerminalInWorkspace();
        break;
    }
  }

  /** Returns "save" | "discard" | "cancel" */
  async function confirmUnsaved(): Promise<"save" | "discard" | "cancel"> {
    if (isTauri) {
      try {
        const { ask } = await import("@tauri-apps/plugin-dialog");
        // Dialog 1: "Save" keeps file; "Cancel" means don't save → proceeds to
      // dialog 2 so the user can still abort. This gives a Cancel path from
      // the very first dialog, unlike a "Don't Save" label that implies finality.
      const save = await ask("This pane has unsaved changes. Save before closing?", {
          title: "Unsaved Changes",
          kind: "warning",
          okLabel: "Save",
          cancelLabel: "Cancel",
        });
        if (save) return "save";
        // Dialog 2: confirm the discard, or truly cancel.
        const discard = await ask("Close without saving? Unsaved changes will be lost.", {
          title: "Close Without Saving",
          kind: "warning",
          okLabel: "Close Without Saving",
          cancelLabel: "Cancel",
        });
        return discard ? "discard" : "cancel";
      } catch {
        return window.confirm("Discard unsaved changes?") ? "discard" : "cancel";
      }
    }
    const ok = confirm("You have unsaved changes. Close anyway?");
    return ok ? "discard" : "cancel";
  }

  async function handleClosePane(paneId: string) {
    if (workspaceManager.hasDirtyFiles(paneId)) {
      const choice = await confirmUnsaved();
      if (choice === "cancel") return;
      if (choice === "save") {
        const ws = workspaceManager.activeWorkspace;
        if (ws) {
          const pane = ws.panes[paneId];
          const dirtyPaths = (pane?.filePaths ?? []).filter((p) =>
            ws.openFileIndex[p]?.dirty,
          );
          for (const p of dirtyPaths) {
            const saved = await workspaceManager.saveFile(p);
            if (!saved) return; // User cancelled Save As → abort close
          }
        }
      }
    }
    workspaceManager.closePaneInWorkspace(paneId);
  }

  async function handleCloseActiveTab() {
    const ws = workspaceManager.activeWorkspace;
    if (!ws?.activePaneId) return;
    const pane = ws.panes[ws.activePaneId];
    if (!pane) return;
    if (pane.kind === "editor" && pane.activeFilePath) {
      await handleTabClose(pane.activeFilePath, ws.activePaneId);
    } else if (pane.kind === "terminal") {
      await handleClosePane(ws.activePaneId);
    }
  }

  async function handleCloseAllTabs() {
    const ws = workspaceManager.activeWorkspace;
    if (!ws?.activePaneId) return;
    const pane = ws.panes[ws.activePaneId];
    if (!pane || pane.kind !== "editor") return;
    const paths = [...(pane.filePaths ?? [])];
    // Check for dirty files
    const dirtyPaths = paths.filter((p) =>
      ws.openFileIndex[p]?.dirty,
    );
    if (dirtyPaths.length > 0) {
      const choice = await confirmUnsaved();
      if (choice === "cancel") return;
      if (choice === "save") {
        for (const p of dirtyPaths) {
          const saved = await workspaceManager.saveFile(p);
          if (!saved) return;
        }
      }
    }
    for (const p of paths) {
      workspaceManager.closeFileInWorkspace(p, ws.activePaneId);
    }
  }

  async function handleCloseWorkspace() {
    const ws = workspaceManager.activeWorkspace;
    if (!ws) return;
    const dirtyFiles = ws.openFiles.filter((f) => f.dirty);
    if (dirtyFiles.length > 0) {
      const choice = await confirmUnsaved();
      if (choice === "cancel") return;
      if (choice === "save") {
        for (const f of dirtyFiles) {
          const saved = await workspaceManager.saveFile(f.path);
          if (!saved) return;
        }
      }
    }
    await workspaceManager.closeWorkspaceWithCleanup(ws.id);
  }

  async function handleTabClose(path: string, paneId: string) {
    if (workspaceManager.isFileDirty(path)) {
      const choice = await confirmUnsaved();
      if (choice === "cancel") return;
      if (choice === "save") {
        const saved = await workspaceManager.saveFile(path);
        if (!saved) return; // User cancelled Save As → abort close
      }
    }
    workspaceManager.closeFileInWorkspace(path, paneId);
  }

  function handlePaneClick(paneId: string) {
    workspaceManager.setActivePaneId(paneId);
  }

  function handleWindowFocus() {
    const paneId = ui.zoomedPaneId ?? workspaceManager.activeWorkspace?.activePaneId;
    if (!paneId) return;
    const paneEl = document.querySelector(`[data-pane-id="${paneId}"]`);
    const target = paneEl?.querySelector<HTMLElement>('canvas[tabindex], .cm-content');
    target?.focus();
  }

  function handleTabDrop(
    filePath: string,
    sourcePaneId: string,
    targetPaneId: string,
    direction: SplitDirection,
    side: "before" | "after",
    zone: DropZone,
  ) {
    if (zone === "center") {
      workspaceManager.moveTabToExistingPane(filePath, sourcePaneId, targetPaneId);
    } else {
      workspaceManager.moveTabToNewPane(filePath, sourcePaneId, targetPaneId, direction, side);
    }
  }

  let selectedFilePath = $state<string | null>(null);

  // --- Physical sidebar layout derived from logical panel state ---
  const explorerOnLeft = $derived(settings.appearance.explorer_side === "left");

  // Map physical sides to logical panels
  const leftVisible = $derived(explorerOnLeft ? ui.explorerVisible : ui.workspacesVisible);
  const rightVisible = $derived(explorerOnLeft ? ui.workspacesVisible : ui.explorerVisible);
  const leftWidth = $derived(explorerOnLeft ? ui.explorerWidth : ui.workspacesWidth);
  const rightWidth = $derived(explorerOnLeft ? ui.workspacesWidth : ui.explorerWidth);
  const leftMinWidth = $derived(explorerOnLeft ? 120 : 62);
  const rightMinWidth = $derived(explorerOnLeft ? 62 : 120);
  const leftLabel = $derived(explorerOnLeft ? "Explorer" : "Workspaces");
  const rightLabel = $derived(explorerOnLeft ? "Workspaces" : "Explorer");

  function setLeftWidth(w: number) {
    if (explorerOnLeft) ui.explorerWidth = w;
    else ui.workspacesWidth = w;
  }
  function setRightWidth(w: number) {
    if (explorerOnLeft) ui.workspacesWidth = w;
    else ui.explorerWidth = w;
  }
  function toggleLeft() {
    if (explorerOnLeft) ui.explorerVisible = !ui.explorerVisible;
    else ui.workspacesVisible = !ui.workspacesVisible;
  }
  function toggleRight() {
    if (explorerOnLeft) ui.workspacesVisible = !ui.workspacesVisible;
    else ui.explorerVisible = !ui.explorerVisible;
  }

  // Sidebar resize drag state
  let draggingSidebar: "left" | "right" | null = $state(null);

  function handleSidebarResizeDown(side: "left" | "right", e: MouseEvent) {
    e.preventDefault();
    draggingSidebar = side;
    const startX = e.clientX;
    const startWidth = side === "left" ? leftWidth : rightWidth;
    const min = side === "left" ? leftMinWidth : rightMinWidth;

    function onMove(e: MouseEvent) {
      const delta = e.clientX - startX;
      const newWidth = side === "left" ? startWidth + delta : startWidth - delta;
      const clamped = Math.max(min, Math.min(500, newWidth));
      if (side === "left") setLeftWidth(clamped);
      else setRightWidth(clamped);
    }

    function onUp() {
      draggingSidebar = null;
      // Persist sidebar widths to settings
      settings.appearance.explorer_width = ui.explorerWidth;
      settings.appearance.workspaces_width = ui.workspacesWidth;
      debouncedSaveSettings();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // Derive everything from the active workspace — access $state fields directly for reactivity
  const ws = $derived.by(() => {
    const id = workspaceManager.activeWorkspaceId;
    if (!id) return null;
    return workspaceManager.workspaces[id] ?? null;
  });

  const fileTree = $derived(ws?.fileTree ?? []);

  const activePane = $derived(ws?.activePaneId ? ws.panes[ws.activePaneId] ?? null : null);
  const activeFileName = $derived(
    activePane?.kind === "editor" && activePane.activeFilePath
      ? activePane.activeFilePath.split("/").pop() ?? null
      : null,
  );
  const statusLanguage = $derived(
    activePane?.kind === "editor" && activePane.activeFilePath
      ? getLanguageName(activePane.activeFilePath)
      : "",
  );

  function getTabsForPane(workspace: Workspace, config: PaneConfig): { name: string; path: string; preview?: boolean; dirty?: boolean; pinned?: boolean; readOnly?: boolean }[] {
    if (config.kind !== "editor") return [];
    const paths = config.filePaths ?? [];
    return paths.map((p) => {
      const openFile = workspace.openFileIndex[p];
      return { name: openFile?.name ?? p.split("/").pop() ?? "untitled", path: p, preview: openFile?.preview, dirty: openFile?.dirty, pinned: openFile?.pinned, readOnly: openFile?.readOnly };
    });
  }

  function getActiveTabForPane(config: PaneConfig): string | null {
    if (config.kind !== "editor") return null;
    return config.activeFilePath ?? null;
  }

  function getContentForPane(workspace: Workspace, config: PaneConfig): string {
    if (config.kind !== "editor") return "";
    const activePath = config.activeFilePath;
    if (!activePath) return "";
    return workspace.openFileIndex[activePath]?.content ?? "";
  }

  async function handleFileClick(entry: FileEntry) {
    selectedFilePath = entry.path;
    if (entry.is_dir) return;

    try {
      // Use cached content if file is already open
      const existing = ws?.openFileIndex[entry.path];
      const content = existing ? existing.content : await getCommands().then(c => c.readFile(entry.path));
      workspaceManager.openFileInWorkspace({
        name: entry.name,
        path: entry.path,
        content,
        preview: true,
      });
      addRecentFile(entry.path);
    } catch (e) {
      console.error("Failed to read file:", e);
    }
  }

  async function handleFileDoubleClick(entry: FileEntry) {
    selectedFilePath = entry.path;
    if (entry.is_dir) return;

    try {
      // Use cached content if file is already open
      const existing = ws?.openFileIndex[entry.path];
      const content = existing ? existing.content : await getCommands().then(c => c.readFile(entry.path));
      workspaceManager.openFileInWorkspace({
        name: entry.name,
        path: entry.path,
        content,
        preview: false,
      });
      addRecentFile(entry.path);
    } catch (e) {
      console.error("Failed to read file:", e);
    }
  }

  function handleTabDoubleClick(path: string) {
    workspaceManager.promotePreviewTab(path);
  }

  function handleTabContextAction(action: string, path: string, paneId: string) {
    switch (action) {
      case "close":
        handleTabClose(path, paneId);
        break;
      case "close-others":
        workspaceManager.closeOtherFilesInPane(path, paneId);
        break;
      case "close-left":
        workspaceManager.closeFilesToLeftInPane(path, paneId);
        break;
      case "close-right":
        workspaceManager.closeFilesToRightInPane(path, paneId);
        break;
      case "close-clean":
        workspaceManager.closeCleanFilesInPane(paneId);
        break;
      case "close-all":
        workspaceManager.closeAllFilesInPane(paneId);
        break;
      case "toggle-readonly":
        workspaceManager.toggleFileReadOnly(path);
        break;
      case "toggle-pin":
        workspaceManager.toggleFilePinned(path);
        break;
    }
  }

  function handleTabClick(path: string, paneId: string) {
    workspaceManager.setActiveFileInWorkspace(path, paneId);
  }

  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  const taglines = [
    "A modern code editor",
    "Where bugs go to die",
    "Works on my machine™",
    "Just one more refactor",
    "git blame someone else",
    "printf debugging approved",
    "Built different (in Rust)",
    "Tab width: none of your business",
    "Ships code. Eventually.",
    "Bespoke code spelunking",
    "It's giving… IDE",
    "For the love of semicolons",
    "Ctrl+Z is a lifestyle",
    "The code writes itself (it doesn't)",
    "$ git commit -m 'fix'",
    "Stack Overflow, but faster",
    "404: work-life balance not found",
    "Your compiler's best friend",
    "Now with 20% fewer segfaults",
    "undefined is not a bug",
    "Technically it compiles",
    "rm -rf /node_modules && pray",
    "Have you tried turning it off and on again?",
    "It's not a bug, it's a feature",
    "Powered by caffeine and spite",
    "Your second favourite editor",
    "We have dark mode (obviously)",
    "Shipping bugs at the speed of light",
    "Brought to you by a sleep-deprived developer",
    "Type-safe, probably",
    "async/await for the soul",
    "// TODO: add more taglines",
    "segfault (core dumped)",
    "NaN out of 10 developers recommend",
    "sudo make me a sandwich",
    "merge conflicts not included",
    "git push --force (don't)",
    "0 days since last npm audit",
    "cargo build --release (please wait)",
    "Lovingly crafted by humans, allegedly",
    "Your therapist recommended this",
    "Less vim, more vibe",
    "Emacs users welcome (but concerned)",
    "VSCode refugees welcome",
    "No Copilot required",
    "Born in a terminal, raised in a browser",
    "Actually reads the error messages",
    "The IDE your IDE wants to be",
    "Making spaghetti code look beautiful",
    "Compiling… please stand by",
    "For developers who like to live dangerously",
    "100% organic, free-range code",
    "The last editor you'll ever need (until the next one)",
    "Batteries not included. node_modules are.",
    "Stack trace? More like stack novel",
    "Where console.log goes to shine",
    "One semicolon to rule them all",
    "Off by one error not included",
    "Ship it",
    "It builds locally",
    "In production, no one can hear you scream",
    "git init and pray",
    "Documentation? We don't do that here",
    "Comments are for quitters",
    "Linting: the voice in your head that won't shut up",
    "We don't talk about v0.0.1",
    "Refactoring is just rearranging deck chairs",
    "YOLO-driven development",
    "Now hiring: rubber duck",
    "Agile: we move the goalposts so you don't have to",
    "DELETE FROM todo_list WHERE done = false",
    "Hello, World!",
    "exit 0",
    ":wq",
    "^C",
    "throw new Error('not my problem')",
    "// this should not happen",
    "// I have no idea why this works",
    "catch (e) { /* ¯\\_(ツ)_/¯ */ }",
    "Making JavaScript slightly less painful",
    "Rust: because C++ wasn't scary enough",
    "undefined behaviour is a vibe",
    "Garbage collected, unlike my thoughts",
    "Null pointer? Barely know her",
    "The heap called, it's full",
    "Memory leaks are just long-term thinking",
    "Premature optimisation is the root of all evil",
    "Big O(h no)",
    "O(n²) problems",
    "Recursion: see recursion",
    "A monad is just a monoid in the category of endofunctors",
    "Write once, debug everywhere",
    "It works in staging",
    "Blame the intern",
    "The cloud is just someone else's computer",
    "Deploying at 4:59pm on a Friday",
    "One linter to rule them all",
    "Prettier? I barely know her",
    "ESLint said no",
    "TypeScript: making JavaScript feel something",
    "Type inference is your friend",
    "any is always the answer",
    "// eslint-disable-next-line",
    "@ts-ignore and pray",
    "Where import cycles go to flourish",
    "Side effects? What side effects?",
    "Pure functions, impure thoughts",
    "Referential transparency achieved",
    "Immutable data, mutable deadlines",
    "The bus factor is 1",
    "10x developer (of bugs)",
    "Senior developer: someone who's made more mistakes",
    "git log --oneline (sobbing)",
    "git stash pop (recklessly)",
    "Detached HEAD? Relatable",
    "Cherry-pick responsibly",
    "Rebase: the forbidden technique",
    "Your branch is 847 commits behind main",
    "Force push forgiveness, not permission",
    "No tests, no mercy",
    "Tests are just code that tests your patience",
    "100% test coverage (of the wrong things)",
    "TDD: Test Driven Despair",
    "CI/CD: Crying In / Crying Daily",
    "Docker: it works in the container",
    "Kubernetes: because one abstraction wasn't enough",
    "Microservices: distributing the blame",
    "Serverless: someone else's problem",
    "The database is probably fine",
    "SELECT * FROM problems",
    "N+1 queries? Bold strategy",
    "Indexes are for people who care",
    "Normalisation: overrated",
    "It's not a deadlock, it's a standoff",
    "Race conditions build character",
    "mutex my beloved",
    "Async all the way down",
    "Callback hell: now with async/await",
    "Promises were made",
    "Event loop trauma",
    "Maximum call stack exceeded (emotionally)",
    "Heap snapshot: don't look",
    "Profiling is just self-reflection for code",
    "Lighthouse score: 23",
    "Bundle size: eventually your problem",
    "Tree shaking the will to live",
    "webpack config: cursed artifact",
    "Vite: fast, unlike your backend",
    "Hot module replacement for the soul",
    "The DOM is not your friend",
    "innerHTML and we don't care",
    "z-index: 9999",
    "display: flex (and cry)",
    "It looks fine on my screen",
    "Mobile-first (lies)",
    "Responsive by accident",
    "Accessibility? Noted",
    "Semantic HTML is a myth",
    "Div soup, anyone?",
    "CSS: Cascading Style Suffering",
    "margin: auto (hoping for the best)",
    "!important considered harmful",
    "Dark mode: the only mode",
    "Light mode users need not apply",
    "fn main() { println!(\"help\"); }",
    "The borrow checker is always right",
    "Lifetime annotations: trust the process",
    "unsafe { /* here be dragons */ }",
    "cargo clippy --fix (a blessing)",
    "No GC, no problem",
    "Zero-cost abstractions, infinite-cost debugging",
    "Where null references come to die",
    "Option<hope>",
    "Result<sanity, Error>",
    "unwrap() and cope",
    "Match exhaustively or don't match at all",
    "Move semantics: no take-backs",
    "The borrower always pays",
    "impl Display for Frustration",
    "Vec<thought> is empty",
    "HashMap<desire, reality>",
    "Arc<Mutex<Sanity>>",
    "Box<dyn Problem>",
    "where T: Tired",
    "Fearless concurrency (terrified developer)",
    "Clippy has thoughts",
    "The type system is trying to help",
    "Compiler error E0502: overlapping borrows on your dreams",
    "Made with ❤️ and stack traces",
    "404: motivation not found",
    "Stands for nothing, ships for everything",
    "est. git init",
    "Offline-first, online-last",
    "Your keyboard deserves better",
    "Pair programming with yourself",
    "Single-threaded ambitions",
    "println! considered elegant",
    "The linter loves you (it just has a funny way of showing it)",
    "Every pixel placed with indifference",
    "Tabs. Final answer.",
    "Spaces. Just kidding. Tabs.",
    "Vim mode: coming eventually",
    "Opens instantly (the terminal does)",
    "No electron was harmed",
    "Lighter than VS Code by several pounds",
    "Memory usage: surprisingly reasonable",
    "The one with the good terminal",
    "More terminal, less configuration",
    "Commit early, commit often, commit regrets",
    "Your git history is a cry for help",
    "main is just a suggestion",
    "const correctness is a personality",
    "Monorepo survivor",
    "cargo test (fingers crossed)",
    "One weird trick to ship faster",
    "Buy low, sell high, deploy on Fridays",
    "If it's stupid but it works…",
    "First, do no harm. Then, ship.",
    "Don't panic (but maybe panic)",
    "Loading your existential dread…",
    "Compiles in release mode",
    "Indexed by anxiety",
    "Where WIP commits go to live",
    "Sponsored by no one, loved by someone",
  ];
  const tagline = taglines[Math.floor(Math.random() * taglines.length)];

  async function openDroppedFiles(paths: string[]) {
    if (!workspaceManager.activeWorkspace) {
      workspaceManager.createEmptyWorkspace();
    }

    for (const filePath of paths) {
      // Skip directories
      if (filePath.endsWith("/")) continue;

      try {
        const { readFile } = await getCommands();
        const content = await readFile(filePath);
        const name = filePath.split("/").pop() ?? "untitled";
        workspaceManager.openFileInWorkspace({ name, path: filePath, content });
        addRecentFile(filePath);
      } catch (e) {
        console.error("Failed to open dropped file:", e);
      }
    }
  }

  const showWelcome = $derived(
    Object.keys(workspaceManager.workspaces).length === 0,
  );

  async function handleOpenFolder() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
      if (selected) {
        if (!workspaceManager.activeWorkspace) {
          workspaceManager.createEmptyWorkspace();
        }
        await workspaceManager.openFolderInWorkspace(selected as string);
        ui.explorerVisible = true;
      }
    } catch (e) {
      console.error("Failed to open folder:", e);
    }
  }

  function handleNewFile() {
    workspaceManager.newUntitledFile();
  }

  async function handleOpenFile() {
    if (!isTauri) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: false, multiple: false });
      if (selected) {
        if (!workspaceManager.activeWorkspace) {
          workspaceManager.createEmptyWorkspace();
        }
        const { readFile } = await getCommands();
        const filePath = selected as string;
        const content = await readFile(filePath);
        const name = filePath.split("/").pop() ?? "untitled";
        workspaceManager.openFileInWorkspace({ name, path: filePath, content });
        addRecentFile(filePath);
      }
    } catch (e) {
      console.error("Failed to open file:", e);
    }
  }

  // Hide sidebars on welcome screen, but user can toggle them back via drawers
  $effect(() => {
    if (showWelcome) {
      ui.explorerVisible = false;
      ui.workspacesVisible = false;
    }
  });

  // Sync sidebar visibility to the active workspace whenever it changes
  $effect(() => {
    const wsId = workspaceManager.activeWorkspaceId;
    const visible = ui.explorerVisible;
    if (wsId) {
      const w = workspaceManager.workspaces[wsId];
      if (w && w.explorerVisible !== visible) w.explorerVisible = visible;
    }
  });

  // Apply theme and UI scale when appearance settings change
  $effect(() => {
    applyTheme(settings.appearance.theme);
  });

  $effect(() => {
    document.documentElement.style.zoom = `${settings.appearance.ui_scale / 100}`;
  });

  $effect(() => {
    document.documentElement.style.setProperty("--font-size", `${settings.appearance.font_size}px`);
  });

  onMount(async () => {
    const stopKeybindings = initKeybindings();
    // Eagerly pre-import commands module
    import("../lib/ipc/commands").then(m => { _commands = m; });
    // Await settings before initializing workspaces (restore_previous_session check)
    await initSettings();
    // Restore sidebar widths from persisted settings
    ui.explorerWidth = settings.appearance.explorer_width ?? 240;
    ui.workspacesWidth = settings.appearance.workspaces_width ?? 220;

    let unlistenSettings: (() => void) | null = null;
    let unlistenAttention: (() => void) | null = null;
    let unlistenMenu: (() => void) | null = null;
    let unlistenDragDrop: (() => void) | null = null;
    let unlistenFileChanged: (() => void) | null = null;
    let unlistenTreeChanged: (() => void) | null = null;
    let unlistenClosing: (() => void) | null = null;
    let unlistenSession: (() => void) | null = null;

    // Register the Claude session listener BEFORE restoring workspaces so we
    // never miss a session event from a restored terminal's Claude process.
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenSession = await listen<{ terminal_id: number; session_id: string; claude_pid: number }>("terminal:claude-session", ({ payload }) => {
        const ws = Object.values(workspaceManager.workspaces).find(
          w => w.terminalIds.includes(payload.terminal_id)
        );
        const paneId = `term-${payload.terminal_id}`;
        if (ws?.panes[paneId]) {
          cancelPendingResume(payload.terminal_id);
          ws.panes[paneId].claudeSessionId = payload.session_id;
          ws.panes[paneId].claudePid = payload.claude_pid;
          workspaceManager.debouncedPersistWorkspace(ws.id);
        }
      });
    }

    workspaceManager.initializeWorkspaces();
    loadRecentFiles();
    loadRecentProjects();

    // Main window: reopen any secondary windows registered before a crash
    if (isTauri) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const currentLabel = getCurrentWindow().label;
      if (currentLabel === "main") {
        const { getSecondaryWindowLabels } = await getCommands();
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const labels = await getSecondaryWindowLabels();
        for (const l of labels) {
          new WebviewWindow(l, {
            url: "/",
            title: "Splice",
            width: 1280,
            height: 800,
            minWidth: 800,
            minHeight: 600,
            decorations: true,
            resizable: true,
          });
        }
      }
    }

    // Expose test helpers for WebDriver E2E automation
    (window as unknown as Record<string, unknown>).__spliceTest = {
      openWorkspace: (path: string) => workspaceManager.createWorkspaceFromDirectory(path),
      closeAllWorkspaces: () =>
        Promise.all(
          Object.keys(workspaceManager.workspaces).map((id) =>
            workspaceManager.closeWorkspaceWithCleanup(id)
          )
        ),
      getWorkspaceIds: () => Object.keys(workspaceManager.workspaces),
      /** Promote the active preview tab in the active editor pane to a permanent (pinned) tab. */
      pinCurrentTab: () => {
        const activeWs = workspaceManager.activeWorkspace;
        if (!activeWs) return;
        const pane = activeWs.activePaneId ? activeWs.panes[activeWs.activePaneId] : null;
        if (!pane || pane.kind !== "editor") return;
        const activePath = pane.activeFilePath;
        if (activePath) workspaceManager.promotePreviewTab(activePath);
      },
      /** Switch the active workspace by ID. */
      switchToWorkspace: (id: string) => workspaceManager.switchWorkspace(id),
      /** Return the currently active workspace ID. */
      getActiveWorkspaceId: () => workspaceManager.activeWorkspaceId,
      /** Open a file as a permanent (non-preview) tab in the active pane. */
      openFilePinned: async (filePath: string) => {
        const name = filePath.split("/").pop() ?? filePath;
        const existing = workspaceManager.activeWorkspace?.openFileIndex[filePath];
        const content = existing
          ? existing.content
          : await getCommands().then((c) => c.readFile(filePath));
        workspaceManager.openFileInWorkspace({ name, path: filePath, content, preview: false });
      },
      /** Directly mark the active file in the active pane as dirty (for E2E tests). */
      markActiveFileDirty: () => {
        const activeWs = workspaceManager.activeWorkspace;
        if (!activeWs) return;
        const pane = activeWs.activePaneId ? activeWs.panes[activeWs.activePaneId] : null;
        if (!pane || pane.kind !== "editor" || !pane.activeFilePath) return;
        const file = activeWs.openFileIndex[pane.activeFilePath];
        if (file) file.dirty = true;
      },
      /** Ensure the file explorer sidebar is visible (for E2E tests). */
      showExplorer: () => { ui.explorerVisible = true; },
      /** Return sidebar logical state (for E2E tests — avoids display:contents WebDriver ambiguity). */
      getSidebarState: () => ({ explorerVisible: ui.explorerVisible, sidebarMode: ui.sidebarMode }),
      /** Update the active file's in-memory content and mark it dirty (for save-verification tests). */
      updateActiveFileContent: (content: string) => {
        const activeWs = workspaceManager.activeWorkspace;
        if (!activeWs) return;
        const pane = activeWs.activePaneId ? activeWs.panes[activeWs.activePaneId] : null;
        if (!pane || pane.kind !== "editor" || !pane.activeFilePath) return;
        const file = activeWs.openFileIndex[pane.activeFilePath];
        if (file) { file.content = content; file.dirty = true; }
      },
      /** Return registered secondary window labels from windows.json (for E2E tests). */
      getWindowRegistry: async () => {
        const { getSecondaryWindowLabels } = await getCommands();
        return getSecondaryWindowLabels();
      },
      /** Open a new secondary window (for E2E tests). */
      openNewWindow: () => openNewWindow(),
      /** Return true if zen mode is active. */
      isZenMode: () => ui.zenMode,
      /** Return the current ui_scale (for command palette execution verification). */
      getUiScale: () => settings.appearance.ui_scale,
      /** Return Rust-side AppState HashMap sizes (e2e debug command, only works in --features e2e build). */
      getDebugStats: async () => {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          return await invoke("get_debug_stats");
        } catch {
          return null;
        }
      },
    };
    const stopGitPolling = workspaceManager.startGitBranchPolling();

    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      import("@tauri-apps/api/event").then(({ listen }) => {
        listen<Settings>("settings-changed", (event) => {
          const updated = event.payload;
          if (updated.general) Object.assign(settings.general, updated.general);
          if (updated.editor) Object.assign(settings.editor, updated.editor);
          if (updated.appearance) Object.assign(settings.appearance, updated.appearance);
          if (updated.terminal) Object.assign(settings.terminal, updated.terminal);
        }).then((fn) => { unlistenSettings = fn; });

        listen<string>("menu-event", (event) => {
          switch (event.payload) {
            case "new-file":
              handleNewFile();
              break;
            case "open-file":
              handleOpenFile();
              break;
            case "open-folder":
              handleOpenFolder();
              break;
            case "save":
              workspaceManager.saveActiveFile();
              break;
            case "save-as":
              workspaceManager.saveActiveFileAs();
              break;
            case "save-all":
              workspaceManager.saveAllDirtyFiles();
              break;
            case "close-tab":
              handleCloseActiveTab();
              break;
            case "close-all-tabs":
              handleCloseAllTabs();
              break;
            case "close-workspace":
              handleCloseWorkspace();
              break;
            case "settings":
              openSettingsWindow();
              break;
            case "find":
              dispatchEditorAction("find");
              break;
            case "find-in-files":
              ui.sidebarMode = "search";
              ui.explorerVisible = true;
              break;
            case "replace":
              dispatchEditorAction("replace");
              break;
            case "goto-line":
              dispatchEditorAction("goto-line");
              break;
            case "format-document":
              dispatchEditorAction("format-document");
              break;
            case "command-palette":
              ui.commandPaletteOpen = !ui.commandPaletteOpen;
              break;
            case "toggle-sidebar":
              ui.explorerVisible = !ui.explorerVisible;
              break;
            case "toggle-word-wrap":
              dispatchEditorAction("toggle-word-wrap");
              break;
            case "zoom-in":
              settings.appearance.ui_scale = Math.min(200, settings.appearance.ui_scale + 10);
              debouncedSaveSettings();
              break;
            case "zoom-out":
              settings.appearance.ui_scale = Math.max(50, settings.appearance.ui_scale - 10);
              debouncedSaveSettings();
              break;
            case "zoom-reset":
              settings.appearance.ui_scale = 100;
              debouncedSaveSettings();
              break;
            case "new-terminal":
              workspaceManager.spawnTerminalInWorkspace();
              break;
            case "new-window":
              openNewWindow();
              break;
            case "zen-mode":
              if (ui.zenMode) exitZenMode(); else enterZenMode();
              break;
          }
        }).then((fn) => { unlistenMenu = fn; });
      });

      const { installClaudeHook } = await getCommands();
      const { onAttentionNotify } = await import("../lib/ipc/events");
      const { attentionStore } = await import("../lib/stores/attention.svelte");

      installClaudeHook().catch(console.warn);

      unlistenAttention = await onAttentionNotify((payload) => {
        // Only show notifications for terminals that exist in a workspace
        const terminalExists = Object.values(workspaceManager.workspaces).some(
          w => w.terminalIds.includes(payload.terminal_id)
        );
        if (!terminalExists) return;
        attentionStore.notify({
          terminalId: payload.terminal_id,
          type: payload.notification_type === "permission_prompt" ? "permission" : "idle",
          message: payload.message,
          timestamp: Date.now(),
        });
      });

      // Persist all workspaces before the window closes, awaiting completion
      import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
        const appWindow = getCurrentWindow();
        const currentLabel = appWindow.label;
        unlistenClosing = await appWindow.onCloseRequested(async (event) => {
          event.preventDefault();
          flushSettingsSave();
          await Promise.allSettled(
            Object.keys(workspaceManager.workspaces).map(wsId =>
              workspaceManager.persistWorkspace(wsId)
            )
          );
          // Graceful close of secondary window: remove from registry + delete workspace file
          if (currentLabel !== "main") {
            const { unregisterWindow } = await getCommands();
            await unregisterWindow(currentLabel).catch(console.warn);
          }
          try {
            await appWindow.destroy();
          } catch {
            await appWindow.close();
          }
        });
      }).catch(console.warn);

      // Listen for file watcher events
      const { listen } = await import("@tauri-apps/api/event");
      listen<string>("file:changed", async (event) => {
        const changedPath = event.payload;
        for (const ws of Object.values(workspaceManager.workspaces)) {
          const file = ws.openFileIndex[changedPath];
          if (!file) continue;
          if (file.dirty) {
            pushToast("File changed externally: " + (changedPath.split("/").pop() ?? changedPath), "warning", 5000);
          } else {
            try {
              const { readFile } = await getCommands();
              const content = await readFile(changedPath);
              file.content = content;
              file.originalContent = content;
              file.dirty = false;
            } catch {
              // ignore read errors
            }
          }
        }
      }).then((fn) => { unlistenFileChanged = fn; });

      // Listen for directory tree changes (new/deleted/renamed files)
      let treeChangeTimer: ReturnType<typeof setTimeout> | null = null;
      listen<string>("tree:changed", (event) => {
        if (treeChangeTimer) clearTimeout(treeChangeTimer);
        treeChangeTimer = setTimeout(() => {
          treeChangeTimer = null;
          const changedPath = event.payload;
          for (const [wsId, w] of Object.entries(workspaceManager.workspaces)) {
            if (w.rootPath && isUnderRoot(changedPath, w.rootPath)) {
              workspaceManager.loadFileTree(wsId);
            }
          }
        }, 300);
      }).then((fn) => { unlistenTreeChanged = fn; });

      // Listen for native file drag-and-drop
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      unlistenDragDrop = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          openDroppedFiles(event.payload.paths);
        }
      });
    }

    // Listen for close-active-tab from keybindings
    const closeTabHandler = () => handleCloseActiveTab();
    document.addEventListener("splice:close-active-tab", closeTabHandler);

    // Listen for open-file from command palette
    const openFileHandler = () => handleOpenFile();
    document.addEventListener("splice:open-file", openFileHandler);

    setDropCallback((data: TabDragData, targetPaneId: string, zone: DropZone) => {
      if (!zone || !targetPaneId) return;

      const ws = workspaceManager.activeWorkspace;
      if (!ws) return;

      const sourceKind = data.kind ?? "editor";
      const targetKind = ws.panes[targetPaneId]?.kind ?? "editor";

      // Center zone between different pane kinds → swap positions
      if (zone === "center" && sourceKind !== targetKind && data.sourcePaneId !== targetPaneId) {
        workspaceManager.swapPanesInLayout(data.sourcePaneId, targetPaneId);
        return;
      }

      // Terminal source drags: layout-level operations (no tab merging)
      if (sourceKind === "terminal") {
        if (data.sourcePaneId === targetPaneId) return;
        if (zone === "center") {
          workspaceManager.swapPanesInLayout(data.sourcePaneId, targetPaneId);
        } else {
          let direction: SplitDirection = "horizontal";
          let side: "before" | "after" = "after";
          if (zone === "left") { direction = "horizontal"; side = "before"; }
          else if (zone === "right") { direction = "horizontal"; side = "after"; }
          else if (zone === "top") { direction = "vertical"; side = "before"; }
          else if (zone === "bottom") { direction = "vertical"; side = "after"; }
          workspaceManager.movePaneInLayout(data.sourcePaneId, targetPaneId, direction, side);
        }
        return;
      }

      // Editor tab drags (original behavior — works for any target kind)
      if (data.sourcePaneId === targetPaneId && zone === "center") return;
      if (data.sourcePaneId === targetPaneId) {
        const cfg = ws.panes[targetPaneId];
        if (cfg?.filePaths && cfg.filePaths.length <= 1) return;
      }

      let direction: SplitDirection = "horizontal";
      let side: "before" | "after" = "after";
      if (zone === "left") { direction = "horizontal"; side = "before"; }
      else if (zone === "right") { direction = "horizontal"; side = "after"; }
      else if (zone === "top") { direction = "vertical"; side = "before"; }
      else if (zone === "bottom") { direction = "vertical"; side = "after"; }
      handleTabDrop(data.filePath, data.sourcePaneId, targetPaneId, direction, side, zone);
    });

    return () => {
      stopKeybindings();
      setDropCallback(null);
      stopGitPolling();
      document.removeEventListener("splice:close-active-tab", closeTabHandler);
      document.removeEventListener("splice:open-file", openFileHandler);
      unlistenSettings?.();
      unlistenAttention?.();
      unlistenMenu?.();
      unlistenDragDrop?.();
      unlistenFileChanged?.();
      if (treeChangeTimer) clearTimeout(treeChangeTimer);
      unlistenTreeChanged?.();
      unlistenClosing?.();
      unlistenSession?.();
    };
  });
</script>

<svelte:window onfocus={handleWindowFocus} />

<div
  class="grid h-screen"
  style="grid-template-columns: {leftVisible && !ui.zenMode
    ? `${leftWidth}px 4px`
    : '0px 0px'} minmax(0,1fr) {rightVisible && !ui.zenMode
    ? `4px ${rightWidth}px`
    : '0px 0px'}; grid-template-rows: 1fr {ui.zenMode ? '0px' : 'var(--topbar-height)'};"
>

  <!-- LEFT SIDEBAR -->
  <div style:display={leftVisible ? 'contents' : 'none'}>
    {#if explorerOnLeft}
      <LeftSidebar
        entries={fileTree}
        onFileClick={handleFileClick}
        onFileDoubleClick={handleFileDoubleClick}
        selectedPath={selectedFilePath}
        hasFolder={!!ws?.rootPath}
        hasWorkspace={!!ws}
        rootPath={ws?.rootPath ?? ""}
        side="left"
      />
    {:else}
      <RightSidebar side="left" />
    {/if}
    <!-- Left resize handle -->
    <div
      style="grid-column: 2; grid-row: 1; cursor: col-resize; background: {draggingSidebar === 'left' ? '#aaaaaa' : 'var(--border)'}; transition: background 100ms;"
      role="separator"
      tabindex="0"
      aria-orientation="vertical"
      onmousedown={(e) => handleSidebarResizeDown('left', e)}
      onmouseenter={(e) => { if (!draggingSidebar) e.currentTarget.style.background = '#888888'; }}
      onmouseleave={(e) => { if (!draggingSidebar) e.currentTarget.style.background = 'var(--border)'; }}
      onkeydown={(e) => {
        if (e.key === "ArrowLeft") { e.preventDefault(); setLeftWidth(Math.max(leftMinWidth, leftWidth - 10)); }
        else if (e.key === "ArrowRight") { e.preventDefault(); setLeftWidth(Math.min(500, leftWidth + 10)); }
      }}
    ></div>
  </div>

  <!-- CENTER: PANE GRID — render ALL workspaces, hide inactive with display:none -->
  <div class="flex flex-col overflow-hidden min-w-0" style="grid-column: 3; grid-row: 1">
    {#each Object.entries(workspaceManager.workspaces) as [wsId, workspace] (wsId)}
      {@const isActive = wsId === workspaceManager.activeWorkspaceId}
      {@const hasContent = workspace.rootPath || workspace.layout !== null}
      <div
        class="flex-1 flex flex-col overflow-hidden min-w-0 min-h-0"
        style:display={isActive ? "flex" : "none"}
      >
        {#if hasContent}
          {#snippet paneSnippet(config: PaneConfig)}
            {#if config.kind === "editor"}
              {@const activeOpenFile = config.activeFilePath ? workspace.openFileIndex[config.activeFilePath] ?? null : null}
              <EditorPane
                tabs={getTabsForPane(workspace, config)}
                activeTab={getActiveTabForPane(config)}
                content={getContentForPane(workspace, config)}
                filePath={config.activeFilePath ?? ""}
                paneId={config.id}
                rootPath={workspace.rootPath ?? ""}
                readOnly={activeOpenFile?.readOnly ?? false}
                onTabClick={(path) => handleTabClick(path, config.id)}
                onTabClose={(path) => handleTabClose(path, config.id)}
                onTabDoubleClick={handleTabDoubleClick}
                onSplit={(dir, side) => handleSplitPane(config.id, dir, side)}
                onClose={() => handleClosePane(config.id)}
                onAction={handlePaneAction}
                onTabContextAction={(action, path) => handleTabContextAction(action, path, config.id)}
                onContentChange={(content) => {
                  if (config.activeFilePath) {
                    workspaceManager.updateFileContent(config.activeFilePath, content);
                  }
                }}
                onSave={() => workspaceManager.saveActiveFile()}
                onAutoSave={() => {
                  if (config.activeFilePath) {
                    workspaceManager.saveFileQuiet(config.activeFilePath);
                  }
                }}
              />
            {:else}
              <TerminalPane
                title={config.title}
                cwd={workspace.rootPath ?? ""}
                terminalId={config.terminalId ?? 0}
                paneId={config.id}
                active={isActive}
                onSplit={(dir, side) => handleSplitPane(config.id, dir, side)}
                onClose={() => handleClosePane(config.id)}
                onAction={handlePaneAction}
              />
            {/if}
          {/snippet}
          {#if workspace.layout}
          <div class="flex-1 flex overflow-hidden min-w-0 min-h-0 relative">
            <div class="flex-1 flex overflow-hidden min-w-0 min-h-0" style:visibility={isActive && ui.zoomedPaneId && workspace.panes[ui.zoomedPaneId] ? 'hidden' : 'visible'}>
              <PaneGrid
                node={workspace.layout}
                panes={workspace.panes}
                {paneSnippet}
                isRoot={true}
                activePaneId={workspace.activePaneId}
                onPaneClick={handlePaneClick}
              />
            </div>
            {#if isActive && ui.zoomedPaneId && workspace.panes[ui.zoomedPaneId]}
              <div class="absolute inset-0 flex overflow-hidden">
                {@render paneSnippet(workspace.panes[ui.zoomedPaneId])}
              </div>
            {/if}
          </div>
          {:else}
          <div class="flex-1 flex items-center justify-center">
            <div style="width: 96px; height: 96px; opacity: 0.35; background-color: var(--accent); -webkit-mask-image: url('/logo.png'); -webkit-mask-size: contain; -webkit-mask-repeat: no-repeat; -webkit-mask-position: center; mask-image: url('/logo.png'); mask-size: contain; mask-repeat: no-repeat; mask-position: center;" aria-hidden="true"></div>
          </div>
          {/if}
        {:else}
          <div class="flex-1 flex items-center justify-center">
            <div class="text-center">
              <i class="bi bi-file-earmark-plus text-3xl text-txt-dim mb-3 block"></i>
              <p class="text-txt-dim text-sm mb-4">Get started</p>
              <div class="flex flex-col gap-2">
                <button class="welcome-item welcome-item-compact" onclick={handleNewFile}>
                  <i class="bi bi-file-earmark-plus"></i>
                  <span style="flex: none;">New File</span>
                </button>
                {#if isTauri}
                  <button class="welcome-item welcome-item-compact" onclick={handleOpenFolder}>
                    <i class="bi bi-folder2-open"></i>
                    <span style="flex: none;">Open Folder</span>
                  </button>
                {/if}
                <button class="welcome-item welcome-item-compact" onclick={() => workspaceManager.spawnTerminalInWorkspace()}>
                  <i class="bi bi-terminal"></i>
                  <span style="flex: none;">Terminal</span>
                </button>
              </div>
            </div>
          </div>
        {/if}
      </div>
    {:else}
      <div class="welcome-screen flex-1 flex items-center justify-center">
        <div class="welcome-container">
          <div class="welcome-header">
            <div style="width: 64px; height: 64px; background-color: var(--accent); -webkit-mask-image: url('/logo.png'); -webkit-mask-size: contain; -webkit-mask-repeat: no-repeat; -webkit-mask-position: center; mask-image: url('/logo.png'); mask-size: contain; mask-repeat: no-repeat; mask-position: center;" aria-label="Splice"></div>
            <div>
              <div class="text-txt-bright text-xl font-medium">Splice</div>
              <div class="text-txt-dim text-xs">{tagline}</div>
            </div>
          </div>

          <fieldset class="welcome-section">
            <legend class="welcome-legend">Get Started</legend>
            <button class="welcome-item" onclick={handleNewFile}>
              <i class="bi bi-file-earmark-plus"></i>
              <span>New File</span>
              <kbd>Cmd N</kbd>
            </button>
            {#if isTauri}
              <button class="welcome-item" onclick={handleOpenFolder}>
                <i class="bi bi-folder2-open"></i>
                <span>Open Folder</span>
                <kbd>Cmd O</kbd>
              </button>
            {/if}
            <button class="welcome-item" onclick={() => (ui.commandPaletteOpen = true)}>
              <i class="bi bi-command"></i>
              <span>Command Palette</span>
              <kbd>Cmd P</kbd>
            </button>
          </fieldset>

          {#if recentProjects.length > 0}
            <fieldset class="welcome-section">
              <legend class="welcome-legend">Recent</legend>
              {#each recentProjects.slice(0, 5) as projectPath}
                <button class="welcome-item" onclick={() => {
                  workspaceManager.createWorkspaceFromDirectory(projectPath);
                }}>
                  <i class="bi bi-folder2" style="flex-shrink: 0;"></i>
                  <span style="flex: none;">{projectPath.split("/").filter(Boolean).pop()}</span>
                  <span class="text-txt-dim text-[10px] truncate" style="flex: 1; min-width: 0;">{projectPath}</span>
                </button>
              {/each}
            </fieldset>
          {/if}

          <fieldset class="welcome-section">
            <legend class="welcome-legend">Configure</legend>
            <button class="welcome-item" onclick={openSettingsWindow}>
              <i class="bi bi-gear"></i>
              <span>Open Settings</span>
              <kbd>Cmd ,</kbd>
            </button>
          </fieldset>
        </div>
      </div>
    {/each}
  </div>

  <!-- RIGHT SIDEBAR -->
  <div style:display={rightVisible ? 'contents' : 'none'}>
    <!-- Right resize handle -->
    <div
      style="grid-column: 4; grid-row: 1; cursor: col-resize; background: {draggingSidebar === 'right' ? '#aaaaaa' : 'var(--border)'}; transition: background 100ms;"
      role="separator"
      tabindex="0"
      aria-orientation="vertical"
      onmousedown={(e) => handleSidebarResizeDown('right', e)}
      onmouseenter={(e) => { if (!draggingSidebar) e.currentTarget.style.background = '#888888'; }}
      onmouseleave={(e) => { if (!draggingSidebar) e.currentTarget.style.background = 'var(--border)'; }}
      onkeydown={(e) => {
        if (e.key === "ArrowLeft") { e.preventDefault(); setRightWidth(Math.min(500, rightWidth + 10)); }
        else if (e.key === "ArrowRight") { e.preventDefault(); setRightWidth(Math.max(rightMinWidth, rightWidth - 10)); }
      }}
    ></div>
    {#if !explorerOnLeft}
      <LeftSidebar
        entries={fileTree}
        onFileClick={handleFileClick}
        onFileDoubleClick={handleFileDoubleClick}
        selectedPath={selectedFilePath}
        hasFolder={!!ws?.rootPath}
        hasWorkspace={!!ws}
        rootPath={ws?.rootPath ?? ""}
        side="right"
      />
    {:else}
      <RightSidebar side="right" />
    {/if}
  </div>

  <!-- BOTTOM BAR (was top bar + status bar) -->
  <TopBar workspaceName={ws?.name ?? "Splice"} language={statusLanguage} branch={ws?.gitBranch ?? ""} />

  <!-- OVERLAYS -->
  <CommandPalette />
  <Toasts />
</div>

<!-- Left edge drawer trigger -->
<div
  class="sidebar-drawer-zone"
  style="left: {leftVisible ? `${leftWidth + 2}px` : '3px'}"
>
  <button
    class="sidebar-drawer-btn"
    title={leftVisible ? `Hide ${leftLabel}` : `Show ${leftLabel}`}
    onclick={toggleLeft}
  >
    <i class="bi bi-chevron-{leftVisible ? 'left' : 'right'}" style="font-size: var(--ui-sm);"></i>
  </button>
</div>

<!-- Right edge drawer trigger -->
<div
  class="sidebar-drawer-zone right"
  style="right: {rightVisible ? `${rightWidth + 2}px` : '3px'}"
>
  <button
    class="sidebar-drawer-btn"
    title={rightVisible ? `Hide ${rightLabel}` : `Show ${rightLabel}`}
    onclick={toggleRight}
  >
    <i class="bi bi-chevron-{rightVisible ? 'right' : 'left'}" style="font-size: var(--ui-sm);"></i>
  </button>
</div>
