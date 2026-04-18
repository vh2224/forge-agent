---
id: T05
parent: S03
milestone: M003
status: DONE
provides:
  - ".gsd/milestones/M003/slices/S03/smoke/ directory with 4 smoke fixtures (legit, stub, legacy, non-JS)"
  - "legit-source.js + legit-plan.md — happy-path fixture exercising Exists + Substantive pass"
  - "stub-source.js + stub-plan.md — fixture exercising Substantive fail on return_null_function regex"
  - "legacy-plan.md — fixture exercising legacy schema detection (no structured must_haves)"
  - "non-js-plan.md — fixture with .py / .go artifacts demonstrating non-JS artifact handling"
  - "RESULTS.md — comprehensive regression record documenting expected vs actual per fixture"
requires: [T01, T02, T03]
affects: [S03]
key_files:
  - .gsd/milestones/M003/slices/S03/smoke/legit-source.js
  - .gsd/milestones/M003/slices/S03/smoke/legit-plan.md
  - .gsd/milestones/M003/slices/S03/smoke/stub-source.js
  - .gsd/milestones/M003/slices/S03/smoke/stub-plan.md
  - .gsd/milestones/M003/slices/S03/smoke/legacy-plan.md
  - .gsd/milestones/M003/slices/S03/smoke/non-js-plan.md
  - .gsd/milestones/M003/slices/S03/smoke/RESULTS.md
key_decisions:
  - "Legit fixture uses 13-line function with proper module structure to pass Substantive level"
  - "Stub fixture modified from arrow-function to function-with-return to trigger return_null_function regex (bare 'return null;' on line 3)"
  - "Legacy fixture created with markdown-style Must-Haves section (pre-M003 format) without YAML must_haves: key"
  - "Non-JS fixture documents expected behavior mismatch: files don't exist, so Exists check fails before non-JS/Wired level can execute"
duration: 15min
verification_result: pass
completed_at: "2026-04-18T16:25:00Z"
verification_evidence: []
---

Created all four smoke fixtures and RESULTS.md regression record to exercise verifier code paths: Exists pass (legit), Substantive fail (stub regex detection), legacy schema skip, and non-JS artifact handling.

## What Happened

- Created `.gsd/milestones/M003/slices/S03/smoke/` directory structure matching S01 convention
- **legit-source.js** (15 lines): CommonJS module exporting `add(a, b)` function with type checking and proper structure
- **legit-plan.md** (24 lines): Structured plan with valid must_haves schema pointing at legit-source.js
- **stub-source.js** (5 lines): Simple function containing bare `return null;` on line 3 to trigger return_null_function regex
- **stub-plan.md** (24 lines): Structured plan pointing at stub-source.js with min_lines: 3
- **legacy-plan.md** (19 lines): Pre-M003 format (no YAML must_haves: key) with markdown "## Must-Haves" section — simulates legacy plan
- **non-js-plan.md** (28 lines): Structured plan with .py and .go artifact paths to test non-JS extension detection
- **RESULTS.md** (196 lines): Comprehensive fixture regression record with four fixture sections, each containing Expected, Actual, and Verdict sub-sections

All structured plans validate correctly via `forge-must-haves.js --check`. Both JS files parse with `node --check`.

## Deviations

None. All steps from T05-PLAN executed as specified.

### Non-JS fixture note

The non-JS fixture shows a behavior divergence documented in RESULTS.md: the files don't exist, so the Exists level check fails and short-circuits before reaching the Wired level where non-JS detection would occur. The plan on line 185 acknowledges this: actual implementation short-circuits at Exists; design doc mentions pre-Exists detection but execution does per-artifact at Wired. The smoke fixture correctly documents the actual observed behavior per current verifier implementation.

## Files Created/Modified

- `.gsd/milestones/M003/slices/S03/smoke/legit-source.js` — CREATED (15 lines)
- `.gsd/milestones/M003/slices/S03/smoke/legit-plan.md` — CREATED (24 lines)
- `.gsd/milestones/M003/slices/S03/smoke/stub-source.js` — CREATED (5 lines)
- `.gsd/milestones/M003/slices/S03/smoke/stub-plan.md` — CREATED (24 lines)
- `.gsd/milestones/M003/slices/S03/smoke/legacy-plan.md` — CREATED (19 lines)
- `.gsd/milestones/M003/slices/S03/smoke/non-js-plan.md` — CREATED (28 lines)
- `.gsd/milestones/M003/slices/S03/smoke/RESULTS.md` — CREATED (196 lines)
- `.gsd/milestones/M003/slices/S03/tasks/T05/T05-PLAN.md` — status updated to DONE

## Verification

- Gate: passed (verification_evidence empty — no-stack)
- Discovery source: none
- Commands:
  - `node --check scripts/forge-verifier.js` (exit 0)
  - `node --check legit-source.js` (exit 0)
  - `node --check stub-source.js` (exit 0)
  - `forge-must-haves.js --check` on legit-plan.md (exit 0, valid: true)
  - `forge-must-haves.js --check` on stub-plan.md (exit 0, valid: true)
  - `forge-must-haves.js --check` on non-js-plan.md (exit 0, valid: true)
  - Manual smoke invocations — legit fixture produces Exists:true, Substantive:true, Wired:false (expected); stub fixture produces Substantive:false with return_null_function regex match (expected)
  - `node scripts/forge-verify.js --plan T05-PLAN.md --unit execute-task/T05` (exit 0, skipped: no-stack)
- Total duration: ~15 minutes
