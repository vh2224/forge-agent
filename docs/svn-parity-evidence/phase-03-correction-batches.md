# Phase 3 — Bounded correction batches

## Batch phase3-b1-reset-at

- Status: complete — stopped before Batch 2.
- Gap IDs: `SVN-001`.
- Scope: command-specific peg escaping for SVN revert targets containing `@`.
- Writes:
  - `scripts/forge-vcs.js`
  - `scripts/forge-vcs.test.js`
  - `scripts/forge-svn-lab.test.js`
  - `docs/svn-capability-matrix.md`
  - `docs/svn-parity-evidence/remote-ownership.json` (repair malformed leading patch marker discovered during mandatory Phase 2 proof read)
  - `docs/svn-parity-evidence/phase-03-correction-batches.md`
- Expected output: a red-before-green live SVN regression covering whitespace, Unicode and literal `@`; raw paths remain unchanged for primitives that require them; preserved dirty descendants remain untouched; failed revert requires caller re-snapshot semantics.
- Acceptance: focused tests green, historical lab probe updated from red expectation to regression, existing VCS suite green, matrix row `family-vcs-primitives` updated with exact evidence, no source file outside the declared writes, no corporate SVN mutation.
- Baseline: `7b8563e98766f9724fd1f4657c61d22ec4c80a5e`.
- Remote ownership preflight: read-only pass; exact leaf r44724, created r44723, UUID and nonce match, two expected subtree log entries, no externals.
- Evidence integrity note: the committed local ownership JSON had a stray leading `+` from Phase 2 artifact generation. The remote version was valid; this batch declares and removes only that marker so later machine readers can consume the local proof.

### Red before green

The new live test was run against the unmodified `forge-vcs.js`. It failed at `forge-vcs.test.js:445`: `restoreAndRemove` returned `{vcs:"svn",ok:false,error:"svn-revert-failed"}` for the whitespace/Unicode/`@` fixture. Exit was 1. This reproduced `SVN-001` independently of the Phase 1 probe.

An intermediate implementation appended the peg escape inside the `--targets` file. SVN 1.14.2 returned exit 0 but left `unicódé@v1.txt` modified. That measured behavior disproved the assumption that targets-file entries and argv targets share peg parsing.

### Minimal correction

- Ordinary whitespace/Unicode paths continue through the batched targets file, escaped only at the command boundary.
- Any path containing `@`, CR or LF is routed one-at-a-time through argv and receives a trailing `@` escape.
- Raw paths remain unchanged in restore/remove sets, preserved-descendant checks, filesystem operations and returned evidence.
- A directory `dir@pkg` was reverted at depth `empty`; its property change was removed while modified descendant `keep ü.txt` stayed byte-identical.
- Failure still returns empty `restored`/`removed` arrays; the regression calls `postChanges` afterward to prove a fresh re-snapshot remains available.
- The historical Phase 1 lab probe now asserts the corrected behavior.

### Verification

- `node scripts/forge-vcs.test.js` → exit 0, 44 passed.
- `node scripts/forge-svn-lab.test.js` → exit 0, 9 passed.
- `node scripts/forge-surgical-reset-guard.test.js` → exit 0, 11 passed.
- `node scripts/forge-svn-audit.test.js` → exit 0, 2 passed.
- `node scripts/forge-verify.js ...phase3-b2` → passed, skipped `no-stack`.
- `node scripts/forge-verify.js ...phase3-b1` → passed, skipped `no-stack`.
- `git diff --check` → exit 0.

### Outcome and safety

- `SVN-001`: fixed in Batch 1; matrix row is `batch-verified`, full Phase 4 E2E remains pending.
- Remote ownership was revalidated read-only at batch start: exact leaf r44724, creation r44723, expected UUID/nonce, exactly two subtree history entries, no externals.
- Remote SVN mutations: 0. Corporate leaf was neither modified nor deleted.
- Writes under `C:\SVN`: 0. WDMA was not accessed.
- Local disposable lab children were removed after each run; marker/manifest-only roots were preserved for audit.
- The malformed leading patch marker in local `remote-ownership.json` was removed as a declared evidence-integrity repair; remote ownership files were already valid and unchanged.

Batch 2 has not started.

## Batch phase3-b2-detection-review

- Status: complete — stopped before Batch 3.
- Gap IDs: `SVN-002`, `SVN-003`.
- Scope: remove silent Git defaults from dispatch/sidecar VCS detection and the no-VCS review branch.
- Writes:
  - `shared/forge-dispatch.md`
  - `shared/forge-sidecar-auto.md`
  - `shared/forge-sidecar-next.md`
  - `shared/forge-review.md`
  - `skills/forge-auto/SKILL.md`
  - `skills/forge-next/SKILL.md`
  - `skills/forge-task/SKILL.md`
  - `scripts/forge-smoke.js`
  - `scripts/forge-review-diff.test.js`
  - `docs/svn-capability-matrix.md`
  - `docs/svn-parity-evidence/phase-03-correction-batches.md`
- Expected output: detection emits `git` and `svn` unchanged when observed, emits `none` when measured, and names `unknown` on detector failure; review outside Git/SVN records explicit unavailability and executes no Git command.
- Acceptance: biting text/behavior guards red before changes and green after; all nine telemetry emitters stay byte-identical to the canonical extraction contract; no `${DISPATCH_VCS:-git}` remains in affected surfaces; valid Git and SVN review branches retain their command bytes; no remote or corporate WC mutation.
- Baseline: `dd3e6552d347c12fa24e92293ebd533b1c7a9a01`.

### Red before green

- The new review regression failed against the baseline because the final branch assigned `git diff HEAD` when neither Git nor SVN was detected and exposed no named unavailability reason.
- The smoke guards failed against the baseline because canonical extraction used `|| echo "git"` and the affected skills/sidecars used `${DISPATCH_VCS:-git}`, converting detector failure or absent telemetry into Git.

### Minimal correction

- Canonical extraction now preserves observed `git`, `svn`, or `none`, and names detector failure `unknown`.
- The three entry skills and both sidecars propagate `unknown`; they do not reinterpret `none` or a failed detector as Git.
- Review retains the Git and SVN command branches byte-for-byte. Its no-VCS branch sets an empty command and `vcs-unavailable:none-or-detection-failed`; downstream review must record unavailability and cannot report a clean diff.

### Verification

- `node scripts/forge-review-diff.test.js` → exit 0, 21 passed.
- `node scripts/forge-svn-audit.test.js` → exit 0, 2 passed.
- `scripts/forge-smoke.js` Section 82 → all Batch 2 canonical extraction and anti-fallback assertions passed.
- Full `node scripts/forge-smoke.js` → exit 1, 2688 passed, 29 failed, 9 skipped; failures are pre-existing/out-of-scope Windows and missing-POSIX-fixture cases, including unrelated SVN primitive/revision-guard crashes. No Batch 2 assertion failed.
- `git diff --check` → exit 0.

### Outcome and safety

- `SVN-002` and `SVN-003`: fixed in Batch 2; exact matrix rows are `batch-verified`, while Phase 4 end-to-end coverage remains pending.
- Valid Git and SVN review branches remain byte-compatible; named `none`/`unknown` paths now refuse VCS-sensitive work explicitly.
- Remote ownership was revalidated read-only at batch start: exact leaf r44724, creation r44723, expected UUID/nonce, exactly two subtree history entries, no externals.
- Remote SVN mutations: 0. Corporate leaf was neither modified nor deleted.
- Writes under `C:\SVN`: 0. WDMA was not accessed.

Batch 3 has not started.

## Batch phase3-b3-public-flows

- Status: complete — stopped before Batch 4.
- Gap IDs: `SVN-004`, `SVN-005`, `SVN-006`, `SVN-007`.
- Scope: forge-touch, responsive fast mode, probe completion, and slice-completer file audit.
- Writes:
  - `scripts/forge-touch.js`
  - `scripts/forge-touch.test.js`
  - `scripts/forge-completer-artifacts.js`
  - `scripts/forge-completer-artifacts.test.js`
  - `skills/forge-responsive/SKILL.md`
  - `skills/forge-probe/SKILL.md`
  - `shared/forge-completer-slice.md`
  - `scripts/forge-smoke.js`
  - `docs/svn-capability-matrix.md`
  - `docs/svn-parity-evidence/phase-03-correction-batches.md`
- Expected output: SVN touch and file-audit use the existing VCS seam; responsive fast mode selects changed files without assuming Git; probe completion never mandates a Git commit on SVN and reports backend-aware completion.
- Acceptance: focused guards fail on the baseline and pass after minimal changes; local SVN fixtures contain no `.git`; Git behavior remains pinned; no silent empty-success or Git fallback; no remote or corporate WC mutation.
- Baseline: `1644778f5b99c5527dccd7616f27348220083e14`.

### Red before green

- The continuation run preserved the partial SVN-004 test and ran the new focused
  Batch 3 guard before editing the three public specs: `2 passed`, `3 failed`
  (SVN-005 responsive still named `git diff --name-only main`; SVN-006 still
  unconditionally ran `git add`/`git commit`; SVN-007 still used Git directly
  and silently converted failure to an empty set). Exit was 1.
- SVN-004 retained the Phase 1 static red reproduction and the partial attempt's
  live no-`.git` SVN fixture. Auditing that attempt before continuing showed the
  new regression green and the baseline Git suite intact.

### Minimal correction

- `forge-touch` now detects through `forge-vcs`; SVN reports the honest current
  WC delta with reason `svn-working-copy`, while status failure is named
  `svn-command-failed` and cannot become empty success.
- The new `forge-completer-artifacts.js` preserves Git branch/untracked selection
  and uses `workingStatus` for SVN added/modified/untracked paths. No-VCS or
  command failure exits nonzero with `file-audit-unavailable:<backend>`.
- Responsive fast mode and slice completion delegate changed-file selection to
  that helper. Probe completion detects the backend: Git keeps its existing commit
  behavior; SVN artifacts remain explicitly uncommitted because no SVN commit
  authorization/contract exists; `none`/`unknown` are reported unavailable.

### Verification

- `node scripts/forge-completer-artifacts.test.js` → exit 0, 6 passed.
- `node scripts/forge-touch.test.js` → exit 0, 18 passed.
- `node scripts/forge-vcs.test.js` → exit 0, 44 passed.
- `node scripts/forge-svn-audit.test.js` → exit 0, 2 passed.
- `node scripts/forge-svn-audit.js` → exit 0; expected=52, observed=52,
  missing=0, duplicates=0, incomplete=0.
- `git diff --check` → exit 0.

### Outcome and safety

- SVN-004 through SVN-007 are `batch-verified`; full Phase 4 E2E remains pending.
- The fresh remote ownership proof was read-only: exact leaf r44724, creation
  r44723, UUID `2211720e-e40a-b547-bb9a-eb178e2eb854`, nonce and equal owner/
  manifest matched, exactly two expected log entries, and no properties/externals.
- Remote SVN mutations: 0. Corporate leaf was neither modified nor deleted.
- Writes under `C:\SVN`: 0. WDMA was not accessed.

Batch 4 has not started. Phase 4 has not started.

## Batch phase3-b4-renderer-contract

- Status: complete — Phase 3 closed; stopped before Phase 4.
- Gap ID: `SVN-008` (projection contract drift caused by Batch 3 source changes;
  not an SVN runtime defect).
- Scope: synchronize the deterministic Claude skills projection golden, then
  classify the three highlighted matrix rows without inventing product gaps.
- Writes:
  - `scripts/fixtures/claude-renderer/claude-4.19.0.golden.json`
  - `docs/svn-capability-matrix.md`
  - `docs/svn-parity-evidence/phase-03-correction-batches.md`
- Red: `node scripts/forge-claude-renderer.test.js` exited 1 with
  `golden bytes drifted: skills`; actual SHA-256 was
  `1690b19b495bc6ecc2e227acd2b6f5b71a242dbf55d04085560eff987b674a79`.
- Acceptance: renderer test green with only the measured skills hash updated;
  operational MCP classified VCS-neutral, Claude settings classified VCS-neutral,
  isolation classified as a tested named limitation; no product source changes,
  no remote mutation, and Phase 4 remains unstarted.
- Baseline: `b62de83ae95f573fecc464b592a9ab19b902f12d`.

### Verification and closure

- `node scripts/forge-claude-renderer.test.js` → exit 0.
- `node scripts/forge-operational-parity.test.js` → exit 0, 5 passed across
  Claude/Codex and win32/darwin/linux projections.
- `node scripts/forge-isolation.test.js` → exit 0, 89 passed; SVN resolves
  shared before Git worktree derivation and names unmet worktree requirements.
- `node scripts/forge-svn-audit.test.js` → exit 0, 2 passed.
- `node scripts/forge-svn-audit.js` → exit 0; expected=52, observed=52,
  missing=0, duplicates=0, incomplete=0.
- `git diff --check` → exit 0.

The remaining `inventory` rows are Phase 4 classification/E2E work, not red
product evidence. No further Phase 3 correction cluster was reproduced. MCP and
Claude settings are VCS-neutral host projections; Git branch/worktree isolation
is intrinsically unavailable in SVN and already degrades explicitly to shared.
No remote revalidation was needed because this batch performed no SVN operation.
Remote mutations: 0; writes under `C:\SVN`: 0; WDMA access: none.

Phase 3 is closed. Phase 4 has not started.
