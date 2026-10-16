import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import {
  beginDrag,
  endDrag,
  registerPane,
  unregisterPane,
  registerPaneContent,
  unregisterPaneContent,
  setDropCallback,
  getDragActive,
  getHoverPaneId,
  getHoverZone,
  getGhostX,
  getGhostY,
  isDragging,
  type TabDragData,
  type DropZone,
} from "./drag.svelte";

type DropCb = (data: TabDragData, targetPaneId: string, zone: DropZone) => void;

// Tab/pane drag-and-drop: threshold activation, hit testing against registered
// panes, the five drop zones (outer 25% margins split; centre moves), and the
// drop callback contract. Elements are fakes with a fixed bounding rect.

function fakeEl(left: number, top: number, width: number, height: number): HTMLElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;
  return el;
}

function mouse(type: "mousemove" | "mouseup", clientX: number, clientY: number) {
  document.dispatchEvent(new MouseEvent(type, { clientX, clientY, bubbles: true }));
}

const DATA: TabDragData = { filePath: "/a.ts", fileName: "a.ts", sourcePaneId: "src", kind: "editor" };

describe("drag store", () => {
  let pane: HTMLElement;
  let drop: Mock<DropCb>;

  beforeEach(() => {
    pane = fakeEl(0, 0, 100, 100);
    registerPane("p1", pane);
    drop = vi.fn<DropCb>();
    setDropCallback(drop);
  });

  afterEach(() => {
    endDrag();
    unregisterPane("p1", pane);
    unregisterPaneContent("p1");
    setDropCallback(null);
  });

  function start(x = 500, y = 500) {
    beginDrag(DATA, new MouseEvent("mousedown", { clientX: x, clientY: y }));
  }

  it("beginDrag_records_payload_but_is_not_dragging_until_threshold", () => {
    start(500, 500);
    expect(getDragActive()).toEqual(DATA);
    expect(isDragging()).toBe(false);
    expect(getGhostX()).toBe(500);
    expect(getGhostY()).toBe(500);
    mouse("mousemove", 502, 502); // < 4px
    expect(isDragging()).toBe(false);
    mouse("mousemove", 505, 505); // > 4px
    expect(isDragging()).toBe(true);
    expect(document.body.classList.contains("tab-dragging")).toBe(true);
  });

  it("ghost_follows_the_pointer_once_dragging", () => {
    start();
    mouse("mousemove", 50, 50);
    expect(getGhostX()).toBe(50);
    expect(getGhostY()).toBe(50);
  });

  it.each([
    [10, 50, "left"],
    [90, 50, "right"],
    [50, 10, "top"],
    [50, 90, "bottom"],
    [50, 50, "center"],
  ] as const)("zone_at_(%i,%i)_is_%s", (x, y, zone) => {
    start();
    mouse("mousemove", x, y);
    expect(getHoverPaneId()).toBe("p1");
    expect(getHoverZone()).toBe(zone);
  });

  it("horizontal_margins_win_over_vertical_in_corners", () => {
    start();
    mouse("mousemove", 10, 10); // both left and top margins → left
    expect(getHoverZone()).toBe("left");
  });

  it("pointer_outside_every_pane_clears_hover", () => {
    start();
    mouse("mousemove", 50, 50);
    expect(getHoverPaneId()).toBe("p1");
    mouse("mousemove", 300, 300);
    expect(getHoverPaneId()).toBeNull();
    expect(getHoverZone()).toBeNull();
  });

  it("content_element_is_preferred_for_zone_math", () => {
    // Content area excludes a 20px tab bar at the top of the pane.
    registerPaneContent("p1", fakeEl(0, 20, 100, 80));
    start();
    // y=30 is 12.5% into the content box → "top"; it would be 30% (centre) of the outer pane.
    mouse("mousemove", 50, 30);
    expect(getHoverZone()).toBe("top");
    // y=10 is in the tab bar: outside content but inside the outer pane → still hits p1.
    mouse("mousemove", 50, 10);
    expect(getHoverPaneId()).toBe("p1");
  });

  it("mouseup_over_a_pane_fires_drop_and_resets", () => {
    start();
    mouse("mousemove", 50, 50);
    mouse("mouseup", 50, 50);
    expect(drop).toHaveBeenCalledTimes(1);
    expect(drop).toHaveBeenCalledWith(DATA, "p1", "center");
    expect(getDragActive()).toBeNull();
    expect(isDragging()).toBe(false);
    expect(getHoverPaneId()).toBeNull();
    expect(document.body.classList.contains("tab-dragging")).toBe(false);
  });

  it("mouseup_without_crossing_threshold_is_a_click_not_a_drop", () => {
    start(50, 50);
    mouse("mousemove", 51, 51);
    mouse("mouseup", 51, 51);
    expect(drop).not.toHaveBeenCalled();
    expect(getDragActive()).toBeNull();
  });

  it("mouseup_outside_any_pane_drops_nothing", () => {
    start();
    mouse("mousemove", 300, 300);
    mouse("mouseup", 300, 300);
    expect(drop).not.toHaveBeenCalled();
    expect(getDragActive()).toBeNull();
  });

  it("endDrag_cancels_and_detaches_listeners", () => {
    start();
    mouse("mousemove", 50, 50);
    endDrag();
    expect(getDragActive()).toBeNull();
    mouse("mouseup", 50, 50); // listeners gone → no drop
    expect(drop).not.toHaveBeenCalled();
  });

  it("unregistered_panes_are_no_longer_hit", () => {
    unregisterPane("p1", pane);
    start();
    mouse("mousemove", 50, 50);
    expect(getHoverPaneId()).toBeNull();
    registerPane("p1", pane); // for afterEach symmetry
  });

  it("window_blur_cancels_a_drag_in_progress", () => {
    start();
    mouse("mousemove", 50, 50);
    expect(isDragging()).toBe(true);
    window.dispatchEvent(new Event("blur"));
    expect(isDragging()).toBe(false);
    expect(getDragActive()).toBeNull();
    expect(document.body.classList.contains("tab-dragging")).toBe(false);
    mouse("mouseup", 50, 50); // the late mouseup must not drop anything
    expect(drop).not.toHaveBeenCalled();
  });

  it("escape_cancels_a_drag_in_progress", () => {
    start();
    mouse("mousemove", 50, 50);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(isDragging()).toBe(false);
    expect(document.body.classList.contains("tab-dragging")).toBe(false);
    mouse("mouseup", 50, 50);
    expect(drop).not.toHaveBeenCalled();
  });

  it("beginDrag_twice_replaces_the_previous_drag", () => {
    start();
    mouse("mousemove", 50, 50);
    const other: TabDragData = { ...DATA, filePath: "/b.ts", fileName: "b.ts" };
    beginDrag(other, new MouseEvent("mousedown", { clientX: 0, clientY: 0 }));
    expect(getDragActive()).toEqual(other);
    expect(isDragging()).toBe(false);
    expect(getHoverPaneId()).toBeNull();
  });
});
