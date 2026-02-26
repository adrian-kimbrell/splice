import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { toasts, pushToast, removeToast } from "./toasts.svelte";

// Drain the toasts array in-place between tests
function clearToasts() {
  toasts.splice(0, toasts.length);
}

describe("toast timer lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearToasts();
  });

  afterEach(() => {
    clearToasts();
    vi.useRealTimers();
  });

  it("pushToast adds to the array", () => {
    pushToast("hello", "info", -1);
    expect(toasts.length).toBe(1);
    expect(toasts[0].message).toBe("hello");
  });

  it("removeToast removes the toast", () => {
    pushToast("hello", "info", -1);
    const id = toasts[0].id;
    removeToast(id);
    expect(toasts.length).toBe(0);
  });

  it("auto-removes after duration elapses", () => {
    pushToast("temp", "info", 500);
    expect(toasts.length).toBe(1);
    vi.advanceTimersByTime(501);
    expect(toasts.length).toBe(0);
  });

  it("does NOT auto-remove before duration", () => {
    pushToast("temp", "info", 500);
    vi.advanceTimersByTime(400);
    expect(toasts.length).toBe(1);
  });

  it("early removeToast cancels the auto-remove timer — no ghost re-add", () => {
    pushToast("temp", "info", 500);
    const id = toasts[0].id;
    removeToast(id); // dismissed early
    expect(toasts.length).toBe(0);

    // timer must NOT fire and re-attempt to splice
    vi.advanceTimersByTime(600);
    expect(toasts.length).toBe(0);
  });

  it("calling removeToast on already-removed id is a no-op", () => {
    pushToast("temp", "info", 500);
    const id = toasts[0].id;
    removeToast(id);
    expect(() => removeToast(id)).not.toThrow();
    expect(toasts.length).toBe(0);
  });

  it("permanent toast (duration=-1) never auto-removes", () => {
    pushToast("sticky", "warning", -1);
    vi.advanceTimersByTime(99999);
    expect(toasts.length).toBe(1);
  });

  it("multiple toasts have independent timers", () => {
    pushToast("fast", "info", 100);
    pushToast("slow", "info", 300);

    vi.advanceTimersByTime(150);
    expect(toasts.length).toBe(1);
    expect(toasts[0].message).toBe("slow");

    vi.advanceTimersByTime(200);
    expect(toasts.length).toBe(0);
  });

  it("dismissing one toast does not cancel another's timer", () => {
    pushToast("a", "info", 200);
    pushToast("b", "info", 200);
    const idA = toasts[0].id;

    removeToast(idA);
    expect(toasts.length).toBe(1);

    vi.advanceTimersByTime(250);
    // b's timer should still fire
    expect(toasts.length).toBe(0);
  });

  it("pushToast with action defaults to no auto-remove", () => {
    pushToast("act", "info", undefined, { label: "Undo", onClick: () => {} });
    vi.advanceTimersByTime(99999);
    expect(toasts.length).toBe(1);
  });
});
