---
id: T02
parent: S03
milestone: M001
provides:
  - skills/forge-auto/SKILL.md — full forge-auto logic (~420 lines) extracted from commands/forge-auto.md
  - commands/forge-auto.md — thin 7-line shim invoking Skill("forge-auto")
requires: []
affects: [S03]
key_files:
  - skills/forge-auto/SKILL.md
  - commands/forge-auto.md
key_decisions:
  - "allowed-tools included in skill frontmatter per ROADMAP spec (not just command shim) — T02-PLAN.md contradicts itself; ROADMAP wins"
  - "Shim forwards $ARGUMENTS to skill per MEM017 convention"
patterns_established:
  - "Command → Skill migration: copy body to skills/forge-<name>/SKILL.md, replace command body with Skill({ skill, args: '$ARGUMENTS' })"
duration: 5min
verification_result: pass
completed_at: 2026-04-15T00:00:00Z
---

Migrated full forge-auto logic to `skills/forge-auto/SKILL.md` and replaced `commands/forge-auto.md` with a 7-line shim.

## What Happened

1. Read `commands/forge-auto.md` (423 lines, post-S01/S02 changes) to capture current content.
2. Checked existing skill frontmatter patterns (forge-brainstorm) and ROADMAP spec — ROADMAP explicitly includes `allowed-tools` in skill frontmatter; followed ROADMAP.
3. Created `skills/forge-auto/SKILL.md` with frontmatter: `name`, `description`, `disable-model-invocation: true`, `allowed-tools` (same list as original command) — body is the full forge-auto logic verbatim.
4. Rewrote `commands/forge-auto.md` as a 7-line shim with original frontmatter and `Skill({ skill: "forge-auto", args: "$ARGUMENTS" })` per MEM017.
5. Verified: shim = 7 lines (< 15), SKILL.md contains `disable-model-invocation: true`.

## Deviations

T02-PLAN.md had a contradictory note: "Do NOT add allowed-tools to skill frontmatter" followed by "Wait — check the ROADMAP: it specifies allowed-tools in skill frontmatter. Follow the ROADMAP spec." Followed the ROADMAP spec — allowed-tools is present in skill frontmatter.

## Files Created/Modified

- `skills/forge-auto/SKILL.md` — created (~420 lines, full forge-auto logic)
- `commands/forge-auto.md` — rewritten to 7-line shim
- `.gsd/milestones/M001/slices/S03/tasks/T02/T02-PLAN.md` — status updated to DONE
