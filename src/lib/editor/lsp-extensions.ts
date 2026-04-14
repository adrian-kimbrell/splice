/**
 * CodeMirror 6 extension builders for LSP features.
 *
 * These are plain TypeScript functions with no Svelte reactivity — they depend
 * only on the `lspClient` singleton and the `isTauri` flag, making them
 * safely extractable from the editor component.
 */

import { EditorView, hoverTooltip } from "@codemirror/view";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { lspClient } from "../lsp/client";
import type { LspPos } from "../lsp/client";

const isTauri = "__TAURI_INTERNALS__" in window;

/** Maps an LSP completion kind number to a CodeMirror completion type label. */
export function lspKindToType(kind: number | undefined): string {
  switch (kind) {
    case 2: case 3: return "function";
    case 4: return "function";   // constructor
    case 5: return "variable";   // field
    case 6: return "variable";
    case 7: return "class";
    case 8: return "interface";
    case 9: return "namespace";
    case 10: return "variable";  // enum
    case 14: return "keyword";
    case 15: return "text";
    case 17: return "variable";  // color
    case 18: return "text";      // file
    case 20: return "constant";  // enum member
    case 21: return "class";     // struct
    default: return "text";
  }
}

/** Returns the well-known LSP server name for display in install prompts. */
export function lspServerName(langId: string): string {
  switch (langId) {
    case "typescript":
    case "javascript":
    case "typescriptreact":
    case "javascriptreact":
      return "typescript-language-server";
    case "python": return "pyright";
    case "rust": return "rust-analyzer";
    case "html":
    case "css":
    case "json": return "vscode-langservers-extracted";
    default: return langId;
  }
}

/**
 * Returns a CodeMirror completion source function that fetches suggestions
 * from the LSP server. Pass the file path so the server targets the right doc.
 */
export function buildLspCompletionSource(fp: string) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    if (!isTauri || !lspClient.getLanguageId(fp)) return null;
    const pos = context.pos;
    const lineInfo = context.state.doc.lineAt(pos);
    const lspPos: LspPos = { line: lineInfo.number - 1, character: pos - lineInfo.from };
    const word = context.matchBefore(/\w*/);
    // Only fire for explicit invocation or after typing at least 1 char
    if (!context.explicit && (!word || word.from === word.to)) return null;
    const items = await lspClient.complete(fp, lspPos).catch(() => []);
    if (!items.length) return null;
    return {
      from: word ? word.from : pos,
      options: items.map(item => ({
        label: item.label,
        detail: item.detail,
        type: lspKindToType(item.kind),
      })),
      validFor: /^\w*$/,
    };
  };
}

/**
 * Returns a CodeMirror hoverTooltip extension that shows LSP hover info for
 * the symbol under the cursor.
 */
export function buildHoverExtension(fp: string) {
  return hoverTooltip(
    async (_view: EditorView, pos: number) => {
      if (!isTauri || !lspClient.getLanguageId(fp)) return null;
      const lineInfo = _view.state.doc.lineAt(pos);
      const lspPos: LspPos = { line: lineInfo.number - 1, character: pos - lineInfo.from };
      const text = await lspClient.hover(fp, lspPos).catch(() => null);
      if (!text) return null;
      return {
        pos,
        create() {
          const dom = document.createElement("div");
          dom.className = "cm-lsp-hover";
          dom.style.cssText = "max-width:400px;padding:4px 8px;font-size:12px;white-space:pre-wrap;word-break:break-word;";
          dom.textContent = text;
          return { dom };
        },
      };
    },
    { hoverTime: 300 },
  );
}
