---
id: T02
parent: S01
milestone: M003
provides:
  - "agents/forge-planner.md updated with structured must_haves schema section"
  - "Per-task template annotated: YAML frontmatter is authoritative"
  - "Schema shape documented inline — unconditional emit requirement stated explicitly"
requires: []
affects: [S01]
key_files:
  - agents/forge-planner.md
key_decisions:
  - "Schema shape embedded verbatim in planner instructions so every future T##-PLAN matches parseMustHaves contract"
duration: 5min
verification_result: pass
completed_at: 2026-04-16T00:00:00Z
---

Surgical edit to `agents/forge-planner.md`: added `## Must-Haves Schema (required on every T##-PLAN)` section with the locked YAML schema shape and unconditional emit contract, plus annotation in the per-task template that YAML frontmatter is authoritative.

## What Happened

- Identified insertion point: after the per-task markdown template block (the `## Context` subsection), before `Then return the ---GSD-WORKER-RESULT--- block.`
- Added the annotation note directly after the template closing fence.
- Added new `## Must-Haves Schema` section with fenced YAML example matching the shape consumed by `scripts/forge-must-haves.js` (`parseMustHaves`).
- Added prose contract explaining required vs optional fields and the unconditional rule.
- Frontmatter lines 1-8 preserved bit-for-bit.
- `grep` confirmed both `must_haves:` and `expected_output:` tokens present.

## Deviations

None.

## Files Created/Modified

- `agents/forge-planner.md` — added schema section + annotation (was 84 lines, now ~120 lines)

## Verification

- Gate: skipped (no-stack)
- Discovery source: none
- Commands: `node scripts/forge-verify.js --plan ... --unit execute-task/T02` (exit 0)
- Total duration: ~500ms
