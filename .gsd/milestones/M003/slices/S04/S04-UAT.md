# S04: Plan-checker agent (advisory) + CLAUDE.md doc — UAT Script

**Slice:** S04  **Milestone:** M003  **Written:** 2026-04-18

## Prerequisites

- M003 complete, `install.sh` re-run after S04 closes (activates `agents/forge-plan-checker.md` + updated skill files per MEM068)
- A test project with `.gsd/` initialized via `/forge-init`
- Optional: a legacy M001/M002 plan with free-text `must_haves` for test case 5

## Test Cases

| # | Action | Expected | Pass? |
|---|--------|----------|-------|
| 1 | Plan a new test slice (`/forge-add-slice`) then run `/forge-next` through `plan-slice` then let forge-auto proceed | After `plan-slice` completes, `S##-PLAN-CHECK.md` is created in the slice directory BEFORE the first `execute-task` dispatch | |
| 2 | Open the `S##-PLAN-CHECK.md` produced in test 1 | File contains ≥ 8 dimension rows, each with `pass`, `warn`, or `fail` status plus a one-line justification. `## Summary` block shows counts (`pass: N, warn: N, fail: N`) | |
| 3 | Set `plan_check.mode: blocking` in `.gsd/prefs.local.md`, craft a slice plan with one T##-PLAN missing `must_haves.artifacts`, run `/forge-next` through plan-slice | Revision loop activates: planner is re-dispatched with `## Revision Request`. Loop terminates at round 3 OR when fail count does not strictly decrease. User sees surface message with remaining failing dimensions | |
| 4 | Revert `plan_check.mode` to `advisory` (or remove the key), re-run `/forge-next` on the same slice after resetting | Plan-check runs once; regardless of any warn/fail verdicts, dispatch continues to first `execute-task`. No revision loop entered | |
| 5 | Point a plan-check at a legacy M001/M002 T##-PLAN with free-text `must_haves:` (not YAML block) | `must_haves_wellformed` dimension scored `warn` (not `fail`). `legacy_schema_detect` row appears with `warn` or `info`. No crash, no blocking | |
| 6 | Run `grep -n "Anti-Hallucination Layer" CLAUDE.md` in the forge-agent repo root | Returns exactly one match line containing the section heading. Section names all 5 components, all 3 artifact files, all 3 prefs keys with their defaults | |
| 7 | Run `/forge-next` on a slice that already has `S##-PLAN-CHECK.md` | Plan-check guard detects the file exists and skips re-dispatch of `forge-plan-checker`. Proceeds directly to execute-task. No duplicate PLAN-CHECK.md created | |

## Notes

- MEM068: `agents/forge-plan-checker.md` and the updated `forge-auto/SKILL.md` + `forge-next/SKILL.md` are only active after `install.sh` / `install.ps1` re-run. Running UAT before install re-run will produce old behavior (no plan-check).
- Test case 3 requires `plan_check.mode: blocking` in prefs — remember to revert after testing to avoid blocking normal workflow.
- The `MAX_PLAN_CHECK_ROUNDS = 3` constant is LOCKED — the loop will never exceed 3 rounds regardless of pref values.
- For test case 5, any pre-M003 plan file with `must_haves: "prose description"` qualifies as legacy input.
