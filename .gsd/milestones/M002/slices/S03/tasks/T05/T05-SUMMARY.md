---
id: T05
parent: S03
milestone: M002
provides: [token_budget prefs block in forge-agent-prefs.md, plan_max alignment in forge-dispatch.md]
requires: [T01 forge-tokens.js, T02 forge-dispatch Token Telemetry]
affects: [S03]
key_files: [forge-agent-prefs.md, shared/forge-dispatch.md]
key_decisions: ["plan_max removed from dispatch pseudocode — mandatory sections have no prefs key, throw is unconditional"]
duration: 10min
verification_result: pass
completed_at: 2026-04-16T00:00:00Z
---

Added `## Token Budget Settings` section to `forge-agent-prefs.md` with defaults matching T02 exactly, plus a 1-line alignment edit in `shared/forge-dispatch.md` removing the stale `plan_max` prefs key.

## What Happened

- Verified T01 (scripts/forge-tokens.js) and T02 (### Token Telemetry) were live.
- Confirmed `token_budget:` not present in prefs (0 hits).
- Read T02 pseudocode — found `PREFS?.token_budget?.plan_max ?? 8000` which contradicts the spec (mandatory sections have no prefs key). Replaced with hardcoded `8000 * 4` plus explanatory comment.
- Inserted `## Token Budget Settings` between `## Verification Settings` and `## Update Settings` with prose (pt-BR), fenced block, `### Semântica` (3 bullets), `### Observação sobre H2 boundary`, and `### Cross-references`.

## Deviations

- Aligned T02 pseudocode `plan_max` → hardcoded `8000` per plan step 6. This was a 1-line edit as permitted.

## Verification

```
grep -c "^## " forge-agent-prefs.md      → 14 (was 13, +1)
grep "token_budget:" forge-agent-prefs.md → 1 hit
grep "auto_memory:" forge-agent-prefs.md  → 1 hit (in fenced block) + 1 in Semântica bullet
grep "ledger_snapshot:" forge-agent-prefs.md → 1 hit
grep "coding_standards:" forge-agent-prefs.md → 1 hit
grep "^## Token Budget Settings" → 1 hit
grep "scope_exceeded" forge-agent-prefs.md → 1 hit
node readable check → OK
```

## Files Created/Modified

- `forge-agent-prefs.md` — added ~35 lines (new section)
- `shared/forge-dispatch.md` — 1-line alignment edit (plan_max removed)
