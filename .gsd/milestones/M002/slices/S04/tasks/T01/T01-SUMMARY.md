---
id: T01
parent: S04
milestone: M002
provides: [shared/forge-tiers.md — canonical tier-to-model reference doc]
requires: []
affects: [S04]
key_files: [shared/forge-tiers.md]
key_decisions: ["Unit type → tier mapping follows GSD-2 pattern: plan-* = heavy, execute-task/research-*/discuss-* = standard, memory-extract/complete-* = light"]
duration: 5min
verification_result: pass
completed_at: 2026-04-16T00:00:00Z
---

Created `shared/forge-tiers.md` as the canonical tier-to-model reference consumed by Tier Resolution logic in forge-dispatch.md and forge-agent-prefs.md.

## What Happened

- Read `forge-agent-prefs.md` to confirm three canonical model IDs and aliases (haiku/sonnet/opus).
- Created `shared/forge-tiers.md` with four sections in required order: Unit Type → Default Tier, Tier → Default Model, Frontmatter Overrides, Override Precedence, plus Cross-references.
- All 10 unit types present in the dispatch table are mapped with exactly one tier.
- Override precedence is a 3-item numbered list, highest-precedence first: `tier:` frontmatter > `tag: docs` downgrade > unit_type default.

## Deviations

None. File follows the exact structure specified in the must-haves.

## Files Created/Modified

- `shared/forge-tiers.md` — new, ~80 lines, no frontmatter, plain Markdown
