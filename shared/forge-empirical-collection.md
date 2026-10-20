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
The T02 path contract also rejects literal @ characters, including versioned directory
names; report this limitation rather than encode or bypass the validated reader.
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
