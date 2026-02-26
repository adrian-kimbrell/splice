export interface ContextMenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  action: () => void;
}

export function showContextMenu(
  items: (ContextMenuItem | "sep")[],
  x: number,
  y: number,
): void {
  document.querySelector(".splice-ctx-menu")?.remove();

  const menu = document.createElement("div");
  menu.className = "split-dropdown splice-ctx-menu";
  menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:9999;`;

  for (const item of items) {
    if (item === "sep") {
      const sep = document.createElement("div");
      sep.className = "split-dropdown-sep";
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.className = "split-dropdown-item" + (item.disabled ? " disabled" : "");
    btn.disabled = item.disabled ?? false;
    btn.innerHTML = `<span>${item.label}</span>${item.shortcut ? `<kbd>${item.shortcut}</kbd>` : ""}`;
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      remove();
      if (!item.disabled) item.action();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);

  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) menu.style.left = `${window.innerWidth - r.width - 4}px`;
    if (r.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - r.height - 4}px`;
  });

  function remove() {
    menu.remove();
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", esc, true);
    document.removeEventListener("contextmenu", outside, true);
  }
  const outside = (e: Event) => { if (!menu.contains(e.target as Node)) remove(); };
  const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); remove(); } };
  document.addEventListener("mousedown", outside, true);
  document.addEventListener("keydown", esc, true);
  document.addEventListener("contextmenu", outside, true);
}
