# Splice Ideation Ledger

Status: collecting from 5 lens agents. Dedup + clustering happens after all report.

---

## Lens C — Cross-industry analogies (supervising autonomous processes)

### C1. Separation Alert — cross-agent collision prediction
Two agents (any workspace/window) about to touch overlapping files → alert BEFORE the second
edit lands, one-click "hold" (SIGSTOP) on the later agent. ATC short-term conflict alert.
Mechanism: PreToolUse hooks → Rust attention server keeps a cross-workspace path→session
"airspace map"; intersection in a time window → alert; Splice owns the PTY child so it can
pause it. Agent-agnostic (Claude Code + Codex). Prior art: only prevention-by-isolation
(worktrees); live cross-session detection is "future work" in the guides. **Effort M**

### C2. Interlocks — tripwires that freeze the agent mid-keystroke
User rules on the raw byte stream (`rm -rf`, `push --force`, writes under migrations/, tests
flip red) that don't notify — they SIGSTOP the agent instantly, show which rule fired +
surrounding transcript, resume/kill controls. Factory SCADA interlock / andon cord.
Mechanism: rule engine inline in the VTE parse loop (term.rs) — zero extra cost, no LLM,
covers ANY CLI, not just Claude's tool calls. **Effort M**

### C3. Multicam Replay — one playhead across every agent session
Scrubbable global timeline; every terminal re-renders its exact grid at that instant; hook
events (tool calls, stops, prompts, trips) as track markers. Sports replay booth / multicam
editing. Mechanism: pty.rs appends timestamped raw byte chunks per terminal; replay = feed
recorded stream back through existing VTE parser → offscreen grid → existing canvas renderer.
Prior art: asciinema is single-session only. **Effort L**

### C4. Early Warning Score — deterioration detection before the doom-loop
Composite per-agent score from byte-stream vitals: identical error recurring, edit→test→fail
cycles on same file, output similarity climbing, token burn without writes. Escalates via
existing attention pipeline WHILE running. ICU NEWS/MEWS scores. Mechanism: simhash rolling
output windows in emitter thread + PostToolUse correlation. Prior art: loop detection only
inside single-agent frameworks (Kilocode). **Effort M**

### C5. Chain of Custody — hunk-level agent provenance in the review gutter
Every diff hunk marked with which agent session wrote it, when, in response to what prompt;
click → jump to that transcript/replay moment. SOC forensics chain of custody. Attacks the
+91% review-time bottleneck; makes corrective re-prompts precise. Mechanism: PostToolUse
(session, ts, path) mapped to hunks by the git module; local JSON sidecar ledger; CodeMirror
gutter decoration. **Effort M–L**

---

## Lens B — Message-bus elimination (human no longer relays between agents)

### B1. Peer Wire — push-based agent-to-agent delivery
Agent addresses another live session by name; Splice delivers into the target's prompt the
moment that agent goes idle. Existing relays (session-bridge, mcp-relay, claude-relay) are
all pull-based inboxes. Mechanism: VTE parser detects `@splice:send` marker in output bytes;
Stop/Notification hooks give idle state; delivery = write into target PTY stdin. PTY-level →
works for Codex too. Open Claude Code feature requests #36181, #24798. **Effort M. N/V/F 4/5/5**

### B2. Boundary Watch — cross-repo interface change propagation
Link two workspaces at a boundary (OpenAPI spec, shared types, protobuf). Agent in repo A
changes it → Splice hands the diff to the agent in dependent repo B automatically.
Mechanism: existing per-workspace file watchers + git; delivery via UserPromptSubmit
additionalContext or idle PTY injection. Only tool with both repos' watchers, git, and both
sessions in one process. **Effort M. N/V/F 4/4/4**

### B3. Handoff Capsule — one-keystroke cross-workspace session teleport
Agent finishes backend work → one keystroke distills the session (decisions, files, open
questions) and boots a primed agent in the frontend workspace. `--resume` only covers the
same project. Mechanism: Stop hook gives transcript_path; local `claude -p` distills;
Splice types the capsule into a terminal in the target workspace. **Effort M. N/V/F 4/4.5/4**

### B4. Collision Sentinel — cross-session file-touch registry  [clusters with C1]
PreToolUse hook on Edit/Write POSTs path to local attention server; live cross-session touch
registry; on collision the second agent is blocked-with-reason WITH the first agent's fresh
diff attached, so the agent self-corrects — no human deconfliction. Spans repos/monorepo,
unlike worktrees. **Effort S–M. N/V/F 3.5/4/4.5**

### B5. Decision Wire — live decision fan-out to concurrent peers
One agent settles something project-spanning ("renamed user_id → account_id") → extracted
locally and injected into every concurrently running peer session's next turn. Editable
ledger pane — strike a bad decision before it propagates. Distinct from claude-mem (temporal
memory, one lineage) — this is live lateral broadcast. Shares delivery substrate with B1.
**Effort M. N/V/F 3/4/4**

---

## Lens R — Reviewer-of-machines (judgment is the bottleneck)

### R1. Reviewed-Line Ledger — "code coverage, but for review"  [clusters with D1]
Track which agent-changed lines were actually rendered in the reviewer's viewport with dwell
time; unseen-lines gutter + "review coverage: 62%" meter. Agent re-touches a seen line → flips
back to unseen, so round 2 reviews only the interdiff. Optional gate: "commit contains 214
lines no human ever displayed." Mechanism: PostToolUse edit ranges + CodeMirror viewport
intersection, one process. Prior art: Nimbalyst file-level self-reported checkboxes only.
**Effort M**

### R2. Receipts Panel — deterministic claim-vs-reality verification
Every command the agent ran, with REAL exit codes, pinned to exact scrollback byte ranges.
"Tests pass" claims get a green receipt only if a matching exit-0 test command exists;
otherwise badged UNVERIFIED. One click re-runs and diffs output. "Agents lie about tests" is
loudly documented; existing verifiers are other agents pattern-matching transcripts — Splice
has ground truth. Zero tokens. **Effort M**

### R3. Shadow-Edit Detector — flag changes with no narration
Diff what changed on disk during a session vs. what the agent declared via Edit/Write tool
calls. `sed -i`, codegen, lockfile churn → "no tool call accounts for this change" badge,
sorted to top of review. Pure set difference (fs watcher ∩ hook ledger), no AI. No prior art
found. **Effort S–M**

### R4. Hunk Time-Travel — click a hunk, land on the terminal moment  [clusters with C5, C3]
Click a diff hunk → terminal scrolls to the timestamped scrollback region where the agent
made and narrated that edit. AgentDiff (CLI, post-hoc JSONL) proves demand; only Splice has
diff viewer + live scrollback in one process. **Effort M (cheap on R2's ledger)**

### R5. Blast-Radius Sort — deterministic risk ordering of the review queue
Order hunks by measured blast radius: LSP find-references fan-in of touched symbols, new
diagnostics, whether any test receipt touches the file. PR bots guess risk with a model;
Splice measures it. **Effort M–L**

Synergy: R2→R3→R4 share one per-session hook-event ledger (commands, edits, timestamps,
scrollback offsets). Build the ledger once, three features fall out.

---

## Lens D — Boring steps made invisible

### D1. Unread Marks — unseen badges for agent-touched files  [clusters with R1]
Every agent-touched file gets an "unseen" badge in tree + tabs; one key cycles unseen hunks;
marks clear as your viewport passes over changes. Kills the git-status→open→"did I already
look at this?" loop × N agents. fs-watch attribution to busy PTY covers non-Claude CLIs.
**Effort M**

### D2. Auto-Reverify — pinned verify command re-runs on turn end
Pin `npm test`/`cargo check` per workspace; on agent turn end, silently re-run in a background
terminal; workspace badge green/red; on red, ONE KEY pipes the failing tail into the agent's
stdin. Agent-agnostic, zero agent config, ambient. Distinct from DIY Stop-hook loops (inside
one session's transcript). **Effort M**

### D3. Peek — hover popover of any agent's live screen, type-through
Hover an attention badge → instant popover rendering that terminal's live grid from another
workspace, no switch; keystrokes forward to that PTY ("approve", "option 2"). Rust owns grid
state for backgrounded workspaces — xterm.js competitors can't. Claude's Agent View covers
only Claude sessions inside one CLI. **Effort M**

### D4. Resume Card — instant "where was I" on workspace focus
Focus a workspace after time away → transient overlay: last prompt sent to each agent, tail
of final answer, files changed while gone, branch/dirty state. Replay, not AI — Splice wrote
every prompt into the PTY itself and owns scrollback. **Effort M**

### D5. Turn Commit — stage exactly one agent turn, message = your prompt
One key stages exactly the files from that turn's changeset, commit message pre-filled from
the prompt that produced it (with Prompt: provenance). Zero-latency, no AI call — derived
from owning the terminal input stream. **Effort S (rides on D1 turn tracking)**

---

## Lens N — Newly possible in mid-2026

### N1. Session Time Machine — scrub any agent session like a video  [clusters with C3, R4, C5]
PTY tee → per-terminal recording with grid keyframes, timestamp-aligned with Claude/Codex
transcript JSONL. Scrubber under any pane; click a diff hunk → jump to the terminal moment +
transcript turn that produced it. Newly possible: CLIs now persist replayable JSONL; hooks
expose transcript_path live. Nobody else owns the emulator. **Effort L (M replay-only)**

### N2. Handoff Briefs — session-end distillation auto-injected into next session  [clusters with B3, B5]
Stop hook → local model distills transcript into "decisions/constraints/open threads" brief →
injected via SessionStart additionalContext (Claude) or AGENTS.md section (Codex). Cross-CLI,
cross-workspace, curated in UI. Newly possible: SessionStart additionalContext (2025), free
on-device distillation (Foundation Models/MLX). **Effort M**

### N3. Spin Detection — semantic triage at the PTY layer  [clusters with C4]
Embed rolling output windows with a ~300M local model; high self-similarity = looping. Upgrades
attention from binary to triage: stuck / asking / grinding. Zero hooks — works for ANY CLI
because it reads the screen. Newly possible: sub-1B embedding models (late 2025) make
continuous embedding of 8 terminals negligible on Apple silicon. **Effort M**

### N4. Answer From Anywhere — App Intents for blocked agents
"Which agents are waiting?" / "Send reply: …" from macOS 26 Spotlight/Shortcuts without
focusing Splice; notification inline-reply → PTY write. Newly possible: Spotlight third-party
App Intents (macOS 26 Tahoe). Transport (attention HTTP + token) already exists. **Effort M**

### N5. Total Recall — semantic search over every agent transcript ever  [clusters with B3]
Local embedding index over ~/.claude/projects/** + ~/.codex/sessions/** JSONL, workspace-
scoped, turn-granular; one keystroke pastes the hit into the current agent's prompt. /resume
search is single-CLI, session-granular. **Effort M**

---

# CLUSTERS (post-dedup)

1. **Flight Recorder** (C3+N1+R4+C5): PTY recording + hook ledger + transcript alignment →
   replay scrubber, hunk↔moment time-travel, provenance gutter. Moat: owns the emulator.
2. **Review Coverage** (R1+D1+D5): viewport-measured seen/unseen line tracking → unread
   marks, coverage meter, interdiff-only re-review, turn-scoped commits.
3. **Ground-Truth Verification** (R2+R3+D2+R5): hook ledger + fs watcher + exit codes →
   receipts panel, shadow-edit detector, auto-reverify, blast-radius sort.
4. **Collision Control** (C1+B4): cross-workspace path registry → pre-edit conflict block
   with peer diff attached; SIGSTOP hold.
5. **Context Routing** (B1+B2+B5+N2+N5): idle-timed PTY injection + hook additionalContext →
   peer messaging, boundary watch, handoff briefs, decision fan-out, total recall.
6. **Ambient Supervision** (D3+D4+C4+N3+N4): grid snapshots + triage scoring → peek popover,
   resume card, spin detection, App Intents surface. (C2 Interlocks sits between 3 and 6.)

Saturation reached — 25 ideas → 6 clusters. No round 2.
