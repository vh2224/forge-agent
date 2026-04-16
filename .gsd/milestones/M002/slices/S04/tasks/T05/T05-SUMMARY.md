---
id: T05
parent: S04
milestone: M002
provides:
  - "## Tier Settings section in forge-agent-prefs.md with tier_models: block"
  - "5 smoke demo transcripts in .gsd/milestones/M002/slices/S04/smokes/T05-DEMOS.md"
  - "5 dispatch events appended to .gsd/forge/events.jsonl (stubbed, all JSON-valid)"
  - "## Notes section updated to reference tier_models: instead of Phase → Agent Routing table"
requires: [T01, T02, T03, T04]
affects: [S04]
key_files:
  - forge-agent-prefs.md
  - .gsd/milestones/M002/slices/S04/smokes/T05-DEMOS.md
  - .gsd/forge/events.jsonl
key_decisions:
  - "Tier Settings section placed between Retry Settings and Verification Settings (lines 142-211)"
  - "Phase → Agent Routing table retained for informational continuity; deprecated for model-selection"
  - "Demo 5 reason remains unit-type:memory-extract — prefs override changes model within tier, not tier itself"
duration: 15min
verification_result: pass
completed_at: 2026-04-16T21:38:30Z
---

Added `## Tier Settings` section to `forge-agent-prefs.md` with `tier_models:` block and prose documentation, then ran 5 smoke demos proving tier resolution produces correct tier/model/reason combinations.

## What Happened

1. Read `forge-agent-prefs.md` to find insertion point: after `## Retry Settings` (line 118), before `## Verification Settings`.
2. Read `shared/forge-tiers.md` and copied canonical model IDs verbatim to avoid drift.
3. Inserted `## Tier Settings` (71 lines) containing: fenced `tier_models:` block with 3 keys, override precedence chain documentation, per-task frontmatter example, deprecation note on Phase → Agent Routing table, and cross-references to `shared/forge-tiers.md` and `shared/forge-dispatch.md § Tier Resolution`.
4. Updated `## Notes` to reference `tier_models:` as source of truth (not the routing table column).
5. Ran 5 smoke demos via Node.js script implementing the tier-resolution algorithm from `shared/forge-dispatch.md`. All 5 appended valid JSON lines to `events.jsonl`.

### Smoke Demo Results

| Demo | Unit | Override | Tier | Model | Reason | Result |
|------|------|----------|------|-------|--------|--------|
| 1 | memory-extract | none | light | claude-haiku-4-5-20251001 | unit-type:memory-extract | PASS |
| 2 | plan-slice | none | heavy | claude-opus-4-7[1m] | unit-type:plan-slice | PASS |
| 3 | execute-task | tag:docs | light | claude-haiku-4-5-20251001 | frontmatter-tag:docs | PASS |
| 4 | execute-task | tag:docs + tier:heavy | heavy | claude-opus-4-7[1m] | frontmatter-override:heavy | PASS |
| 5 | memory-extract | prefs light→sonnet | light | claude-sonnet-4-6 | unit-type:memory-extract | PASS |

Note on Demo 5: `reason` stays `unit-type:memory-extract` — the prefs override changes which model the `light` tier resolves to, not the tier itself. This matches the spec: `reason` reflects *how tier was picked*, not *how model was picked within tier*.

Demos are stubbed (Agent() not invoked) per T05-PLAN.md § Context explicit allowance. All 5 events.jsonl lines verified valid JSON via `node -e "JSON.parse(...)"`.

## Deviations

None. Section placement matches T05-PLAN.md must-have (after Retry, before Verification). Prose length is 71 lines total for the section (including blank lines and fenced blocks), well within the ≤40 prose lines constraint (prose-only lines are approximately 25).

## Files Created/Modified

- `forge-agent-prefs.md` — added `## Tier Settings` section (+70 lines), updated `## Notes` (1 line)
- `.gsd/milestones/M002/slices/S04/smokes/T05-DEMOS.md` — created (5 demo transcripts)
- `.gsd/forge/events.jsonl` — appended 5 smoke dispatch events
- `.gsd/milestones/M002/slices/S04/tasks/T05/T05-PLAN.md` — status: DONE
