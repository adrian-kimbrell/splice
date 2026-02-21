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
  const minimapCompartment = new Compartment();
  const indentGuidesCompartment = new Compartment();

  function getExtForPath(path: string): string {
    const dot = path.lastIndexOf(".");
    return dot >= 0 ? path.slice(dot).toLowerCase() : "";
  }

  async function getLanguageExtension(path: string) {
    const ext = getExtForPath(path);
    switch (ext) {
      case ".js":
      case ".jsx": {
        const { javascript } = await import("@codemirror/lang-javascript");
        return javascript({ jsx: true });
      }
      case ".ts":
      case ".tsx": {
        const { javascript } = await import("@codemirror/lang-javascript");
        return javascript({ jsx: true, typescript: true });
      }
      case ".html":
      case ".svelte": {
        const { html } = await import("@codemirror/lang-html");
        return html();
      }
      case ".css": {
        const { css } = await import("@codemirror/lang-css");
        return css();
      }
      case ".json": {
        const { json } = await import("@codemirror/lang-json");
        return json();
      }
      case ".rs": {
        const { rust } = await import("@codemirror/lang-rust");
        return rust();
      }
      case ".py": {
        const { python } = await import("@codemirror/lang-python");
        return python();
      }
      case ".md": {
        const { markdown } = await import("@codemirror/lang-markdown");
        return markdown();
      }
      default:
        return [];
    }
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
        EditorView.updateListener.of((update) => {
          if (update.docChanged && onContentChange) {
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
  $effect(() => {
    if (!viewReady || !view) return;
    const path = filePath;
    getLanguageExtension(path).then((lang) => {
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

  // Sync content when it changes
  $effect(() => {
    if (!viewReady || !view) return;
    const doc = content;
    if (doc !== view.state.doc.toString()) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc },
      });
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
    if (!viewReady || !view || mode !== "afterDelay" || !onAutoSave) return;

    const listener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        if (autoSaveTimer) clearTimeout(autoSaveTimer);
        autoSaveTimer = setTimeout(() => onAutoSave(), delay);
      }
    });

    view.dispatch({ effects: readonlyCompartment.reconfigure([EditorState.readOnly.of(readonly), listener]) });

    return () => {
      if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null; }
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
