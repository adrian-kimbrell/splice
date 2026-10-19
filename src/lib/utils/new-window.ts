/**
 * Creates a new independent Splice editor window via the Tauri WebviewWindow API.
 *
 * Each window gets a unique random label and its own workspace config file,
 * registered on the Rust side before the webview is spawned. The new window
 * loads the root `/` entry point with default 1280x800 dimensions.
 * No-ops gracefully outside a Tauri environment.
 */
import { log } from "./log";
import { registerWindow, getAllWorkspaceLabels } from "../ipc/commands";

/** Opens a fresh, independent app window with its own workspace file. */
export async function openNewWindow(): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  try {
    const label = `main-${Math.random().toString(16).slice(2, 8)}`;
    await registerWindow(label);
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const { LogicalPosition } = await import("@tauri-apps/api/dpi");
    new WebviewWindow(label, {
      url: "/",
      title: "Splice",
      width: 1280,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      decorations: true,
      titleBarStyle: "overlay",
      hiddenTitle: true,
      trafficLightPosition: new LogicalPosition(14, 21),
      resizable: true,
      backgroundColor: { red: 30, green: 30, blue: 30, alpha: 255 },
    });
  } catch (e) {
    log.error("Failed to open new window:", e);
  }
}

/**
 * Main window only: reopen the secondary windows that were registered before a
 * crash or force-quit, so their workspaces come back.
 */
export async function reopenRegisteredWindows(): Promise<void> {
  const { getCurrentWebviewWindow, WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const currentLabel = getCurrentWebviewWindow().label;
  if (currentLabel !== "main") return;
  const labels = await getAllWorkspaceLabels();
  for (const l of labels) {
    if (l === currentLabel) continue;
    new WebviewWindow(l, {
      url: "/",
      title: "Splice",
      width: 1280,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      decorations: true,
      titleBarStyle: "overlay",
      hiddenTitle: true,
      resizable: true,
    });
  }
}
