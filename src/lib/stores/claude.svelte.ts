/**
 * Svelte 5 runes store for live Claude Code session telemetry.
 *
 * Holds the statusLine HUD payload (model, context-window %, cost, rate limits)
 * keyed by `terminalId`. Fed by the `claude:status` event (Claude's statusLine
 * command → `/status` endpoint → `handle_status_request`).
 *
 * Mutations reassign the top-level object (`{ ...map }`) so the runes getters
 * stay reactive — same pattern as `attention.svelte.ts`.
 */

export interface ClaudeStatus {
  terminalId: number;
  model?: string;
  /** context_window.used_percentage (0–100) */
  contextPct?: number;
  /** cost.total_cost_usd */
  costUsd?: number;
  /** rate_limits.five_hour.used_percentage (0–100) */
  rateLimit5h?: number;
  /** rate_limits.seven_day.used_percentage (0–100) */
  rateLimit7d?: number;
  updatedAt: number;
}

/** Parse Claude's statusLine JSON into our flat `ClaudeStatus`. */
export function statusFromPayload(p: any): ClaudeStatus | null {
  const terminalId = Number(p?.terminal_id);
  if (!Number.isFinite(terminalId) || terminalId <= 0) return null;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  return {
    terminalId,
    model: p?.model?.display_name ?? undefined,
    contextPct: num(p?.context_window?.used_percentage),
    costUsd: num(p?.cost?.total_cost_usd),
    rateLimit5h: num(p?.rate_limits?.five_hour?.used_percentage),
    rateLimit7d: num(p?.rate_limits?.seven_day?.used_percentage),
    updatedAt: Date.now(),
  };
}

function createClaudeStore() {
  let status = $state<Record<number, ClaudeStatus>>({});

  return {
    get status() {
      return status;
    },
    setStatus(s: ClaudeStatus) {
      status = { ...status, [s.terminalId]: s };
    },
    /** Drop a terminal's status (on close / session end). */
    clear(terminalId: number) {
      const { [terminalId]: _s, ...rest } = status;
      status = rest;
    },
  };
}

export const claudeStore = createClaudeStore();
