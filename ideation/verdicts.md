# Critique Verdicts & Final Ranking (July 2026)

Adversarial pass, default-KILL, per-idea WebSearch. 16 judged → 6 survive.

## Killed (with the decisive incumbent)
- Flight Recorder / Time Machine — Mantra, 1DevTool, coder/agent-tty ship session replay
- Chain of Custody — agentblame, git-ai, blameprompt ship gutter provenance
- Auto-Reverify — official Stop-hook pattern + community self-verification loops
- Interlocks — PreToolUse deny (works under --dangerously-skip-permissions) is prevention;
  byte-stream SIGSTOP is damage-limitation after dispatch. Strictly worse.
- Peer Wire — agent-comms-mcp (push, real-time), xats, agmsg; Claude agent teams native msg
- Handoff Briefs — claude-mem IS this, cross-CLI already
- Resume Card — atrium + Warp cover the job; fold 20% into Peek
- Turn Commit — GitButler hooks post documents the exact flow; git-ai attributes per-prompt
- Answer From Anywhere — Happy (10.8k★), Omnara, Warp mobile: saturated category
- Total Recall — claude-find, claude-history, claude-mem semantic search

## Survivors, ranked (Novelty / Value / Feasibility, 1–5)

### 1. Reviewed-Line Ledger + Unread Marks — N5 V5 F4  ★ flagship
Viewport-measured seen/unseen tracking of agent-changed lines; unseen gutter; coverage meter;
re-touched lines flip back to unseen (interdiff-only re-review); "N lines never displayed"
soft gate on commit. NOBODY measures what the reviewer's eyes actually passed over (GitHub
"Viewed" = manual file checkbox; Zed = agent-side flags; Nimbalyst = self-reported).
Structurally unabsorbable: a CLI can never see your viewport. Attacks review time +91%.
Insight: review is claimed, never measured. Flow changed: post-agent-turn re-scan loop.

### 2. Receipts Panel — N4 V5 F4
Every command the agent ran + real success/failure pinned to actual scrollback bytes;
UNVERIFIED badge on claims without receipts; one-click re-run + output diff.
KEEP-IF: empirically validate PostToolUse/PostToolUseFailure semantics for Bash exit codes
BEFORE building (undocumented); Codex degrades to UNVERIFIED-by-default (honest).
Insight: agents lie about tests; all shipped fixes are agent-side self-enforcement — nobody
ships an independent ground-truth audit. Flow changed: verify step.

### 3. Shadow-Edit Detector — N4 V4 F4  (cheapest win, S–M)
Disk changes with no corresponding declared tool call → badge + sort to top of review.
KEEP-IF: time-window attribution of formatter/codegen/lockfile fallout to declared Bash
calls, or it cries wolf. No shipped equivalent (nearest: manual audit methodology, AgentFS).
Insight: the scariest changes are the undeclared ones. Flow changed: find-what-changed.

### 4. Spin Detection — N4 V4 F3
Local-embedding self-similarity over rolling PTY output windows → triage: stuck / asking /
grinding. CLI-agnostic because it reads the screen — true emulator moat.
KEEP-IF: precision proven on real transcripts first (progress bars & retry storms are
similarity bombs); ship as "experimental" behind a setting. Flow changed: the wait/poll step
upgrades from binary alert to prioritized queue.

### 5. Peek — N3 V4 F5  (cheap, do alongside)
Hover attention badge → live-rendered grid popover of any terminal in any workspace,
type-through to the PTY. Job partially covered (Warp panel, atrium sidebar); the delta —
render a backgrounded workspace's terminal + type into it without switching — only Splice's
Rust-owned grid can do. Demoted to UX increment; absorb Resume Card's best 20%.

### 6. Separation Alert / Collision Sentinel — N4 V3 F4  (niche, defer)
Cross-session same-checkout collision block with peer diff attached (PreToolUse deny —
mechanism verified). KEEP-IF telemetry/user reports confirm same-checkout multi-agent is
common among Splice users; ecosystem consensus is worktree isolation, Claude teams handle
intra-team. Build last.

## The strategic read
Survivors 1–3 are ONE product story: **Splice is the trust layer for agent-written code** —
the only tool that can measure review (viewport), audit claims (receipts vs. scrollback
ground truth), and expose undeclared changes (watcher ∩ ledger). They share one substrate:
a per-session hook-event ledger (commands, edit ranges, timestamps, scrollback offsets)
persisted with workspace state. Build the ledger once; three features fall out.

Systemic risks (from the critic):
- Hook-API churn: everything leans on Claude Code hook semantics Anthropic reshuffled as
  recently as June 2026. Treat all features as Claude-first with graceful degradation.
- Codex has no PreToolUse equivalent — "cross-CLI" means degraded-but-honest, not parity.
- Validate Bash exit-code hook semantics empirically before writing Rust for Receipts.

## Suggested build order
1. Hook-event ledger substrate (enables 1–3) — validate hook payloads empirically first
2. Shadow-Edit Detector (S–M, first visible win on the ledger)
3. Reviewed-Line Ledger + Unread Marks (the flagship)
4. Receipts Panel
5. Peek (independent, anytime)
6. Spin Detection (after a precision spike on recorded transcripts)
