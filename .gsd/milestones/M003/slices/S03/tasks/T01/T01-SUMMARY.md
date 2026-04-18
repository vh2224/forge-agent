---
id: T01
parent: S03
milestone: M003
status: DONE
provides:
  - "scripts/forge-verifier.js — CommonJS module exporting verifyArtifact(mustHaves, sliceFiles, opts)"
  - "DEFAULT_STUB_REGEXES — ordered 4-pattern stub library with LOCKED canonical names"
  - "_private exports — checkExists, checkSubstantive, readFileCached for T02/T03/T05 tests"
  - "3-level verification with short-circuit (Exists→Substantive→Wired-stub)"
  - "stub_patterns:[] per-artifact override fully functional"
requires: []
affects: [S03]
key_files:
  - scripts/forge-verifier.js
key_decisions:
  - "return_null_function regex flags ALL bare `return null;` lines as heuristic; human triages false positives per RISK card — not worth precise scoping"
  - "Wired level returns { wired: null, flag: { reason: 'not_implemented_yet' } } as T03 placeholder; non_js_ts repos get wired:'skipped'"
new_helpers:
  - "verifyArtifact — scripts/forge-verifier.js — 3-level artifact verifier (Exists+Substantive+Wired-stub) consuming parseMustHaves output"
  - "DEFAULT_STUB_REGEXES — scripts/forge-verifier.js — canonical 4-pattern stub regex library with precedence order"
  - "checkExists — scripts/forge-verifier.js — Level-1 file presence check with cache"
  - "checkSubstantive — scripts/forge-verifier.js — Level-2 stub detection with stub_patterns override"
  - "readFileCached — scripts/forge-verifier.js — per-invocation Map-backed file read cache"
duration: 20min
verification_result: pass
completed_at: "2026-04-18T00:00:00Z"
verification_evidence: []
---

Created `scripts/forge-verifier.js` (367 lines) — a CommonJS module implementing the 3-level `verifyArtifact` API with the canonical stub-regex library, short-circuit evaluation, and per-invocation file cache.

## What Happened

- Implemented all 4 stub regexes in locked precedence order (empty_function_body → return_null_function → jsx_placeholder_onclick → jsx_placeholder_return_div).
- The module's own comment lines (`// onClick={() => {}}`) and the `return null;` in `readFileCached` correctly trigger stub detection when checking forge-verifier.js itself without the `stub_patterns: []` override — this is expected false-positive behavior per RISK card; the override disables detection for T01-PLAN.md's artifact declaration.
- Wired level stubbed with `not_implemented_yet` flag; non-JS/TS repos get `wired: 'skipped'`.
- `require('./forge-must-haves')` loaded unconditionally (no side effects) so T02 CLI can use `hasStructuredMustHaves` without re-requiring.

## Deviations

None. All steps from T01-PLAN.md executed as specified.

## Files Created/Modified

- `scripts/forge-verifier.js` — CREATED (367 lines)
- `.gsd/milestones/M003/slices/S03/tasks/T01/T01-PLAN.md` — status updated to DONE

## Verification

- Gate: skipped (no-stack)
- Discovery source: none
- Commands:
  - `node --check scripts/forge-verifier.js` (exit 0)
  - `node scripts/forge-verify.js --plan ... --unit execute-task/T01` (exit 0, skipped: no-stack)
- Smoke tests: all 3 manual cases passed (missing file short-circuit, stub_patterns:[] override, legacy null input)
