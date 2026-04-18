---
id: T02
parent: S04
milestone: M001
provides: [README.md updated for v1.0 — /forge as primary entry point, commands table updated, skills table updated]
requires: []
affects: [S04]
key_files: [README.md]
key_decisions: ["/forge added as first row in commands table; /forge-auto and /forge-new-milestone noted as aliases that delegate to /forge"]
duration: 5min
verification_result: pass
completed_at: 2026-04-15T00:00:00Z
---

README.md updated: `/forge` set as primary Quick start command with explanatory note, added as first row in commands table with alias notes for `/forge-auto` and `/forge-new-milestone`, and `forge-security` added to skills table.

## What Happened

1. Replaced `/forge-auto` with `/forge` in the Quick start code block and added a one-line explanation of what the REPL shell does.
2. Added `/forge` as the first row in the commands table ("Shell interativo — entry point principal"); annotated `/forge-new-milestone` and `/forge-auto` as aliases that delegate to `/forge`.
3. Added `forge-security` row to the skills table ("Análise de segurança por task/slice") between `forge-risk-radar` and `forge-responsive`.
4. Verified all existing links (docs/architecture.md, docs/commands.md, docs/skills.md, docs/configuration.md) are unchanged and no formatting was broken.

## Deviations

None.

## Files Created/Modified

- `README.md` — modified (Quick start, commands table, skills table)
