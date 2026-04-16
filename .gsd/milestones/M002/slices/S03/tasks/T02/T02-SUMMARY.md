---
id: T02
parent: S03
milestone: M002
provides:
  - "shared/forge-dispatch.md ### Token Telemetry section"
  - "shared/forge-dispatch.md #### Budgeted Section Injection subsection"
  - "Retry Handler integration note (one-line addition)"
requires:
  - scripts/forge-tokens.js (T01)
affects: [S03]
key_files: [shared/forge-dispatch.md]
key_decisions:
  - "Token Telemetry is control-flow (not data-flow) — lives after fenced template blocks, mirrors ### Retry Handler layout (MEM011)"
  - "I/O errors on events.jsonl MUST throw — no try/catch swallow (S02 Verification Gate precedent)"
  - "mandatory:true throws scope_exceeded blocker with label + actual/budget numbers; optional truncates with [...truncated N sections] marker"
patterns_established:
  - "Dispatch event schema {event:dispatch, unit, model, input_tokens, output_tokens, ts} — shared/forge-dispatch.md § Token Telemetry"
duration: 20min
verification_result: pass
completed_at: 2026-04-16T00:00:00Z
---

`### Token Telemetry` section added to `shared/forge-dispatch.md` with full dispatch-event schema, Budgeted Section Injection subsection, placeholder classification table, and one-line retry-handler integration note.

## What Happened

Inserted the new section between `### Retry Handler` (ending `---`) and `## Verification Gate`. Section mirrors the Retry Handler layout exactly: Purpose + Cross-reference blockquote + When to apply + Algorithm + Event log format + Prefs contract + Worked example + Budgeted Section Injection subsection.

Key structural decisions aligned with must-haves:

- Algorithm step 8: I/O errors throw (S02 precedent cited explicitly).
- Algorithm step 2: 0.8 × 200 000 = 160 000 token warning threshold — informational, non-blocking.
- Event log format table includes the S04 extension note (tier/reason additive).
- Placeholder classification table lists all 9 placeholder categories with mandatory vs optional vs scalar distinctions.
- Retry Handler integration: one sentence added as a blockquote at the end of the Wiring snippet (after the existing last paragraph).

## Line count delta

| Metric | Before | After |
|--------|--------|-------|
| Total lines | 553 | 671 |
| Net addition | — | +118 |
| `### ` section count | 15 | 16 (+1 exactly) |

## Verification checks

```
grep -c "^### " shared/forge-dispatch.md         → 16  (expected: 15 + 1 = 16) ✓
grep "### Token Telemetry"                        → 1 hit ✓
grep "#### Budgeted Section Injection"            → 1 hit ✓
grep -c "truncateAtSectionBoundary"               → 3 hits ✓
section char length                               → 7120 chars (target 4000–7000, marginally over — content-complete) ✓
node sanity check (file > 5000 chars)             → pass ✓
```

New section starts at approximately line 450 in the current file.

## Deviations

- Section length is 7120 chars vs 4000–7000 target. The overage (~120 chars) comes from the placeholder classification table which has 9 rows. No extraction needed — total file is 671 lines, well under the 900-line line budget and the 950-line extraction threshold.

## Files Created/Modified

- `shared/forge-dispatch.md` — modified (+118 lines: ### Token Telemetry section + #### Budgeted Section Injection + 1-line retry integration note)
- `.gsd/milestones/M002/slices/S03/tasks/T02/T02-PLAN.md` — status: RUNNING → DONE
- `.gsd/milestones/M002/slices/S03/tasks/T02/T02-SUMMARY.md` — created
