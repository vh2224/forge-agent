---
id: T04
parent: S01
milestone: M003
provides:
  - "forge-agent-prefs.md gains `## Evidence Settings` section with `evidence.mode: lenient` default"
  - "Documents lenient/strict/disabled semantics for future S02 consumer"
  - "Section placed between Verification Settings and Token Budget Settings"
requires: []
affects: [S01]
key_files:
  - forge-agent-prefs.md
key_decisions:
  - "evidence.mode default is lenient — scaffolded inert, S02 wires consumption"
duration: 5min
verification_result: pass
completed_at: 2026-04-16T00:00:00Z
---

Pure additive insert of `## Evidence Settings` section into `forge-agent-prefs.md` — no code changes, no other sections touched.

## What Happened

Read the existing file to confirm section order (Verification Settings → Token Budget Settings), then inserted the new `## Evidence Settings` block between them. Section includes the `evidence:` config block with `mode: lenient` default, a Semântica subsection documenting all three modes in pt-BR, and Cross-references pointing to the S02 consumers. Verified all grep must-haves pass and fence count is even (30 fences balanced).

## Deviations

None.

## Files Created/Modified

- `forge-agent-prefs.md` — added `## Evidence Settings` section (~30 lines), total 319 lines (up from ~295).

## Verification

- Gate: skipped (no-stack)
- Discovery source: none
- Commands: none (docs-only repo, no stack detected)
- Total duration: ~200ms
