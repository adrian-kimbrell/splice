/**
 * Imperative, native-style right-click context menu rendered as a DOM overlay.
 *
 * Submenu behaviour uses the Radix UI "grace polygon" technique: when the cursor
 * leaves a sub-trigger, a pentagon is constructed from the exit point to the
 * submenu's four corners. A pointermove listener watches the document; the
 * submenu stays open as long as the cursor is inside that polygon. The moment
 * the cursor leaves the polygon (or a 300 ms fallback fires), the submenu closes.
 * Sibling items suppress their own activation while the grace period is active.
 */

export interface ContextMenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  action?: () => void;
  submenu?: (ContextMenuItem | "sep")[];
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

type Point = { x: number; y: number };

function isPointInPolygon(pt: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if ((yi > pt.y) !== (yj > pt.y) &&
        pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function isPointInRect(pt: Point, r: DOMRect): boolean {
  return pt.x >= r.left && pt.x <= r.right && pt.y >= r.top && pt.y <= r.bottom;
}

/**
 * Pentagon bridging the cursor's exit point to all four corners of the submenu.
 * The bleed extends the apex point BACK toward the parent menu so the polygon
 * covers the full gap between the two menus.
 */
function buildGracePolygon(exitX: number, exitY: number, sub: DOMRect, side: "right" | "left"): Point[] {
  // Negative bleed for right-side (extend apex leftward into the gap)
  const bleed = side === "right" ? -8 : 8;
  return [
    { x: exitX + bleed, y: exitY },
    { x: sub.left,  y: sub.top    },
    { x: sub.right, y: sub.top    },
    { x: sub.right, y: sub.bottom },
    { x: sub.left,  y: sub.bottom },
  ];
}

// ---------------------------------------------------------------------------
// Grace period state
// ---------------------------------------------------------------------------

let activeSubmenu: HTMLElement | null = null;
let graceCleanup: (() => void) | null = null;
let inGracePeriod = false;

function startGracePeriod(exitX: number, exitY: number, submenuEl: HTMLElement, onClose: () => void) {
  stopGracePeriod();
  inGracePeriod = true;

  const subRect = submenuEl.getBoundingClientRect();
  const side: "right" | "left" = exitX <= subRect.left ? "right" : "left";
  const polygon = buildGracePolygon(exitX, exitY, subRect, side);

  let fallback = setTimeout(() => { stopGracePeriod(); onClose(); }, 300);

  function onMove(e: PointerEvent) {
    const pt: Point = { x: e.clientX, y: e.clientY };
    const currentRect = submenuEl.getBoundingClientRect();

    if (isPointInRect(pt, currentRect)) {
      // Cursor reached the submenu — grace fulfilled
      stopGracePeriod();
      return;
    }

    if (isPointInPolygon(pt, polygon)) {
      // Still travelling toward submenu — reset fallback
      clearTimeout(fallback);
      fallback = setTimeout(() => { stopGracePeriod(); onClose(); }, 300);
      return;
    }

    // Outside the safe zone — close immediately
    stopGracePeriod();
    onClose();
  }

  document.addEventListener("pointermove", onMove);

  graceCleanup = () => {
    clearTimeout(fallback);
    document.removeEventListener("pointermove", onMove);
    inGracePeriod = false;
    graceCleanup = null;
  };
}

function stopGracePeriod() {
  graceCleanup?.();
}

function removeSubmenu() {
  stopGracePeriod();
  activeSubmenu?.remove();
  activeSubmenu = null;
}

// ---------------------------------------------------------------------------
// Menu builder
// ---------------------------------------------------------------------------

function buildMenu(items: (ContextMenuItem | "sep")[], onRemove: () => void): HTMLElement {
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
    btn.tabIndex = -1; // prevent Tab key from navigating into menu buttons

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
        stopGracePeriod();
        removeSubmenu();

        const sub = buildMenu(item.submenu!, onRemove);
        // Render hidden so we can measure before showing
        sub.style.cssText = "position:fixed;visibility:hidden;z-index:10000;";
        document.body.appendChild(sub);
        activeSubmenu = sub;

        // Measure synchronously (forces layout)
        const subW = sub.offsetWidth;
        const subH = sub.offsetHeight;
        const parentRect = btn.getBoundingClientRect();

        // Position flush against parent menu — no gap to bridge
        let left = parentRect.right;
        let top = parentRect.top;
        if (left + subW > window.innerWidth) left = parentRect.left - subW;
        if (top + subH > window.innerHeight) top = window.innerHeight - subH - 4;

        sub.style.left = `${left}px`;
        sub.style.top = `${top}px`;
        sub.style.visibility = "visible";
      });

      btn.addEventListener("pointerleave", (e) => {
        if (!activeSubmenu) return;
        startGracePeriod(e.clientX, e.clientY, activeSubmenu, () => {
          removeSubmenu();
        });
      });

    } else {
      btn.addEventListener("mouseenter", () => {
        if (inGracePeriod) return; // don't disturb in-flight navigation to submenu
        removeSubmenu();
      });

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function showContextMenu(items: (ContextMenuItem | "sep")[], x: number, y: number): void {
  document.querySelector(".splice-ctx-menu")?.remove();
  removeSubmenu();

  const menu = buildMenu(items, remove);
  menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:9999;`;
  document.body.appendChild(menu);

  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right  > window.innerWidth)  menu.style.left = `${window.innerWidth  - r.width  - 4}px`;
    if (r.bottom > window.innerHeight) menu.style.top  = `${window.innerHeight - r.height - 4}px`;
  });

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
    if (e.key === "Tab") { e.preventDefault(); } // prevent Tab from walking focus out of menu
  };
  document.addEventListener("mousedown",   outside, true);
  document.addEventListener("keydown",     onKey,   true);
  document.addEventListener("contextmenu", outside, true);
}
