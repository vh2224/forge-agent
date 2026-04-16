---
id: T03
parent: S04
milestone: M002
provides: [tier-resolution wired into forge-auto dispatch loop, frontmatter tier/tag parsing, extended dispatch event with tier+reason]
requires: [T01-forge-tiers.md, T02-Tier-Resolution-contract]
affects: [S04]
key_files: [skills/forge-auto/SKILL.md]
key_decisions: ["Tier Resolution inserted as step 1.5 between Resolve effort and Risk radar gate", "dispatch event extended with tier+reason fields placed between model and input_tokens", "old Phase-routing table reference replaced with $MODEL_ID from tier resolution"]
duration: 10min
verification_result: pass
completed_at: 2026-04-16T00:00:00Z
---

Wired Tier Resolution into `skills/forge-auto/SKILL.md`: inserts step 1.5 that resolves `{tier, model, reason}` before every dispatch using unit-type defaults, frontmatter overrides, and PREFS fallbacks; extends the dispatch event echo line with `tier` and `reason` fields.

## What Happened

1. Inserted `**Tier resolution (step 1.5)**` block (lines 155–194 in final file) between "Resolve effort for this unit" and "Risk radar gate". The block implements the 5-step algorithm from `shared/forge-dispatch.md § Tier Resolution`:
   - Declare `TIER_DEFAULTS` map covering all 10 unit types
   - For `execute-task`: run two `node -e` one-liners to extract `tier:` and `tag:` from T##-PLAN frontmatter (YAML regex idiom from Asset Map)
   - Apply precedence: frontmatter-override → frontmatter-tag:docs → unit-type default
   - Resolve MODEL_ID via `node -e` reading `.gsd/prefs-resolved.json` with tier-defaults fallback; unknown tiers treated as `standard`

2. Replaced `"Resolve the model ID for this unit from PREFS"` (Step 4 header) with explicit prohibition of Phase-routing table and reference to `$MODEL_ID` from step 1.5.

3. Extended the dispatch event echo (formerly `${modelId}`) to use `${MODEL_ID}` and appended `"tier":"${TIER}","reason":"${REASON}"` between `model` and `input_tokens` fields, matching the ordered schema in T03-PLAN must-have.

## JSON smoke-test

```
echo '{"ts":"2026-04-16T10:00:00Z","event":"dispatch","unit":"execute-task/T03","model":"claude-sonnet-4-6","tier":"standard","reason":"unit-type:execute-task","input_tokens":2000,"output_tokens":300}' | node -e "JSON.parse(require('fs').readFileSync(0,'utf8'));console.log('valid JSON')"
# → valid JSON
```

## Token budget

```
node scripts/forge-tokens.js --file skills/forge-auto/SKILL.md
# → {"tokens":6169,"chars":24675,"method":"heuristic"}
```

Well within the skill token budget.

## Deviations

None. Patch does not touch forge-next (T04 handles that). ISOLATION RULE, AUTONOMY RULE, COMPACTION RESILIENCE, and compact recovery check blocks are unchanged.

## Files Created/Modified

- `skills/forge-auto/SKILL.md` — modified (~+40 lines: Tier Resolution block + Step 4 update + echo line extension)
- `.gsd/milestones/M002/slices/S04/tasks/T03/T03-PLAN.md` — status: DONE
- `.gsd/milestones/M002/slices/S04/tasks/T03/T03-SUMMARY.md` — created
