---
id: T02
parent: S02
milestone: M001
provides: [forge-auto Step 3 rewritten to use template paths instead of inlining artifacts]
requires: [T01]
affects: [S02]
key_files: [commands/forge-auto.md]
key_decisions: ["Lean orchestrator: Step 3 now substitutes placeholders only; workers read their own artifacts via Read tool"]
duration: 5min
verification_result: pass
completed_at: 2026-04-15T00:00:00Z
---

Step 3 of forge-auto.md rewritten: removed the "Read ONLY artifact files, inline their content" instruction and replaced it with explicit placeholder substitution list. Workers now read their own context via Read tool; orchestrator no longer inlines KB of artifacts.

## What Happened

- Located the single-line artifact read instruction at line 176 of `commands/forge-auto.md`
- Replaced it with the new Step 3 block listing all placeholders (`{WORKING_DIR}`, `{M###}`, `{S##}`, `{T##}`, `{unit_effort}`, `{THINKING_OPUS}`, `{TOP_MEMORIES}`, `{CS_LINT}`, `{CS_STRUCTURE}`, `{CS_RULES}`, `{auto_commit}`, `{milestone_cleanup}`, `{CODING_STANDARDS}`)
- Verified "Worker Prompt Templates" section at line 387 still references `~/.claude/forge-dispatch.md`
- Step 4 "Selective memory injection" block untouched

## Deviations

None.

## Files Created/Modified

- `commands/forge-auto.md` — Step 3 section rewritten (1 line → 14 lines)
