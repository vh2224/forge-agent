# Verified PR validation reuse: design and current boundary

Issue #249 asks for lower measured PR-to-release latency and a design for safe
reuse. The implemented optimizations refresh observed shard costs, isolate the
remaining long agent-phase suite and preserve bounded timing artifacts. This
document specifies the reuse boundary; it does not enable CI skipping.
`forge-release-github.js` still requires successful exact-candidate `push` CI on
the configured default branch. All required checks, platform coverage, smoke,
known-failure comparisons, history/version validation and publication authority
remain enforcing. Missing evidence always means full CI.

## Why matching trees are insufficient

A PR run can test GitHub's synthetic merge commit instead of its advertised head.
Even equal tested file trees do not establish equal parents, tags, conventional
commit history, release version, event metadata, checkout depth, runner image,
toolchain, environment, permissions or publication authority. Source code may read
these inputs. A successful job or an uploaded JSON field is not a transferable
authorization. Reuse must be narrower than the existing exact-push release gate.

## Issuer and immutable evidence

A future issuer must be a specifically allowed repository/workflow revision,
verified independently of the candidate's own claims. It must capture the actual
checked-out commit/tree, PR head/base and synthetic merge parents before tests;
repository identities and fork status; event; immutable workflow/dependency
digests; run ID/attempt/job IDs; required suite universe/partition fingerprint;
toolchain and runner-image version; and declared external/environment inputs.
No caller-supplied `approved`, passing status or identical tree can replace this.

Issue an immutable attestation only after all declared jobs finish successfully.
Bind it to the exact source run attempt and artifact digest using a verifiable
GitHub issuer identity or equivalent trusted signing authority. The consumer must
verify the issuer/workflow policy, subject digest, artifact immutability and job
results against the authoritative API. An artifact's existence or its filename
alone is insufficient. Do not give fork PRs publication credentials to issue it.
Expired, deleted, superseded, ambiguous or unverifiable evidence falls back.

## Consumer and equivalence classes

The consumer runs under trusted post-integration publication authority, reloads
the integrated candidate and attestation, and verifies that the attested tested
tree equals the candidate tree. It then verifies every declared non-tree input
for each reusable check, not just a global repository fingerprint. The reuse
result is a check-specific decision bound to the candidate SHA, source run/attempt,
issuer policy revision and complete evidence digest. It grants no general merge,
worker or release capability.

| Check input class | Required treatment |
| --- | --- |
| Deterministic tree-only test with attested toolchain/image and closed inputs | Potentially reusable only after complete attestation and equivalence checks |
| Parents, tags, version, conventional history, merge metadata or event | Rerun on integrated candidate unless those exact inputs are separately proved equivalent |
| External service, mutable dependency, clock, secret, permission or undeclared environment | Rerun; tree equality cannot prove equivalence |
| Release coordination, final candidate freshness, publication rights, tag/package/install verification | Always retain under current trusted publication authority |
| Unknown input classification or incomplete required-job coverage | Full CI fallback |

Current suites contain history/version and environment-sensitive cases. There is
no reviewed executable issuer/consumer or closed tree-only check inventory yet;
therefore this release retains full exact-push validation. Do not wire a shortcut
into `validateRun` before those components and their independent review exist.
The design deliberately avoids a second permissive path based on tree equality.

## Required negative matrix before activation

Refuse forged/unsigned attestations; changed artifact bytes; wrong issuer,
repository, fork, workflow/dependency digest, event, commit/tree, PR base/head,
synthetic merge parent, candidate, run attempt, toolchain/image, partition or suite
universe; failed/missing/skipped required jobs; superseded/deleted evidence;
changed history/tag/version/environment input; and unknown classifications.
Test API pagination, repeated jobs, retry/attempt confusion, reordered or duplicate
evidence, outage/rate-limit fallback and candidate movement during verification.
Every refusal preserves the ordinary full CI route and cannot publish a release.

## Measurement

Use completed API run/job timestamps for elapsed PR-to-release time, distinguishing
queue, overlapping jobs and publication delay. Sum job durations separately as
aggregate runner time; it is not wall time or an invoice. Compare strata with the
same platform, image/toolchain, shard count, suite universe and cache observations;
state changes that prevent a controlled comparison. The structured suite profiles
contain timings/provenance only, not child stdout, prompts or environment dumps.
Shard replay predicts an allocation from historical costs; report actual completed
CI durations separately and never label a prediction as a measured speedup.
