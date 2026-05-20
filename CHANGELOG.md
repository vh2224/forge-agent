## v1.1.0 (2026-05-20) — M004 Multi-Run Workspace

### Breaking Changes

- `.gsd/STATE.md` raiz vira **dashboard read-only auto-gerado** (Multi-run mode). Single-run workspaces continuam funcionando via migração lazy ao primeiro boot multi-run — sem ação manual necessária.
- Workers (forge-executor, forge-discusser, forge-completer, forge-memory) escrevem decisões/memórias/eventos em arquivos **per-milestone** (`M###-DECISIONS.md`, `M###-AUTO-MEMORY.md`, `M###-events.jsonl`, `M###-CHECKER-MEMORY.md`) durante a run. Globais são merged em `complete-milestone` via `forge-merger.js` sob lockfile.

### Features

- feat: **Per-milestone state + runs registry** (S01) — `M###-STATE.md` substitui STATE.md raiz como source-of-truth de cada run. `.gsd/forge/runs/{id}.json` registra todas as runs ativas (kind: milestone | task).
- feat: **Hooks session-aware** (S02) — `forge-hook.js` resolve a run dona via `data.session_id` em todos os 6 phases. Evidence path scoped por run_id.
- feat: **Pause + compact-signal per-run** (S03) — `.gsd/forge/pause-{run_id}` e `compact-signal-{sessionId}.json` substituem globais. `/forge-pause M065` toggla scoped.
- feat: **Global merge sob lockfile** (S05) — `scripts/forge-merger.js` promove per-milestone files pros globais (DECISIONS, AUTO-MEMORY com cap-50 decay, LEDGER, CHECKER-MEMORY, events.jsonl) sob `mkdir`-mutex via `scripts/forge-lock.js`. Validado com 2 mergers concorrentes em NTFS sem corruption.
- feat: **CLI multi-run** (S06) — `/forge-auto <ID>`, `/forge-next <ID>`, `/forge-task <descrição>` aceitam ID args. Sem arg + 0 ativas = legacy fallback; 1 ativa = assume retomar; 2+ ativas = refuse + lista IDs.
- feat: **File-locks modo shared** (S07) — `scripts/forge-filelock.js` + `forge-hook.js` PreToolUse bloqueia Write/Edit cross-run quando outra run ativa segura o arquivo. Steal-on-inactive + steal-on-expired (TTL 60s). Orquestrador retenta 3× com backoff 5-30s jitter via `forge-classify-error.js` novo class `cross_run_file_lock`.
- feat: **Isolation modes** (S08) — `forge_isolation.mode: shared | branch | worktree` configurável em prefs. `scripts/forge-repos.js` auto-detect multi-repo via walk de subdirs `.git/`. `scripts/forge-isolation.js` setup/cleanup pra branch (`forge/{M###}`) e worktree (`.forge-worktrees/{M###}/{repo}/`).
- feat: **Statusline multi-run** (S09) — `forge-statusline.js` scaneia `runs/*.json`. 1 run = visual rico legado. 2-3 runs = compacto `● AUTO ×2 │ M065 ⚡T03 +12s │ M066 🔥S04 +1m`. 4+ trunca com `+N mais`.
- feat: **Docs** (S10) — `docs/multi-run.md` cobre 3 modes, locks, registry, CLI, troubleshooting. `forge-agent-prefs.md` ganha bloco `forge_isolation:` + `multi_run:` + `parallelism.cross_run_overlap:` scaffolded.

### Architecture (M004 decisions D-M004-1..12 — see .gsd/milestones/M004/M004-CONTEXT.md)

- STATE.md raiz dashboard regenerável; per-milestone state em M###-STATE.md
- Runs registry indexado por ID, kind=milestone | task
- Per-milestone artifacts → globals via merger sob lockfile no complete-milestone
- File-locks only em shared mode; defesa-em-profundidade em branch; auto-disabled em worktree
- Conflict de lock → retry 3× com jitter 5-30s
- forge_isolation.mode default = shared (zero quebra retroativa)
- Multi-repo auto-detect via walk de .git
- CLI exige ID quando 2+ ativas
- Hooks resolvem run via session_id
- Statusline linha compacta multi-run; trunca em 4+
- forge-memory promove per-milestone → global no merger
- auto-mode.json mantido como alias do oldest active (compat)

### Scripts added

- `scripts/forge-runs.js` — registry CRUD
- `scripts/forge-state.js` — per-milestone STATE read/write + legacy compat
- `scripts/forge-lock.js` — mkdir-mutex helper
- `scripts/forge-dashboard.js` — regen STATE.md raiz
- `scripts/forge-merger.js` — per-milestone → global promotion
- `scripts/forge-cli-helpers.js` — resolveRunFromArgs, refuse logic, newTaskId
- `scripts/forge-filelock.js` — cross-run file ownership tracking
- `scripts/forge-repos.js` — auto-detect git repos via walk
- `scripts/forge-isolation.js` — setup/cleanup branch + worktree modes

All 9 scripts auto-installed via existing `install.sh` / `install.ps1` globs — no installer changes needed.

## v1.0.0 (2026-04-15)

### Breaking Changes

- `/forge` replaces `/forge-auto` as the primary entry point; existing `/forge-auto` invocations continue to work via a thin shim
- `forge-auto`, `forge-task`, and `forge-new-milestone` commands migrated to skills (`skills/forge-auto/`, `skills/forge-task/`, `skills/forge-new-milestone/`); the original command files are now 6–7-line shims that delegate to `Skill()`

### Features

- feat: PostCompact hook recovery — `forge-hook.js` writes `.gsd/forge/compact-signal.json` when Claude Code fires the PostCompact lifecycle event while forge-auto is active; orchestrator detects the signal on the next loop iteration, re-initializes all in-memory state from disk, deletes the signal, and continues transparently
- feat: lean orchestrator — all 24 `{content of …}` artifact-inlining placeholders in `shared/forge-dispatch.md` replaced with `Read:` / `Read if exists:` path directives; workers resolve their own context in their isolated context window, cutting per-unit token growth from ~10–50K down to ~500 tokens
- feat: `/forge` REPL shell — new `commands/forge.md` (126 lines, < 5K tokens) is a compact-safe router with bootstrap guard, auto-resume detection, and an `AskUserQuestion` dispatch loop covering forge-auto, forge-task, forge-new-milestone, forge-status, and forge-help
- feat: skill migration with `disable-model-invocation: true` — three heavyweight commands converted to skills, shrinking command footprint from ~950 lines to ~20 lines of shims while preserving all logic in isolated skill contexts

### Architecture

- compact-signal.json recovery flow: PostCompact hook (forge-hook.js) → disk signal (`.gsd/forge/compact-signal.json`) → orchestrator reads/deletes on next iteration → transparent resume; existing COMPACTION RESILIENCE behavioral rule kept as fallback for Claude Code versions without PostCompact support
- workers read own artifacts: orchestrator passes paths, not content; workers call `Read` tool inside their isolated context — eliminates token accumulation across dispatch loop iterations
- `/forge` compact-safe token budget: REPL shell stays well within < 5K token re-attachment budget; compact recovery check runs at the top of every loop iteration

## v0.7.3 (2026-04-10)

### Features

- feat: add /forge-task command — autonomous task without milestone/slice hierarchy. Flow: brainstorm → discuss → research → plan → execute. Supports --skip-brainstorm, --skip-research, --resume TASK-###. Tasks live in .gsd/tasks/TASK-###/. forge-status and forge-explain updated.

## v0.7.2 (2026-04-10)

### Features

- feat: distribute decisions by phase — workers inject CONTEXT.md decisions instead of global DECISIONS.md; DECISIONS.md becomes audit overview for /forge-explain decisions

## v0.7.1 (2026-04-10)

### Performance

- perf: reduce context injection in worker prompts — DECISIONS.md capped at last 20 rows in plan-slice/plan-milestone/discuss (was full file), AUTO-MEMORY capped at 40 lines (was 80), T##/S##-SUMMARY injection capped at 35 lines each

## v0.7.0 (2026-04-09)

### Features

- feat: integrate skills via Skill tool — brainstorm/scope/risk-radar composable in workflow (837d746)
- feat: effort/thinking per phase, WebSearch in researcher, SubagentStart/Stop + PreCompact hooks (2b9d3b0)
- feat: AskUserQuestion + PlanMode in discusser, TaskList/TaskStop in orchestrators (9d0a79f)

### Other Changes

- Merge branch 'master' of https://github.com/vh2224/forge-agent (9c1fb90)


## v0.6.1 (2026-04-09)

### Bug Fixes

- fix: add UTF-8 BOM to install.ps1 to fix PowerShell 5.x parse errors (9402028)


## v0.6.0 (2026-04-09)

### Features

- feat: auto-mode indicator with blink, timer and stale detection (3c584e9)
- feat: show auto-mode indicator with elapsed time in status line (c28ce56)


## v0.5.0 (2026-04-09)

### Features

- feat: add auto_commit preference — let users opt out of git management (c773c4c)
- feat: add visual timeline to forge-auto and forge-next via TaskCreate (0b907c2)


## v0.4.0 (2026-04-09)

### Features

- feat: filter internal commits from /forge-update release notes (4920422)
- feat: show release notes on /forge-update and rename GSD Agent → Forge Agent (38746a1)

### Bug Fixes

- fix: emit next action hint after forge-next completes a unit (ba43da0)
- fix: add explicit autonomy rule to forge-auto to prevent pausing between units (18f1a5e)
- fix: repair install.ps1 form feed chars and clean up legacy gsd-* agents (da6453d)

### Other Changes

- refactor: unify forge-doctor + forge-fix into single command with --fix flag (5fe50d3)


## v0.3.0 (2026-04-09)

### Features

- feat: add /forge-fix — auto-correction for GSD project structure (90c6600)


# Changelog

## v0.2.0 (2026-04-09)

### Features

- feat: add CHANGELOG.md generation to release workflow (bfbba43)


