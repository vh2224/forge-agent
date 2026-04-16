---
id: T02
parent: S04
milestone: M002
provides:
  - "### Tier Resolution control-flow section in shared/forge-dispatch.md"
  - "5-step algorithm: unit-type default → frontmatter parse → precedence → model resolve → reason string"
  - "Frontmatter override table (tier: and tag: docs)"
  - "Dispatch event schema extended additively with tier + reason fields"
  - "3 worked examples + bash wiring snippet"
requires:
  - shared/forge-tiers.md (T01)
affects: [S04, M002]
key_files:
  - shared/forge-dispatch.md
key_decisions:
  - "Tier resolution placed after Token Telemetry separator, before ## Verification Gate (lines 568–749)"
  - "No new Node script — pure Markdown rules + node -e one-liners per M002-CONTEXT D7 Hybrid C"
  - "Dispatch event extended additively; S03 readers ignoring unknown fields remain compatible"
patterns_established:
  - "Dispatch control-flow section pattern (8-subsection skeleton) instantiated at ### Tier Resolution"
duration: 15min
verification_result: pass
completed_at: 2026-04-16T00:00:00Z
---

Added `### Tier Resolution` control-flow section to `shared/forge-dispatch.md` (248 lines, file now at 854 lines — under 900 budget), fulfilling the S04 extension note planted in Token Telemetry (line 497).

## What Happened

- Inserted the section between the Token Telemetry `---` separator (line 566) and `## Verification Gate` (now line 751).
- Section follows the 8-subsection Dispatch control-flow pattern: Purpose → Cross-reference pull-quote → When to apply → Algorithm (5 steps) → Prefs contract → Frontmatter override table → Event log extension → Worked examples (3) → Wiring snippet.
- Algorithm step 2 uses `node -e` one-liners to extract `tier:` and `tag:` from T##-PLAN frontmatter — no new Node script (per D7 Hybrid C).
- Override precedence locked to match `shared/forge-tiers.md`: `tier:` > `tag:docs` > unit-type default.
- Dispatch event extended with `tier` and `reason` fields additively; compatibility paragraph included.
- Three worked examples: memory-extract (light/haiku), execute-task with tier:heavy+tag:docs (heavy/opus, manual wins), execute-task with only tag:docs (light/haiku, downgrade applied).
- Wiring snippet is a self-contained bash block ready for T03/T04 to copy-paste-adapt.

## Deviations

None. All must-haves satisfied exactly as specified.

## Files Created/Modified

- `shared/forge-dispatch.md` — modified (+248 lines, new `### Tier Resolution` section at line 568)
- `.gsd/milestones/M002/slices/S04/tasks/T02/T02-PLAN.md` — status updated to DONE
