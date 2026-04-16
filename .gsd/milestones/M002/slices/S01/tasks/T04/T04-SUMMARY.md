---
id: T04
parent: S01
milestone: M002
provides:
  - Retry Handler wired into skills/forge-auto/SKILL.md Step 4 Dispatch
  - Retry Handler wired into skills/forge-next/SKILL.md Step 4 Dispatch
  - MEM015 selective memory injection block preserved in forge-next
  - CRITICAL path clarified: only reached after retry exhaustion or retry:false
  - Both files reference shared/forge-dispatch.md ### Retry Handler (no duplication)
requires: [T02, T03]
affects: [S01]
key_files:
  - skills/forge-auto/SKILL.md
  - skills/forge-next/SKILL.md
key_decisions:
  - "forge-next file is at skills/forge-next/SKILL.md (commands/forge-next.md does not exist)"
  - "Patch adds a guarded-dispatch block BEFORE the Agent() call cite; existing CRITICAL block updated with clarification line"
duration: 10min
verification_result: pass
completed_at: 2026-04-16T00:00:00Z
---

Wired the Retry Handler (T03) into both dispatch-loop skill files; CRITICAL path now requires retry exhaustion or permanent classification before bailing.

## What Happened

- `commands/forge-next.md` does not exist. The step-mode dispatch lives at `skills/forge-next/SKILL.md`.
- Patched `skills/forge-auto/SKILL.md`: inserted "Guarded dispatch" block (~13 lines) immediately before the existing CRITICAL block. The CRITICAL block headline was updated to `(permanent / retries exhausted)` and a clarification line was added: "Transient errors … are handled by the Retry Handler before this block is reached."
- Patched `skills/forge-next/SKILL.md`: same guarded-dispatch block inserted before the `Agent()` call. MEM015 selective memory injection block (lines ~125-129) was untouched — verified via grep.
- Both patches reference `shared/forge-dispatch.md ### Retry Handler` by name only; the algorithm body is NOT duplicated (delta: ~13 lines added each file, well under the 20-line budget).
- Smoke checks pass: `node -c scripts/forge-classify-error.js` → OK; `bash -n install.sh` → OK.
- Security checklist verified: `--msg "$errorMsg"` double-quoted in example invocations; errorMsg not included in events.jsonl schema references.

## Deviations

None. `commands/forge-next.md` absence was handled as documented in must-haves (graceful skip).

## Security Flags

None. All three reviewer checklist items confirmed:
- Retry block references `shared/forge-dispatch.md` (no inline duplication).
- Example uses `--msg "$errorMsg"` (double-quoted).
- MEM015 divergence preserved: forge-next retains selective memory injection block; forge-auto does not.

## Files Created/Modified

- `skills/forge-auto/SKILL.md` — modified (~13 lines added, CRITICAL block updated)
- `skills/forge-next/SKILL.md` — modified (~13 lines added before Agent() call)
- `.gsd/milestones/M002/slices/S01/tasks/T04/T04-PLAN.md` — status updated
- `.gsd/milestones/M002/slices/S01/tasks/T04/T04-SUMMARY.md` — created (this file)
