/**
 * Moving keyboard focus into a pane's content.
 *
 * A pane id can appear more than once in the DOM: every workspace keeps its
 * panes mounted (only the active one is displayed) and a zoomed pane is
 * rendered again in the zoom overlay while its grid copy is hidden. Only the
 * visible copy can take focus, so every caller goes through here.
 */

/** The focusable element inside a pane: terminal canvas, editor, or anything with a tabindex. */
const CONTENT_SELECTOR = "canvas[tabindex], .cm-content, [tabindex]";

/** The displayed element for `paneId`, or null when none is visible. */
export function findVisiblePaneEl(paneId: string): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>(`[data-pane-id="${paneId}"]`);
  return Array.from(candidates).find((el) => el.offsetParent !== null) ?? null;
}

/**
 * Focus the content of the visible copy of `paneId`. With `unlessInside`,
 * focus already inside that pane is left alone. Returns true when focus moved.
 */
export function focusPaneContent(paneId: string, opts: { unlessInside?: boolean } = {}): boolean {
  const paneEl = findVisiblePaneEl(paneId);
  if (!paneEl) return false;
  if (opts.unlessInside && paneEl.contains(document.activeElement)) return false;
  const target = paneEl.querySelector<HTMLElement>(CONTENT_SELECTOR);
  if (!target) return false;
  target.focus();
  return true;
}
