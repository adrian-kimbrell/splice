<script lang="ts">
  import { onMount } from "svelte";
  import { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, scrollPastEnd, placeholder, keymap } from "@codemirror/view";
  import { EditorState, Compartment } from "@codemirror/state";
  import { lintGutter, setDiagnostics } from "@codemirror/lint";
  import type { Diagnostic as CmDiagnostic } from "@codemirror/lint";
  import { bracketMatching, indentOnInput, foldGutter, foldKeymap, indentUnit, indentRange } from "@codemirror/language";
  import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from "@codemirror/commands";
  import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from "@codemirror/autocomplete";
  import { search, searchKeymap, highlightSelectionMatches, gotoLine, openSearchPanel } from "@codemirror/search";
  import { cursorMatchingBracket } from "@codemirror/commands";
  import { editorTheme, editorHighlighting } from "../../lib/theme/editor-theme";
  import { conflictExtension, conflictTheme } from "../../lib/editor/conflict-extension";
  import { settings, effectiveSettings } from "../../lib/stores/settings.svelte";
  import { editorActions, dispatchEditorAction } from "../../lib/stores/editor-actions.svelte";
  import { workspaceManager } from "../../lib/stores/workspace.svelte";
  import { showContextMenu } from "../../lib/utils/context-menu";
  import { lspClient } from "../../lib/lsp/client";
  import type { LspLocation, WorkspaceEdit, CodeAction } from "../../lib/lsp/client";
  import { getDiagnosticsForUri } from "../../lib/stores/diagnostics.svelte";
  import { pushToast } from "../../lib/stores/toasts.svelte";
  import { ui } from "../../lib/stores/ui.svelte";
  import { getExtForPath, getLanguageExtension } from "../../lib/editor/language-loader";
  import { lspKindToType, lspServerName, buildLspCompletionSource, buildHoverExtension } from "../../lib/editor/lsp-extensions";

  let {
    content,
    filePath,
    paneId = "",
    readonly = false,
    onContentChange,
    onSave,
    onAutoSave,
  }: {
    content: string;
    filePath: string;
    paneId?: string;
    readonly?: boolean;
    onContentChange?: (content: string) => void;
    onSave?: () => void;
    onAutoSave?: () => void;
  } = $props();

  let containerEl: HTMLDivElement;
  let view: EditorView | undefined;
  let viewReady = $state(false);
  let suppressContentChange = false;
  const langCompartment = new Compartment();
  const tabSizeCompartment = new Compartment();
  const indentUnitCompartment = new Compartment();
  const lineNumbersCompartment = new Compartment();
  const highlightActiveLineCompartment = new Compartment();
  const bracketMatchingCompartment = new Compartment();
  const closeBracketsCompartment = new Compartment();
  const scrollPastEndCompartment = new Compartment();
  const wordWrapCompartment = new Compartment();
  const readonlyCompartment = new Compartment();
  const autoSaveCompartment = new Compartment();
  const minimapCompartment = new Compartment();
  const indentGuidesCompartment = new Compartment();
  const lintCompartment = new Compartment();
  const hoverCompartment = new Compartment();
  const completionCompartment = new Compartment();

  // LSP state
  let lspReferences = $state<LspLocation[] | null>(null);
  let renaming = $state(false);
  let renamePos = $state({ x: 0, y: 0 });
  let renameName = $state("");
  let renameTarget = $state({ line: 0, char: 0 });

  function formatDocument(view: EditorView): boolean {
    const state = view.state;
    const ext = getExtForPath(filePath);

    if (ext === ".json") {
      try {
        const parsed = JSON.parse(state.doc.toString());
        const formatted = JSON.stringify(parsed, null, state.tabSize);
        view.dispatch({
          changes: { from: 0, to: state.doc.length, insert: formatted },
        });
        return true;
      } catch {
        // Invalid JSON — fall through to re-indent
      }
    }

    const changes = indentRange(state, 0, state.doc.length);
    if (changes) view.dispatch(changes);
    return true;
  }

  // LSP helpers
  const isTauri = "__TAURI_INTERNALS__" in window;

  function getCursorLspPos(pos: number): LspPos {
    const lineInfo = view!.state.doc.lineAt(pos);
    return { line: lineInfo.number - 1, character: pos - lineInfo.from };
  }

  function getWorkspaceRoot(): string {
    return workspaceManager.activeWorkspace?.rootPath ?? "";
  }

  async function navigateToLocation(loc: LspLocation): Promise<void> {
    const path = lspClient.uriToPath(loc.uri);
    const targetLine = loc.range.start.line + 1;
    if (path === filePath) {
      // Same file — just jump, no need to read from disk
      dispatchEditorAction("goto-line-number", targetLine);
      return;
    }
    // Cross-file: read content from disk so the editor opens correctly
    const { readFile } = await import("../../lib/ipc/commands");
    const content = await readFile(path).catch(() => "");
    workspaceManager.openFileInWorkspace({ name: path, path, content });
    setTimeout(() => dispatchEditorAction("goto-line-number", targetLine), 50);
  }

  async function navigateOrShowPicker(locs: LspLocation[]): Promise<void> {
    if (!locs.length) return;
    if (locs.length === 1) {
      navigateToLocation(locs[0]);
      return;
    }
    // If all locations are in the same file, navigate to the first
    if (locs.every((l) => lspClient.uriToPath(l.uri) === filePath)) {
      navigateToLocation(locs[0]);
      return;
    }
    lspReferences = locs;
  }

  async function applyWorkspaceEdit(edit: WorkspaceEdit): Promise<void> {
    if (!edit.changes) return;
    for (const [uri, edits] of Object.entries(edit.changes)) {
      const path = lspClient.uriToPath(uri);
      if (path === filePath) {
        // Apply in-editor via CodeMirror dispatch (sorted reverse to preserve offsets)
        const sorted = [...edits].sort(
          (a, b) =>
            b.range.start.line - a.range.start.line ||
            b.range.start.character - a.range.start.character,
        );
        for (const e of sorted) {
          const from =
            view!.state.doc.line(e.range.start.line + 1).from +
            e.range.start.character;
          const to =
            view!.state.doc.line(e.range.end.line + 1).from +
            e.range.end.character;
          view!.dispatch({ changes: { from, to, insert: e.newText } });
        }
      } else {
        // Apply to file on disk
        const { readFile, writeFile } = await import("../../lib/ipc/commands");
        const current = await readFile(path);
        const lines = current.split("\n");
        const sorted = [...edits].sort(
          (a, b) => b.range.start.line - a.range.start.line,
        );
        for (const e of sorted) {
          const ln = e.range.start.line;
          lines[ln] =
            lines[ln].slice(0, e.range.start.character) +
            e.newText +
            lines[ln].slice(e.range.end.character);
        }
        await writeFile(path, lines.join("\n"));
      }
    }
  }

  function groupReferencesByFile(
    locs: LspLocation[],
  ): { shortPath: string; items: LspLocation[] }[] {
    const groups = new Map<string, LspLocation[]>();
    for (const loc of locs) {
      const arr = groups.get(loc.uri) ?? [];
      arr.push(loc);
      groups.set(loc.uri, arr);
    }
    return Array.from(groups.entries()).map(([uri, items]) => {
      const p = lspClient.uriToPath(uri);
      const parts = p.split("/").filter(Boolean);
      const shortPath = parts.slice(-2).join("/");
      return { shortPath, items };
    });
  }

  function triggerRename(): void {
    if (!view) return;
    const pos = view.state.selection.main.head;
    const { line: lspLine, character: lspChar } = getCursorLspPos(pos);
    lspClient
      .prepareRename(filePath, lspLine, lspChar)
      .catch(() => null)
      .then((prep) => {
        if (!prep) return;
        const coords = view!.coordsAtPos(pos);
        renamePos = { x: coords?.left ?? 0, y: coords?.top ?? 0 };
        renameName = prep.placeholder ?? "";
        renameTarget = { line: lspLine, char: lspChar };
        renaming = true;
        setTimeout(
          () =>
            document
              .querySelector<HTMLInputElement>(".rename-input")
              ?.select(),
          0,
        );
      });
  }

  function triggerCodeActions(): void {
    if (!view) return;
    const pos = view.state.selection.main.head;
    const { line: lspLine, character: lspChar } = getCursorLspPos(pos);
    lspClient
      .codeActions(filePath, lspLine, lspChar)
      .catch(() => [] as CodeAction[])
      .then((actions) => {
        if (!actions.length) return;
        const coords = view!.coordsAtPos(pos) ?? { left: 0, top: 0 };
        showContextMenu(
          actions.map((a) => ({
            label: a.title,
            action: () => lspClient.executeCodeAction(a, applyWorkspaceEdit),
          })),
          coords.left + 8,
          coords.top,
        );
      });
  }

  onMount(() => {
    const s = effectiveSettings.editor;

    let scrollAccum = 0;
    let scrollAccumTime = 0;
    const scrollThrottle = EditorView.domEventHandlers({
      wheel: (event: WheelEvent, view: EditorView) => {
        // Pass through zoom gesture (Ctrl+wheel) and horizontal-only scroll
        if (event.ctrlKey || event.deltaY === 0) return false;
        const now = performance.now();
        // Reset accumulator when there's a gap between gestures
        if (now - scrollAccumTime > 80) scrollAccum = 0;
        scrollAccumTime = now;
        scrollAccum += Math.abs(event.deltaY);
        // Only throttle once the burst exceeds the pre-rendered buffer headroom
        if (scrollAccum > 600) {
          event.preventDefault();
          view.scrollDOM.scrollBy({
            top: Math.sign(event.deltaY) * Math.min(Math.abs(event.deltaY), 300),
          });
          return true;
        }
        return false;
      },
    });

    const state = EditorState.create({
      doc: content,
      extensions: [
        editorTheme,
        ...editorHighlighting,
        lineNumbersCompartment.of(s.line_numbers ? [lineNumbers(), highlightActiveLineGutter()] : []),
        highlightActiveLineCompartment.of(s.highlight_active_line ? highlightActiveLine() : []),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        crosshairCursor(),
        scrollThrottle,
        bracketMatchingCompartment.of(s.bracket_matching ? bracketMatching() : []),
        closeBracketsCompartment.of(s.auto_close_brackets ? closeBrackets() : []),
        lintGutter(),
        lintCompartment.of([]),
        hoverCompartment.of([]),
        completionCompartment.of(autocompletion()),
        indentOnInput(),
        indentUnitCompartment.of(indentUnit.of(s.insert_spaces ? " ".repeat(s.tab_size) : "\t")),
        foldGutter(),
        search({ top: true }),
        highlightSelectionMatches(),
        scrollPastEndCompartment.of(s.scroll_past_end ? scrollPastEnd() : []),
        wordWrapCompartment.of(s.word_wrap ? EditorView.lineWrapping : []),
        placeholder("Start typing…"),
        conflictExtension,
        conflictTheme,
        history(),
        tabSizeCompartment.of(EditorState.tabSize.of(s.tab_size)),
        EditorState.allowMultipleSelections.of(true),
        keymap.of([
          indentWithTab,
          { key: "Mod-s", run: () => { onSave?.(); return true; } },
          { key: "Mod-/", run: toggleComment },
          { key: "Mod-g", run: gotoLine },
          { key: "Mod-m", run: cursorMatchingBracket },
          { key: "Shift-Alt-f", run: formatDocument },
          // LSP keybindings
          { key: "F12", run: () => { if (!isTauri || !lspClient.getLanguageId(filePath)) return false; const p = getCursorLspPos(view!.state.selection.main.head); lspClient.ensureReady(filePath, view!.state.doc.toString(), getWorkspaceRoot()).then(ok => { if (ok) lspClient.gotoDefinition(filePath, p.line, p.character).then(l => navigateOrShowPicker(l)).catch(() => {}); }).catch(() => {}); return true; } },
          { key: "Ctrl-F12", run: () => { if (!isTauri || !lspClient.getLanguageId(filePath)) return false; const p = getCursorLspPos(view!.state.selection.main.head); lspClient.ensureReady(filePath, view!.state.doc.toString(), getWorkspaceRoot()).then(ok => { if (ok) lspClient.gotoDeclaration(filePath, p.line, p.character).then(l => navigateOrShowPicker(l)).catch(() => {}); }).catch(() => {}); return true; } },
          { key: "Mod-F12", run: () => { if (!isTauri || !lspClient.getLanguageId(filePath)) return false; const p = getCursorLspPos(view!.state.selection.main.head); lspClient.ensureReady(filePath, view!.state.doc.toString(), getWorkspaceRoot()).then(ok => { if (ok) lspClient.gotoTypeDefinition(filePath, p.line, p.character).then(l => navigateOrShowPicker(l)).catch(() => {}); }).catch(() => {}); return true; } },
          { key: "Shift-F12", run: () => { if (!isTauri || !lspClient.getLanguageId(filePath)) return false; const p = getCursorLspPos(view!.state.selection.main.head); lspClient.ensureReady(filePath, view!.state.doc.toString(), getWorkspaceRoot()).then(ok => { if (ok) lspClient.gotoImplementation(filePath, p.line, p.character).then(l => navigateOrShowPicker(l)).catch(() => {}); }).catch(() => {}); return true; } },
          { key: "F2", run: () => { if (!isTauri || !lspClient.getLanguageId(filePath)) return false; lspClient.ensureReady(filePath, view!.state.doc.toString(), getWorkspaceRoot()).then(ok => { if (ok) triggerRename(); }).catch(() => {}); return true; } },
          { key: "Mod-.", run: () => { if (!isTauri || !lspClient.getLanguageId(filePath)) return false; lspClient.ensureReady(filePath, view!.state.doc.toString(), getWorkspaceRoot()).then(ok => { if (ok) triggerCodeActions(); }).catch(() => {}); return true; } },
          ...closeBracketsKeymap,
          ...searchKeymap,
          ...foldKeymap,
          ...completionKeymap,
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        langCompartment.of([]),
        minimapCompartment.of([]),
        indentGuidesCompartment.of([]),
        readonlyCompartment.of(EditorState.readOnly.of(readonly)),
        autoSaveCompartment.of([]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && onContentChange && !suppressContentChange) {
            onContentChange(update.state.doc.toString());
          }
        }),
      ],
    });

    view = new EditorView({ state, parent: containerEl });
    viewReady = true;

    return () => {
      stateCache.clear();
      view?.destroy();
      if (prevLspPath) lspClient.didClose(prevLspPath).catch(() => {});
    };
  });

  // Load/swap language when filePath changes or view becomes ready
  let lastLangExt = "";
  $effect(() => {
    if (!viewReady || !view) return;
    const ext = getExtForPath(filePath);
    if (ext === lastLangExt) return;
    lastLangExt = ext;
    getLanguageExtension(filePath).then((lang) => {
      if (view) {
        view.dispatch({ effects: langCompartment.reconfigure(lang) });
      }
    });
  });

  // Reconfigure editor extensions when settings change
  $effect(() => {
    if (!viewReady || !view) return;
    const s = effectiveSettings.editor;
    view.dispatch({ effects: [
      tabSizeCompartment.reconfigure(EditorState.tabSize.of(s.tab_size)),
      indentUnitCompartment.reconfigure(indentUnit.of(s.insert_spaces ? " ".repeat(s.tab_size) : "\t")),
      lineNumbersCompartment.reconfigure(s.line_numbers ? [lineNumbers(), highlightActiveLineGutter()] : []),
      highlightActiveLineCompartment.reconfigure(s.highlight_active_line ? highlightActiveLine() : []),
      bracketMatchingCompartment.reconfigure(s.bracket_matching ? bracketMatching() : []),
      closeBracketsCompartment.reconfigure(s.auto_close_brackets ? closeBrackets() : []),
      scrollPastEndCompartment.reconfigure(s.scroll_past_end ? scrollPastEnd() : []),
      wordWrapCompartment.reconfigure(s.word_wrap ? EditorView.lineWrapping : []),
    ]});
  });

  // Update editor font via CSS custom properties
  $effect(() => {
    if (!containerEl) return;
    containerEl.style.setProperty("--font-family", `'${effectiveSettings.editor.font_family}', monospace`);
    containerEl.style.setProperty("--font-size", `${effectiveSettings.editor.font_size}px`);
    if (view) view.requestMeasure();
  });

  // Per-file EditorState cache: saves cursor, scroll, and undo history between tab switches.
  const stateCache = new Map<string, EditorState>();

  // Sync content when it changes (suppress onContentChange to avoid promoting preview tabs)
  let lastSyncedPath = "";
  $effect(() => {
    if (!viewReady || !view) return;
    const doc = content;
    const path = filePath;
    // On tab switch, save outgoing state and restore cached state if content unchanged
    if (path !== lastSyncedPath) {
      if (lastSyncedPath) stateCache.set(lastSyncedPath, view.state);
      lastSyncedPath = path;
      const cached = stateCache.get(path);
      if (cached && cached.doc.length === doc.length) {
        view.setState(cached);
      } else {
        stateCache.delete(path);
        suppressContentChange = true;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: doc },
        });
        suppressContentChange = false;
      }
    } else if (doc !== view.state.doc.toString()) {
      stateCache.delete(path);
      suppressContentChange = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc },
      });
      suppressContentChange = false;
    }
  });

  // Minimap: async import, reconfigure when setting toggles
  $effect(() => {
    if (!viewReady || !view) return;
    const enabled = effectiveSettings.editor.minimap;
    if (enabled) {
      import("@replit/codemirror-minimap").then(({ showMinimap }) => {
        if (view) {
          view.dispatch({ effects: minimapCompartment.reconfigure(showMinimap.compute(["doc"], () => ({
            create: () => {
              const dom = document.createElement("div");
              return { dom };
            },
            displayText: "blocks",
            showOverlay: "always",
          }))) });
        }
      });
    } else {
      view.dispatch({ effects: minimapCompartment.reconfigure([]) });
    }
  });

  // Reconfigure readOnly when prop changes
  $effect(() => {
    if (!viewReady || !view) return;
    const ro = readonly;
    view.dispatch({ effects: readonlyCompartment.reconfigure(EditorState.readOnly.of(ro)) });
  });

  // Indent guides: reconfigure when setting toggles
  $effect(() => {
    if (!viewReady || !view) return;
    const enabled = effectiveSettings.editor.indent_guides;
    if (enabled) {
      import("@replit/codemirror-indentation-markers").then(({ indentationMarkers }) => {
        if (view) {
          view.dispatch({ effects: indentGuidesCompartment.reconfigure(indentationMarkers()) });
        }
      });
    } else {
      view.dispatch({ effects: indentGuidesCompartment.reconfigure([]) });
    }
  });

  // Auto-save: onFocusChange
  $effect(() => {
    if (!containerEl || !onAutoSave) return;
    const mode = effectiveSettings.general.auto_save;
    if (mode !== "onFocusChange") return;
    const handler = () => onAutoSave();
    containerEl.addEventListener("focusout", handler);
    return () => containerEl.removeEventListener("focusout", handler);
  });

  // Auto-save: afterDelay (debounced from doc changes)
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    // Track settings to re-run when they change
    const mode = effectiveSettings.general.auto_save;
    const delay = effectiveSettings.general.auto_save_delay;
    if (!viewReady || !view || !onAutoSave) return;

    if (mode === "afterDelay") {
      const listener = EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          if (autoSaveTimer) clearTimeout(autoSaveTimer);
          autoSaveTimer = setTimeout(() => onAutoSave(), delay);
        }
      });
      view.dispatch({ effects: autoSaveCompartment.reconfigure(listener) });
    } else {
      // Clear any previously installed afterDelay listener so toggling auto-save
      // to "off" (or another mode) actually stops the debounced saves.
      view.dispatch({ effects: autoSaveCompartment.reconfigure([]) });
    }

    return () => {
      if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null; }
      // Always clear the compartment on cleanup so stale listeners don't survive
      // across effect re-runs (e.g. when viewReady becomes false during hot-reload).
      if (view) view.dispatch({ effects: autoSaveCompartment.reconfigure([]) });
    };
  });

  // Consume editor actions dispatched from menu/command palette
  $effect(() => {
    const action = editorActions.pending;
    if (!action || !viewReady || !view) return;
    // Only consume if this pane is the active pane
    const ws = workspaceManager.activeWorkspace;
    if (ws?.activePaneId !== paneId) return;

    switch (action) {
      case "goto-line":
        gotoLine(view);
        break;
      case "goto-line-number": {
        const line = editorActions.gotoLineNumber;
        if (line != null && line >= 1 && line <= view.state.doc.lines) {
          const lineInfo = view.state.doc.line(line);
          view.dispatch({
            selection: { anchor: lineInfo.from },
            scrollIntoView: true,
          });
          view.focus();
        }
        break;
      }
      case "format-document":
        formatDocument(view);
        break;
      case "find":
        openSearchPanel(view);
        break;
      case "replace":
        openSearchPanel(view);
        break;
      case "toggle-word-wrap":
        settings.editor.word_wrap = !settings.editor.word_wrap;
        break;
    }

    editorActions.pending = null;
  });

  // LSP: notify server when file is opened or switched
  let prevLspPath = "";
  $effect(() => {
    if (!isTauri || !viewReady) return;
    const path = filePath;
    const langId = lspClient.getLanguageId(path);
    if (!langId || path.startsWith("untitled-")) return;
    const root = getWorkspaceRoot();
    const doc = content;

    if (path !== prevLspPath) {
      if (prevLspPath) lspClient.didClose(prevLspPath).catch(() => {});
      prevLspPath = path;
      lspClient.didOpen(path, doc, root).catch(() => {});

      // Proactively check if the language server is installed
      lspClient.checkInstall(langId, root, (install) => {
        const serverName = lspServerName(langId);
        pushToast(
          `Install ${serverName} for LSP features?`,
          "info",
          -1,
          {
            label: "Install",
            onClick: () => {
              pushToast(`Installing ${serverName}…`, "info", -1);
              install()
                .then(() => pushToast(`${serverName} installed. LSP features active.`, "success"))
                .catch((err: unknown) => pushToast(String(err), "error"));
            },
          },
        );
      }).catch(() => {});
    }
  });

  // LSP: notify server of content changes (debounced 300ms)
  let lspChangeTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    if (!isTauri || !viewReady) return;
    const doc = content;
    const path = filePath;
    if (!lspClient.getLanguageId(path) || path.startsWith("untitled-")) return;
    if (lspChangeTimer) clearTimeout(lspChangeTimer);
    lspChangeTimer = setTimeout(
      () => lspClient.didChange(path, doc).catch(() => {}),
      300,
    );
    return () => {
      if (lspChangeTimer) {
        clearTimeout(lspChangeTimer);
        lspChangeTimer = null;
      }
    };
  });

  // LSP: update lint diagnostics when diagnostics store changes
  $effect(() => {
    if (!viewReady || !view) return;
    const uri = lspClient.fileUri(filePath);
    const diags = getDiagnosticsForUri(uri);
    const cmDiags: CmDiagnostic[] = [];
    for (const d of diags) {
      try {
        const fromLine = view.state.doc.line(d.range.start.line + 1);
        const toLine = view.state.doc.line(d.range.end.line + 1);
        const from = Math.min(fromLine.from + d.range.start.character, fromLine.to);
        const to = Math.min(toLine.from + d.range.end.character, toLine.to);
        const severity = d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info";
        cmDiags.push({ from, to, severity, message: d.message });
      } catch {
        // Skip diagnostics for lines that don't exist in current doc
      }
    }
    view.dispatch(setDiagnostics(view.state, cmDiags));
  });

  // LSP: wire hover and completion extensions when file path changes
  $effect(() => {
    if (!viewReady || !view || !isTauri) return;
    const fp = filePath;
    const hasLsp = !!lspClient.getLanguageId(fp) && !fp.startsWith("untitled-");
    if (hasLsp) {
      view.dispatch({ effects: [
        hoverCompartment.reconfigure(buildHoverExtension(fp)),
        completionCompartment.reconfigure(autocompletion({ override: [buildLspCompletionSource(fp)], activateOnTyping: true })),
      ]});
    } else {
      view.dispatch({ effects: [
        hoverCompartment.reconfigure([]),
        completionCompartment.reconfigure(autocompletion()),
      ]});
    }
  });

  async function handleContextMenu(e: MouseEvent) {
    if (!view) return;
    e.preventDefault();
    e.stopPropagation();

    const sel = view.state.selection.main;
    const hasSelection = sel.from !== sel.to;
    const selectedText = hasSelection ? view.state.doc.sliceString(sel.from, sel.to) : "";

    const clickPos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
    // When text is selected, use the selection start so LSP resolves the symbol
    // at the beginning of the selection rather than at the arbitrary click position
    const lspPos = hasSelection ? sel.from : clickPos;
    const { line: lspLine, character: lspChar } = getCursorLspPos(lspPos);
    // Enabled for any language we support — ensureReady() bootstraps on first use
    const hasLsp = isTauri && !!lspClient.getLanguageId(filePath);
    const doc = view.state.doc.toString();
    const root = getWorkspaceRoot();

    // Wrapper: starts the server if needed, returns false to abort
    async function withLsp(): Promise<boolean> {
      try {
        return await lspClient.ensureReady(filePath, doc, root);
      } catch {
        return false;
      }
    }

    showContextMenu([
      { label: "Go to Definition",      shortcut: "F12",    disabled: !hasLsp,
        action: async () => {
          if (!await withLsp()) return;
          navigateOrShowPicker(await lspClient.gotoDefinition(filePath, lspLine, lspChar).catch(() => []));
        }},
      { label: "Go to Declaration",     shortcut: "^F12",   disabled: !hasLsp,
        action: async () => {
          if (!await withLsp()) return;
          navigateOrShowPicker(await lspClient.gotoDeclaration(filePath, lspLine, lspChar).catch(() => []));
        }},
      { label: "Go to Type Definition", shortcut: "⌘F12",   disabled: !hasLsp,
        action: async () => {
          if (!await withLsp()) return;
          navigateOrShowPicker(await lspClient.gotoTypeDefinition(filePath, lspLine, lspChar).catch(() => []));
        }},
      { label: "Go to Implementation",  shortcut: "⇧F12",   disabled: !hasLsp,
        action: async () => {
          if (!await withLsp()) return;
          navigateOrShowPicker(await lspClient.gotoImplementation(filePath, lspLine, lspChar).catch(() => []));
        }},
      { label: "Find All References",   shortcut: "⌥⇧F12",  disabled: !hasLsp,
        action: async () => {
          if (!await withLsp()) return;
          const locs = await lspClient.findReferences(filePath, lspLine, lspChar).catch(() => [] as LspLocation[]);
          lspReferences = locs;
        }},
      "sep",
      { label: "Rename Symbol",   shortcut: "F2",   disabled: !hasLsp,
        action: async () => {
          if (!await withLsp()) return;
          const prep = await lspClient.prepareRename(filePath, lspLine, lspChar).catch(() => null);
          if (!prep) return;
          const coords = view!.coordsAtPos(clickPos);
          renamePos = { x: coords?.left ?? e.clientX, y: coords?.top ?? e.clientY };
          renameName = prep.placeholder ?? "";
          renameTarget = { line: lspLine, char: lspChar };
          renaming = true;
          setTimeout(() => document.querySelector<HTMLInputElement>(".rename-input")?.select(), 0);
        }},
      { label: "Format Buffer",   shortcut: "⌘⇧I",  action: () => formatDocument(view!) },
      { label: "Show Code Actions", shortcut: "⌘.",  disabled: !hasLsp,
        action: async () => {
          if (!await withLsp()) return;
          const actions = await lspClient.codeActions(filePath, lspLine, lspChar).catch(() => [] as CodeAction[]);
          if (actions.length) {
            showContextMenu(
              actions.map((a: CodeAction) => ({
                label: a.title,
                action: () => lspClient.executeCodeAction(a, applyWorkspaceEdit),
              })),
              e.clientX + 8,
              e.clientY,
            );
          }
        }},
      "sep",
      { label: "Cut",  shortcut: "⌘X", disabled: !hasSelection || readonly, action: () => {
          navigator.clipboard.writeText(selectedText).catch(() => {});
          view!.dispatch(view!.state.replaceSelection(""));
      }},
      { label: "Copy", shortcut: "⌘C", disabled: !hasSelection, action: () =>
          navigator.clipboard.writeText(selectedText).catch(() => {})
      },
      { label: "Copy and Trim", disabled: !hasSelection, action: () =>
          navigator.clipboard.writeText(
            selectedText.split("\n").map(l => l.trimEnd()).join("\n").trim()
          ).catch(() => {})
      },
      { label: "Paste", shortcut: "⌘V", action: async () => {
          const text = await navigator.clipboard.readText().catch(() => "");
          if (text && view) view.dispatch(view.state.replaceSelection(text));
      }},
      "sep",
      { label: "Send to Claude…", shortcut: "⌘⇧U", disabled: !hasSelection,
        action: () => {
          const lineStart = view!.state.doc.lineAt(sel.from).number;
          const lineEnd   = view!.state.doc.lineAt(sel.to === sel.from ? sel.to : sel.to - 1).number;
          ui.sendToClaudeModal = { selectedText, filePath, lineStart, lineEnd };
        }},
      "sep",
      { label: "Reveal in Finder", shortcut: "⌘K R", disabled: !filePath || filePath.startsWith("untitled-"),
        action: async () => {
          const { revealInFileManager } = await import("../../lib/ipc/commands");
          revealInFileManager(filePath);
      }},
      { label: "Open in Terminal", disabled: !filePath || filePath.startsWith("untitled-"),
        action: () => {
          const dir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : filePath;
          workspaceManager.spawnTerminalInWorkspace(undefined, dir);
      }},
      { label: "Copy Permalink",  disabled: true, action: () => {} },
      { label: "View File History", disabled: true, action: () => {} },
    ], e.clientX, e.clientY);
  }
</script>

<div class="relative h-full w-full overflow-hidden">
  <div bind:this={containerEl} class="h-full w-full"
       oncontextmenu={handleContextMenu}></div>


  {#if lspReferences !== null}
    <div class="lsp-references-panel">
      <div class="lsp-ref-header">
        <span>References ({lspReferences.length})</span>
        <button onclick={() => lspReferences = null}>✕</button>
      </div>
      {#if lspReferences.length === 0}
        <div class="lsp-ref-empty">No references found</div>
      {:else}
        {#each groupReferencesByFile(lspReferences) as group}
          <div class="lsp-ref-file">{group.shortPath}</div>
          {#each group.items as loc}
            <button onclick={() => { lspReferences = null; navigateToLocation(loc); }}>
              Line {loc.range.start.line + 1}:{loc.range.start.character + 1}
            </button>
          {/each}
        {/each}
      {/if}
    </div>
  {/if}

  {#if renaming}
    <div class="rename-overlay" style="position:absolute;left:{renamePos.x}px;top:{renamePos.y}px">
      <input class="rename-input" bind:value={renameName}
        onkeydown={async (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            renaming = false;
            const edit = await lspClient.rename(filePath, renameTarget.line, renameTarget.char, renameName).catch(() => null);
            if (edit) applyWorkspaceEdit(edit);
          } else if (ev.key === "Escape") {
            renaming = false;
          }
        }} />
    </div>
  {/if}
</div>

<style>
  .lsp-references-panel { position: absolute; bottom: 0; left: 0; right: 0; max-height: 220px; overflow-y: auto; background: var(--bg-palette); border-top: 1px solid var(--border); z-index: 50; font-size: var(--ui-body); }
  .lsp-references-panel :global(.lsp-ref-header) { display: flex; justify-content: space-between; align-items: center; padding: 4px 10px; background: var(--bg-tab); font-size: var(--ui-label); color: var(--text-dim); }
  .lsp-references-panel :global(.lsp-ref-header button) { background: none; border: none; color: var(--text-dim); cursor: pointer; padding: 0 4px; }
  .lsp-references-panel :global(.lsp-ref-file) { padding: 3px 10px 1px; color: var(--text-dim); font-size: var(--ui-label); font-weight: 600; }
  .lsp-references-panel :global(button) { display: block; width: 100%; text-align: left; padding: 2px 22px; font-size: var(--ui-body); color: var(--text); background: none; border: none; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lsp-references-panel :global(button:hover) { background: var(--bg-hover); color: var(--text-bright); }
  .lsp-references-panel :global(.lsp-ref-empty) { padding: 6px 12px; color: var(--text-dim); font-size: var(--ui-body); font-style: italic; }
  .rename-overlay { z-index: 200; box-shadow: var(--shadow-md); border-radius: var(--radius-md); }
  .rename-input { background: var(--bg-palette); color: var(--text-bright); border: 1px solid var(--accent); padding: 3px 8px; font-size: var(--ui-md); font-family: inherit; outline: none; min-width: 160px; border-radius: var(--radius-md); }
</style>
