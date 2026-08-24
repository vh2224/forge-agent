# Phase 1 — Safety harness, inventory and red probes

**Task:** T-20260824120158-auditar-validar
**Base:** `6d3d6d4ac550830a48f8daf9564c0ba04222ca42` / `v4.27.1`
**Result:** `not-100%-complete`
**Remote SVN mutations:** 0
**Corporate working-copy mutations:** 0

## Environment

| Check | Result |
|---|---|
| Worktree | `C:\dev\.forge-worktrees\T-20260824120158-auditar-validar\forge-agent` |
| Branch | `forge/T-20260824120158-auditar-validar` |
| Node | `v24.14.1` |
| svn | `1.14.2` |
| svnadmin | `1.14.2` |
| Lab transport | local `file:///` only |
| Lab Git presence | absent |
| Corporate URL access | none |
| Commands under `C:\SVN` | none |

No command in this phase used a corporate SVN URL or a path under `C:\SVN`. Consequently there was no update, cleanup, revert, add, delete, move, property edit, commit, or filesystem write on a pre-existing WC. Phase 1 deliberately did not create `FORGE_SVN_PARITY_TEST_T20260824120158`.

## Safety harness

`scripts/forge-svn-lab.js` creates an unpredictable task-owned root under the operating-system temp directory. Its marker and manifest bind task ID, nonce, canonical root and the exact four allowed children: `repo`, `svnconfig`, `wc`, and `evidence`.

Every guarded target is:

- an absolute strict descendant, never the root;
- under a manifested first-level child;
- revalidated against marker and manifest;
- checked for lexical and real-path escape;
- rejected when a symlink/junction/reparse point is encountered;
- passed to SVN with argv arrays.

Cleanup removes each manifested child separately after revalidation. It never removes the exclusive root, uses no glob, and leaves marker/manifest evidence. Failure preserves the lab.

Focused result: `9 passed`, including root/parent/sibling-prefix/`..` refusal, unmanifested refusal, missing/mismatched proof refusal, reparse refusal, live `svnadmin + file:///` lifecycle, preservation on failure and positive child-only cleanup.

## Inventory

`scripts/forge-svn-audit.js` validates the matrix schema and the canonical capability catalog:

- expected catalog IDs: 52;
- observed catalog IDs: 52;
- missing: 0;
- duplicates: 0;
- incomplete rows: 0;
- explicitly enumerated additional families: 7.

The additional families are VCS primitives, review diff, touch, unit delta, isolation, ignore, and claims/recovery. Platform CI is explicitly not accepted as SVN evidence. Final per-row E2E verdicts remain for Phase 4.

## Seven focused probes

All probes used either the local no-`.git` SVN lab or static inspection of the exact executable instruction. Static probes have `git_invocations: 0` because commands were not executed; the finding is that the public instruction would invoke Git. No product file was edited.

| Gap | Result | Fixture / command | Exit / output | git_invocations | Expectation |
|---|---|---|---|---:|---|
| SVN-001 revert path containing `@` | reproduced red | live local WC; `restoreAndRemove(... service@1.2.0.txt ... vcs:svn)` | API `ok:false`, `svn-revert-failed:E205000` | 0 | SVN revert must peg-escape the target |
| SVN-002 detection none/failure defaults to Git | reproduced red | static exact lines in dispatch + auto/next sidecars | `|| echo "git"` present; audit exit 0 | 0 | failure must be named unknown/none, not Git |
| SVN-003 review no-VCS fallback invokes Git | reproduced red | `shared/forge-review.md:338-340` | `DIFF_CMD="git diff HEAD"`; audit exit 0 | 0 | no-VCS must be explicit/no-diff |
| SVN-004 forge-touch misclassifies SVN | reproduced red | `scripts/forge-touch.js:253-254` | non-Git path => `repo-not-git`; audit exit 0 | 0 | SVN must be supported or explicitly unavailable |
| SVN-005 responsive fast mode | reproduced red | `skills/forge-responsive/SKILL.md:173` | instructs `git diff --name-only main`; audit exit 0 | 0 | use VCS seam or explicit limitation |
| SVN-006 probe completion | reproduced red | `skills/forge-probe/SKILL.md:215-216` | unconditional `git add` + `git commit`; audit exit 0 | 0 | SVN completion or explicit limitation |
| SVN-007 slice completer file audit | reproduced red | `shared/forge-completer-slice.md:112-123` | Git diff/ls-files; Git failure silently empty; audit exit 0 | 0 | VCS-aware diff and fail-honest result |

The live red probe was intentionally asserted as the current behavior, so the harness suite is green while retaining proof that the product behavior is red. No hypothesized gap was marked “not reproduced”.

## Commands and exits

- `node scripts/forge-svn-audit.test.js` → exit 0, `2 passed`.
- `node scripts/forge-svn-audit.js` → exit 0, expected=52, observed=52, missing=0, duplicates=0, extras=7.
- `node scripts/forge-svn-lab.test.js` → exit 0, `9 passed`; live no-Git WC and reproduced SVN-001.
- `git diff --name-only` was used only on the isolated Git worktree to audit Phase 1 source scope; it did not inspect an SVN WC.

## Proposed bounded correction batches

1. **Primitive safety / reset @**
   - Gaps: SVN-001.
   - Product files: `scripts/forge-vcs.js`, `scripts/forge-vcs.test.js`.
   - Red basis: live Phase 1 fixture.
2. **Detection and review fallbacks**
   - Gaps: SVN-002, SVN-003.
   - Product files: `shared/forge-dispatch.md`, `shared/forge-sidecar-auto.md`, `shared/forge-sidecar-next.md`, `shared/forge-review.md`, focused mirror/spec tests.
3. **Public flows**
   - Gaps: SVN-004 through SVN-007.
   - Product files: `scripts/forge-touch.js`, `scripts/forge-touch.test.js`, `skills/forge-responsive/SKILL.md`, `skills/forge-probe/SKILL.md`, `shared/forge-completer-slice.md`, and focused tests/a helper only if red-first demands it.
4. **Remaining matrix gaps**
   - One separately manifested cluster at a time, only after a focused red reproduction.

## Scope proof

The source diff at this checkpoint contains only:

- `scripts/forge-svn-lab.js`
- `scripts/forge-svn-lab.test.js`
- `scripts/forge-svn-audit.js`
- `scripts/forge-svn-audit.test.js`
- `docs/svn-capability-matrix.md`
- `docs/svn-parity-evidence/phase-01-safety-inventory-probes.md`

No product gap was fixed in Phase 1. Phase 2 has not started.

## Preserved local proof roots

The successful child-only cleanup left only marker and manifest in these exact task-created roots: `forge-svn-parity-SCyaY8`, `forge-svn-parity-OSCJjc`, `forge-svn-parity-H6NdhI`, and `forge-svn-parity-3S1Tbl` under the operating-system temp directory. No repo, WC, config or evidence child remains. A later cleanup may remove only these exact roots after separately validating their marker and manifest; no broad temp-directory cleanup is authorized.
