---
id: T03
parent: S02
milestone: M001
provides: ["forge-next.md Step 3 rewritten — artifact reads removed, placeholder substitutions + memory injection retained"]
requires: ["T01 (lean dispatch templates)"]
affects: [S02]
key_files: ["commands/forge-next.md"]
key_decisions: ["Step 3 in forge-next retains selective memory injection block (lines 123-129); only the artifact-read instruction was removed"]
duration: 5min
verification_result: pass
completed_at: 2026-04-15T00:00:00Z
---

Removed the "Read ONLY the .gsd/ artifact files" instruction from forge-next.md Step 3, replacing it with placeholder substitution directives that mirror forge-auto.md — while preserving the selective memory injection block unique to forge-next.

## What Happened

- Read `commands/forge-next.md` lines 115-145 to locate the exact text to replace
- Replaced single-line artifact-read instruction with the 14-line placeholder substitution block from the plan
- Verified `~/.claude/forge-dispatch.md` still referenced in both Step 3 and "Worker Prompt Templates" section
- Verified "Inline their content" phrase is fully gone from the file

## Deviations

None.

## Files Created/Modified

- `commands/forge-next.md` — Step 3 rewritten: artifact read instruction replaced with placeholder substitution directives
