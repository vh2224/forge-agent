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


