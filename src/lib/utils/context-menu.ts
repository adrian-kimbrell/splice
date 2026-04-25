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

        // Measure synchronously, then position
        const subW = sub.offsetWidth;
        const subH = sub.offsetHeight;
        const r = btn.getBoundingClientRect();

        let left = r.right;
        let top  = r.top;
        if (left + subW > window.innerWidth)  left = r.left - subW;
        if (top  + subH > window.innerHeight) top  = window.innerHeight - subH - 4;

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
    if (e.key === "Tab")    { e.preventDefault(); }
  };
  document.addEventListener("mousedown",   outside, true);
  document.addEventListener("keydown",     onKey,   true);
  document.addEventListener("contextmenu", outside, true);
}
