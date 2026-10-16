/**
 * Guarded workspace close.
 *
 * Closing a workspace is destructive and irreversible: every terminal in it is
 * killed (including any running Claude session) and its record is removed from
 * disk. Both entry points — the hover "×" in the workspaces bar and the
 * File → Close Workspace menu item — go through `requestCloseWorkspace` so a
 * stray click can't silently wipe a workspace.
 *
 * Flow:
 *   1. Unsaved files → the standard save / discard / cancel dialogs.
 *   2. Anything live to lose (terminals or open files) → one confirmation
 *      naming the workspace and how many terminal sessions will end.
 *   3. Close.
 *
 * An empty workspace (no terminals, no open files) closes immediately.
 */
import { workspaceManager } from "../stores/workspace.svelte";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Ask what to do about unsaved changes: save them, discard them, or abort. */
export async function confirmUnsaved(): Promise<"save" | "discard" | "cancel"> {
  if (isTauri) {
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      // Dialog 1: "Save" keeps file; "Cancel" means don't save → proceeds to
      // dialog 2 so the user can still abort. This gives a Cancel path from
      // the very first dialog, unlike a "Don't Save" label that implies finality.
      const save = await ask("This pane has unsaved changes. Save before closing?", {
        title: "Unsaved Changes",
        kind: "warning",
        okLabel: "Save",
        cancelLabel: "Cancel",
      });
      if (save) return "save";
      // Dialog 2: confirm the discard, or truly cancel.
      const discard = await ask("Close without saving? Unsaved changes will be lost.", {
        title: "Close Without Saving",
        kind: "warning",
        okLabel: "Close Without Saving",
        cancelLabel: "Cancel",
      });
      return discard ? "discard" : "cancel";
    } catch {
      return window.confirm("Discard unsaved changes?") ? "discard" : "cancel";
    }
  }
  const ok = confirm("You have unsaved changes. Close anyway?");
  return ok ? "discard" : "cancel";
}

/** Ask the user to confirm closing `name`, mentioning what will be lost. */
async function confirmClose(name: string, terminalCount: number, fileCount: number): Promise<boolean> {
  const parts: string[] = [];
  if (terminalCount > 0) {
    parts.push(`${terminalCount} terminal session${terminalCount === 1 ? "" : "s"} will be ended`);
  }
  if (fileCount > 0) {
    parts.push(`${fileCount} open file${fileCount === 1 ? "" : "s"} will be closed`);
  }
  const detail = parts.length ? ` ${parts.join(" and ")}.` : "";
  const message = `Close workspace “${name}”?${detail}`;
  if (isTauri) {
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      return await ask(message, {
        title: "Close Workspace",
        kind: "warning",
        okLabel: "Close Workspace",
        cancelLabel: "Cancel",
      });
    } catch {
      return window.confirm(message);
    }
  }
  return confirm(message);
}

/**
 * Close workspace `id` after the appropriate confirmations.
 * Returns true if the workspace was closed, false if the user cancelled.
 */
export async function requestCloseWorkspace(id: string): Promise<boolean> {
  const ws = workspaceManager.workspaces[id];
  if (!ws) return false;

  const dirtyFiles = ws.openFiles.filter((f) => f.dirty);
  if (dirtyFiles.length > 0) {
    const choice = await confirmUnsaved();
    if (choice === "cancel") return false;
    if (choice === "save") {
      for (const f of dirtyFiles) {
        const saved = await workspaceManager.saveFile(f.path);
        if (!saved) return false; // user cancelled a Save As → abort close
      }
    }
  }

  const terminalCount = ws.terminalIds.length;
  const fileCount = ws.openFiles.length;
  if (terminalCount > 0 || fileCount > 0) {
    const ok = await confirmClose(ws.name, terminalCount, fileCount);
    if (!ok) return false;
  }

  await workspaceManager.closeWorkspaceWithCleanup(id);
  return true;
}
