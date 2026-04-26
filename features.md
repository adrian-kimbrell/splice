# Splice — Feature Roadmap

Researched against Zed releases v0.91 → v0.234 (2023–2026), filtered by 12 agents (10 explorers + 2 pragmatists). Excludes collaboration/multiplayer features and anything Splice already has.

**Effort scale:** S (~1–3 days) · M (~1–2 weeks) · L (multi-week)

**Total: 82 features** (deduped from ~150 raw mentions; 29 dropped as already-implemented or low-leverage).

---

## Build order — top 10

1. **Per-project `.splice/settings.json`** — foundation for everything project-scoped
2. **EditorConfig support + inheritance** — rides on #1
3. **Format-on-save** — needs #1 to be per-repo opt-in
4. **Bracket pair / rainbow colorization** — independent S, same sprint as #3
5. **Search panel regex/word/case toggles** — independent S, same sprint
6. **Vim mode** — biggest single gap; arrives after #1 so it's per-repo
7. **Outline / symbol panel** — leverages `documentSymbol`; unblocks #8
8. **Sticky scroll** — depends on #7's symbol ranges
9. **Inlay hints** — independent M, biggest LSP impact
10. **Editable find-in-files results buffer** — power-tool capstone

---

## Editor primitives (24)

- **Breadcrumb path navigation** (S) — clickable file/symbol path at top of editor
- **Bracket pair / rainbow colorization** (S) — color-matched brackets for visual nesting
- **Smart-case + regex search toggles** (S) — case-sensitivity and regex toggles in search panel
- **Go-to-definition with preview** (S) — peek inline without navigating away
- **Symbol next/prev navigation** (S) — jump between symbols in current file
- **Bookmarks with persistent gutter display** (S) — mark and revisit lines, persisted per workspace
- **Toggle block comments** (S) — block-comment toggle action
- **Text transform / case conversion** (S) — upper/lower/title/snake/camel commands
- **File extension detection** (S) — recognize `.cts`/`.mts`/`.cjs`
- **Project search expand/collapse all** (S) — bulk expand/collapse search results
- **Order-independent fuzzy file finder** (S) — tokens match in any order
- **Wrapped line number handling** (M) — correct line numbering with soft-wrap on
- **Multi-cursor align selections** (M) — `editor::AlignSelections` for column alignment
- **LSP snippets + postfix snippets** (M) — snippet expansion with rich tabstops
- **Inlay hints** (M) — multi-LSP inlay hints with hover detail and per-language toggle
- **Outline / symbol panel** (M) — document symbol tree (tree-sitter + LSP)
- **Editable find-in-files results buffer** (M) — edit search results in place to bulk-replace
- **Find references panel** (M) — dedicated references results UI
- **Inline replace in buffer search** (M) — replace inline within current-buffer search
- **Vim-style tag stack navigation** (M) — jump-back stack like vim's `Ctrl-]`/`Ctrl-T`
- **Vim Mode** (L) — full modal emulation incl. `:w`/`:%s` and `Ctrl-V` visual block

## Language tooling (16)

- **Per-project `.splice/settings.json`** (S) — project-local LSP/format/keymap overrides
- **Semantic token highlighting** (S) — LSP semantic tokens incl. readonly modifier
- **EditorConfig support + inheritance** (S) — `.editorconfig` parsing with `root=true`
- **Diagnostics hover persistence** (S) — popover stays put when interacted with
- **Search filter exclusions for warnings** (S) — filter out warnings from project search
- **Format-on-save** (S) — autosave wired through formatters
- **Task runner** (M) — `tasks.json` equivalent w/ save integration
- **Inline test runnables / gutter run buttons** (M) — click-to-run tests at gutter
- **Multi-formatter pipeline** (M) — chain or pick from multiple formatters per language
- **Lint integration beyond LSP** (M) — run external linters (eslint, ruff)
- **Multi-LSP per language** (M) — run several language servers simultaneously
- **Rust macro expansion** (M) — `editor::ExpandMacroRecursively` inline view
- **Tailwind CSS autocomplete in templating langs** (M) — complete in Svelte/HEEx/ERB/PHP
- **Syntax tree view debug tool** (M) — inspect tree-sitter parse output
- **DAP integration** (L) — full Debug Adapter Protocol incl. memory view, data breakpoints, stack frame filtering, inline variable display, conditional breakpoints
- **REPL / Jupyter notebook support** (L) — embedded REPL with Python kernel selection

## AI / Assistant (8)

- **Native thinking mode with stream display** (S) — show model reasoning live
- **Context window + token estimation UI** (S) — show token budget and usage
- **Agent thread markdown editing** (S) — edit messages as markdown post-hoc
- **Inline assist** (M) — `Cmd+K` to transform selection via prompt
- **Slash commands** (M) — `/file`, `/tab`, `/symbol`, `/branch` context injection
- **Thread history & archival** (M) — persistent searchable conversation history
- **Multiple edit-prediction providers** (M) — pluggable Copilot/Ollama/Codestral inline completion
- **MCP server protocol support** (L) — native MCP client incl. remote dev

## Git / VCS (12)

- **Git panel quick actions** (S) — restore-and-next, pull --rebase, branch deletion, commit templates, file icons + uncommitted badge
- **Word-level diff highlighting** (S) — intra-line word diffs in diff view
- **Copy file location with line range** (S) — copy `path:line-line` link
- **Git blame inline hover** (M) — author/commit/age popover at cursor line
- **Remote branch picker** (M) — fuzzy multi-word branch search
- **Git commit view by ref** (M) — inspect arbitrary commits without checkout
- **Git worktree picker / management** (M) — browse and switch worktrees, open in new windows
- **Split diff side-by-side toggle** (M) — two-pane diff alongside existing unified view
- **GitHub avatars in blame** (M) — provider-aware blame metadata + PR/MR links
- **File history view** (M) — per-file commit log
- **Branch diff as agent context** (M) — send branch diff to agent for review
- **Git graph visualization** (L) — branch/commit graph UI

## Terminal (4)

- **Terminal tab renaming** (S) — rename terminal tabs
- **Terminal download from remote** (S) — pull files from remote shell
- **Command aliases with autocompletion** (S) — shell-style aliases with completion
- **Terminal hyperlink detection** (M) — auto-detect URLs/paths in output, click to open at line

## UI / Visual (10)

- **Focus follows mouse** (S) — hover-to-focus on panes and terminal
- **Mouse-wheel font zoom** (S) — `Cmd`+wheel to resize
- **Settings search/discovery UI** (S) — searchable settings page
- **Hover popover customization** (S) — configure hover delay/stickiness
- **Markdown preview enhancements** (M) — search inside preview, vim scroll keys, anchors + footnotes
- **Mermaid diagrams in markdown** (M) — inline mermaid rendering
- **Image viewer** (M) — zoom/pan/pinch, toolbar, GIF/PNM support
- **Scrollbar markers** (M) — search hits and diagnostics shown in scrollbar
- **Sticky scroll / current-function header** (M) — pin enclosing scope at top while scrolling
- **Markdown LaTeX support** (L) — KaTeX/MathJax inline + display math

## Customization / Extensibility (6)

- **Unbind default keybindings** (S) — explicitly disable bindings
- **Pane navigation actions** (S) — focus center, swap panes via `Cmd+K Shift+arrow`
- **Light/dark theme toggle hotkey** (S) — `Cmd+K Cmd+T` swaps configured pair
- **Project panel polish** (S) — hidden-files glob patterns, auto-reveal edited file, deletion coloring
- **Keymap presets** (M) — bundled VSCode/Atom/Sublime profiles
- **Context-aware keymap overrides** (M) — conditional keybindings by editor mode

## Workflow / Misc (3)

- **Task language variable `$SPLICE_LANGUAGE`** (S) — task templating variables
- **`workspace::FormatAndSave` action** (S) — combined format+save command
- **Windows SSH remoting** (M) — SSH from a Windows host

---

## Already in Splice (verified — don't rebuild)

Minimap (settings toggle) · code folding · multi-cursor + block selection · LSP rename / code-actions / hover / completion · merge-conflict UI · find-in-files with `replaceAll` · breadcrumbs (path-only — symbol-aware breadcrumbs would extend this naturally on top of the outline panel)

## Explicitly skipped (Tier 4)

Helix mode · devcontainer auto-open · ACP external agents · status-bar plugin API · icon theme extensions · GitLab/Azure git providers · terminal AI inline command generation (Claude already covers it) · markdown anchors/footnotes (covered by markdown enhancements) · reasoning-effort UI · pinch-zoom image viewer · search history · vim modeline (EditorConfig covers it) · CSS Language Server (LSP plumbing already supports any LS) · semantic search index · external ACP agents · parallel subagents · web search tool · branch deletion as standalone (rolled into git panel quick actions) · file extension detection (CodeMirror handles) · split diff auto-layout · recent projects 7-day persistence · GitLab/Gitee avatars · pane swap shortcuts · agent thread persistence (Splice has session resume) · interleaved reasoning · model selection UI (CLI handles) · rules library (CLAUDE.md auto-injected by Claude itself) · tool use permissions · reasoning effort favorites · edit prediction Zeta-specific · branch diff as agent context (handled via Claude Code) · cancellable thread

## Source

Researched against:
- Zed GitHub releases v0.91 (June 2023) → v0.234 (April 2026)
- Zed source code referenced in release notes
- Verified against Splice codebase: `CLAUDE.md`, `src/lib/ipc/commands.ts`, `src-tauri/src/commands/`, `src/components/`, `src/lib/utils/keybindings.ts`
