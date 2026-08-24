# Phase 2 — Remote ownership protocol

**Task:** T-20260824120158-auditar-validar
**Result:** `pass`
**Exact mutable leaf:** `https://cvs.cma.local/cma_series_2/CMA/FORGE_SVN_PARITY_TEST_T20260824120158`
**Creation revision:** `44723`
**Binding revision:** `44724`
**Remote cleanup:** not run and not authorized in Phase 2

## Preconditions

The local remote guard passed before any corporate mutation. It compares decoded URL segments for exact equality and rejects parent, WDMA, siblings and sibling-prefixes, dot segments, encoded separators/dots, query, fragment, userinfo, scheme/host/port changes, incomplete XML, ambiguous absence, repository identity mismatch, owner/manifest mismatch, nonce/revision/phase mismatch, HEAD divergence and externals.

Parent proof immediately before creation:

- parent URL: `https://cvs.cma.local/cma_series_2/CMA`;
- parent query exit: 0;
- repository root: `https://cvs.cma.local/cma_series_2`;
- repository UUID: `2211720e-e40a-b547-bb9a-eb178e2eb854`;
- parent observed revision: `44722`.

Exact-leaf absence proof immediately before creation:

- `svn info --xml <exact-leaf>` exit: 1;
- warning: `W170000`, exact URL non-existent at r44722;
- terminal code: `E200009`, target does not exist;
- parent authentication/network/UUID had already succeeded;
- no auth, network, certificate or redirect ambiguity was present.

An initial attempt to combine the proof under PowerShell `ErrorActionPreference=Stop` stopped on SVN's expected warning before reaching import. It caused zero mutation. The second attempt explicitly captured the nonzero probe, checked `E200009`, repeated all guards, and only then imported.

## Two-stage creation

### Stage 1 — atomic import

A task-owned unpredictable staging root was created outside `C:\SVN`:

`C:\Users\LUIS~1.FER\AppData\Local\Temp\forge-svn-phase2-eUQgII`

Its import directory contained exactly:

- `.forge-svn-owner.json`;
- `.forge-svn-manifest.json`.

Both documents were byte-equivalent and bound schema version, task ID, phase, 48-hex nonce, exact canonical URL, repository root and UUID. `created_revision` was explicitly `null` pending the returned revision.

After a fresh exact-URL guard, parent identity proof, specific absence proof and stage-file validation, one atomic `svn import` created only the exact leaf and those two files.

Result: `Committed revision 44723`.

### Inter-stage proof

Before binding the revision, remote reads proved:

- exact URL and decoded segments unchanged;
- repository root and UUID unchanged;
- remote owner and manifest equal, with expected nonce and pending revision;
- leaf last-changed revision exactly 44723;
- subtree log from r44723 to HEAD contained exactly one entry;
- the entry added only the exact leaf and its two ownership files;
- `svn proplist --xml` returned no properties, therefore no `svn:externals`.

A first binding attempt stopped before commit because passing JSON through process argv stripped quoting. The subtree remained unchanged at r44723. No compensating delete or other mutation ran. The retry used structured PowerShell JSON parsing, then repeated URL, UUID, marker, manifest, log, HEAD and externals proof.

### Stage 2 — bind creation revision

The task-owned binding WC contained exactly two modified files. Both were changed only from `created_revision: null` to `created_revision: 44723`.

A commit explicitly named those two file paths and no directory/parent target.

Result: `Committed revision 44724`.

## Postcondition

Post-commit proof:

- leaf info URL is the exact authorized URL;
- repository UUID is `2211720e-e40a-b547-bb9a-eb178e2eb854`;
- leaf last-changed revision is 44724;
- remote owner and manifest are equal;
- both contain nonce `2c46193c1f13d05993a2bcb1d8f38def9258bb60db11b0a2`;
- both bind `created_revision: 44723`;
- no externals exist;
- repository log for r44723:r44724 shows every changed path strictly below `/CMA/FORGE_SVN_PARITY_TEST_T20260824120158`;
- r44723 added the leaf and two files;
- r44724 modified only the two files;
- parent `CMA`, `WDMA` and every sibling received no changed path in either revision.

The subtree is intentionally preserved for later phases. No `svn delete`, remote cleanup, update, revert, switch, property mutation, or write under any pre-existing `C:\SVN` WC occurred.

## Tests and commands

- `node scripts/forge-svn-remote-guard.test.js` → exit 0, 7 passed.
- `node scripts/forge-svn-remote-guard.js <exact-leaf>` → exit 0, exact canonical URL.
- Parent and exact-leaf `svn info --xml` → parent 0; leaf absent 1 with E200009.
- `svn import <task-stage> <exact-leaf>` → exit 0, r44723.
- Remote `info`, `cat`, `log -v`, and `proplist` inter-stage → all identity/ancestry/HEAD/externals checks passed.
- Explicit two-file `svn commit` → exit 0, r44724.
- Postcondition `info`, `cat`, repository `log -v -r 44723:44724`, and `proplist` → passed.

## Stop boundary

Phase 2 is complete. Phase 3 has not started. No product gap was corrected. Every later mutation must re-read this ownership record and independently revalidate exact segments, UUID, remote marker+manifest, nonce, creation revision, subtree HEAD/history and absence of externals immediately before the effect.
## Preserved local evidence

The Phase 2 staging root `forge-svn-phase2-eUQgII` is preserved with its import source, binding WC and local ownership marker. The verification rerun also left `forge-svn-parity-P1k2hY` containing only the Phase 1 lab marker and manifest after child-only cleanup. Neither root is under `C:\SVN`. No broad cleanup is authorized; later removal requires exact marker/manifest revalidation.
