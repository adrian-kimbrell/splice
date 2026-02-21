<script lang="ts">
  import { onDestroy } from "svelte";

  export interface DropdownItem {
    label: string;
    icon?: string;
    iconStyle?: string;
    shortcut?: string;
    action: string;
    separator?: boolean;
  }

  let {
    open = $bindable(false),
    triggerEl = null,
    items,
    onSelect,
    containerClass = "",
  }: {
    open: boolean;
    triggerEl: HTMLElement | null;
    items: DropdownItem[];
    onSelect: (action: string) => void;
    containerClass?: string;
  } = $props();

  let dropdownEl: HTMLDivElement | null = null;

  function createDropdown() {
    if (dropdownEl) return;
    dropdownEl = document.createElement("div");
    dropdownEl.className = `split-dropdown ${containerClass}`;

    let html = "";
    for (const item of items) {
      if (item.separator) {
        html += `<div class="split-dropdown-sep"></div>`;
      }
      html += `<button class="split-dropdown-item" data-action="${item.action}">`;
      if (item.icon) {
        html += `<i class="bi ${item.icon}"${item.iconStyle ? ` style="${item.iconStyle}"` : ""}></i>`;
      }
      html += `<span>${item.label}</span>`;
      if (item.shortcut) {
        html += `<kbd>${item.shortcut}</kbd>`;
      }
      html += `</button>`;
    }
    dropdownEl.innerHTML = html;

    dropdownEl.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("[data-action]");
      if (btn) {
        const action = btn.getAttribute("data-action")!;
        open = false;
        onSelect(action);
      }
    });
    document.body.appendChild(dropdownEl);
  }

  function removeDropdown() {
    if (dropdownEl) {
      dropdownEl.remove();
      dropdownEl = null;
    }
  }

  function updatePos() {
    if (!triggerEl || !dropdownEl) return;
    const r = triggerEl.getBoundingClientRect();
    dropdownEl.style.top = r.bottom + "px";
    dropdownEl.style.left = r.right + "px";
  }

  $effect(() => {
    if (open) {
      createDropdown();
      updatePos();
    } else {
      removeDropdown();
    }
  });

  export function reposition() {
    if (open) updatePos();
  }

  function handleDocClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    if (open && containerClass && !t.closest(`.${containerClass}`)) {
      open = false;
    }
  }

  onDestroy(() => removeDropdown());
</script>

<svelte:document onclick={handleDocClick} />
