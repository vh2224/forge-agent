---
id: T03
parent: S01
milestone: M001
provides: [compact-signal detection in dispatch loop, orchestrator state re-init after compaction]
requires: [T01 — compact-signal.json written by PostCompact hook]
affects: [S01]
key_files: [commands/forge-auto.md]
key_decisions: ["Compact recovery check is procedural (disk-based signal), complementary to the existing behavioral COMPACTION RESILIENCE rule (undefined variable detection)"]
duration: 5min
verification_result: pass
completed_at: 2026-04-15T00:00:00Z
---

Added compact-signal detection as the first step of the dispatch loop in forge-auto.md, enabling automatic orchestrator re-initialization after a compaction event.

## What Happened

Inserted a "Compact recovery check" subsection at the very beginning of "#### 1. Derive next unit" in `commands/forge-auto.md`. The check reads `.gsd/forge/compact-signal.json` via Bash; if the file exists, it re-reads all context files (STATE.md, 3 pref layers, AUTO-MEMORY.md, CODING-STANDARDS.md), re-derives EFFORT_MAP/THINKING_OPUS, resets session_units, deletes the signal file, and emits the recovery message before continuing the loop normally. The existing COMPACTION RESILIENCE behavioral rule remains intact as a fallback for older Claude Code versions where the PostCompact hook does not fire.

## Deviations

None.

## Files Created/Modified

- `commands/forge-auto.md` — inserted ~18 lines "Compact recovery check" block at start of "#### 1. Derive next unit"
- `.gsd/milestones/M001/slices/S01/tasks/T03/T03-SUMMARY.md` — created (this file)
