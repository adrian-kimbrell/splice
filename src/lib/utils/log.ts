/**
 * Tiny logging facade so release builds can be quiet.
 *
 *   log.debug(...)  — dev-only diagnostics; compiled to a no-op in production
 *   log.warn(...)   — recoverable problems; always emitted
 *   log.error(...)  — failures; always emitted
 *
 * `setLogLevel` lets a release build be turned verbose at runtime (for example
 * from the dev tools console: `window.__spliceLog.setLevel("debug")`) without
 * touching the code. Use this instead of bare `console.*` in app code; tests
 * may still spy on `console` since the facade forwards to it.
 */

export type LogLevel = "debug" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = { debug: 0, warn: 1, error: 2, silent: 3 };

let level: LogLevel = import.meta.env.DEV ? "debug" : "warn";

export function setLogLevel(next: LogLevel): void {
  level = next;
}

export function getLogLevel(): LogLevel {
  return level;
}

function enabled(min: LogLevel): boolean {
  return ORDER[level] <= ORDER[min];
}

export const log = {
  debug(...args: unknown[]): void {
    if (enabled("debug")) console.log(...args);
  },
  warn(...args: unknown[]): void {
    if (enabled("warn")) console.warn(...args);
  },
  error(...args: unknown[]): void {
    if (enabled("error")) console.error(...args);
  },
};

// Expose a runtime toggle for release-build debugging.
if (typeof window !== "undefined") {
  (window as unknown as { __spliceLog?: unknown }).__spliceLog = { setLevel: setLogLevel, getLevel: getLogLevel };
}
