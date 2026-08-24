# Phase 5 — protected-wc read-only UAT

## Verdict

**UAT result: not equivalent under the strict snapshot contract.** The protected-wc filesystem and administrative metadata remained identical, as did status, diff, properties and svnversion. However, the first and final `svn info --xml` output hashes differed. The plan requires any difference to stop the successful path, so no restoration or cleanup was attempted and the final task verdict remains `not-100%-complete`.

## Safety boundary

- Target was the local path `<PROTECTED_WORKING_COPY>`; no SVN URL was used.
- SVN commands were limited to local `svn info`, `svn status` without `-u`, `svn diff`, `svn proplist`, `svn propget`, and `svnversion`.
- No network option, update, cleanup, revert, add, delete, move, copy, mkdir, property mutation, switch, resolve, commit, or administrative write was invoked.
- Filesystem operations were reads, metadata inventory, and SHA-256 hashing only.
- No attempt was made to restore or alter the pre-existing modifications and unversioned files reported by status.

## Snapshot definition

The bounded snapshot was defined before the successful capture:

- exit code and SHA-256 of `svn info --xml` output;
- exit code, exact text and SHA-256 of local `svn status` output;
- exit code and SHA-256 of local `svn diff` output;
- exit code and SHA-256 of recursive local `svn proplist --xml` output;
- exit code and SHA-256 of local `svn propget svn:ignore` output;
- exit code and exact `svnversion` value;
- immediate root inventory: name, kind, length, timestamp and attributes;
- complete `.svn` inventory: relative path, kind, length, timestamp, attributes and SHA-256 for every file.

An initial attempt to hash the entire filesystem tree was interrupted because it was unbounded over local non-versioned content. It performed only allowed reads and no write. The bounded snapshot retains complete administrative coverage and explicitly defines the consulted filesystem set.

## Before and after

| Measurement | Before | After | Equal |
|---|---|---|---|
| `svn status` exit/hash | 0 / `6c99246af66b1a92dac67310b0195f5573768af119a9d47af87f777e80fba47f` | same | yes |
| `svn diff` exit/hash | 0 / `31ad2350596a6f5e0cb67c9c4199d33eaac49ed64fec9c67a4fbf3f26d27edd3` | same | yes |
| `svn proplist` exit/hash | 0 / `de6d9677554514dae0ea58d0f50d2fc4fa1756dca53ee58a85daf49545de73fa` | same | yes |
| `svn propget` exit/hash | 0 / `0b73371ac22b71adab2657eb287a5b78e1efe248b7f5fc83d712beeae505ae04` | same | yes |
| `svnversion` | `44701:44720MP` | `44701:44720MP` | yes |
| root inventory | 22 / `f454d47e8e4f5e305f70a61788dba347d4a3e053d623875545c1be1994b3d0ed` | same | yes |
| `.svn` inventory | 5,960 / `8fb3dc4905d4570a04d10746df252131352b817dd506ea51e9e3c73b69ebb13e` | same | yes |
| `svn info --xml` exit/hash | 0 / `30205e5da7b40d9d7b6acea9c433cf250ab014f5f887df1824889ec5dd7e40ca` | 0 / `76e7368a64bcdff675fcd99bd42c12320124854a92a91166314985a3ef113d7e` | **no** |

Status remained byte-identical and reported the same pre-existing state: four unversioned paths and two modified files in changelist `ignore-on-commit`. Those items were observed, not created or changed by this task.

## Conservative diagnosis

Two subsequent back-to-back local `svn info --xml` reads were byte-equivalent and exited 0. This suggests the earlier mismatch may be output volatility rather than a durable WC mutation. It does not erase the captured mismatch: the strict contract says any difference interrupts, and the identical administrative inventory cannot be used to waive that rule.

Review follow-up retained a deterministic command manifest at `phase-05-protected-wc-command-manifest.json`. It records the formal hashes, inventory definition, exact diagnostic argv, exits, byte counts, stdout/stderr hashes, and a ten-read `info --xml` series. That series reproducibly alternated between two 598-byte hashes with exit 0 and empty stderr, strengthening the volatility diagnosis without changing this verdict. The follow-up used only the same local read-only allowlist.

The original raw stdout/stderr was not retained and cannot be reconstructed. The
[prospective bundle contract](../svn-evidence-bundle.md) makes future captures
recomputable; it does not change this historical evidence or verdict.

## Cleanup decisions

- Local cleanup: **not run**. A protected-wc snapshot difference forbids both cleanups; task-owned lab roots are preserved without attempting ownership validation or deletion.
- Remote cleanup: **not eligible and not run**. Phase 4 was already `not-100%-complete`, and this UAT did not establish strict equivalence. The leaf `FORGE_SVN_PARITY_TEST_T20260824120158` remains preserved at its recorded state. No remote mutator or revalidation was invoked.
