/**
 * Tauri event subscriptions for real-time backend → frontend data.
 *
 * `onTerminalGrid`: listens on `terminal:grid:<id>` for base64-encoded binary frames,
 *   decodes to Uint8Array, and passes to the caller (typically `TerminalRenderer`).
 *   Frame format is documented in `src-tauri/src/terminal/emitter.rs`.
 *
 * `onAttentionNotify`: listens on `attention:notify` for Claude hook payloads forwarded
 *   by the HTTP server in `src-tauri/src/attention/mod.rs`.
 *
 * All listeners return an `unlisten` function — call it in component cleanup to avoid leaks.
 */
import { listen } from "@tauri-apps/api/event";

export function onTerminalGrid(
  id: number,
  callback: (data: Uint8Array) => void,
) {
  return listen<string>(`terminal:grid:${id}`, (event) => {
    const bin = atob(event.payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    callback(bytes);
  });
}

export function onTerminalExit(id: number, callback: (code: number) => void) {
  return listen<number>(`terminal:exit:${id}`, (event) => {
    callback(event.payload);
  });
}

export function onTerminalClipboard(id: number, callback: (text: string) => void) {
  return listen<string>(`terminal:clipboard:${id}`, (event) => {
    callback(event.payload);
  });
}

/** Fires when the shell's working directory changes (for "name follows folder" mode). */
export function onTerminalCwd(id: number, callback: (cwd: string) => void) {
  return listen<string>(`terminal:cwd:${id}`, (event) => {
    callback(event.payload);
  });
}

/** Fires when the shell sets the terminal title via OSC 0/2. Used for the remote
 *  folder in SSH sessions, where the local cwd poll can't see the remote directory. */
export function onTerminalTitle(id: number, callback: (title: string) => void) {
  return listen<string>(`terminal:title:${id}`, (event) => {
    callback(event.payload);
  });
}

export interface AttentionPayload {
  terminal_id: number;
  notification_type: string;
  message: string;
}

export function onAttentionNotify(callback: (payload: AttentionPayload) => void) {
  return listen<AttentionPayload>('attention:notify', (event) => {
    callback(event.payload);
  });
}

/** statusLine command → live cost / context-window HUD. Payload is Claude's
 *  raw statusLine JSON (model, cost, context_window, rate_limits) plus terminal_id. */
export function onClaudeStatus(callback: (payload: any) => void) {
  return listen<any>('claude:status', (event) => {
    callback(event.payload);
  });
}
