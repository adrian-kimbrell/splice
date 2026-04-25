/**
 * LSP diagnostic aggregation store.
 *
 * Listens for `lsp:diagnostics` Tauri events emitted by the Rust LSP client
 * and maintains a reactive map of file URI to diagnostic arrays. Diagnostics
 * follow LSP severity levels: 1 = error, 2 = warning, 3 = info, 4 = hint.
 *
 * `getDiagnosticCounts()` returns aggregate error/warning totals for the
 * status bar. `getDiagnosticsForUri(uri)` returns diagnostics for a single
 * file, used by the editor gutter and problems panel.
 *
 * @exports diagnosticsStore - Reactive read-only accessor for the full diagnostics map
 * @exports getDiagnosticsForUri - Per-file diagnostic lookup
 * @exports getDiagnosticCounts - Aggregate error/warning counts for status bar
 * @exports LspDiagnostic - Single diagnostic entry interface
 */

import { listen } from "@tauri-apps/api/event";

export interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity: 1 | 2 | 3 | 4; // 1=error, 2=warning, 3=info, 4=hint
  message: string;
  source?: string;
}

let _diagnostics = $state<Record<string, LspDiagnostic[]>>({});

export const diagnosticsStore = {
  get value() { return _diagnostics; },
};

export function getDiagnosticsForUri(uri: string): LspDiagnostic[] {
  return _diagnostics[uri] ?? [];
}

export function getDiagnosticCounts(): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const diags of Object.values(_diagnostics)) {
    for (const d of diags) {
      if (d.severity === 1) errors++;
      else if (d.severity === 2) warnings++;
    }
  }
  return { errors, warnings };
}

const isTauri = "__TAURI_INTERNALS__" in window;
if (isTauri) {
  listen<{ uri: string; diagnostics: LspDiagnostic[] }>("lsp:diagnostics", (event) => {
    const { uri, diagnostics } = event.payload;
    _diagnostics = { ..._diagnostics, [uri]: diagnostics };
  }).catch(() => {});
}
