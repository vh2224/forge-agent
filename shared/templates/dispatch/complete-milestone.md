Complete GSD milestone {M###}.
WORKING_DIR: {WORKING_DIR}
auto_commit: {auto_commit}
milestone_cleanup: {milestone_cleanup}
Expand M = {WORKING_DIR}/.gsd/milestones/{M###}.
## Slice Summaries
Read first 35 lines each: M/slices/S*/S*-SUMMARY.md.
Read complete sibling S*-DELIVERY.json; never derive criterion status from excerpts.
## Milestone Roadmap
Read M/{M###}-ROADMAP.md.
## Milestone Summary
Read M/{M###}-SUMMARY.md if present.
## Instructions
1. Write final M###-SUMMARY.md
1.5. Read {FORGE_SCRIPTS_DIR}/../shared/forge-delivery.md. Write M###-DELIVERY-INPUT.json:
exact plan/roadmap fingerprint, explicit milestone-owned bindings, every expected slice DELIVERY,
including missing children. Run forge-delivery.js `--input <M###-DELIVERY-INPUT.json>
--owner-root "{WORKING_DIR}" --code-dir "<isolation CODE_DIR; WORKING_DIR if shared>" --json`
into M###-DELIVERY.json; repeat with `--markdown --table-limit 50
--detail-reference "./M###-DELIVERY.json"`. Upsert generated `## Entrega por critério`;
retain gap counts/detail pointer within 150 SUMMARY lines. Keep implementation, CI, review,
merge, installation, human acceptance independent.
2. Mark milestone complete in STATE.md.
3. auto_commit true: final git tag or note; false: no git commands.
4. **NEVER integrate**; OPERATOR does. Only add, commit, tag, read-only inspection allowed;
   see `## Git boundary — complete-milestone`.
Return ---GSD-WORKER-RESULT---.
