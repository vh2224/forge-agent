---
id: T04
parent: S02
milestone: M003
provides:
  - "forge-completer sub-step 1.6: file audit comparing git diff AM set against union of expected_output from all T##-PLANs"
  - "Branch fallback chain: master → main → origin/HEAD → working-tree"
  - "Inline node -e expected_output parser (no new scripts)"
  - "file_audit.ignore_list prefs cascade read with hardcoded defaults"
  - "## File Audit section written to S##-SUMMARY.md (advisory, omitted when both lists empty)"
requires: []
affects: [S02]
key_files: [agents/forge-completer.md]
key_decisions:
  - "Use inline node -e for expected_output parse; forge-must-haves.js CLI does not emit expected_output array (extending it would reopen S01 contract)"
  - "Deletions NOT tracked per D4 LOCKED — --diff-filter=AM only"
  - "File Audit is advisory; never blocks merge or returns status: blocked"
duration: 10min
verification_result: pass
completed_at: 2026-04-16T00:00:00Z
---

Added sub-step 1.6 to `forge-completer.md` that runs git diff AM, parses expected_output from all T##-PLANs, filters via file_audit.ignore_list, and writes an advisory `## File Audit` section to S##-SUMMARY.md.

## What Happened

Inserted sub-step 1.6 between step 1 (Write S##-SUMMARY.md) and step 2 (Write S##-UAT.md) in `agents/forge-completer.md`. The sub-step:

- Computes `ACTUAL_AM` via `git diff --name-only --diff-filter=AM` from merge-base, with fallback chain (master → main → origin/HEAD → working-tree diff + untracked via `git ls-files --others`)
- Builds `EXPECTED` by shelling out `node scripts/forge-must-haves.js --check` per T##-PLAN.md and then inline-parsing `expected_output:` from the frontmatter (because the CLI only returns `{legacy, valid, errors}`)
- Reads `file_audit.ignore_list` from three-file prefs cascade with hardcoded defaults matching T05's shipped defaults
- Filters both sides and diffs sets to produce `unexpected` and `missing` lists
- Writes `## File Audit` section only when at least one list is non-empty; omits section when both are empty (no noise)
- All git/node failures are silent (try/catch); never blocks merge

T03 (evidence cross-ref, sub-step 1.5) will be inserted before 1.6 in the next task execution — 1.6 is in place now.

## Deviations

None. Exactly followed T04-PLAN instructions including the inline parse approach (no changes to forge-must-haves.js to avoid reopening S01 contract).

## Files Created/Modified

- `agents/forge-completer.md` — added sub-step 1.6 (~110 lines added; file grew from 156 to 252 lines)

## Verification

- Gate: skipped (no-stack)
- Discovery source: none
- Commands: `node scripts/forge-verify.js --plan ... --unit execute-task/T04` (exit 0)
- Manual checks:
  - `grep -n "File Audit"` → 3 matches (line 43, 122, 124)
  - `grep -n "diff-filter=AM"` → 4 matches
  - `grep -n "expected_output"` → 8 matches
  - `grep -n "ignore_list"` → 4 matches
  - Fence count: 34 (even — balanced)
  - Line count: 252 (≥ 250 min_lines requirement)
