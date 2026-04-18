---
id: T01
parent: S01
milestone: M003
provides:
  - "scripts/forge-must-haves.js — CommonJS module with hasStructuredMustHaves() and parseMustHaves()"
  - "CLI: node scripts/forge-must-haves.js --check <plan.md> exits 0/0/2 for legacy/valid/malformed"
  - "Hand-rolled minimal YAML parser for must_haves sub-schema (no external deps)"
  - "Schema validation with structured error messages matching 'malformed must_haves schema: <field> — <reason>'"
requires: []
affects: [S01]
key_files:
  - scripts/forge-must-haves.js
key_decisions:
  - "Used [ \\t]* instead of \\s* in extractTopLevelValue regex to prevent cross-line matching — \\s matches newlines which caused greedy consumption of next-line content into the captured group"
  - "Implemented extractSubBlock + dedent pattern for nested YAML maps rather than recursive parseYamlValue — cleaner and avoids ambiguity between map and array at same indentation level"
patterns_established:
  - "extractSubBlock(yaml, key) + dedent-2-spaces pattern for parsing YAML nested maps in scripts/forge-must-haves.js"
new_helpers:
  - "hasStructuredMustHaves — scripts/forge-must-haves.js — returns true if plan frontmatter has must_haves: key at YAML root (presence check only)"
  - "parseMustHaves — scripts/forge-must-haves.js — parses must_haves block into {truths, artifacts, key_links, expected_output}; throws structured error on malformed schema"
duration: 45min
verification_result: pass
completed_at: 2026-04-16T14:00:00Z
---

Created `scripts/forge-must-haves.js` — the shared schema detection predicate and parser that S01/T02 (planner), S01/T03 (executor), S03 (verifier), and S04 (plan-checker) will all consume.

## What Happened

- Implemented `hasStructuredMustHaves(content)` — presence-only check using `/^must_haves:\s*(\n|$)/m` on frontmatter.
- Implemented `parseMustHaves(content)` — extracts and validates all required fields (`truths`, `artifacts`, `key_links`, `expected_output`). Throws `Error("malformed must_haves schema: <field> — <reason>")` on invalid shape.
- Implemented CLI dual-mode with `--check <path>` flag, JSON output to stdout, exit 0/0/2 contract.
- Key gotcha: `extractTopLevelValue` initially used `\\s*` (which matches newlines) after the colon. This caused the regex to consume the newline and the next indented line (`  - x.js`) into the capture group, returning `"- x.js"` instead of `null` (the multi-line sentinel). Fix: replaced with `[ \\t]*` (space/tab only) to restrict matching to the current line.
- Adapted frontmatter extraction regex from `scripts/forge-verify.js` line 430 (`/^---\n([\s\S]*?)\n---/`) plus the 1 MB size cap — same idiom, no require() dependency.
- 29/29 unit + CLI smoke tests pass.

## Deviations

None. All steps executed as planned. The `extractSubBlock + dedent` approach for nested YAML maps was chosen over a recursive generic parser — simpler and sufficient for this fixed schema shape.

## Files Created/Modified

- `scripts/forge-must-haves.js` — **created** (370 lines)
- `.gsd/milestones/M003/slices/S01/tasks/T01/T01-PLAN.md` — status updated to DONE

## Verification

- Gate: skipped (no-stack)
- Discovery source: none
- Commands:
  - `node --check scripts/forge-must-haves.js` (exit 0)
  - `node scripts/forge-verify.js --plan T01-PLAN.md --cwd . --unit execute-task/T01` (exit 0, passed:true, skipped:no-stack)
- Smoke: 29/29 assertions passed covering hasStructuredMustHaves, parseMustHaves, CLI exit codes
