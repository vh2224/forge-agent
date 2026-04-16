---
id: T04
parent: S03
milestone: M002
provides: [Token usage block in forge-status skill]
requires: [T01, T02]
affects: [S03]
key_files: [skills/forge-status/SKILL.md]
key_decisions: ["Path A chosen: aggregation inline as node -e block — 24 lines, within the 25-line limit"]
duration: 15min
verification_result: pass
completed_at: 2026-04-16T00:00:00Z
---

Added `### Token usage` subsection to `skills/forge-status/SKILL.md` immediately before `### Blockers`, with a bash/node -e aggregation block that reads `.gsd/forge/events.jsonl` and renders a pt-BR token summary for the active milestone.

## What Happened

- Inserted `### Token usage (M###)` placeholder into the dashboard template (before `### Blockers`).
- Added `## Token usage — geração do bloco` section with a bash wrapper and `node -e` inline aggregator (Path A, 24 lines — within the 25-line limit).
- Aggregation strategy: find first dispatch event naming `M###` directly → use its timestamp as milestone start → sum all dispatch events from that point onward.
- Three graceful-degradation branches: missing file, no matching events, malformed lines (silently skipped).
- No active milestone → block omitted entirely.

## Verification

```
grep "### Token usage" skills/forge-status/SKILL.md  → 4 hits (template placeholder + code prose)
grep "Sem dados de telemetria ainda" → 5 hits (all branches covered)
grep "por fase:" → 1 hit
node scripts/forge-tokens.js --file skills/forge-status/SKILL.md → {"tokens":1393} (< 2500 budget)
node -c scripts/forge-tokens.js → syntax OK
```

## Smoke Test (3 fabricated dispatch events)

Input events:
```
{"ts":"2026-04-16T10:00:00Z","event":"dispatch","unit":"plan-milestone/M002","input_tokens":1200,"output_tokens":400}
{"ts":"2026-04-16T10:05:00Z","event":"dispatch","unit":"execute-task/T01","input_tokens":3200,"output_tokens":800}
{"ts":"2026-04-16T10:10:00Z","event":"dispatch","unit":"execute-task/T02","input_tokens":2400,"output_tokens":600}
```

Output:
```
### Token usage (M002)
- Total input:  6 800 tokens
- Total output: 1 800 tokens
- Dispatches:   3 (por fase: plan-milestone 1 · execute-task 2)
```

## Path Justification

Path A (inline `node -e`): chosen. Body = 24 lines, within the 25-line threshold from MEM042. No new CLI surface needed; `forge-tokens.js` remains single-purpose (T01 frozen).

## Files Created/Modified

- `skills/forge-status/SKILL.md` — modified. Before: 80 lines. After: 155 lines (+75 lines).
- `.gsd/milestones/M002/slices/S03/tasks/T04/T04-SUMMARY.md` — new.

## Deviations

None.
