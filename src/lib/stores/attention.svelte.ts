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
  };
}

export const attentionStore = createAttentionStore();
