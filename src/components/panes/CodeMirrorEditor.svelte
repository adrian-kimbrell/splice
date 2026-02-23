<script lang="ts">
  import { onMount } from "svelte";
  import { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, scrollPastEnd, placeholder, keymap } from "@codemirror/view";
  import { EditorState, Compartment } from "@codemirror/state";
  import { bracketMatching, indentOnInput, foldGutter, foldKeymap, indentUnit, indentRange } from "@codemirror/language";
  import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from "@codemirror/commands";
  import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from "@codemirror/autocomplete";
  import { search, searchKeymap, highlightSelectionMatches, gotoLine, openSearchPanel } from "@codemirror/search";
  import { cursorMatchingBracket } from "@codemirror/commands";
  import { editorTheme, editorHighlighting } from "../../lib/theme/editor-theme";
  import { settings } from "../../lib/stores/settings.svelte";
  import { editorActions } from "../../lib/stores/editor-actions.svelte";
  import { workspaceManager } from "../../lib/stores/workspace.svelte";

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

  function getExtForPath(path: string): string {
    const dot = path.lastIndexOf(".");
    return dot >= 0 ? path.slice(dot).toLowerCase() : "";
  }

  const langCache = new Map<string, any>();

  async function getLanguageExtension(path: string) {
    const ext = getExtForPath(path);
    const cached = langCache.get(ext);
    if (cached) return cached;

    let lang: any;
    switch (ext) {
      case ".js":
      case ".jsx": {
        const { javascript } = await import("@codemirror/lang-javascript");
        lang = javascript({ jsx: true });
        break;
      }
      case ".ts":
      case ".tsx": {
        const { javascript } = await import("@codemirror/lang-javascript");
        lang = javascript({ jsx: true, typescript: true });
        break;
      }
      case ".html":
      case ".svelte": {
        const { html } = await import("@codemirror/lang-html");
        lang = html();
        break;
      }
      case ".css": {
        const { css } = await import("@codemirror/lang-css");
        lang = css();
        break;
      }
      case ".json": {
        const { json } = await import("@codemirror/lang-json");
        lang = json();
        break;
      }
      case ".rs": {
        const { rust } = await import("@codemirror/lang-rust");
        lang = rust();
        break;
      }
      case ".py": {
        const { python } = await import("@codemirror/lang-python");
        lang = python();
        break;
      }
      case ".md": {
        const { markdown } = await import("@codemirror/lang-markdown");
        lang = markdown();
        break;
      }
      default:
        return [];
    }
    langCache.set(ext, lang);
    return lang;
  }

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

  onMount(() => {
    const s = settings.editor;
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
        bracketMatchingCompartment.of(s.bracket_matching ? bracketMatching() : []),
        closeBracketsCompartment.of(s.auto_close_brackets ? closeBrackets() : []),
        autocompletion(),
        indentOnInput(),
        indentUnitCompartment.of(indentUnit.of(s.insert_spaces ? " ".repeat(s.tab_size) : "\t")),
        foldGutter(),
        search({ top: true }),
        highlightSelectionMatches(),
        scrollPastEndCompartment.of(s.scroll_past_end ? scrollPastEnd() : []),
        wordWrapCompartment.of(s.word_wrap ? EditorView.lineWrapping : []),
        placeholder("Start typing…"),
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
      view?.destroy();
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
    const s = settings.editor;
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
    containerEl.style.setProperty("--font-family", `'${settings.editor.font_family}', monospace`);
    containerEl.style.setProperty("--font-size", `${settings.editor.font_size}px`);
    if (view) view.requestMeasure();
  });

  // Sync content when it changes (suppress onContentChange to avoid promoting preview tabs)
  let lastSyncedPath = "";
  $effect(() => {
    if (!viewReady || !view) return;
    const doc = content;
    const path = filePath;
    // On tab switch, always replace without string comparison
    if (path !== lastSyncedPath) {
      lastSyncedPath = path;
      suppressContentChange = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc },
      });
      suppressContentChange = false;
    } else if (doc !== view.state.doc.toString()) {
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
    const enabled = settings.editor.minimap;
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
    const enabled = settings.editor.indent_guides;
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
    const mode = settings.general.auto_save;
    if (mode !== "onFocusChange") return;
    const handler = () => onAutoSave();
    containerEl.addEventListener("focusout", handler);
    return () => containerEl.removeEventListener("focusout", handler);
  });

  // Auto-save: afterDelay (debounced from doc changes)
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    // Track settings to re-run when they change
    const mode = settings.general.auto_save;
    const delay = settings.general.auto_save_delay;
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
</script>

<div bind:this={containerEl} class="h-full w-full overflow-hidden"></div>
