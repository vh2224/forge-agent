---
id: T04
parent: S03
milestone: M001
provides:
  - skills/forge-new-milestone/SKILL.md — full forge-new-milestone logic (~215 lines) extracted from commands/forge-new-milestone.md
  - commands/forge-new-milestone.md — thin 7-line shim invoking Skill("forge-new-milestone")
requires: []
affects: [S03]
key_files:
  - skills/forge-new-milestone/SKILL.md
  - commands/forge-new-milestone.md
key_decisions:
  - "allowed-tools included in skill frontmatter per ROADMAP spec (consistent with T02/T03 pattern)"
  - "Shim forwards $ARGUMENTS to skill per MEM017 convention"
patterns_established:
  - "Command → Skill migration: copy body to skills/forge-<name>/SKILL.md, replace command body with Skill({ skill, args: '$ARGUMENTS' })"
duration: 5min
verification_result: pass
completed_at: 2026-04-15T00:00:00Z
---

Migrated full forge-new-milestone logic to `skills/forge-new-milestone/SKILL.md` and replaced `commands/forge-new-milestone.md` with a 7-line shim.

## What Happened

1. Read `commands/forge-new-milestone.md` (214 lines) to capture full content.
2. Checked T02 summary and existing shim pattern (forge-auto.md) for reference.
3. Created `skills/forge-new-milestone/SKILL.md` with frontmatter: `name`, `description`, `disable-model-invocation: true`, `allowed-tools` — body is the full forge-new-milestone logic verbatim.
4. Rewrote `commands/forge-new-milestone.md` as a 7-line shim with original frontmatter and `Skill({ skill: "forge-new-milestone", args: "$ARGUMENTS" })`.
5. Verified: shim = 7 lines (< 15), SKILL.md contains `disable-model-invocation: true`.

## Deviations

None. Followed the established T02/T03 migration pattern exactly.

## Files Created/Modified

- `skills/forge-new-milestone/SKILL.md` — created (~215 lines, full forge-new-milestone logic)
- `commands/forge-new-milestone.md` — rewritten to 7-line shim
- `.gsd/milestones/M001/slices/S03/tasks/T04/T04-PLAN.md` — status updated to DONE
