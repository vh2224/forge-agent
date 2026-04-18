---
id: T04
parent: S04
milestone: M001
provides:
  - Five v1.0 architecture decision blocks appended to CLAUDE.md
  - PostCompact hook + compact-signal.json recovery decision documented
  - Lean orchestrator (workers read own artifacts) decision documented
  - /forge REPL shell as unified entry point decision documented
  - Skill migration with command shims + compact-safe token budget documented
requires: []
affects: [S04]
key_files:
  - CLAUDE.md
key_decisions:
  - "Five new ### blocks appended at end of Decisões de arquitetura recentes section, before ## Convenções de código"
duration: 5min
verification_result: pass
completed_at: 2026-04-15T00:00:00Z
---

Five v1.0 architecture decisions appended to `CLAUDE.md`'s "Decisões de arquitetura recentes" section covering the three pillars of M001: PostCompact recovery, lean orchestrator, and /forge REPL.

## What Happened

1. Read T04-PLAN.md and S04-RESEARCH.md to understand requirements and insertion point.
2. Read M001-CONTEXT.md `## Decisions` section for canonical decision content.
3. Located insertion point in CLAUDE.md: after "MCP management integrado ao Forge" block (line 311), before `## Convenções de código` (line 312).
4. Appended 5 decision blocks following the existing `### Title` + paragraph format, matching style of surrounding entries.
5. Verified all 5 headings present at lines 312, 315, 318, 321, 324.

## Deviations

None. All 5 decisions match the canonical list from M001-CONTEXT.md. No existing content was modified.

## Files Created/Modified

- `CLAUDE.md` — appended ~50 lines (5 architecture decision blocks) to the "Decisões de arquitetura recentes" section
