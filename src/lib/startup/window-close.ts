/**
 * Persist everything before the window closes. A secondary window owns its
 * workspaces: closing it deletes its workspace file, so it confirms first when
 * there is anything to lose.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { workspaceManager } from "../stores/workspace.svelte";
import { flushSettingsSave } from "../stores/settings.svelte";
import { unregisterWindow } from "../ipc/commands";
import { log } from "../utils/log";

export async function startWindowCloseHandler(): Promise<() => void> {
  const appWindow = getCurrentWindow();
  const currentLabel = appWindow.label;
  return appWindow.onCloseRequested(async (event) => {
    event.preventDefault();
    if (currentLabel !== "main") {
      const count = Object.keys(workspaceManager.workspaces).length;
      if (count > 0) {
        let ok = true;
        try {
          const { ask } = await import("@tauri-apps/plugin-dialog");
          ok = await ask(
            `Close this window? ${count} workspace${count === 1 ? "" : "s"} in it will be removed, and their terminals ended.`,
            { title: "Close Window", kind: "warning", okLabel: "Close Window", cancelLabel: "Cancel" },
          );
        } catch {
          ok = window.confirm("Close this window and remove its workspaces?");
        }
        if (!ok) return;
      }
    }
    flushSettingsSave();
    // Cancel + flush any pending debounced persistence so state mutated
    // <500ms before quit is not lost when timers fire after destroy.
    await workspaceManager.flushPersistTimers();
    await Promise.allSettled(
      Object.keys(workspaceManager.workspaces).map((wsId) => workspaceManager.persistWorkspace(wsId)),
    );
    // Graceful close of a secondary window: remove from registry + delete workspace file.
    if (currentLabel !== "main") {
      await unregisterWindow(currentLabel).catch(log.warn);
    }
    try {
      await appWindow.destroy();
    } catch {
      await appWindow.close();
    }
  });
}
