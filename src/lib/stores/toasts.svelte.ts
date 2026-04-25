/**
 * Toast notification system for transient user-facing messages.
 *
 * Call `pushToast(message, kind)` to display a notification. Toasts auto-dismiss
 * after 4 seconds by default. Passing an `action` (button label + callback) disables
 * auto-dismiss so the user can interact. A custom `duration` overrides both defaults;
 * use -1 for indefinite toasts.
 *
 * The `toasts` array is reactive (Svelte 5 $state) and rendered by the ToastContainer
 * component. Each toast gets a unique sequential ID for removal targeting.
 *
 * @exports toasts - Reactive array of active toast notifications
 * @exports pushToast - Add a toast (auto-generates ID and schedules removal)
 * @exports removeToast - Manually dismiss a toast by ID
 * @exports Toast - Toast data interface
 */

export interface Toast {
  id: string;
  message: string;
  kind: "info" | "success" | "error" | "warning";
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export const toasts = $state<Toast[]>([]);

let counter = 0;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function pushToast(
  message: string,
  kind: Toast["kind"] = "info",
  duration?: number,
  action?: Toast["action"],
): void {
  const id = `toast-${++counter}`;
  const effectiveDuration = duration ?? (action ? -1 : 4000);
  toasts.push({ id, message, kind, duration: effectiveDuration, action });
  if (effectiveDuration > 0) {
    timers.set(id, setTimeout(() => removeToast(id), effectiveDuration));
  }
}

export function removeToast(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  const idx = toasts.findIndex((t) => t.id === id);
  if (idx !== -1) toasts.splice(idx, 1);
}
