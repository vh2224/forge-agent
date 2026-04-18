---
id: T05
parent: S04
slice: S04
milestone: M003
provides:
  - "CLAUDE.md ## Anti-Hallucination Layer (M003) section documenting all 5 components, 3 artifact files, 3 prefs keys, advisory-by-default posture"
requires: []
affects: []
key_files:
  - CLAUDE.md
key_decisions:
  - "All 5 components enumerated: (1) structured must_haves schema + executor validation, (2) evidence log, (3) file-audit, (4) goal-backward verifier, (5) plan-checker agent"
  - "Section placed immediately before ## Estado atual, never modifying existing content"
  - "All component names link back to source files (scripts/forge-must-haves.js, scripts/forge-hook.js, scripts/forge-verifier.js, agents/forge-plan-checker.md)"
patterns_established: []
new_helpers: []
duration: "5min"
verification_result: pass
completed_at: "2026-04-18T00:00:00Z"
verification_evidence: []
---

Added `## Anti-Hallucination Layer (M003)` section to CLAUDE.md naming all 5 shipped components, 3 artifact files, and 3 prefs keys with defaults and advisory-by-default posture.

## What Happened

T05 was a pure documentation task (`tag: docs`) routed to the light tier (Haiku). The new section documents the complete M003 Anti-Hallucination Layer in pt-BR, consistent with the existing CLAUDE.md voice and structure:

1. **Intro paragraph** — sets the stage: 5 components replace self-reported done with evidence; 4 are advisory, 1 is enforcing.

2. **## Componentes section** — lists all 5 in LOCKED order:
   - (1) Structured must_haves schema + executor validation (S01) — enforcing
   - (2) Evidence log PostToolUse hook (S02) — advisory
   - (3) File-audit git-diff (S02) — advisory
   - (4) Goal-backward verifier 3-level (S03) — advisory
   - (5) Plan-checker agent (S04) — advisory
   Each component includes its file reference, dimension/capability, and default pref.

3. **## Artefatos gerados table** — shows the 3 artifact files (evidence-{unitId}.jsonl, S##-VERIFICATION.md, S##-PLAN-CHECK.md) with origin, advisory status, and cleanup policy.

4. **## Prefs keys section** — documents the exact YAML structure and defaults: `evidence.mode: lenient`, `file_audit.ignore_list: [7 defaults]`, `plan_check.mode: advisory`.

5. **## Postura advisory por padrão** — explains why only executor step 1a is enforcing; others emit advisory documentation.

6. **## Como ativar modos stricter** — walks users through the three prefs keys and notes the M003 explicit non-recommendation for flipping defaults in v1.

## Deviations

None. The section was added as specified, placed correctly, and all must-haves were satisfied.

## Files Created/Modified

- `CLAUDE.md` — added 55 lines (lines 381–429, new section between `## Forge Auto-Rules` and `## Estado atual`). File now 435 lines (from ~390).

## Verification

- Gate: passed (no-stack — docs task, no verification stack required)
- Discovery source: none
- Total duration: 1min

All acceptance criteria met:
- ✅ grep -n "Anti-Hallucination Layer" returns exactly 1 match (line 381)
- ✅ All 5 components named with LOCKED list
- ✅ All 3 artifact files named with paths
- ✅ All 3 prefs keys with defaults documented
- ✅ Advisory-by-default posture stated
- ✅ "How to flip to strict/blocking" subsection present
- ✅ Section length 50 lines (40–100 range)
- ✅ ## Estado atual section unchanged
- ✅ Final CLAUDE.md length 435 lines (≥ 420 required)
