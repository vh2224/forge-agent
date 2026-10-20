# Forge slice and milestone completion

## Verification and aggregation

Read complete child DELIVERY.json files, including missing expected children;
never derive criterion status from SUMMARY excerpts. Preserve open review findings.
Run applicable verification in the actual CODE_DIR, not the owner artifact root.
Record commands, exit codes, discovery source and total duration under Verification
Gate. Nonzero unskipped verification blocks completion with tooling_failure.
no-stack and disabled-by-pref mean zero commands, not tests passed.
Capture actual gate and declared-artifact results contemporaneously with unit,
exact plan fingerprint, code root, workspace/revision, environment and timestamp.
Read {FORGE_SCRIPTS_DIR}/../shared/forge-delivery.md; bind each criterion/aspect to
concrete checks/artifact rows. A global pass or empty check list proves no criterion.
Lint changed files when available and fix violations before completion.

## Delivery and publication

Write the unit DELIVERY-INPUT.json with exact plan/roadmap fingerprint, explicit
unit-owned bindings and every expected child delivery, including absent children.
Run forge-delivery.js with --input, --owner-root "{WORKING_DIR}", the actual
--code-dir and --json to produce the unit DELIVERY.json; repeat with --markdown,
the unit's table limit and --detail-reference to that JSON. Upsert generated
## Entrega por critério; retain gap counts and detail pointer within SUMMARY limits.
Keep implementation, CI, review, merge, installation and human acceptance as
independent facts. Synthetic checks do not establish UAT or efficacy.
Workers return scoped artifacts; the owner validates/publishes and checkpoints.

## Slice guard — owner responsibility

Immediately before dispatching the complete-slice completer, the owner runs
node "{FORGE_SCRIPTS_DIR}/forge-slice-git-guard.js" --snapshot --cwd CODE_DIR
--unit complete-slice/SLICE_ID --gsd-dir "{WORKING_DIR}/.gsd" --run RUN_ID.
Immediately after the completer, run the same command with --verify instead of
--snapshot, using the same real run ID, unit, owner/gsd-dir and physical CODE_DIR.
The pre-dispatch snapshot is consumed exactly once. Never take another snapshot
after the completer to conceal divergence or manufacture a historical baseline.
snapshot-missing/inconclusive is a real advisory, never a clean verification;
exit zero alone does not prove clean. Preserve violations as failures.
Preserve any earlier inconclusive/snapshot-missing guard result; do not
retroactively declare it valid or infer absence of changes. The current slice
requires its own fresh pre-dispatch snapshot.

## Git boundary

Never integrate; the OPERATOR owns integration. Preserve template-specific Git
restrictions and auto_commit behavior. A successful completer does not prove
merge, installation or human acceptance. Return ---GSD-WORKER-RESULT---.
