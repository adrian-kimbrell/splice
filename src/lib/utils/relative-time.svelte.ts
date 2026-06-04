/**
 * Format a timestamp as a short relative-time string ("5m ago", "2h ago", "3d ago").
 *
 * Returns `null` if the input is missing or younger than {@link STALE_THRESHOLD_MS}
 * (5 min). The null case lets callers conditionally render the badge only when the
 * pane has actually been idle for a while — fresh activity reads as noise.
 *
 * Exports a shared {@link tickingNow} `$state` driven by a single 30 s setInterval
 * so badges in every pane re-derive automatically as time passes. The interval is
 * lazily started on first read so dead modules don't pay for it.
 */

export const STALE_THRESHOLD_MS = 5 * 60_000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

let tickStarted = false;
const tick = $state({ now: Date.now() });

function ensureTickerStarted() {
  if (tickStarted) return;
  tickStarted = true;
  setInterval(() => { tick.now = Date.now(); }, 30_000);
}

/** Reactive epoch-ms that advances every 30 s. Read this inside a `$derived` and
 *  your formatter will rebroadcast as the underlying timestamp drifts further into
 *  the past. The interval starts the first time this function is called. */
export function tickingNow(): number {
  ensureTickerStarted();
  return tick.now;
}

export function formatRelativeTime(ts: number | undefined, now: number = Date.now()): string | null {
  if (!ts) return null;
  const diff = now - ts;
  if (diff < STALE_THRESHOLD_MS) return null;
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < WEEK) return `${Math.floor(diff / DAY)}d ago`;
  return `${Math.floor(diff / WEEK)}w ago`;
}
