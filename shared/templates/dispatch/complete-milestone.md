Complete GSD milestone {M###}.
WORKING_DIR: {WORKING_DIR}
auto_commit: {auto_commit}
milestone_cleanup: {milestone_cleanup}
Expand M = {WORKING_DIR}/.gsd/milestones/{M###}.
## Slice Summaries
Read first 35 lines each: M/slices/S*/S*-SUMMARY.md.
## Milestone Roadmap
Read M/{M###}-ROADMAP.md.
## Milestone Summary
Read M/{M###}-SUMMARY.md if present.
## Instructions
1. Write final M###-SUMMARY.md
1.5. Materialize M###-DELIVERY-INPUT.json and M###-DELIVERY.json per the completion procedure; table limit 50, detail reference ./M###-DELIVERY.json, SUMMARY limit 150 lines.
2. Return milestone completion for the owner to mark in STATE.md.
3. auto_commit true: final git tag or note; false: no git commands.
4. **NEVER integrate**; OPERATOR does. Only add, commit, tag, read-only inspection allowed;
   see `## Git boundary — complete-milestone`.
