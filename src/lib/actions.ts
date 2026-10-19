/**
 * App-wide action registry.
 *
 * Every user-facing command has one id and one handler. The native menu
 * (`menu-event` from src-tauri/src/lib.rs), keyboard shortcuts
 * (`utils/keybindings.ts`), the command palette and the pane "+" menu all
 * dispatch through `runAction`, so a command is implemented exactly once and a
 * menu id with no handler is a logged error rather than a silent no-op.
 *
 * App.svelte registers the handlers on mount: several of them (closing tabs
 * with a save prompt, for instance) are flows that live there.
 */
import { log } from "./utils/log";

/** Ids of the native menu items in src-tauri/src/lib.rs. `actions.test.ts` keeps the two lists in sync. */
export const MENU_ACTION_IDS = [
  "settings",
  "new-file",
  "open-file",
  "open-folder",
  "new-window",
  "save",
  "save-as",
  "save-all",
  "close-tab",
  "close-all-tabs",
  "close-workspace",
  "find",
  "find-in-files",
  "replace",
  "goto-line",
  "format-document",
  "command-palette",
  "toggle-sidebar",
  "toggle-word-wrap",
  "zoom-in",
  "zoom-out",
  "zoom-reset",
  "zen-mode",
  "new-terminal",
] as const;

/** Commands that exist only in-app (shortcuts, palette, pane menu). */
export const APP_ONLY_ACTION_IDS = ["search-project", "find-replace", "problems-panel"] as const;

export type MenuActionId = (typeof MENU_ACTION_IDS)[number];
export type AppActionId = MenuActionId | (typeof APP_ONLY_ACTION_IDS)[number];

export type ActionHandler = () => void | Promise<void>;

const ALL_IDS = new Set<string>([...MENU_ACTION_IDS, ...APP_ONLY_ACTION_IDS]);
const handlers = new Map<AppActionId, ActionHandler>();

export function isActionId(id: string): id is AppActionId {
  return ALL_IDS.has(id);
}

/** Register handlers; returns a disposer that removes exactly these. */
export function registerActions(map: Partial<Record<AppActionId, ActionHandler>>): () => void {
  const ids = Object.keys(map) as AppActionId[];
  for (const id of ids) handlers.set(id, map[id]!);
  return () => {
    for (const id of ids) if (handlers.get(id) === map[id]) handlers.delete(id);
  };
}

/** Run the handler for `id`. Returns false (and warns) for an unknown or unregistered id. */
export function runAction(id: string): boolean {
  if (!isActionId(id)) {
    log.warn("Unknown action id:", id);
    return false;
  }
  const handler = handlers.get(id);
  if (!handler) {
    log.warn("No handler registered for action:", id);
    return false;
  }
  void Promise.resolve(handler()).catch((e) => log.error(`Action "${id}" failed:`, e));
  return true;
}

/** Native menu items (src-tauri/src/lib.rs) arrive as `menu-event` with the item id. */
export async function startMenuEvents(): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string>("menu-event", (event) => { runAction(event.payload); });
}
