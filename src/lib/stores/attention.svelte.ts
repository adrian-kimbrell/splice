/**
 * Svelte 5 runes store for Claude Code attention notifications.
 *
 * Keyed by `terminalId` — only one pending notification per terminal at a time;
 * a new notification for the same terminal overwrites the previous one.
 *
 * Notification types:
 * - 'permission': Claude is requesting user approval (e.g. to run a shell command)
 * - 'idle':       Claude has finished a task and is waiting for further input
 *
 * Populated by `onAttentionNotify` in `src/lib/ipc/events.ts`, which decodes
 * the `attention:notify` Tauri event emitted by `src-tauri/src/attention/mod.rs`.
 */
export interface AttentionNotification {
  terminalId: number;
  type: 'permission' | 'idle';
  message: string;
  timestamp: number;
}

function createAttentionStore() {
  let notifications = $state<Record<number, AttentionNotification>>({});

  return {
    get notifications() { return notifications; },
    get count() { return Object.keys(notifications).length; },
    get hasPermission() {
      return Object.values(notifications).some(n => n.type === 'permission');
    },
    notify(n: AttentionNotification) {
      notifications = { ...notifications, [n.terminalId]: n };
    },
    clear(terminalId: number) {
      const { [terminalId]: _, ...rest } = notifications;
      notifications = rest;
    },
    clearAll() {
      notifications = {};
    },
  };
}

export const attentionStore = createAttentionStore();
