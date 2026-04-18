---
id: T05
parent: S01
milestone: M003
provides:
  - "legacy-plan.md fixture (no must_haves: key → legacy:true, exit 0)"
  - "structured-valid-plan.md fixture (well-formed must_haves → valid:true, exit 0)"
  - "structured-malformed-plan.md fixture (missing min_lines → valid:false, exit 2)"
  - "RESULTS.md outcome table — all 3 rows Pass"
requires:
  - T01 (forge-must-haves.js parser + CLI)
affects: [S01]
key_files:
  - .gsd/milestones/M003/slices/S01/smoke/legacy-plan.md
  - .gsd/milestones/M003/slices/S01/smoke/structured-valid-plan.md
  - .gsd/milestones/M003/slices/S01/smoke/structured-malformed-plan.md
  - .gsd/milestones/M003/slices/S01/smoke/RESULTS.md
key_decisions:
  - "Malformed fixture omits artifacts[0].min_lines — minimal defect that exercises the specific validator path without introducing other errors"
  - "RESULTS.md includes actual error string from parser so future readers can verify specificity of error messages"
patterns_established:
  - "Smoke fixture convention: one file per scenario under smoke/ subdirectory; RESULTS.md records actual vs expected — used in M003/S01/smoke/"
duration: 5min
verification_result: pass
completed_at: 2026-04-16T00:00:00Z
---

Three smoke-demo plan fixtures created and validated against `forge-must-haves.js --check` — all three exit codes and JSON outputs match expectations, proving end-to-end round-trip of the parser.

## What Happened

Created three T##-PLAN fixtures under `.gsd/milestones/M003/slices/S01/smoke/`:
- `legacy-plan.md`: mimics M001/M002 shape — frontmatter has `id/slice/milestone` only, body has `## Must-Haves` markdown bullets. Parser returns `{legacy:true,valid:true,errors:[]}`, exit 0.
- `structured-valid-plan.md`: full `must_haves:` block with `truths`, `artifacts` (path + provides + min_lines), `key_links` (from/to/via), and `expected_output`. Parser returns `{legacy:false,valid:true,errors:[]}`, exit 0.
- `structured-malformed-plan.md`: `must_haves:` present but `artifacts[0]` omits `min_lines`. Parser returns `{legacy:false,valid:false,errors:["malformed must_haves schema: artifacts[0].min_lines — required number field missing"]}`, exit 2.

All three fixtures now serve as living regression tests for S03/S04 consumers.

## Deviations

None — all three fixtures behaved exactly as specified on first run.

## Files Created/Modified

- `.gsd/milestones/M003/slices/S01/smoke/legacy-plan.md` (created, 27 lines)
- `.gsd/milestones/M003/slices/S01/smoke/structured-valid-plan.md` (created, 40 lines)
- `.gsd/milestones/M003/slices/S01/smoke/structured-malformed-plan.md` (created, 26 lines)
- `.gsd/milestones/M003/slices/S01/smoke/RESULTS.md` (created, 30 lines)
- `.gsd/milestones/M003/slices/S01/tasks/T05/T05-PLAN.md` (status: RUNNING → DONE)

## Verification

- Gate: skipped (no-stack)
- Discovery source: none
- Commands: `node scripts/forge-verify.js --plan ... --unit execute-task/T05` (exit 0)
- Manual checks: all 4 files present; RESULTS.md has 4 pipe-rows (header+sep+3 data); 4 "Pass" occurrences
- Total duration: ~200ms
