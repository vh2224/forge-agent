---
id: T03
parent: S03
milestone: M001
provides: [skills/forge-task/SKILL.md with full forge-task logic, commands/forge-task.md thin shim]
requires: []
affects: [S03]
key_files: [skills/forge-task/SKILL.md, commands/forge-task.md]
key_decisions: ["forge-task migrated to skill with disable-model-invocation: true; shim passes $ARGUMENTS through"]
duration: 5min
verification_result: pass
completed_at: 2026-04-15T00:00:00Z
---

Migrated forge-task command logic to skills/forge-task/SKILL.md and replaced commands/forge-task.md with a 6-line shim.

## What Happened

- Created `skills/forge-task/SKILL.md` with `disable-model-invocation: true` frontmatter and the complete forge-task logic (parse args, bootstrap guard, load context, TASK_ID determination, init, cleanup orphaned tasks, 5-step dispatch loop, post-task housekeeping, compact signal)
- Rewrote `commands/forge-task.md` as a thin shim (6 lines total) that invokes `Skill("forge-task")` and passes `$ARGUMENTS` through
- Verified: `disable-model-invocation: true` present in SKILL.md, shim is 6 lines (under 15 limit)

## Deviations

None.

## Files Created/Modified

- `skills/forge-task/SKILL.md` — new file, full forge-task logic (~300 lines)
- `commands/forge-task.md` — rewritten to shim, 6 lines
