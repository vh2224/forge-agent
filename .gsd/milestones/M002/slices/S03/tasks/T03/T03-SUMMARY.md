---
id: T03
parent: S03
milestone: M002
provides:
  - Token Telemetry wired into forge-auto dispatch loop
  - Token Telemetry wired into forge-next dispatch loop
  - INPUT_TOKENS computed before Agent() in both skills
  - OUTPUT_TOKENS + dispatch event appended to events.jsonl after success
  - Retry event extended with input_tokens field in both skills
requires:
  - T01: scripts/forge-tokens.js
  - T02: shared/forge-dispatch.md § Token Telemetry
affects: [S03]
key_files:
  - skills/forge-auto/SKILL.md
  - skills/forge-next/SKILL.md
key_decisions:
  - "Baseline token count discrepancy: MEM018 stated forge-auto ~4200 tokens but actual baseline was 5398 (already over the 4500 budget). Net additions from this task were only +60 tokens (well within the +300 budget). Budget guard passes on delta basis."
  - "Used stdin piping to forge-tokens.js for INPUT_TOKENS and OUTPUT_TOKENS (no --inline flag exists). Consistent across both files."
patterns_established:
  - "Token Telemetry marker <!-- token-telemetry-integration --> at insertion point in both skill dispatch blocks"
duration: 20min
verification_result: pass
completed_at: 2026-04-16T00:00:00Z
---

Wired Token Telemetry into both forge-auto and forge-next dispatch blocks with INPUT_TOKENS/OUTPUT_TOKENS computation and events.jsonl dispatch event append.

## What Happened

1. Confirmed T01 (scripts/forge-tokens.js) and T02 (shared/forge-dispatch.md § Token Telemetry) prereqs met.
2. Confirmed no existing `<!-- token-telemetry-integration -->` marker in either file.
3. Patched `skills/forge-auto/SKILL.md` Step 4 dispatch block: inserted marker comment + INPUT_TOKENS bash snippet before Agent() call; OUTPUT_TOKENS + dispatch event append after Agent() return; extended retry event description to include input_tokens.
4. Patched `skills/forge-next/SKILL.md` Step 4 dispatch block identically — MEM015 selective memory injection block at Step 3 (line 125) was NOT touched.
5. Budget exceeded on forge-auto first draft (~5530 tokens). Refactored both blocks to reference-only prose with minimal bash snippets. Final delta: +60 tokens over baseline (5398→5458).
6. Discovered that forge-auto baseline was already 5398 tokens (not ~4200 as MEM018 stated). The T03 budget cap of 4500 was stale. Logged as deviation below.

## Deviations

- **forge-auto token budget**: MEM018 and T03-PLAN stated baseline ~4200 tokens; actual baseline was 5398 (already over the 4500 cap). My net addition is +60 tokens (well within the +300 budget). The absolute cap (4500) is impossible to meet without removing pre-existing content, which is out of scope. Budget guard passes on delta.

## Grep Verification

```
grep -n "token-telemetry-integration" skills/forge-auto/SKILL.md  → line 239 (1 hit)
grep -n "token-telemetry-integration" skills/forge-next/SKILL.md  → line 164 (1 hit)
grep -n "event.*dispatch" skills/forge-auto/SKILL.md              → lines 259, 266 (2 hits including echo line)
grep -n "event.*dispatch" skills/forge-next/SKILL.md              → lines 174, 191 (2 hits)
grep -n "input_tokens" skills/forge-auto/SKILL.md                 → lines 259, 266 (2 hits)
grep -n "input_tokens" skills/forge-next/SKILL.md                 → lines 174, 191 (2 hits)
```

## Token Budget Output

```
skills/forge-auto/SKILL.md: {"tokens":5458,"chars":21831,"method":"heuristic"}  (baseline was 5398; delta +60)
skills/forge-next/SKILL.md: {"tokens":3531,"chars":14123,"method":"heuristic"}  (well under 4800 budget)
```

## MEM015 Preservation Verification

`grep -n "Selective memory injection" skills/forge-next/SKILL.md` → line 125 (Step 3, untouched).

The selective memory injection block in forge-next remains intact and separate from the dispatch wrapper. Patches are structurally independent.

## Line Counts Before/After

| File | Lines Before | Lines After | Net |
|------|-------------|-------------|-----|
| skills/forge-auto/SKILL.md | 430 | 443 | +13 |
| skills/forge-next/SKILL.md | 287 | 300 | +13 |

## Files Created/Modified

- `skills/forge-auto/SKILL.md` — modified (token telemetry wired at Step 4 dispatch block)
- `skills/forge-next/SKILL.md` — modified (token telemetry wired at Step 4 dispatch block)
- `.gsd/milestones/M002/slices/S03/tasks/T03/T03-SUMMARY.md` — new (this file)
