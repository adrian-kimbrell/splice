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
