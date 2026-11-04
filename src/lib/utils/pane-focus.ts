/**
 * Moving keyboard focus into a pane's content.
 *
 * A pane id can appear more than once in the DOM: every workspace keeps its
 * panes mounted (only the active one is displayed) and a zoomed pane is
 * rendered again in the zoom overlay while its grid copy is hidden. Only the
 * visible copy can take focus, so every caller goes through here.
 */

/**
 * The focusable element inside a pane, in priority order: terminal canvas, editor
 * content, then anything with a tabindex. Tried one at a time: a single combined
 * selector would return whichever comes first in document order, and a tab's
 * `tabindex` precedes the editor body.
 */
const CONTENT_SELECTORS = ["canvas[tabindex]", ".cm-content", "[tabindex]"];

/**
 * Rendered and not hidden. `offsetParent` is null under `display: none` (the
 * inactive workspaces) but not under `visibility: hidden` (the grid copy of a
 * zoomed pane), so both are checked.
 */
export function isDisplayed(el: HTMLElement): boolean {
  return el.offsetParent !== null && getComputedStyle(el).visibility !== "hidden";
}

/** The displayed element for `paneId`, or null when none is visible. */
export function findVisiblePaneEl(paneId: string): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>(`[data-pane-id="${paneId}"]`);
  return Array.from(candidates).find(isDisplayed) ?? null;
}

/**
 * Focus the content of the visible copy of `paneId`. With `unlessInside`,
 * focus already inside that pane is left alone. Returns true when focus moved.
 */
export function focusPaneContent(paneId: string, opts: { unlessInside?: boolean } = {}): boolean {
  const paneEl = findVisiblePaneEl(paneId);
  if (!paneEl) return false;
  if (opts.unlessInside && paneEl.contains(document.activeElement)) return false;
  for (const selector of CONTENT_SELECTORS) {
    const target = paneEl.querySelector<HTMLElement>(selector);
    if (target) {
      target.focus();
      return true;
    }
  }
  return false;
}
