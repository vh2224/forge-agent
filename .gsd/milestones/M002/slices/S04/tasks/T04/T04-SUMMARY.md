---
id: T04
parent: S04
milestone: M002
provides:
  - "Tier Resolution block inserted at line 103 of skills/forge-next/SKILL.md (step 1.5)"
  - "model lookup replaced with MODEL_ID from tier system"
  - "dispatch event echo extended with tier + reason fields"
  - "MEM015 selective memory injection block preserved at line 166"
requires: [T02, T03]
affects: [S04]
key_files:
  - skills/forge-next/SKILL.md
key_decisions:
  - "Tier resolution inserted after effort resolution (line ~101) and before risk/security gates — same semantic position as forge-auto but derived independently per MEM015"
  - "Memory injection block confirmed at line 166 post-edit — byte-identical, not relocated"
duration: 10min
verification_result: pass
completed_at: 2026-04-16T00:00:00Z
---

Wired Tier Resolution into `skills/forge-next/SKILL.md` independently from forge-auto, preserving MEM015's selective memory injection block intact at line 166.

## What Happened

- Read forge-next SKILL.md in full to identify the actual layout (step-mode, not a loop).
- Inserted the tier resolution block (same 5-step algorithm as T02/T03) after effort resolution, before risk/security gates — line 103 in the final file.
- Replaced `Resolve the model ID for this unit from PREFS` with a directive to use `$MODEL_ID` from tier resolution (`model = PREFS.tier_models[tier]`).
- Extended the dispatch event echo line (now line 232) with `"tier":"${TIER}","reason":"${REASON}"` in the canonical ordering: ts, event, unit, model, tier, reason, input_tokens, output_tokens.
- MEM015 verification: selective memory injection block (`**Selective memory injection**`) is at line 166 post-edit — untouched and not relocated.

## MEM015 Preservation Verification

- Pre-edit memory injection block: lines ~125-130 (original file)
- Post-edit memory injection block: **line 166** (after 41-line tier resolution insertion above it)
- Content: byte-identical — no changes to the block itself, only line numbers shifted

## Deviations

None. Every edit derived independently from forge-next's actual structure per MEM015 constraint.

## Files Created/Modified

- `skills/forge-next/SKILL.md` — modified (+43 lines: tier resolution block ~40 lines, model lookup replacement 1 line, echo line extension 1 line, 1 blank)
