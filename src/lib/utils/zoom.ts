/**
 * Zoom-aware coordinate helpers. [[zoom-coords]]
 *
 * `appearance.ui_scale` applies CSS `zoom` to the document root. That splits the
 * coordinate world in two:
 *   - MouseEvent.clientX/Y are ALWAYS in *visual* px (= layout px × zoom).
 *   - getBoundingClientRect() is *layout* px in WebKit (macOS WKWebView — where
 *     rect.width === offsetWidth) but *visual* px in Chromium (rect.width ===
 *     offsetWidth × zoom).
 *
 * Comparing a client coord against a rect (hit-testing, ratios, cell mapping)
 * without reconciling those spaces produces an error that scales with the
 * coordinate magnitude — invisible near the top-left / on a small laptop screen,
 * but large far from the origin / on a wide monitor. Every consumer must funnel
 * through here instead of re-deriving the math. All helpers are a no-op at zoom 1.
 */

/** CSS zoom (ui_scale) on the document root; 1 when unzoomed.
 *
 * Read the INLINE style, not getComputedStyle: macOS WKWebView applies the zoom
 * (the UI visibly scales) but does NOT report `zoom` back through getComputedStyle,
 * so the computed read returns "" → parseFloat → NaN → we'd silently fall back to 1.
 * A docZoom() that reads 1 while the real scale is e.g. 1.1 throws off every
 * zoom-aware coordinate by (zoom-1)×distance-from-origin — the splitter drifting
 * right of the cursor, worst on a wide monitor. App.svelte writes `style.zoom`
 * directly, so the inline value is the reliable source of truth. [[zoom-coords]] */
export function docZoom(): number {
  return (
    parseFloat(document.documentElement.style.zoom) ||
    parseFloat(getComputedStyle(document.documentElement).zoom) ||
    1
  );
}

/**
 * rect-vs-layout scale for `el`: 1 in WebKit (rect is layout px), `zoom` in
 * Chromium (rect is visual px). Measured off the element itself so it needs no
 * engine sniffing.
 */
function rectScale(el: HTMLElement, rect: DOMRect): number {
  const s = el.offsetWidth ? rect.width / el.offsetWidth : 0;
  return s || 1;
}

/**
 * Layout-pixel offset of a visual client coordinate from the top-left of `el`.
 * Feeds anything that reasons in unzoomed layout px — cell mapping, split ratios.
 */
export function clientToLayoutOffset(
  clientX: number,
  clientY: number,
  el: HTMLElement,
): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  const s = rectScale(el, rect);
  const zoom = docZoom();
  return {
    x: clientX / zoom - rect.left / s,
    y: clientY / zoom - rect.top / s,
  };
}

/**
 * A visual client coordinate expressed in the coordinate space that
 * getBoundingClientRect() reports for `refEl`, so it can be compared directly
 * against any rect's left/top/right/bottom. (rectScale is a document-wide
 * property, so any on-screen element works as the reference.)
 */
export function clientToRectSpace(
  clientX: number,
  clientY: number,
  refEl: HTMLElement,
): { x: number; y: number } {
  const rect = refEl.getBoundingClientRect();
  const factor = docZoom() / rectScale(refEl, rect);
  return { x: clientX / factor, y: clientY / factor };
}
