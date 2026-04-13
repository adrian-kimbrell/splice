/**
 * Frontend LSP client — coordinates language server lifecycle and request deduplication.
 *
 * The actual server process lives in `src-tauri/src/lsp/mod.rs`; this class is the
 * coordination layer on top of Tauri IPC. Per-instance state:
 * - `startPromises`: deduplicates concurrent `ensureStarted` calls for the same language
 * - `openPromises`: deduplicates concurrent `didOpen` calls for the same file URI
 * - `docVersions`: tracks per-file version numbers for textDocument sync
 * - `runningLanguages` / `failedLanguages`: tracks server health to avoid retry storms
 *
 * Diagnostics arrive as `lsp:diagnostics` Tauri events (not via this class) and are
 * consumed by `src/lib/stores/diagnostics.svelte.ts`.
 *
 * Language IDs are mapped from file extensions in `getLanguageId`. Supported:
 * TypeScript/JavaScript, Rust, Python (pyright preferred over pylsp), HTML, CSS, JSON.
 */
import { lspStart, lspNotify, lspRequest, lspCheck, lspInstall } from "../ipc/commands";
import { pushToast } from "../stores/toasts.svelte";

export interface LspCompletionItem {
  label: string;
  detail?: string;
  kind?: number;
  documentation?: string | { kind: string; value: string };
}

export interface LspPos {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPos;
  end: LspPos;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface TextEdit {
  range: LspRange;
  newText: string;
}

export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
}

export interface CodeAction {
  title: string;
  kind?: string;
  edit?: WorkspaceEdit;
  command?: { command: string; arguments?: unknown[] };
}

export class LspClient {
  private docVersions = new Map<string, number>();
  private startPromises = new Map<string, Promise<void>>();
  private openPromises = new Map<string, Promise<void>>();
  private runningLanguages = new Set<string>();
  private checkedLanguages = new Set<string>();
  private failedLanguages = new Set<string>();

  getLanguageId(filePath: string): string | null {
    const dot = filePath.lastIndexOf(".");
    const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
    switch (ext) {
      case ".ts":
      case ".tsx":
        return "typescript";
      case ".js":
      case ".jsx":
        return "javascript";
      case ".rs":
        return "rust";
      case ".py":
        return "python";
      case ".html":
      case ".svelte":
        return "html";
      case ".css":
        return "css";
      case ".json":
        return "json";
      default:
        return null;
    }
  }

  fileUri(filePath: string): string {
    return "file://" + filePath;
  }

  uriToPath(uri: string): string {
    return uri.startsWith("file://") ? uri.slice("file://".length) : uri;
  }

  async ensureStarted(languageId: string, workspaceRoot: string): Promise<void> {
    if (this.runningLanguages.has(languageId)) return;
    if (this.failedLanguages.has(languageId)) throw new Error(`${languageId} LSP unavailable`);
    // If a start is in flight, wait for it instead of issuing a second one
    const existing = this.startPromises.get(languageId);
    if (existing) {
      await existing;
      return;
    }
    const p = lspStart(languageId, workspaceRoot)
      .then(() => {
        this.runningLanguages.add(languageId);
      })
      .catch((err) => {
        this.startPromises.delete(languageId);
        this.failedLanguages.add(languageId);
        const msg = String(err);
        // Extract executable name from "Failed to spawn /path/to/exe: reason"
        const exeMatch = msg.match(/spawn\s+\S+\/(\S+?):/);
        const reason = msg.includes("No such file") ? "not found" :
                       msg.includes("Permission denied") ? "permission denied" :
                       "failed to start";
        const hint = exeMatch ? `${exeMatch[1]}: ${reason}` : reason;
        pushToast(`${languageId} LSP: ${hint}`, "warning", 8000);
        console.error(`[LSP] ${languageId} failed to start:`, err);
        throw err;
      });
    this.startPromises.set(languageId, p);
    await p;
  }

  /** True if the language server is currently running for this file's language. */
  hasSession(filePath: string): boolean {
    const langId = this.getLanguageId(filePath);
    return langId !== null && this.runningLanguages.has(langId);
  }

  /**
   * Checks whether the language server for `languageId` is installed on the system.
   * If not, calls `onMissing` with an install function the caller can trigger.
   * De-duplicates: only checks once per language per app session.
   */
  async checkInstall(
    languageId: string,
    workspaceRoot: string,
    onMissing: (install: () => Promise<void>) => void,
  ): Promise<void> {
    if (this.checkedLanguages.has(languageId)) return;
    this.checkedLanguages.add(languageId);
    const installed = await lspCheck(languageId).catch(() => true); // fail open
    if (installed) return;
    onMissing(async () => {
      await lspInstall(languageId); // throws on failure — caller surfaces error toast
      await this.ensureStarted(languageId, workspaceRoot);
    });
  }

  /**
   * Ensures the server is started and the file is open in the server.
   * Call this from action handlers so a first right-click can bootstrap the session.
   * Returns true if the session is ready for requests.
   */
  async ensureReady(filePath: string, content: string, workspaceRoot: string): Promise<boolean> {
    const langId = this.getLanguageId(filePath);
    if (!langId) return false;
    const root =
      workspaceRoot ||
      (filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "");
    if (!root) return false;
    await this.ensureStarted(langId, root); // throws on failure
    if (!this.runningLanguages.has(langId)) return false;
    if (!this.docVersions.has(filePath)) {
      const inFlight = this.openPromises.get(filePath);
      if (inFlight) {
        await inFlight;
      } else {
        await this.didOpen(filePath, content, root).catch((err) =>
          console.error("[LSP] didOpen failed:", err),
        );
      }
    }
    return this.runningLanguages.has(langId);
  }

  async didOpen(filePath: string, content: string, workspaceRoot: string): Promise<void> {
    const languageId = this.getLanguageId(filePath);
    if (!languageId) return;
    // Deduplicate concurrent didOpen calls for the same file
    if (this.openPromises.has(filePath)) {
      return this.openPromises.get(filePath);
    }
    const p = (async () => {
      await this.ensureStarted(languageId, workspaceRoot);
      await lspNotify(languageId, "textDocument/didOpen", {
        textDocument: {
          uri: this.fileUri(filePath),
          languageId,
          version: 1,
          text: content,
        },
      });
      // Only mark as open after the server has successfully received it
      this.docVersions.set(filePath, 1);
    })();
    this.openPromises.set(filePath, p);
    try {
      await p;
    } finally {
      this.openPromises.delete(filePath);
    }
  }

  async didChange(filePath: string, content: string): Promise<void> {
    const languageId = this.getLanguageId(filePath);
    if (!languageId) return;
    if (!this.docVersions.has(filePath)) return;
    const version = (this.docVersions.get(filePath) ?? 1) + 1;
    this.docVersions.set(filePath, version);
    await lspNotify(languageId, "textDocument/didChange", {
      textDocument: { uri: this.fileUri(filePath), version },
      contentChanges: [{ text: content }],
    });
  }

  async didClose(filePath: string): Promise<void> {
    const languageId = this.getLanguageId(filePath);
    if (!languageId) return;
    this.docVersions.delete(filePath);
    await lspNotify(languageId, "textDocument/didClose", {
      textDocument: { uri: this.fileUri(filePath) },
    });
  }

  private _textDocPos(filePath: string, line: number, char: number) {
    return {
      textDocument: { uri: this.fileUri(filePath) },
      position: { line, character: char },
    };
  }

  async gotoDefinition(filePath: string, line: number, char: number): Promise<LspLocation[]> {
    const langId = this.getLanguageId(filePath);
    if (!langId) return [];
    try {
      const result = await lspRequest(langId, "textDocument/definition", this._textDocPos(filePath, line, char));
      return this._normalizeLocations(result);
    } catch (err) {
      console.error("[LSP] definition error:", err);
      return [];
    }
  }

  async gotoDeclaration(filePath: string, line: number, char: number): Promise<LspLocation[]> {
    const langId = this.getLanguageId(filePath);
    if (!langId) return [];
    const result = await lspRequest(langId, "textDocument/declaration", this._textDocPos(filePath, line, char));
    return this._normalizeLocations(result);
  }

  async gotoTypeDefinition(filePath: string, line: number, char: number): Promise<LspLocation[]> {
    const langId = this.getLanguageId(filePath);
    if (!langId) return [];
    const result = await lspRequest(langId, "textDocument/typeDefinition", this._textDocPos(filePath, line, char));
    return this._normalizeLocations(result);
  }

  async gotoImplementation(filePath: string, line: number, char: number): Promise<LspLocation[]> {
    const langId = this.getLanguageId(filePath);
    if (!langId) return [];
    const result = await lspRequest(langId, "textDocument/implementation", this._textDocPos(filePath, line, char));
    return this._normalizeLocations(result);
  }

  async findReferences(filePath: string, line: number, char: number): Promise<LspLocation[]> {
    const langId = this.getLanguageId(filePath);
    if (!langId) return [];
    try {
      const result = await lspRequest(langId, "textDocument/references", {
        ...this._textDocPos(filePath, line, char),
        context: { includeDeclaration: true },
      });
      return this._normalizeLocations(result);
    } catch (err) {
      console.error("[LSP] references error:", err);
      return [];
    }
  }

  async prepareRename(filePath: string, line: number, char: number): Promise<{ placeholder: string } | null> {
    const langId = this.getLanguageId(filePath);
    if (!langId) return null;
    try {
      const result = await lspRequest(langId, "textDocument/prepareRename", this._textDocPos(filePath, line, char));
      if (!result) return null;
      const r = result as Record<string, unknown>;
      const placeholder = (r.placeholder as string) ?? (r.defaultBehavior ? "" : "");
      return { placeholder };
    } catch {
      return null;
    }
  }

  async rename(filePath: string, line: number, char: number, newName: string): Promise<WorkspaceEdit | null> {
    const langId = this.getLanguageId(filePath);
    if (!langId) return null;
    try {
      const result = await lspRequest(langId, "textDocument/rename", {
        ...this._textDocPos(filePath, line, char),
        newName,
      });
      return (result as WorkspaceEdit) ?? null;
    } catch {
      return null;
    }
  }

  async hover(filePath: string, position: LspPos): Promise<string | null> {
    const langId = this.getLanguageId(filePath);
    if (!langId) return null;
    try {
      const result = await lspRequest(langId, "textDocument/hover", {
        textDocument: { uri: this.fileUri(filePath) },
        position,
      });
      if (!result) return null;
      const contents = (result as { contents?: unknown }).contents;
      if (!contents) return null;
      if (typeof contents === "string") return contents;
      if (typeof contents === "object" && "value" in (contents as object))
        return (contents as { value: string }).value;
      if (Array.isArray(contents))
        return contents
          .map((c: unknown) => (typeof c === "string" ? c : (c as { value: string }).value))
          .join("\n---\n");
      return null;
    } catch {
      return null;
    }
  }

  async complete(filePath: string, position: LspPos, triggerKind = 1): Promise<LspCompletionItem[]> {
    const langId = this.getLanguageId(filePath);
    if (!langId) return [];
    try {
      const result = await lspRequest(langId, "textDocument/completion", {
        textDocument: { uri: this.fileUri(filePath) },
        position,
        context: { triggerKind },
      });
      if (!result) return [];
      const items = Array.isArray(result)
        ? result
        : ((result as { items?: LspCompletionItem[] }).items ?? []);
      return items as LspCompletionItem[];
    } catch {
      return [];
    }
  }

  async codeActions(filePath: string, line: number, char: number): Promise<CodeAction[]> {
    const langId = this.getLanguageId(filePath);
    if (!langId) return [];
    try {
      const result = await lspRequest(langId, "textDocument/codeAction", {
        textDocument: { uri: this.fileUri(filePath) },
        range: { start: { line, character: char }, end: { line, character: char } },
        context: { diagnostics: [] },
      });
      return (result as CodeAction[]) ?? [];
    } catch {
      return [];
    }
  }

  async executeCodeAction(
    action: CodeAction,
    applyEdit: (edit: WorkspaceEdit) => Promise<void>,
  ): Promise<void> {
    if (action.edit) {
      await applyEdit(action.edit);
    }
    // workspace/executeCommand not yet implemented
  }

  private _normalizeLocations(result: unknown): LspLocation[] {
    if (!result) return [];
    const items = Array.isArray(result) ? result : [result];
    return items
      .map((item: Record<string, unknown>) => {
        // Standard Location: { uri, range }
        if (typeof item.uri === "string") return item as unknown as LspLocation;
        // LocationLink: { targetUri, targetSelectionRange, targetRange }
        if (typeof item.targetUri === "string") {
          return {
            uri: item.targetUri as string,
            range: (item.targetSelectionRange ?? item.targetRange) as LspRange,
          };
        }
        return null;
      })
      .filter((x): x is LspLocation => x !== null);
  }
}

export const lspClient = new LspClient();
