export interface Toast {
  id: string;
  message: string;
  kind: "info" | "success" | "error" | "warning";
}

export const toasts = $state<Toast[]>([]);

let counter = 0;

export function pushToast(message: string, kind: Toast["kind"] = "info", duration = 3000): void {
  const id = `toast-${++counter}`;
  toasts.push({ id, message, kind });
  if (duration > 0) {
    setTimeout(() => removeToast(id), duration);
  }
}

export function removeToast(id: string): void {
  const idx = toasts.findIndex((t) => t.id === id);
  if (idx !== -1) toasts.splice(idx, 1);
}
