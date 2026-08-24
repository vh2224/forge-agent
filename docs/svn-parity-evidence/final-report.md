# SVN parity audit — final report

## Final verdict

**`not-100%-complete`**

The audit produced a closed capability matrix and executable evidence for the applicable SVN primitives, removed seven reproduced silent-Git/SVN-flow gaps, and documented intrinsic limitations explicitly. It cannot declare 100% completion because the complete repository gates are not green and the strict WDMA before/after contract recorded one differing `svn info --xml` output hash.

## Phase outcomes

1. Phase 1 created the guarded local SVN lab, complete capability inventory, auditor, and seven red probes without touching pre-existing working copies.
2. Phase 2 created and bound only the authorized remote leaf in revisions 44723 and 44724 with exact ownership evidence.
3. Phase 3 fixed SVN-001 through SVN-007 in bounded red-before-green batches; Batch 4 synchronized the renderer contract and classified non-gaps.
4. Phase 4 closed every matrix row. Focused SVN suites and the auditor passed, but full gates retained reproduced Windows/environment failures.
5. Phase 5 ran the WDMA UAT with local read-only commands only. Durable WC/admin measurements stayed equal, but strict textual equality failed on one `svn info --xml` hash.

## Capability closure

- Catalog capabilities expected/observed: 52/52.
- Missing, duplicate, or incomplete rows: 0/0/0.
- Additional internal/public VCS families: 7.
- Rows left at `inventory`: 0.
- Allowed final row classes: `verified`, `verified-neutral`, and `declared-limitation`.
- Silent fallback to Git in the seven reproduced gaps was removed or replaced with explicit unavailability.
- SVN branch/worktree isolation remains an explicit shared-mode limitation because SVN has no Git worktree/branch equivalent.
- The Git-distributed updater and macOS-only app surface remain explicitly classified rather than presented as SVN functionality.

## Gate evidence

All focused SVN suites passed, including live local SVN coverage for VCS primitives, review diff, touch, completion artifacts, doctor projection, unit delta, isolation, claims/recovery, verification, lab guards, and the capability auditor.

`node scripts/run-tests.js` exited 1 with four of 232 suites failing on Windows symbolic-link `EPERM`. The same four failures reproduced at clean base `6d3d6d4ac550`.

`node scripts/forge-smoke.js` exited 1 on the task branch with 2688 passed, 29 failed, 9 skipped and three crashed sections. Clean base produced 2684 passed, the same 29 failures, the same 9 skips and the same three crashes. These gates are documented as non-green, not silently waived.

## WDMA evidence

WDMA was queried only by local `svn info`, `svn status` without `-u`, `svn diff`, `svn proplist`, `svn propget`, `svnversion`, and filesystem reads/hashes.

Status, diff, property outputs, svnversion `44701:44720MP`, 22 root inventory entries, and all 5,960 `.svn` inventory entries were identical before/after. The `.svn` aggregate hash remained `8fb3dc4905d4570a04d10746df252131352b817dd506ea51e9e3c73b69ebb13e`.

The `svn info --xml` output hash changed between the formal before and after snapshots. Later consecutive reads matched, but the recorded difference remains disqualifying under the task's strict contract. No restoration was attempted.

The independently retained `phase-05-wdma-command-manifest.json` contains the formal hash inventory plus exact argv/exit/byte/hash results from the local read-only review diagnostic. Ten repeated `svn info --xml .` reads alternated between two equal-length hashes, making the volatility reproducible while leaving the formal mismatch and final verdict unchanged.

## Ownership and cleanup

The corporate leaf `https://cvs.cma.local/cma_series_2/CMA/FORGE_SVN_PARITY_TEST_T20260824120158` remains intentionally preserved. Remote cleanup was ineligible because Phase 4 and the final result are not 100% complete. No remote mutator was called in Phases 3–5.

Local task-owned labs were also preserved. The WDMA mismatch forbids both cleanup paths, so no child deletion, broad root deletion, or cleanup of any pre-existing working copy was attempted.

## Safety conclusion

- No task write targeted `C:\SVN` or any pre-existing working copy.
- No WDMA mutation, repair, update, cleanup, revert, property change, or commit occurred.
- No remote URL was queried or mutated during Phase 5.
- No cleanup was performed after the strict snapshot mismatch.
- The evidence supports meaningful SVN parity improvements and a complete audit matrix, but not a claim of universal or 100% SVN completeness.
