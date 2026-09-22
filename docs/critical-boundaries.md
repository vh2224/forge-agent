# Persistence, locking and Git boundaries

These contracts address audit findings A1–A8 from the September 2026 critical
review. Tests use isolated temporary stores and repositories.

## Credentials (A1)

`forge-secrets.js` treats only `ENOENT` as an empty registry/fallback store.
Unreadable files and invalid JSON/schema raise `VAULT_UNREADABLE` or
`VAULT_INVALID`, preserving the previous bytes. A vault mutex serializes the
complete operation; its lease is not stolen by age. A provably dead local PID
can be reclaimed. Publication uses an exclusive `0600` temporary file, `fsync`
and a rename in the same directory.

An intent journal coordinates the backend value with registry metadata. It
contains intended metadata and a secret digest, never the secret itself. A
pending journal blocks registry reads and unrelated mutations; probes return
`unknown`. Run `node scripts/forge-secrets.js --recover` to verify the intended
backend result and finish publication. If the backend operation never finished,
repeat the original add with the same secret on stdin, or the original remove.
Recovery does not silently repair corrupt files; restore or repair those first.

A crash during guard initialization can leave a directory without owner metadata;
this cannot be distinguished from a live initializing writer. Ordinary mutations
report `VAULT_GUARD_INCOMPLETE` and never steal it by age. Stop **all** vault writers
and contenders before `--recover --confirm-stopped`. This archives the exact guard
directory and prints its evidence path, then performs normal journal recovery.
The library equivalent is `recover({ confirmStopped: true })`, returning
`{ recovered, guard_evidence }`; ordinary `recover()` retains its boolean result.
The confirmation is an operator assertion that writers are stopped, not automatic
proof of process inactivity.

If an operation committed but its mutex cleanup fails, it raises
`VAULT_GUARD_RELEASE_FAILED` instead of reporting full success. The same explicit
recovery can archive an interrupted release: when metadata remains, its exact
owner-token `.released` marker must exist and the active marker must be absent.
Other metadata-bearing owners are not removed by this maintenance operation.

These tests do not exercise a real macOS Keychain or prove power-loss durability
of filesystem directory metadata.

## File locks and old writers (A2, A5)

`forge-filelock.js` reports corrupt JSON, incompatible metadata and read failures
as held/unknown, with `lock_invalid_json`, `lock_invalid_metadata` or
`lock_read_failed`. Acquire, renew and release do not overwrite these states.
Valid locks retain token/generation ownership and holder-liveness checks.

New filenames are `v2-<SHA-256 of canonical path>.json` (72 ASCII bytes).
Temporary and recovery basenames remain below the exported 160-byte ceiling.
The canonical readable path remains in metadata; Unicode normalization and
separator aliases continue to share one identity. This bounds components, not
the total length of the project's own absolute path.

The original `filelock-<digest>` mutex remains held for the entire v2 lock
lifetime with a persisted, effectively unbounded TTL. A separate v2 mutex
serializes current operations. Consequently an old writer cannot mistake the
missing base64 filename for permission to write, even after the originating
process exits. Only proven absence of the v2 file permits release of this
compatibility mutex. A current client can resume an interrupted publication
or recover an expired lock through the retained mutex; an old client cannot.

Existing base64 entries are refused as `legacy_lock_present`. Let the old
owner release normally, or stop all writers and explicitly recover:

```text
node scripts/forge-filelock.js --cwd <project> --recover <target> --confirm-stopped
```

The API equivalent is `recoverFileLock(cwd, target, { confirmStopped: true })`.
This acknowledgement means writers have actually been stopped. Recovery renames
the damaged/legacy record to the returned `.recovery-<UUID>` evidence path and
retains its exact bytes. Valid v2 ownership still requires normal token-based
release; a known live or unmeasured legacy owner is refused. Never delete the
compatibility mutex merely because its process exited or its age is large.
The baseline implementations under `scripts/fixtures/filelock-v1` test both
old-first and new-first acquisition, process exit and subsequent recovery.

The existing `--recover --confirm-stopped` also handles interrupted initialization
or release of either the compatibility mutex or the v2 operation mutex. It returns
separate `guard_evidence` and `operation_guard_evidence` paths when applicable.
All writers and contenders must be stopped first; ordinary acquisition does not
guess that metadata-free compatibility guards are abandoned. Guard release
failures raise `GUARD_RELEASE_FAILED` when the file operation otherwise succeeded;
if the file operation already failed, its original error/result is preserved with
an additive `guard_release_failure` diagnostic. Retry only after inspecting the
operation result and recovering the guards, since the file mutation may have
already completed. The shared `recoverIncompleteLock` helper preserves residues
instead of deleting them and refuses intact metadata owners.
For the short v2 operation mutex and the legacy v1 compatibility process mutex
(5-second TTL, no run holder), explicit recovery may also archive a complete
owner proven dead by `ESRCH`. Live processes, absent PIDs and unreadable process
liveness remain protected. The compatibility eligibility predicate is evaluated
against the recovery helper's own metadata snapshot. This exception is never
applied to the durable v2 compatibility fence, whose creator may legitimately
have exited. All paths still require `--confirm-stopped` after stopping writers.

`forge-yaml-safe.writeAtomic` propagates guard-release failures even when its
target rename completed. If writing also failed, the original error is preserved
with an additive `guard_release_failure` diagnostic. Directory creation is inside
the same release-protected scope, so a failed mkdir cannot strand the file lock.

## Git execution and worktree reuse (A3, A6)

`forge-git-process.js` invokes native Git with an argument array, `shell: false`,
noninteractive input and a default 15-second timeout. Branch validation uses
Git's reference validator and refuses option-shaped input. Valid metacharacters
remain literal arguments. Package-manager commands and user shell commands use
their existing, separate execution contracts.

An existing directory is reusable only if Git confirms its canonical root,
common repository, expected branch and worktree registration. Refusals include
`not-a-worktree`, `not-worktree-root`, `wrong-repository`, `wrong-branch` and
`unregistered-worktree`; these directories are not deleted or repaired by setup.
A valid existing worktree remains `already-exists`, with dependency installation
skipped under the existing reuse contract.

New provisioning writes a journal in the common Git directory before creating
the worktree. An interrupted checkout is refused on retry with the journal path
for inspection; setup never resets or deletes user files. Failed dependency
installation is retried until successful (or explicitly disabled). The journal
is removed only after provisioning completes. Existing worktrees without this
journal retain legacy reuse behavior. Attaching a borrower validates every
lender repository, registered path and recorded branch, and rejects pending
provisioning or incomplete identity records.

## Grouped reads and projection freshness (A4, A7)

Memory, ledger and decision listings attach a non-enumerable parsed payload to
each grouped entry. Reading that entry reuses its operation's snapshot instead
of rereading/parsing the whole container per member. Keep the entry only as long
as that snapshot is needed; list again to observe later edits. There is no global
cache. Public JSON rows, member ordering, loose-fragment precedence, namespaces
and invalid-container diagnostics retain their contracts.

Projection receipts live in local `.gsd/forge/projection-state.json`. They record
source membership, size, mtime and content digests, output digests, and renderer
source identity. Deletion, rename, grouping, checkout and renderer changes
invalidate freshness. Failed inspection reports stale; it never proves fresh.
Publication uses the existing atomic writer and checks source signatures before
and after rendering. A crash before receipt publication leaves a rebuildable
projection that will be checked again.

Deleting the final fragment clears a previously generated projection only when
its prior receipt matches the output, including when a checkout removes the
entire source directory. Modified outputs and unreceipted monoliths remain protected.
An untracked populated legacy monolith retains its migration guard. Receipt
deletion is safe but removes freshness evidence; rebuild to establish it again.

## Update status (A8)

`forge-update-check.js` distinguishes `equal`, `behind`, `ahead`, `diverged` and
`unknown` using Git ancestry. Merely possessing the remote commit is insufficient.
Behind/diverged states indicate an available update. Cache files in the temporary
directory are keyed by canonical repository identity, with a ten-minute TTL.

Status rendering returns cached state immediately and schedules a background
refresh when needed. Git commands in the refresh have two- or five-second
timeouts; rendering does not wait for network I/O. The refresh may fetch a missing
commit object without advancing the checkout. Network/ancestry failures record
`unknown` while retaining the last known update indication for the same local
commit. A changed checkout clears the old indication; an initially empty
cache is unknown rather than evidence that the checkout is current.
