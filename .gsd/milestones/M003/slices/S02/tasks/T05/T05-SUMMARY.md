---
id: T05
parent: S02
milestone: M003
provides:
  - "forge-agent-prefs.md ## File Audit Settings section with file_audit.ignore_list default"
requires: []
affects: [S02]
key_files:
  - forge-agent-prefs.md
key_decisions:
  - "file_audit.ignore_list key name LOCKED — T04 completer consumer parses this exact key via regex"
  - "Placement between Evidence Settings and Token Budget Settings for topical grouping of advisory-pipeline prefs"
duration: 5min
verification_result: pass
completed_at: 2026-04-16T00:00:00Z
---

Added `## File Audit Settings` section to `forge-agent-prefs.md` with the `file_audit.ignore_list` default array (7 patterns: lockfiles + dist/build/.next/.gsd).

## What Happened

Inserted the new section between `## Evidence Settings` and `## Token Budget Settings` following the exact style of the Evidence Settings section (pt-BR intro, fenced config block, Semântica subsection, Cross-references subsection). The section documents the ignore list consumed by `forge-completer` sub-step 1.6 (T04) when running the file audit diff on slice close.

## Deviations

None. Pure insertion-only edit as planned.

## Files Created/Modified

- `forge-agent-prefs.md` — added `## File Audit Settings` section (~38 lines); file grew from 319 to 348 lines. All other sections preserved bit-for-bit.

## Verification

- Gate: skipped (no-stack)
- Discovery source: none
- Commands: none (docs-only task, no stack detected)
- Total duration: ~200ms
- Manual checks all passed:
  - `grep -c "^## File Audit Settings"` == 1
  - `grep -c "^file_audit:"` == 1
  - `grep -c "ignore_list:"` == 1
  - `grep -c "^## Evidence Settings"` == 1
  - `grep -c "^## Token Budget Settings"` == 1
  - `wc -l forge-agent-prefs.md` == 348 (> 330 min)
  - Balanced fences: EVEN:32
