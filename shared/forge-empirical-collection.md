# Private empirical collection

This tool composes the corpus, bounded source, historical SVN and split contracts.
It does not discover personal queues, authenticate, update checkouts or install Forge.
The caller owns roots, network posture, classification and historical acceptance.
Imported manifests grant no capability, roots, commands or increased budgets.

## Owner inputs

Prepare a private JSON input with `catalog`, `captures`, `freeze_id`, `reserved_count`.
The catalog follows `shared/schemas/empirical-corpus.schema.json` exactly.
Every candidate has its canonical `caseIdentity` identity and explicit selection reason.
Initialize references as missing; the collector records actually captured bytes.
Claims, metrics and stratum classifications need explicit owner-reviewed sources.
No parsing of prose into successful delivery, installation or human acceptance occurs.

Each capture has `id`, `root`, `path`, `type`, `format` and usually `ref_id`.
IDs use ASCII letters, numbers, underscore or hyphen, at most 64 characters.
Paths are relative to the caller-supplied root and cannot contain traversal or flags.
Literal @ characters are supported, including versioned directories and repeated @.
Supply the unencoded relative path: the SVN reader percent-encodes each segment,
then appends the separately validated numeric peg revision.
`type` is local or svn; `format` is raw, json or jsonl.
SVN captures add `request` with operation info, log, list or cat.
Except for local info, requests require numeric string `revision` and `peg`.
Only log can additionally supply numeric `endRevision`.
An info capture may omit ref_id; schedule it before historical reads on that root.
No free arguments, environment, executable, shell or credentials are accepted.

The owner creates its milestone evidence directory before initialization.
Pass roots separately, scoped to the exact selected unit directories.
The private manifest must be directly in the milestone evidence directory.
The private input should also remain in owner evidence, outside public source control.

```powershell
node scripts/forge-empirical-collect.js --init --owner C:/private/owner --milestone M001 --input C:/private/owner/.gsd/milestones/M001/evidence/input.json --manifest C:/private/owner/.gsd/milestones/M001/evidence/manifest.json --root source=C:/private/source/unit --capability offline
node scripts/forge-empirical-collect.js --collect --owner C:/private/owner --milestone M001 --manifest C:/private/owner/.gsd/milestones/M001/evidence/manifest.json --root source=C:/private/source/unit --capability offline
```

For historical collection, additionally declare repository and working-copy subtree:

```powershell
node scripts/forge-empirical-collect.js --collect --owner C:/private/owner --milestone M001 --manifest C:/private/owner/.gsd/milestones/M001/evidence/manifest.json --root history=C:/private/history --svn history=https://example.invalid/repository,https://example.invalid/repository/subtree --capability networked
```

These are generic examples; supply reviewed private inputs and real roots separately.
Network posture is an explicit operation by the authorized owner, not an imported flag.
Offline SVN info only observes local working-copy identity; historical HTTPS never starts.
The bounded T02 reader controls argv, byte limits, command count and elapsed budgets.
Its configured synchronous timeout is not a universal process-tree wall-clock guarantee.
Missing credentials or SVN remain gaps; never repair evidence checkouts automatically.

## API and private publication

`initCollection(input, trusted)` returns a validated serializable manifest.
`collectCorpus(manifest, trusted)` returns private collection metadata and private_root.
`trusted` contains owner, milestone, roots and explicit offline/networked capability.
Root rows have id/path and, for SVN, repository/subtree identities.
Optional limits can only reduce T02 defaults; runner is an API-only test seam.
Neither runner nor limits can be loaded from an imported manifest.
`validateCollectionInput(catalog, graph, trusted)` delegates to T03 graph validation.
Supply digest-bound prework availability and the exact persisted split for that step.

The tool publishes immutable selection.json, catalog.json, provenance.json and collection.json.
They live under evidence/corpus/run-IDENTITY, with separate capture directories.
Snapshots are physically separated by prework, grader, reserved and unknown region.
All files use exclusive creation; the tool never overwrites an earlier capture or freeze.
An identical validated replay returns the earlier collection and checks snapshot hashes.
Changed source bytes or capture outcomes create a different collection identity.
Replay performs bounded source reads again, so it checks current source availability.
Additional capture attempts remain private and do not overwrite published evidence.
CLI stdout contains opaque IDs, counts, hashes and reason codes only.
API private results must never be pasted into implementer context for real reserved cases.
Diagnostics omit raw source text, credentials, URLs and private paths.

## Selection and acceptance

Record all exposed families before reserved selection, including the six declared seeds.
Discover at most 200 directory names within the authorized date interval separately.
Rank identities using the recorded T03 family hash policy before reading outcomes.
Select no more than two new eligible families; do not select using observed success.
Unknown eligibility or insufficient sources remains an explicit gap.
The collector preserves imported excluded decisions and marks failed coverage insufficient.
The T03 split never selects an already exposed family as reserved.
The collector's ready flag describes structural corpus coverage, not historical acceptance.
Owner verification separately proves success, return/failure and simple-control strata.
Owner verification must also prove two new reserved families before comparative freeze.
Preserve functional success separately from operational exceptions and UAT.
For removed artifacts, capture at their known numeric operative and peg revisions.
Use a numeric log interval to observe removal; removal does not establish its cause.
Record version declaration, component equality, release and complete installation separately.
Equal bytes prove integrity/component equality, never installation of every dependency.
Compare historical components with authorized git show reads without checkout changes.
Record exact revisions, argv, hashes, timestamps with timezone and source limitations privately.
Owner records before/after readonly checkout checks and concrete gaps for final delivery.
Synthetic tests only prove the pipeline; they cannot satisfy real historical truths.

## Replay, freeze and publication checks

Collection replay compares freshly validated readiness, counts, gaps and capture
identities with the persisted result, then rechecks the stored snapshot and document
hashes. Altering a derived result does not create a valid replay.

Each baseline row identifies the canonical case/version pair; multiple versions
remain distinct while coverage denominators still count deliveries. Coverage lookups
use that same pair. A split records earlier adjustment exclusions when advancing to
a new freeze, and reuses them when regenerating its own persisted record.

Freeze inventory includes the transitive modules actually executing validation and
measurement, plus the schema and templates. Run the freeze/verify script from the
same physical code root passed as code-dir, including when using an isolated worktree.
A different executing root or changed dependency refuses verification. Regenerate a
new freeze after reviewed code changes; earlier freezes remain immutable.

Verbose SVN logs may include sibling paths from the same commit. Both changed and
copy-from paths must stay inside the caller-authorized subtree; mixed commits are
rejected before capture. A log gap does not authorize widening that subtree.
JSON documents each consume one record from the same cumulative session budget used
by JSONL records. An autonomy compatibility limit does not discard the documentary
snapshot, and never increases the canonical autonomy cap.

Publication audit scans working bytes, diffs and each exact index blob with bounded
readonly Git queries, including NUL-containing and attribute-marked binary content.
It records the index mode, object ID, byte count and SHA-256, then rechecks index
identity and blob hashes before returning. Reviewed synthetic working bytes exempt
only an identical reviewed index blob from the generic sensitive-content finding;
private-content matches always fail.
