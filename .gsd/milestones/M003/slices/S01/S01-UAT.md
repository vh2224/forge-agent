# S01: Structured must-haves schema + executor validation — UAT Script

**Slice:** S01  **Milestone:** M003  **Written:** 2026-04-16

## Prerequisites

- Repo at `C:/DEV/forge-agent` (or clone).
- Node.js available on PATH (`node --version` returns v18+).
- `scripts/forge-must-haves.js` exists in the repo root `scripts/` directory.
- Smoke fixtures exist under `.gsd/milestones/M003/slices/S01/smoke/`.

## Test Cases

| # | Action | Expected | Pass? |
|---|--------|----------|-------|
| 1 | Run `node --check scripts/forge-must-haves.js` | Exit 0, no output | |
| 2 | Run `node scripts/forge-must-haves.js --check .gsd/milestones/M003/slices/S01/smoke/legacy-plan.md` | Stdout JSON: `{"legacy":true,"valid":true,"errors":[]}`, exit code 0 | |
| 3 | Run `node scripts/forge-must-haves.js --check .gsd/milestones/M003/slices/S01/smoke/structured-valid-plan.md` | Stdout JSON: `{"legacy":false,"valid":true,"errors":[]}`, exit code 0 | |
| 4 | Run `node scripts/forge-must-haves.js --check .gsd/milestones/M003/slices/S01/smoke/structured-malformed-plan.md` | Stdout JSON: `{"legacy":false,"valid":false,"errors":["malformed must_haves schema: artifacts[0].min_lines — required number field missing"]}`, exit code 2 | |
| 5 | Open `agents/forge-planner.md`, search for `must_haves:` | File contains `## Must-Haves Schema (required on every T##-PLAN)` section with the full YAML example and unconditional emit rule | |
| 6 | Open `agents/forge-executor.md`, search for `step 1a` | File contains step 1a block with branch logic: structured+valid → continue; malformed → blocked/scope_exceeded; legacy → warn note | |
| 7 | Open `forge-agent-prefs.md`, search for `evidence:` | File contains `## Evidence Settings` section with `mode: lenient` default and lenient/strict/disabled semantics | |
| 8 | Create a new T##-PLAN.md using the planner template guidance, verify frontmatter includes `must_haves:` block with `truths`, `artifacts`, `key_links` keys and a top-level `expected_output:` array | Both keys present in frontmatter, `expected_output` is a sibling of `must_haves` (not nested inside it) | |
| 9 | Run `node scripts/forge-must-haves.js --check` with no path argument | Prints usage/error message, exits non-zero | |
| 10 | Verify RESULTS.md under `smoke/` matches actual CLI output from tests 2–4 above | Three rows with matching actual output strings | |

## Notes

- Test 4 is the critical regression path — the malformed fixture deliberately omits `artifacts[0].min_lines` only. If the error message changes wording, S03 downstream consumers may need updating.
- Test 8 requires the planner to actually produce a plan for a new task (live run or manual file creation following the schema section in `forge-planner.md`).
- The `legacy_schema: true` warn note (executor behavior for legacy plans, test 6) is verified by reading the agent instructions — live verification requires dispatching a real task with a legacy plan file.
- Windows testers: use forward slashes in paths or wrap in double quotes; `node` resolves both.
