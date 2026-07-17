# Splice — Market Model (July 2026)

## What Splice is
Native macOS dev environment (Tauri/Rust/Svelte). Identity: **one window, every project** —
isolated workspaces, custom Rust/canvas terminal (owns every byte of PTY traffic), CodeMirror
editor, LSP, SSH, git, and an **attention hook system** that tracks Claude Code / Codex agents
across terminals and surfaces "agent needs you" alerts. Local-first, MIT, free.

## Personas & jobs-to-be-done
1. **The agent wrangler** — runs 2–8 Claude Code/Codex sessions across several repos.
   JTBD: keep all agents productive without becoming the message bus between them.
2. **The terminal loyalist** — churned from Cursor/Windsurf back to terminal agents; the IDE
   became "a heavy text viewer with Git integration." JTBD: a fast, honest cockpit around the
   terminal, not an AI IDE that wants gravity.
3. **The reviewer-of-machines** — ships mostly agent-written code; manually edits ~1% of what
   ships. JTBD: judge diffs fast enough to keep up with generation.

## The flow end-to-end (where friction lives)
prompt agent → **wait/poll** (Splice solves with attention alerts) → agent finishes →
**find what changed** → **review the diff** (bottleneck) → test/verify → commit/PR →
**re-prompt with corrections** (user re-types context) → repeat × N agents × M projects.

- Faros.ai: AI raised PR volume +47% while review time rose +91% — review is THE bottleneck.
- Context fragmentation: "each agent runs in isolation… you become the message bus,
  copy-pasting context and re-explaining decisions."
- Session sprawl: "five Claude Code sessions and three Codex sessions across two projects is
  impossible without visual tooling."
- Warp criticism: cloud dependency + "gravity" (its own agent flow and conventions);
  power users want local-first and BYO-agent.
- Cursor/Windsurf churn drivers: credit pricing, VS Code fork lock-in, privacy of code
  leaving the machine.

## Decision drivers
Pick: speed, local-first/privacy, works WITH the agent CLI they already pay for (no
markup/credits), native feel, free. Churn: pricing games, cloud lock-in, editor gravity,
"another place to configure my agent."

## Splice's unfair advantages (build FROM these)
- Owns the terminal emulator end-to-end in Rust — can parse/annotate/act on every byte an
  agent prints (nobody on xterm.js can do this cheaply).
- Workspaces = many projects, one window; per-workspace terminals that keep running.
- Attention hook infra already installed into Claude Code's hook system (HTTP + token).
- Local-first, no cloud, no credits — rides the anti-gravity churn wave.

## AVOID SET (dead on arrival if an idea reskins these)
1. **Everything in `features.md`** — all 82 Zed-catch-up items (vim mode, outline panel,
   inlay hints, DAP, task runner, git graph, sticky scroll, …) and its "explicitly skipped" list.
2. **Everything Splice ships** — workspaces, attention alerts, context HUD, canvas terminal,
   in-terminal search, session restore, SSH workspaces, send-to-Claude, LSP basics, themes,
   git panel, markdown preview, minimap, multi-window.
3. **Competitor table stakes** —
   - AI chat sidebar / inline completion / Cmd+K edit (Cursor, Zed, Windsurf, Copilot)
   - Agent kanban boards (Vibe Kanban), worktree-per-agent managers (Conductor, Claude
     Squad, Nimbalyst/Crystal), tmux orchestration (cmux)
   - Cloud/container agent fleets triggered by webhooks (Warp Oz, VS Code multi-agent,
     Copilot cloud agents)
   - Statusline/HUD context meters (claude-hud, 18k stars), /statusline generators, ccusage
   - MCP client integration, /review-pr first-pass automation, PR-bot reviewers
   - Block-based terminal output, AI command suggestion/natural-language-to-shell (Warp)
4. **Rejected by maintainer** — collaboration/multiplayer, plugin/extension platform APIs,
   model-selection UIs (the agent CLI handles it), anything requiring Splice-hosted cloud.

## Sources
- https://shipyard.build/blog/claude-code-multi-agent/
- https://nimbalyst.com/blog/best-multi-agent-desktop-apps-claude-code-codex-2026/
- https://www.developersdigest.tech/blog/ai-code-review-bottleneck
- https://claude-codex.fr/en/future/trends-2026/ (65% of engineers run two agents daily)
- https://www.augmentcode.com/tools/warp-vs-cursor
- https://agentsroom.dev/blog/best-terminal-for-agentic-coding
- https://github.com/jarrodwatts/claude-hud
- https://devgent.org/en/ai-code-editor-comparison-cursor-zed-windsurf-antigravity-kiro-developer-guide/
