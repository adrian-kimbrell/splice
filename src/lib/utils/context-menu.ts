/**
 * Imperative, native-style right-click context menu rendered as a DOM overlay.
 *
 * Submenu behaviour: opens on mouseenter of the trigger item. A safe triangle
 * (apex = cursor exit point, base = submenu near-edge corners) is tracked via
 * mousemove so diagonal cursor movement toward the submenu never triggers an
 * accidental close. The triangle is only set up when the cursor exits the trigger
 * toward the submenu side; exiting the other way closes immediately.
 */

export interface ContextMenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  action?: () => void;
  submenu?: (ContextMenuItem | "sep")[];
}

let activeSubmenu: HTMLElement | null = null;
// Safe triangle vertices [ax,ay, bx,by, cx,cy]
let safeTri: [number, number, number, number, number, number] | null = null;
let safeTriUnlisten: (() => void) | null = null;

// ── Triangle math ────────────────────────────────────────────────────────────

function triSign(
  p1x: number, p1y: number,
  p2x: number, p2y: number,
  p3x: number, p3y: number,
): number {
  return (p1x - p3x) * (p2y - p3y) - (p2x - p3x) * (p1y - p3y);
}

function pointInTri(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
): boolean {
  const d1 = triSign(px, py, ax, ay, bx, by);
  const d2 = triSign(px, py, bx, by, cx, cy);
  const d3 = triSign(px, py, cx, cy, ax, ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function inSafeTri(x: number, y: number): boolean {
  if (!safeTri) return false;
  return pointInTri(x, y, safeTri[0], safeTri[1], safeTri[2], safeTri[3], safeTri[4], safeTri[5]);
}

// ── Safe-triangle lifecycle ──────────────────────────────────────────────────

function clearSafeTri() {
  safeTri = null;
  safeTriUnlisten?.();
  safeTriUnlisten = null;
}

function removeSubmenu() {
  clearSafeTri();
  activeSubmenu?.remove();
  activeSubmenu = null;
}

/**
 * Called on mouseleave of a submenu-trigger button.
 * Sets up a triangle from the cursor's exit position to the submenu's near
 * edge corners, then tracks mousemove. Any mousemove that exits the triangle
 * (and isn't inside the submenu itself) closes the submenu.
 *
 * Only sets up the triangle when the cursor exits toward the submenu side;
 * if it exits the other way, the submenu is closed immediately.
 */
function setupSafeTriangle(e: MouseEvent, sub: HTMLElement, triggerRect: DOMRect) {
  const subRect = sub.getBoundingClientRect();
  const toRight = subRect.left >= triggerRect.right - 2;

  // Only protect diagonal movement toward the submenu
  const exitingToward = toRight
    ? e.clientX >= triggerRect.left + triggerRect.width * 0.4
    : e.clientX <= triggerRect.left + triggerRect.width * 0.6;

  if (!exitingToward) {
    removeSubmenu();
    return;
  }

  // Apex: cursor exit point shifted slightly away from the submenu so the
  // triangle has non-zero width even when there is no gap.
  const ax = toRight ? e.clientX - 10 : e.clientX + 10;
  const ay = e.clientY;

  // Base: near edge of submenu with a small vertical buffer
  const bx = toRight ? subRect.left : subRect.right;
  const by = subRect.top - 5;
  const cx = bx;
  const cy = subRect.bottom + 5;

  safeTri = [ax, ay, bx, by, cx, cy];

  const onMove = (ev: MouseEvent) => {
    if (!sub || !safeTri) { clearSafeTri(); return; }

    // Cursor entered the submenu — stop triangle tracking
    const sr = sub.getBoundingClientRect();
    if (
      ev.clientX >= sr.left - 2 && ev.clientX <= sr.right + 2 &&
      ev.clientY >= sr.top  - 2 && ev.clientY <= sr.bottom + 2
    ) {
      clearSafeTri();
      return;
    }

    // Cursor left the safe zone — close submenu
    if (!inSafeTri(ev.clientX, ev.clientY)) {
      removeSubmenu();
    }
  };

  document.addEventListener("mousemove", onMove, true);
  safeTriUnlisten = () => document.removeEventListener("mousemove", onMove, true);
}

// ── Menu builder ─────────────────────────────────────────────────────────────

function buildMenu(items: (ContextMenuItem | "sep")[], onRemove: () => void, depth = 0): HTMLElement {
  const menu = document.createElement("div");
  menu.className = "split-dropdown splice-ctx-menu";

  for (const item of items) {
    if (item === "sep") {
      const sep = document.createElement("div");
      sep.className = "split-dropdown-sep";
      menu.appendChild(sep);
      continue;
    }

    const btn = document.createElement("button");
    const hasSubmenu = !!(item.submenu && item.submenu.length > 0);
    btn.className = "split-dropdown-item" + (item.disabled ? " disabled" : "");
    btn.disabled = (!hasSubmenu && !item.action) || (item.disabled ?? false);
    btn.tabIndex = -1;

    const labelSpan = document.createElement("span");
    labelSpan.textContent = item.label;
    btn.appendChild(labelSpan);

    if (hasSubmenu) {
      const arrow = document.createElement("span");
      arrow.style.cssText = "margin-left:auto;padding-left:8px;opacity:0.5;font-size:9px;pointer-events:none";
      arrow.textContent = "▶";
      btn.appendChild(arrow);
    } else if (item.shortcut) {
      const kbd = document.createElement("kbd");
      kbd.textContent = item.shortcut;
      btn.appendChild(kbd);
    }

    if (hasSubmenu) {
      btn.addEventListener("mouseenter", () => {
        // Clear any pending safe triangle from a previous submenu trigger
        clearSafeTri();
        removeSubmenu();

        const sub = buildMenu(item.submenu!, onRemove, depth + 1);
        sub.style.cssText = "position:fixed;visibility:hidden;z-index:10000;";
        document.body.appendChild(sub);
        activeSubmenu = sub;

        // Position entirely in unzoomed layout px. The trigger's getBoundingClientRect
        // is layout px in WebKit but visual (layout*zoom) in Chromium; normalize it
        // by the ratio of its reported width to its layout offsetWidth, then place
        // the submenu (offsetWidth/Height and clientWidth/Height are layout px on
        // every engine). style.left/top on the fixed submenu are layout px too, so
        // no further zoom conversion is needed. See [[zoom-coords]].
        const r = btn.getBoundingClientRect();
        const s = btn.offsetWidth ? (r.width / btn.offsetWidth) || 1 : 1;
        // Root rect / s gives the viewport bounds in layout px on either engine.
        const vp = document.documentElement.getBoundingClientRect();
        const vw = vp.width  / s;
        const vh = vp.height / s;
        const subW = sub.offsetWidth;
        const subH = sub.offsetHeight;

        let left = r.right / s;
        let top  = r.top   / s;
        if (left + subW > vw) left = r.left / s - subW;
        if (top  + subH > vh) top  = vh - subH - 4;

        sub.style.left = `${left}px`;
        sub.style.top  = `${top}px`;
        sub.style.visibility = "visible";
      });

      btn.addEventListener("mouseleave", (e) => {
        if (!activeSubmenu) return;
        setupSafeTriangle(e, activeSubmenu, btn.getBoundingClientRect());
      });

    } else {
      // Only top-level items need to close a sibling submenu on hover.
      // Submenu items must NOT call removeSubmenu — activeSubmenu IS the submenu they live in.
      if (depth === 0) {
        btn.addEventListener("mouseenter", (e) => {
          if (inSafeTri(e.clientX, e.clientY)) return;
          removeSubmenu();
        });
      }

      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        removeSubmenu();
        onRemove();
        if (!item.disabled) item.action?.();
      });
    }

    menu.appendChild(btn);
  }

  return menu;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Position an already-appended `position:fixed` menu element at a viewport
 * (zoom-scaled / visual) click coordinate, correcting for the document root's
 * CSS `zoom` (appearance.ui_scale) and clamping to stay on-screen.
 *
 * clientX/Y are visual px on every engine, but a fixed element inside the zoomed
 * root positions in layout px (the root re-multiplies by zoom on render), so set
 * left/top = client/zoom. For the on-screen clamp, the menu's own
 * getBoundingClientRect and the root element's are in the SAME engine-specific
 * space (layout px in WebKit, visual px in Chromium), so comparing them is valid
 * without knowing which; overflow is converted back to layout px via the menu's
 * rectScale (rect.width/offsetWidth = 1 in WebKit, zoom in Chromium). No-op when
 * zoom is 1. Call after the element is in the DOM so it has a measurable size.
 * See [[zoom-coords]]. Used by every fixed context menu in the app.
 */
export function positionFixedMenu(menu: HTMLElement, x: number, y: number): void {
  const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  const leftLayout = x / zoom;
  const topLayout  = y / zoom;
  menu.style.left = `${leftLayout}px`;
  menu.style.top  = `${topLayout}px`;

  requestAnimationFrame(() => {
    if (!menu.parentNode) return;
    const r  = menu.getBoundingClientRect();
    const vp = document.documentElement.getBoundingClientRect();
    const s  = menu.offsetWidth ? (r.width / menu.offsetWidth) || 1 : 1;
    const overR = r.right  - (vp.right  - 4);
    const overB = r.bottom - (vp.bottom - 4);
    if (overR > 0) menu.style.left = `${Math.max(4, leftLayout - overR / s)}px`;
    if (overB > 0) menu.style.top  = `${Math.max(4, topLayout  - overB / s)}px`;
  });
}

export function showContextMenu(items: (ContextMenuItem | "sep")[], x: number, y: number): void {
  document.querySelector(".splice-ctx-menu")?.remove();
  removeSubmenu();

  const menu = buildMenu(items, remove);
  menu.style.cssText = "position:fixed;z-index:9999;";
  document.body.appendChild(menu);
  positionFixedMenu(menu, x, y);

  function remove() {
    removeSubmenu();
    menu.remove();
    document.removeEventListener("mousedown",   outside, true);
    document.removeEventListener("keydown",     onKey,   true);
    document.removeEventListener("contextmenu", outside, true);
  }
  const outside = (e: Event) => {
    const t = e.target as Node;
    if (!menu.contains(t) && !(activeSubmenu?.contains(t))) remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); remove(); }
    if (e.key === "Tab")    { e.preventDefault(); }
  };
  document.addEventListener("mousedown",   outside, true);
  document.addEventListener("keydown",     onKey,   true);
  document.addEventListener("contextmenu", outside, true);
}
