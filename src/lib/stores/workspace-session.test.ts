import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isValidSessionId,
  scheduleClaudeResume,
  cancelPendingResume,
  waitForShellReady,
} from "./workspace-session";

// ---------------------------------------------------------------------------
// isValidSessionId
// ---------------------------------------------------------------------------
describe("isValidSessionId", () => {
  it("valid_alphanumeric", () => {
    expect(isValidSessionId("abc123")).toBe(true);
  });

  it("valid_with_hyphens_and_underscores", () => {
    expect(isValidSessionId("session-id_v2")).toBe(true);
  });

  it("empty_string_rejected", () => {
    expect(isValidSessionId("")).toBe(false);
  });

  it("spaces_rejected", () => {
    expect(isValidSessionId("hello world")).toBe(false);
  });

  it("semicolon_rejected", () => {
    expect(isValidSessionId("abc;rm -rf /")).toBe(false);
  });

  it("over_128_chars_rejected", () => {
    expect(isValidSessionId("a".repeat(129))).toBe(false);
  });

  it("exactly_128_chars_accepted", () => {
    expect(isValidSessionId("a".repeat(128))).toBe(true);
  });

  it("newline_rejected", () => {
    expect(isValidSessionId("abc\ndef")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// waitForShellReady
// ---------------------------------------------------------------------------
describe("waitForShellReady", () => {
  let frameCallback: ((data: Uint8Array) => void) | null = null;

  const mockSubscribe = vi.fn().mockImplementation((_id: number, cb: (data: Uint8Array) => void) => {
    frameCallback = cb;
    return Promise.resolve(() => { frameCallback = null; });
  });

  function sendFrame(col: number, row: number) {
    const d = new Uint8Array(20);
    new DataView(d.buffer).setUint16(4, col, true);
    new DataView(d.buffer).setUint16(6, row, true);
    frameCallback?.(d);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    frameCallback = null;
    mockSubscribe.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves_at_hard_timeout_without_frames", async () => {
    const p = waitForShellReady(
      1,
      { minWait: 10_000, stableMs: 400, hardTimeout: 100 },
      { subscribeToFrames: mockSubscribe },
    );
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBeUndefined();
  });

  it("resolves_after_stable_cursor_following_minwait", async () => {
    const p = waitForShellReady(
      1,
      { minWait: 500, stableMs: 400, hardTimeout: 10_000 },
      { subscribeToFrames: mockSubscribe },
    );
    await vi.advanceTimersByTimeAsync(500); // minWait fires, stable timer starts
    sendFrame(5, 2); // cursor moves → reset stable timer
    await vi.advanceTimersByTimeAsync(400); // stable timer fires
    await expect(p).resolves.toBeUndefined();
  });

  it("does_not_resolve_before_minwait_plus_stablems", async () => {
    const p = waitForShellReady(
      1,
      { minWait: 500, stableMs: 400, hardTimeout: 10_000 },
      { subscribeToFrames: mockSubscribe },
    );

    let resolved = false;
    p.then(() => { resolved = true; });

    await vi.advanceTimersByTimeAsync(499); // just before minWait
    await Promise.resolve();
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1 + 400); // minWait fires, then stableMs
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it("cursor_move_resets_stable_timer", async () => {
    const p = waitForShellReady(
      1,
      { minWait: 500, stableMs: 400, hardTimeout: 10_000 },
      { subscribeToFrames: mockSubscribe },
    );

    let resolved = false;
    p.then(() => { resolved = true; });

    await vi.advanceTimersByTimeAsync(500); // minWait fires, stable timer starts (fires at t=900)
    sendFrame(0, 0); // cursor "0:0" ≠ "" → reset stable timer (now fires at t=500+400=900)

    await vi.advanceTimersByTimeAsync(350); // at t=850, stable timer not yet fired
    await Promise.resolve();
    expect(resolved).toBe(false);

    sendFrame(1, 0); // cursor "1:0" ≠ "0:0" → reset stable timer (fires at t=850+400=1250)
    await vi.advanceTimersByTimeAsync(400); // at t=1250, stable timer fires
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it("abort_resolves_immediately", async () => {
    const controller = new AbortController();
    const p = waitForShellReady(
      1,
      { minWait: 2000, stableMs: 400, hardTimeout: 10_000 },
      { subscribeToFrames: mockSubscribe, signal: controller.signal },
    );

    controller.abort();
    await Promise.resolve(); // flush microtasks for subscribeToFrames + IIFE

    await expect(p).resolves.toBeUndefined();
  });

  it("frames_before_minwait_ignored", async () => {
    const p = waitForShellReady(
      1,
      { minWait: 500, stableMs: 400, hardTimeout: 10_000 },
      { subscribeToFrames: mockSubscribe },
    );

    let resolved = false;
    p.then(() => { resolved = true; });

    sendFrame(5, 5); // at t=0, before minWait — should be ignored

    await vi.advanceTimersByTimeAsync(400); // stableMs passes, but minWait not done
    await Promise.resolve();
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(500 + 400); // minWait fires, then stableMs
    await Promise.resolve();
    expect(resolved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cancelPendingResume
// ---------------------------------------------------------------------------
describe("cancelPendingResume", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("cancel_clears_all_timers", async () => {
    const writeToTerminal = vi.fn().mockResolvedValue(undefined);
    const checkPidAlive = vi.fn().mockResolvedValue(false);
    const subscribeToFrames = vi.fn().mockImplementation((_id: number, _cb: (d: Uint8Array) => void) => {
      return Promise.resolve(() => {});
    });

    // Schedule 3 terminals so we have multiple timer sets
    for (const tid of [1, 2, 3]) {
      scheduleClaudeResume(tid, "sess", null, 100, { checkPidAlive, writeToTerminal, subscribeToFrames });
    }
    // Cancel all three before waitForShellReady resolves
    cancelPendingResume(1);
    cancelPendingResume(2);
    cancelPendingResume(3);

    await vi.runAllTimersAsync();

    expect(writeToTerminal).not.toHaveBeenCalled();
  });

  it("cancel_unknown_terminal_is_noop", () => {
    expect(() => cancelPendingResume(99999)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// scheduleClaudeResume — retry logic
// ---------------------------------------------------------------------------
describe("scheduleClaudeResume", () => {
  // With no frames sent, waitForShellReady resolves at staggerMs + stableMs (400ms).
  // Retry timers fire at: staggerMs+400, staggerMs+5400, staggerMs+13400.
  const STABLE_MS = 400;

  let subscribeToFrames: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    subscribeToFrames = vi.fn().mockImplementation((_id: number, _cb: (d: Uint8Array) => void) => {
      return Promise.resolve(() => {});
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    // Clean up any lingering timers for test terminals
    for (const tid of [10, 11, 12, 20, 21, 99]) {
      cancelPendingResume(tid);
    }
  });

  it("fires_write_at_base_delay", async () => {
    const writeToTerminal = vi.fn().mockResolvedValue(undefined);
    const checkPidAlive = vi.fn().mockResolvedValue(false);

    scheduleClaudeResume(10, "sess-abc", null, 2000, { checkPidAlive, writeToTerminal, subscribeToFrames });

    // Advance 1ms past staggerMs+stableMs so the setTimeout(0) first retry fires.
    await vi.advanceTimersByTimeAsync(2000 + STABLE_MS + 1);

    expect(writeToTerminal).toHaveBeenCalledTimes(1);
    const data: Uint8Array = writeToTerminal.mock.calls[0][1];
    expect(new TextDecoder().decode(data)).toBe("claude --resume sess-abc\n");
  });

  it("fires_three_retries_total", async () => {
    const writeToTerminal = vi.fn().mockResolvedValue(undefined);
    const checkPidAlive = vi.fn().mockResolvedValue(false);

    scheduleClaudeResume(10, "sess", null, 2000, { checkPidAlive, writeToTerminal, subscribeToFrames });

    // advance past staggerMs+stableMs+13000 (all 3 retries)
    await vi.advanceTimersByTimeAsync(2000 + STABLE_MS + 13000);

    expect(writeToTerminal).toHaveBeenCalledTimes(3);
  });

  it("retries_stagger_correctly", async () => {
    const writeToTerminal = vi.fn().mockResolvedValue(undefined);
    const checkPidAlive = vi.fn().mockResolvedValue(false);

    scheduleClaudeResume(10, "sess", null, 2000, { checkPidAlive, writeToTerminal, subscribeToFrames });

    await vi.advanceTimersByTimeAsync(2000 + STABLE_MS - 1); // one ms before first write
    expect(writeToTerminal).toHaveBeenCalledTimes(0);

    // Advance 2ms past boundary so the setTimeout(0) first retry fires.
    await vi.advanceTimersByTimeAsync(2); // now at staggerMs+stableMs+1
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000); // now at staggerMs+stableMs+5001
    expect(writeToTerminal).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(8000); // now at staggerMs+stableMs+13001
    expect(writeToTerminal).toHaveBeenCalledTimes(3);
  });

  it("cancels_when_pid_alive_on_first_check", async () => {
    const writeToTerminal = vi.fn().mockResolvedValue(undefined);
    const checkPidAlive = vi.fn().mockResolvedValue(true); // PID alive

    scheduleClaudeResume(10, "sess", 9999, 2000, { checkPidAlive, writeToTerminal, subscribeToFrames });

    await vi.advanceTimersByTimeAsync(2000 + STABLE_MS + 13000);

    expect(writeToTerminal).not.toHaveBeenCalled();
  });

  it("cancels_remaining_retries_when_pid_alive_mid_sequence", async () => {
    const writeToTerminal = vi.fn().mockResolvedValue(undefined);
    // First call: pid dead → write; second call: pid alive → cancel
    const checkPidAlive = vi.fn()
      .mockResolvedValueOnce(false) // first retry fires
      .mockResolvedValueOnce(true); // second retry: pid alive, cancel

    scheduleClaudeResume(10, "sess", 5555, 2000, { checkPidAlive, writeToTerminal, subscribeToFrames });

    await vi.advanceTimersByTimeAsync(2000 + STABLE_MS + 1); // first retry (1ms past boundary)
    expect(writeToTerminal).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000); // second retry (+5000)
    expect(writeToTerminal).toHaveBeenCalledTimes(1); // no new write — pid alive, cancel

    await vi.advanceTimersByTimeAsync(8000); // third retry (+13000) — should be cancelled
    expect(writeToTerminal).toHaveBeenCalledTimes(1);
  });

  it("writeToTerminal_rejects_does_not_throw", async () => {
    // When writeToTerminal rejects, scheduleClaudeResume should warn but NOT rethrow.
    // Subsequent retries must still be scheduled.
    const deps = {
      checkPidAlive: vi.fn().mockResolvedValue(false),
      writeToTerminal: vi.fn().mockRejectedValue(new Error("write failed")),
      subscribeToFrames: vi.fn().mockResolvedValue(() => {}),
    };
    scheduleClaudeResume(99, "sess-abc", null, 0, deps);
    await vi.runAllTimersAsync();
    // All 3 retries should fire despite each writeToTerminal rejecting
    expect(deps.writeToTerminal).toHaveBeenCalledTimes(3);
  });

  it("checkPidAlive_rejects_treated_as_not_alive", async () => {
    // If checkPidAlive throws, it should NOT cancel remaining retries.
    const deps = {
      checkPidAlive: vi.fn().mockRejectedValue(new Error("ps failed")),
      writeToTerminal: vi.fn().mockResolvedValue(undefined),
      subscribeToFrames: vi.fn().mockResolvedValue(() => {}),
    };
    scheduleClaudeResume(99, "sess-abc", 1234, 0, deps);
    await vi.runAllTimersAsync();
    // All 3 retries should still write (throwing checkPidAlive is treated as "not alive")
    expect(deps.writeToTerminal).toHaveBeenCalledTimes(3);
  });

  it("null_savedPid_skips_pid_check_and_always_writes", async () => {
    const deps = {
      checkPidAlive: vi.fn(),
      writeToTerminal: vi.fn().mockResolvedValue(undefined),
      subscribeToFrames: vi.fn().mockResolvedValue(() => {}),
    };
    scheduleClaudeResume(99, "sess-abc", null, 0, deps);
    await vi.runAllTimersAsync();
    expect(deps.checkPidAlive).not.toHaveBeenCalled();
    expect(deps.writeToTerminal).toHaveBeenCalledTimes(3);
  });

  it("second_terminal_staggered_300ms_later", async () => {
    const writeToTerminal = vi.fn().mockResolvedValue(undefined);
    const checkPidAlive = vi.fn().mockResolvedValue(false);

    scheduleClaudeResume(20, "sess-a", null, 2000, { checkPidAlive, writeToTerminal, subscribeToFrames });
    scheduleClaudeResume(21, "sess-b", null, 2300, { checkPidAlive, writeToTerminal, subscribeToFrames });

    // Advance 1ms past terminal 20's boundary (staggerMs+stableMs=2400)
    await vi.advanceTimersByTimeAsync(2000 + STABLE_MS + 1);
    expect(writeToTerminal).toHaveBeenCalledTimes(1);
    expect(writeToTerminal.mock.calls[0][0]).toBe(20);

    // Advance to past terminal 21's boundary (2300+400=2700); currently at 2401, need 300 more
    await vi.advanceTimersByTimeAsync(300); // now at 2701, past terminal 21's t=2700
    expect(writeToTerminal).toHaveBeenCalledTimes(2);
    expect(writeToTerminal.mock.calls[1][0]).toBe(21);
  });
});

// ---------------------------------------------------------------------------
// waitForShellReady — edge cases (Group F)
// ---------------------------------------------------------------------------
describe("waitForShellReady — edge cases", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("frame_with_fewer_than_8_bytes_does_not_crash", async () => {
    // Binary frame data shorter than 8 bytes — DataView.getUint16(4) would throw
    // without a bounds guard. The minWaitDone check also protects this path.
    let frameCb: ((d: Uint8Array) => void) | null = null;
    const deps = {
      subscribeToFrames: vi.fn().mockImplementation((_id: number, cb: (data: Uint8Array) => void) => {
        frameCb = cb;
        return Promise.resolve(() => {});
      }),
      signal: undefined as AbortSignal | undefined,
    };
    const p = waitForShellReady(1, { minWait: 0, stableMs: 50, hardTimeout: 200 }, deps);
    await Promise.resolve(); // let subscribeToFrames resolve and set frameCb
    // Send a 4-byte (truncated) frame — should not throw
    expect(() => frameCb!(new Uint8Array([1, 2, 3, 4]))).not.toThrow();
    await vi.runAllTimersAsync();
    await p;
  });

  it("subscribeToFrames_rejects_still_resolves_at_hard_timeout", async () => {
    // If subscribeToFrames rejects, waitForShellReady should fall back to hard timeout.
    const deps = {
      subscribeToFrames: vi.fn().mockRejectedValue(new Error("no sub")),
      signal: undefined as AbortSignal | undefined,
    };
    const p = waitForShellReady(1, { minWait: 50, stableMs: 50, hardTimeout: 100 }, deps);
    await vi.runAllTimersAsync();
    // Should resolve (via hard timeout) without throwing
    await expect(p).resolves.toBeUndefined();
  });

  it("already_aborted_signal_resolves_before_subscribe", async () => {
    // An already-aborted signal must resolve immediately without calling subscribeToFrames.
    const ac = new AbortController();
    ac.abort();
    let subscribeCallCount = 0;
    const deps = {
      subscribeToFrames: vi.fn().mockImplementation(() => {
        subscribeCallCount++;
        return Promise.resolve(() => {});
      }),
      signal: ac.signal,
    };
    const p = waitForShellReady(1, { minWait: 100, stableMs: 100, hardTimeout: 1000 }, deps);
    await expect(p).resolves.toBeUndefined();
    expect(subscribeCallCount).toBe(0);
  });
});
