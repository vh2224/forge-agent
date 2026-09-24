Complete GSD milestone {M###}.
WORKING_DIR: {WORKING_DIR}
auto_commit: {auto_commit}
milestone_cleanup: {milestone_cleanup}

## Slice Summaries

Read (first 35 lines each): {WORKING_DIR}/.gsd/milestones/{M###}/slices/S*/S*-SUMMARY.md
Read each complete sibling S*-DELIVERY.json; never infer criterion status from the SUMMARY excerpt.

## Milestone Roadmap

Read: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-ROADMAP.md

## Milestone Summary

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-SUMMARY.md

## Instructions
1. Write final M###-SUMMARY.md
1.5. Read {FORGE_SCRIPTS_DIR}/../shared/forge-delivery.md. Write
M###-DELIVERY-INPUT.json with the exact milestone plan/roadmap fingerprint, explicit
milestone-owned bindings and every expected slice DELIVERY, including missing children. Run
forge-delivery.js with `--owner-root "{WORKING_DIR}" --code-dir "<actual CODE_DIR from the isolation header, or WORKING_DIR in shared mode>" --json` to write
M###-DELIVERY.json, then `--markdown --table-limit 50 --detail-reference
"./M###-DELIVERY.json"` and upsert `## Entrega por critério`. Preserve generated gap counts and
the full-detail pointer within the 150-line SUMMARY budget. Keep implementation, CI, review,
merge, installation and human acceptance independent.
2. Mark milestone as complete in STATE.md (do modify STATE.md for this)
If auto_commit is true:
3. Write final git tag or note
If auto_commit is false:
3. Skip — do NOT run any git commands.
4. **NEVER integrate** — the OPERATOR does that. Only add, commit, tag and read-only inspection
   are permitted; see `## Git boundary — complete-milestone`.
Return ---GSD-WORKER-RESULT---.
