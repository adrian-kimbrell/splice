<script lang="ts">
  import { onMount } from "svelte";
  import { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, scrollPastEnd, placeholder, keymap } from "@codemirror/view";
  import { EditorState, Compartment } from "@codemirror/state";
  import { syntaxHighlighting, bracketMatching, indentOnInput, foldGutter, foldKeymap, indentUnit, HighlightStyle } from "@codemirror/language";
  import { classHighlighter, tags } from "@lezer/highlight";
  import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from "@codemirror/commands";
  import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from "@codemirror/autocomplete";
  import { search, searchKeymap, highlightSelectionMatches, gotoLine } from "@codemirror/search";
  import { cursorMatchingBracket } from "@codemirror/commands";

  let {
    content,
    filePath,
    readonly = false,
    onContentChange,
  }: {
    content: string;
    filePath: string;
    readonly?: boolean;
    onContentChange?: (content: string) => void;
  } = $props();

  let containerEl: HTMLDivElement;
  let view: EditorView | undefined;
  let viewReady = $state(false);
  const langCompartment = new Compartment();

  // Fine-grained highlight style for tags classHighlighter doesn't cover
  const customHighlights = HighlightStyle.define([
    { tag: tags.keyword, color: "#c678dd" },
    { tag: tags.controlKeyword, color: "#c678dd" },
    { tag: tags.operatorKeyword, color: "#c678dd" },
    { tag: tags.moduleKeyword, color: "#c678dd" },
    { tag: tags.definitionKeyword, color: "#c678dd" },
    { tag: tags.function(tags.variableName), color: "#61afef" },
    { tag: tags.function(tags.definition(tags.variableName)), color: "#61afef" },
    { tag: tags.string, color: "#98c379" },
    { tag: tags.typeName, color: "#e5c07b" },
    { tag: tags.className, color: "#e5c07b" },
    { tag: tags.definition(tags.typeName), color: "#e5c07b" },
    { tag: tags.number, color: "#d19a66" },
    { tag: tags.bool, color: "#d19a66" },
    { tag: tags.comment, color: "#5c6370" },
    { tag: tags.lineComment, color: "#5c6370" },
    { tag: tags.blockComment, color: "#5c6370" },
    { tag: tags.macroName, color: "#56b6c2" },
    { tag: tags.processingInstruction, color: "#56b6c2" },
    { tag: tags.attributeName, color: "#d19a66" },
    { tag: tags.propertyName, color: "#d19a66" },
    { tag: tags.operator, color: "#abb2bf" },
    { tag: tags.punctuation, color: "#abb2bf" },
    { tag: tags.tagName, color: "#c678dd" },
    { tag: tags.angleBracket, color: "#636d83" },
    { tag: tags.self, color: "#c678dd" },
    { tag: tags.atom, color: "#d19a66" },
    { tag: tags.special(tags.variableName), color: "#56b6c2" },
  ]);

  const editorTheme = EditorView.theme({
    "&": {
      backgroundColor: "var(--bg-editor)",
      color: "var(--text)",
      fontFamily: "var(--font-family)",
      fontSize: "var(--font-size)",
      height: "100%",
    },
    ".cm-content": {
      caretColor: "var(--accent)",
      lineHeight: "var(--line-height)",
      padding: "8px 0",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--accent)",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "var(--bg-selected) !important",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(255,255,255,0.03)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "var(--text)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--bg-editor)",
      color: "var(--text-dim)",
      border: "none",
      minWidth: "50px",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 12px 0 8px",
    },
    ".cm-matchingBracket": {
      backgroundColor: "rgba(255,255,255,0.1)",
      outline: "1px solid rgba(255,255,255,0.2)",
    },
    ".cm-scroller": {
      overflow: "auto",
    },
    // Fold gutter
    ".cm-foldGutter .cm-gutterElement": {
      padding: "0 4px",
      cursor: "pointer",
      color: "var(--text-dim)",
      fontSize: "11px",
      lineHeight: "inherit",
    },
    ".cm-foldGutter .cm-gutterElement:hover": {
      color: "var(--text)",
    },
    // Search panel
    ".cm-panels": {
      backgroundColor: "var(--bg-sidebar)",
      color: "var(--text)",
      borderBottom: "1px solid var(--border)",
    },
    ".cm-panels input, .cm-panels button": {
      fontFamily: "var(--ui-font)",
      fontSize: "12px",
      color: "var(--text)",
    },
    ".cm-panels input": {
      backgroundColor: "var(--bg-input)",
      border: "1px solid var(--border)",
      borderRadius: "3px",
      padding: "2px 6px",
      outline: "none",
    },
    ".cm-panels input:focus": {
      borderColor: "var(--accent)",
    },
    ".cm-panels button": {
      backgroundColor: "transparent",
      border: "1px solid var(--border)",
      borderRadius: "3px",
      cursor: "pointer",
      padding: "2px 8px",
    },
    ".cm-panels button:hover": {
      backgroundColor: "var(--bg-hover)",
    },
    ".cm-panels label": {
      fontSize: "12px",
      color: "var(--text-dim)",
    },
    ".cm-panel.cm-search": {
      padding: "6px 8px",
    },
    // Go-to-line dialog
    ".cm-panel.cm-gotoLine": {
      padding: "6px 8px",
    },
    ".cm-searchMatch": {
      backgroundColor: "rgba(255, 213, 0, 0.2)",
      outline: "1px solid rgba(255, 213, 0, 0.4)",
    },
    ".cm-searchMatch-selected": {
      backgroundColor: "rgba(255, 213, 0, 0.4)",
    },
    // Selection match highlighting
    ".cm-selectionMatch": {
      backgroundColor: "rgba(255, 255, 255, 0.08)",
    },
    // Autocomplete tooltip
    ".cm-tooltip": {
      backgroundColor: "var(--bg-sidebar)",
      border: "1px solid var(--border)",
      color: "var(--text)",
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
      backgroundColor: "var(--bg-selected)",
      color: "var(--text-bright)",
    },
    // Placeholder
    ".cm-placeholder": {
      color: "var(--text-dim)",
      fontStyle: "italic",
    },
    // classHighlighter token classes (fallback)
    ".tok-keyword": { color: "#c678dd" },
    ".tok-string, .tok-string2": { color: "#98c379" },
    ".tok-number": { color: "#d19a66" },
    ".tok-bool": { color: "#d19a66" },
    ".tok-comment": { color: "#5c6370", fontStyle: "italic" },
    ".tok-variableName": { color: "#abb2bf" },
    ".tok-variableName.tok-definition": { color: "#61afef" },
    ".tok-typeName": { color: "#e5c07b" },
    ".tok-className": { color: "#e5c07b" },
    ".tok-macroName": { color: "#56b6c2" },
    ".tok-propertyName": { color: "#d19a66" },
    ".tok-propertyName.tok-definition": { color: "#61afef" },
    ".tok-attributeName": { color: "#d19a66" },
    ".tok-operator": { color: "#abb2bf" },
    ".tok-punctuation": { color: "#abb2bf" },
    ".tok-atom": { color: "#d19a66" },
    ".tok-meta": { color: "#56b6c2" },
    ".tok-link": { color: "#61afef", textDecoration: "underline" },
    ".tok-heading": { color: "#e06c75", fontWeight: "bold" },
    ".tok-emphasis": { fontStyle: "italic" },
    ".tok-strong": { fontWeight: "bold" },
  }, { dark: true });

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

  onMount(() => {
    const state = EditorState.create({
      doc: content,
      extensions: [
        editorTheme,
        syntaxHighlighting(customHighlights),
        syntaxHighlighting(classHighlighter),
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        crosshairCursor(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        indentOnInput(),
        indentUnit.of("  "),
        foldGutter(),
        search({ top: true }),
        highlightSelectionMatches(),
        scrollPastEnd(),
        placeholder("Start typing…"),
        history(),
        EditorState.tabSize.of(2),
        EditorState.allowMultipleSelections.of(true),
        keymap.of([
          indentWithTab,
          { key: "Mod-/", run: toggleComment },
          { key: "Mod-g", run: gotoLine },
          { key: "Mod-m", run: cursorMatchingBracket },
          ...closeBracketsKeymap,
          ...searchKeymap,
          ...foldKeymap,
          ...completionKeymap,
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        langCompartment.of([]),
        EditorState.readOnly.of(readonly),
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
</script>

<div bind:this={containerEl} class="h-full w-full overflow-hidden"></div>
