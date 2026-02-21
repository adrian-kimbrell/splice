import { EditorView } from "@codemirror/view";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { classHighlighter } from "@lezer/highlight";

export const customHighlights = HighlightStyle.define([
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

export const editorTheme = EditorView.theme({
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
  // Minimap
  ".cm-minimap": {
    backgroundColor: "var(--bg-editor)",
    borderLeft: "1px solid var(--border)",
  },
  ".cm-minimap-overlay": {
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  // Indent guides
  ".cm-indentation-marker": {
    "--indent-marker-bg-color": "var(--border)",
    "--indent-marker-active-bg-color": "var(--text-dim)",
  },
}, { dark: true });

export const editorHighlighting = [
  syntaxHighlighting(customHighlights),
  syntaxHighlighting(classHighlighter),
];
