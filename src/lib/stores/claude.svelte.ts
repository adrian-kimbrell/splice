/**
 * Svelte 5 runes store for live Claude Code session telemetry.
 *
 * Two slices, both keyed by `terminalId`:
 * - `status`:   the statusLine HUD payload (model, context-window %, cost, rate
 *               limits). Fed by the `claude:status` event (Claude's statusLine
 *               command → `/status` endpoint → `handle_status_request`).
 * - `activity`: a rolling tool-use feed plus a working/idle state. Fed by the
 *               `claude:tooluse` event (PostToolUse hook) and cleared to idle by
 *               `claude:stop`. Powers the activity ticker and the sidebar dot.
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

export interface ClaudeActivityEntry {
  tool: string;
  label: string;
  at: number;
}

export interface ClaudeSessionActivity {
  state: "working" | "idle";
  /** Human-readable label for the in-flight action, if working. */
  current?: string;
  /** Newest-first ring buffer of recent tool calls (capped). */
  recent: ClaudeActivityEntry[];
  lastActiveAt: number;
}

const MAX_ACTIVITY = 20;

/** Build a concise, human-readable label for a tool call. */
export function toolLabel(
  tool: string,
  filePath?: string | null,
  command?: string | null,
): string {
  const base = filePath ? filePath.split("/").pop() ?? filePath : "";
  switch (tool) {
    case "Edit":
    case "MultiEdit":
      return base ? `Editing ${base}` : "Editing";
    case "Write":
      return base ? `Writing ${base}` : "Writing";
    case "Read":
      return base ? `Reading ${base}` : "Reading";
    case "NotebookEdit":
      return base ? `Editing ${base}` : "Editing notebook";
    case "Bash":
      return command ? `Ran ${command.trim().split(/\s+/)[0]}` : "Ran command";
    case "Grep":
      return "Searching";
    case "Glob":
      return "Finding files";
    case "Task":
      return "Running subagent";
    case "WebFetch":
    case "WebSearch":
      return "Researching";
    case "TodoWrite":
      return "Updating plan";
    default:
      return tool || "Working";
  }
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
  let activity = $state<Record<number, ClaudeSessionActivity>>({});

  return {
    get status() {
      return status;
    },
    get activity() {
      return activity;
    },

    setStatus(s: ClaudeStatus) {
      status = { ...status, [s.terminalId]: s };
    },

    /** Record a tool call; flips the session to "working". */
    recordTool(
      terminalId: number,
      tool: string,
      filePath?: string | null,
      command?: string | null,
    ) {
      const label = toolLabel(tool, filePath, command);
      const at = Date.now();
      const prev = activity[terminalId];
      const recent = [{ tool, label, at }, ...(prev?.recent ?? [])].slice(0, MAX_ACTIVITY);
      activity = {
        ...activity,
        [terminalId]: { state: "working", current: label, recent, lastActiveAt: at },
      };
    },

    /** Flip a session to "idle" (Stop hook) without dropping its feed history. */
    markIdle(terminalId: number) {
      const prev = activity[terminalId];
      if (!prev) {
        activity = {
          ...activity,
          [terminalId]: { state: "idle", recent: [], lastActiveAt: Date.now() },
        };
        return;
      }
      activity = {
        ...activity,
        [terminalId]: { ...prev, state: "idle", current: undefined },
      };
    },

    /** Drop all telemetry for a terminal (on close / session end). */
    clear(terminalId: number) {
      const { [terminalId]: _a, ...restA } = activity;
      const { [terminalId]: _s, ...restS } = status;
      activity = restA;
      status = restS;
    },
  };
}

export const claudeStore = createClaudeStore();
