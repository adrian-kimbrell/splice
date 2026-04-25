import { EditorView } from "@codemirror/view";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { classHighlighter } from "@lezer/highlight";

export const customHighlights = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--syn-kw)" },
  { tag: tags.controlKeyword, color: "var(--syn-kw)" },
  { tag: tags.operatorKeyword, color: "var(--syn-kw)" },
  { tag: tags.moduleKeyword, color: "var(--syn-kw)" },
  { tag: tags.definitionKeyword, color: "var(--syn-kw)" },
  { tag: tags.function(tags.variableName), color: "var(--syn-fn)" },
  { tag: tags.function(tags.definition(tags.variableName)), color: "var(--syn-fn)" },
  { tag: tags.string, color: "var(--syn-str)" },
  { tag: tags.typeName, color: "var(--syn-ty)" },
  { tag: tags.className, color: "var(--syn-ty)" },
  { tag: tags.definition(tags.typeName), color: "var(--syn-ty)" },
  { tag: tags.number, color: "var(--syn-num)" },
  { tag: tags.bool, color: "var(--syn-num)" },
  { tag: tags.comment, color: "var(--syn-cm)" },
  { tag: tags.lineComment, color: "var(--syn-cm)" },
  { tag: tags.blockComment, color: "var(--syn-cm)" },
  { tag: tags.macroName, color: "var(--syn-mac)" },
  { tag: tags.processingInstruction, color: "var(--syn-mac)" },
  { tag: tags.attributeName, color: "var(--syn-attr)" },
  { tag: tags.propertyName, color: "var(--syn-attr)" },
  { tag: tags.operator, color: "var(--text)" },
  { tag: tags.punctuation, color: "var(--text)" },
  { tag: tags.tagName, color: "var(--syn-kw)" },
  { tag: tags.angleBracket, color: "var(--text-dim)" },
  { tag: tags.self, color: "var(--syn-kw)" },
  { tag: tags.atom, color: "var(--syn-num)" },
  { tag: tags.special(tags.variableName), color: "var(--syn-mac)" },
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
    fontSize: "var(--ui-label)",
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
    fontSize: "var(--ui-body)",
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
    fontSize: "var(--ui-body)",
    color: "var(--text-dim)",
  },
  ".cm-panel.cm-search": {
    padding: "6px 8px",
  },
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
  ".tok-keyword": { color: "var(--syn-kw)" },
  ".tok-string, .tok-string2": { color: "var(--syn-str)" },
  ".tok-number": { color: "var(--syn-num)" },
  ".tok-bool": { color: "var(--syn-num)" },
  ".tok-comment": { color: "var(--syn-cm)", fontStyle: "italic" },
  ".tok-variableName": { color: "var(--text)" },
  ".tok-variableName.tok-definition": { color: "var(--syn-fn)" },
  ".tok-typeName": { color: "var(--syn-ty)" },
  ".tok-className": { color: "var(--syn-ty)" },
  ".tok-macroName": { color: "var(--syn-mac)" },
  ".tok-propertyName": { color: "var(--syn-attr)" },
  ".tok-propertyName.tok-definition": { color: "var(--syn-fn)" },
  ".tok-attributeName": { color: "var(--syn-attr)" },
  ".tok-operator": { color: "var(--text)" },
  ".tok-punctuation": { color: "var(--text)" },
  ".tok-atom": { color: "var(--syn-num)" },
  ".tok-meta": { color: "var(--syn-mac)" },
  ".tok-link": { color: "var(--syn-fn)", textDecoration: "underline" },
  ".tok-heading": { color: "var(--ansi-red)", fontWeight: "bold" },
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
