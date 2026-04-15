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


