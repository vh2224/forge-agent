---
id: T03
parent: S02
milestone: M003
provides:
  - "forge-completer.md sub-step 1.5: Evidence cross-ref reads evidence-{T##}.jsonl and cross-references verification_evidence claims"
  - "Three mismatch conditions documented: command_not_in_log, command_mismatch_at_line, evidence_log_missing"
  - "Evidence Flags section written to S##-SUMMARY.md when mismatches found (advisory only)"
  - "evidence.mode: disabled path skips entire sub-step"
  - "NOTE line added to step 1 frontmatter keys description pointing to sub-step 1.5"
requires: [T01, T02, T04]
affects: [S02]
key_files:
  - agents/forge-completer.md
key_decisions:
  - "Placed as sub-step 1.5 (between step 1 and step 1.6 File Audit) to keep step 1 conceptually intact"
  - "Used inline node -e one-liner for verification_evidence parse — no new scripts per D1"
  - "Trimmed blank lines between b/c/d sub-items to stay within ≤60 line growth constraint"
duration: 10min
verification_result: pass
completed_at: 2026-04-16T00:29:22Z
---

Surgical insertion of sub-step 1.5 into `agents/forge-completer.md` — completer now cross-references each task's `verification_evidence:` claims against `.gsd/forge/evidence-{T##}.jsonl` and writes an advisory `## Evidence Flags` section to `S##-SUMMARY.md` when mismatches are detected.

## What Happened

- Read `forge-completer.md` (253 lines after T04's File Audit addition).
- Inserted sub-step 1.5 between step 1's Forward Intelligence section and step 1.6 File Audit, exactly as planned.
- Sub-step documents: evidence.mode pref read (3-file cascade), per-task verification_evidence parse via inline `node -e`, `.jsonl` read with `sed -n`, three mismatch conditions (a/b/c), and table format for `## Evidence Flags`.
- Added NOTE line to step 1 frontmatter keys description per plan step 3.
- Trimmed 3 blank lines between sub-items b/c/d to land at exactly +60 lines (253→313).
- Fence count: 40 (even). All verification greps pass.

## Deviations

- Removed blank separator lines between sub-items b, c, d to stay within the ≤60 line constraint — functionally identical, slightly more compact.

## Files Created/Modified

- `agents/forge-completer.md` — added sub-step 1.5 (Evidence cross-ref) + NOTE line in step 1

## Verification

- Gate: skipped (no-stack)
- Discovery source: none
- Commands: `node scripts/forge-verify.js --plan ... --unit execute-task/T03` (exit 0)
- Total duration: ~500ms
