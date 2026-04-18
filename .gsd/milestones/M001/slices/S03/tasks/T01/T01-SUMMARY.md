---
id: T01
parent: S03
milestone: M001
provides:
  - commands/forge.md — thin REPL router, 126 lines, under 300-line and ~5K token budget
  - Bootstrap guard pattern (same as forge-auto.md)
  - Auto-resume detection via auto-mode.json
  - AskUserQuestion persistent menu loop with 6 options
  - Compact recovery check at start of every loop iteration
requires: []
affects: [S03]
key_files:
  - commands/forge.md
key_decisions:
  - "forge.md REPL loop reads STATE.md after each skill returns to refresh status line — ensures stale data is never shown"
  - "Exit path checks for active auto-mode before deactivating — avoids overwriting auto-mode.json when it was never activated"
patterns_established:
  - "REPL loop with AskUserQuestion in commands/forge.md — persistent menu dispatch via Skill() calls"
duration: 10min
verification_result: pass
completed_at: 2026-04-15T00:00:00Z
---

Created `commands/forge.md` as the unified `/forge` entry point — a 126-line thin REPL router with bootstrap guard, auto-resume detection, compact recovery check per iteration, and AskUserQuestion menu dispatching to forge-auto, forge-task, forge-new-milestone, forge-status, and forge-help skills.

## What Happened

1. Read T01-PLAN.md, S03-PLAN.md, S03-RESEARCH.md, and commands/forge-auto.md for patterns.
2. Created `commands/forge.md` (126 lines) with:
   - Frontmatter: description + allowed-tools (Read, Bash, Skill, AskUserQuestion, TaskCreate, TaskUpdate)
   - Bootstrap guard: same pattern as forge-auto.md (CLAUDE.md + STATE.md checks)
   - Load context: reads STATE.md for project name, active milestone, next action
   - Auto-resume detection: if auto-mode.json shows active:true within 60min, calls Skill("forge-auto") and skips menu
   - REPL loop: compact recovery check at top of every iteration, then AskUserQuestion with 6 options
   - Dispatch table: auto → forge-auto, task → forge-task, new-milestone → forge-new-milestone, status → forge-status, help → forge-help, sair → exit
   - Exit: deactivates auto-mode if active, emits farewell message
3. Verified: 126 lines (well under 300), ~1,900 tokens estimated (well under 5K budget)

## Deviations

None. All must-haves satisfied. TaskCreate/TaskUpdate kept in allowed-tools as specified in plan even though the REPL itself doesn't create tasks (may be needed by dispatched skills running in same context).

## Files Created/Modified

- `commands/forge.md` — created (126 lines)
- `.gsd/milestones/M001/slices/S03/tasks/T01/T01-PLAN.md` — status updated to DONE
