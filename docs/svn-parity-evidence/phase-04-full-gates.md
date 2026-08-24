# Phase 4 — complete gates and matrix closure

## Verdict

**Phase 4 completed; overall gate is not 100% green.** No new reproducible SVN product gap was found. Every SVN-focused suite and the capability auditor passed. The non-zero complete gates reproduce on the clean base commit and are Windows/tool-environment failures rather than regressions introduced by the SVN parity batches.

This verdict deliberately does not claim universal parity or a green full repository gate. It closes the matrix with `verified`, `verified-neutral`, or `declared-limitation` evidence and leaves Phase 5 to perform the separately authorized UAT and final audit.

## Safety boundary

- No command read or wrote `C:\SVN`; no pre-existing working copy was touched.
- WDMA was not accessed.
- No remote SVN endpoint was contacted or mutated.
- Mutable SVN exercises used task-owned temporary local repositories and working copies outside `C:\SVN`.
- No cleanup command was run against a pre-existing working copy.

## Focused SVN gates

All commands ran from the task worktree and exited 0.

| Command | Result |
|---|---:|
| `node scripts/forge-svn-lab.test.js` | 9 passed |
| `node scripts/forge-svn-remote-guard.test.js` | 7 passed; local fixture only |
| `node scripts/forge-vcs.test.js` | 44 passed |
| `node scripts/forge-review-diff.test.js` | 21 passed |
| `node scripts/forge-touch.test.js` | 18 passed |
| `node scripts/forge-completer-artifacts.test.js` | 6 passed |
| `node scripts/forge-doctor-projection-svn.test.js` | 4 passed |
| `node scripts/forge-unit-delta.test.js` | 29 passed |
| `node scripts/forge-isolation.test.js` | 89 passed |
| `node scripts/forge-claim-release.test.js` | 46 passed |
| `node scripts/forge-claim-recovery.test.js` | 32 passed |
| `node scripts/forge-verify.test.js` | 37 passed |
| `node scripts/forge-svn-audit.test.js` | 2 passed |
| `node scripts/forge-svn-audit.js` | expected 52, observed 52, missing 0, duplicates 0, incomplete 0, additional families 7 |

Together these gates exercise detection/status/diff, add/delete/move/copy and property-aware WC changes, review scoping, touch attribution, unit delta, ignore behavior, dirty-post conditions, isolation degradation, claims/recovery, verification, doctor projection, and completion artifacts. Smoke Sections 80 and 82 additionally kept SVN execute/plan plus isolation/telemetry paths green.

## Complete repository gates

### `node scripts/run-tests.js`

Exit 1 after 530.87 seconds. Four of 232 suites failed:

- `forge-installer.test.js`
- `forge-projection-self.test.js`
- `forge-route-audit.test.js`
- `forge-sweep-vault.test.js`

Each failure is an `EPERM` while creating a symbolic link on Windows. The same four focused suites reproduce with the same failure class at clean base commit `6d3d6d4ac550`, in a detached task-owned worktree. They are therefore pre-existing environment failures, not SVN batch regressions.

### `node scripts/forge-smoke.js`

Current branch: exit 1, **2688 passed, 29 failed, 9 skipped**, with three crashed sections: `smokeSvnPrimitives`, `smokeSvnRevisionGuard`, and `smokeSidecarDiffCanonical`.

Clean base `6d3d6d4ac550`: exit 1, **2684 passed, 29 failed, 9 skipped**, with the same three crashed sections. The four additional passes on the task branch are retained improvements; failure and skip counts did not increase.

The repeated failure classes are host/environment dependent: unavailable `bash`/`sh`/`vitest`/`jest`, Windows symlink `EPERM`, an invalid-on-Windows newline filename fixture, CRLF/path-separator expectations, quoting of `C:\Program Files`, and live Codex schema/sandbox-policy drift. The SVN xllm execute/plan checks in Section 80 and SVN isolation/telemetry checks in Section 82 passed. Phase 3 had already recorded the task-branch total of 2688/29/9 before this closure run.

## Matrix closure

- Catalog IDs expected/observed: 52/52.
- Missing, duplicate, or incomplete catalog rows: 0/0/0.
- Additional internal/public families: 7.
- Rows left at `inventory`: 0.
- Explicit limitations: Git-distributed updater, macOS-only app on this host, and SVN shared isolation where Git worktree/branch semantics have no equivalent.
- VCS-neutral surfaces are classified as such rather than treated as untested SVN implementations.

## Gap decision

No new red SVN behavior was reproduced, so Phase 4 does not authorize or open another product-fix batch. The complete repository gate remains honestly non-green because of reproduced base/environment failures. Proceed only to the separately dispatched Phase 5 UAT and final verdict; do not reinterpret this report as a 100% compatibility claim.
