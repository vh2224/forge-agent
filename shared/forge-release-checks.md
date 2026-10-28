# Exact-SHA release checks

This contract defines the source policy and read-only decision APIs in
`scripts/forge-release-checks.js`, using `scripts/forge-release-policy.js`.
It does not publish tags/releases, authenticate imported JSON or create receipts.
T02 supplies current authenticated API facts. T03 owns fresh prepare/receipt/apply.
T04 installs the master-only bootstrap before any candidate file executes.

## Candidate origin

`resolveCandidate(context, {cwd, spawnSync})` accepts a trusted context containing:

- `authenticated_repository`: the authenticated API repository's numeric `id` and `full_name`.
- `repository`: the trusted runner repository identity, matching that repository.
- `event_name: 'push'`, `ref: 'refs/heads/master'`, and the complete push `event`.
- `event.repository` with matching id/name and `fork:false`, `event.deleted:false`.
- `event.ref: 'refs/heads/master'`, full `event.before` and `event.after` SHAs.
- `github_sha`, `candidate_sha` and `event.after`, all exactly the same full SHA.
- `trusted_master_sha`: independently observed master, never a replacement candidate.
- `workflow_ref: owner/repo/.github/workflows/release.yml@refs/heads/master`.
- `workflow_sha`, exactly the candidate SHA.

It verifies candidate ancestry under the observed master using Git and checks
checkout HEAD exactly. Master may have advanced; candidate identity stays fixed.
Tag events, PR heads, synthetic merge refs, foreign repositories, forks and wrong
workflow provenance fail before any Git read in this module's rejection cases.
An ancestry/checkout failure also blocks. No candidate script is run by these APIs.
Loading this file from a candidate cannot itself authenticate the chosen workflow;
the trusted workflow bootstrap must precede candidate Node execution.
An existing same-SHA tag can be inspected independently through the master route.
Its existence never authenticates tag-selected YAML or bypasses the gates.

## Git blob source policy

`assertPolicySources(candidate, {cwd, spawnSync, policy})` reads these committed sources:

- `.github/workflows/ci.yml` (lookup filename `ci.yml`).
- `.github/workflows/app.yml` (lookup filename `app.yml`).
- `.github/workflows/release.yml` (source-pinned; not an awaited remote gate).

Git argv reads `candidate_sha:path` through `rev-parse --verify` and `cat-file blob`.
The blob OID identifies the Git object; SHA-256 hashes its exact content bytes.
A full workflow path is distinct from its API lookup filename or numeric workflow ID.
Checkout EOL normalization and HTTP metadata are never sources for committed bytes.
Reads have `shell:false`, a 30-second timeout and a 4 MiB maximum buffer.
Missing objects, nonzero exit, signal, timeout or truncated output fail closed.

Every workflow has a reviewed full-byte pin and a semantic job mapping. The
bounded job-header reader checks exact keys, names, runner, needs and matrices.
It also supports explicit job `permissions` with exactly contents read/write and
actions read, checked against `job.permissions` in the policy. This bounded form
supports T04's read-only coordinator and write publisher, scalar needs and job
timeout, while rejecting missing, duplicate, unknown or broader permission forms.
Only the documented scalar/include/cartesian header forms are supported; unknown
YAML forms or expressions fail until deliberately implemented and tested.
Matrix rendering supports `${{ matrix.KEY }}` substitution, requiring unique names.
The returned source record carries candidate, policy digest, blob identity and
expanded semantic rows. `policyDigest()` hashes the versioned policy value, including
its local inventory; T03 binds it to the freshly generated receipt.
The source-pinned Release has the fixed `coordinator` and `publisher` jobs.
Their distinct names and explicit permission mappings are bound to the blob pins.
Release is source policy only and is never an awaited remote gate.

## Required remote matrix

| Workflow/key | Rendered API names | Kind |
| --- | --- | --- |
| CI / operational-offline | Offline both / linux, darwin, win32 | 3 native |
| CI / test | Tests (ubuntu-latest), Tests (macos-latest), Tests (windows-latest, shard 1/2), Tests (windows-latest, shard 2/2) | 4 native/sharded |
| CI / required-offline-windows | Offline claude / linux, darwin, win32; Offline codex / linux, darwin, win32 | 6 aliases needing operational-offline |
| CI / required-tests-windows | Tests (windows-latest) | 1 alias needing test |
| app / app | Swift app and PTY regressions | 1 native, macos-26 |

There are 14 CI executions; seven aliases do not replace seven native executions.
A numeric API job ID identifies an execution, never the semantic YAML job key.
The API does not provide that key; mapping uses the pinned source and unique name.

## Complete push diff and applicability

`resolveApplicability(candidate, {cwd, spawnSync})` requires authenticated origin.
It reads `git diff --no-ext-diff --no-textconv --no-relative --ignore-submodules=none --name-only --no-renames -z before..after --`.
The full push interval includes every commit, deletions and both rename paths
(renames are represented as delete/add). Payload commit arrays and HEAD^ are unused.
Relative-path and ignored-submodule user config cannot hide part of the interval.
NUL-delimited bytes are hashed, measured and decoded with strict UTF-8. Newlines
inside paths are retained. Unknown or malformed paths require app, never N/A.
Zero/missing before, absent Git objects, timeout, overflow, explicit truncation or
unterminated NUL output yield an unavailable interval and require app.
Every nonempty diff requires app, including docs and unknown future paths.
Only a complete authenticated empty interval, with exact range/size/digest, allows N/A.
An unknown origin blocks separately; an unavailable interval cannot invent origin.

## Pure evaluation facts

`evaluateChecks({candidate, applicability, sources, workflows}, policy)` performs no IO.
`workflows.ci` and, when applicable, `workflows.app` each contain:

- `metadata: {id, path, state:'active'}` from authenticated workflow discovery.
- `run: {id, workflow_id, head_sha, head_branch:'master', event:'push', repository,
  run_attempt, status, conclusion}` from the chosen run.
- `current_attempt`: independently collected latest attempt, exactly `run.run_attempt`.
- `jobs_complete:true`: collector has proved complete pagination for that attempt.
- `jobs: [{id, run_id, head_sha, name, status, conclusion}]` from that attempt's endpoint.

The collector must obtain fresh latest-run/attempt facts; fabricated completeness
flags or stale imported records are not authority. No nonexistent job `run_attempt`
or job key is required or fabricated. Do not union jobs across attempts.
Every applicable run/job must be `completed/success`. Missing, skipped, neutral,
failure, cancelled, timed_out, queued, pending and unknown values block.
Duplicate names/IDs, unexpected jobs, wrong workflow/repository/SHA/run or incomplete
coverage block. A successful older attempt cannot satisfy a newer attempt.
N/A is a complete-empty applicability decision; skipped is never promoted to success.
The result has `allowed`, `reasons:[{code,detail}]`, `checks`, candidate and policy
digest. Each check records workflow ID, run, attempt, semantic key, unique rendered
name, numeric execution ID and native/alias kind for downstream reporting.

## Preserved local gates and evolution

The policy enumerates version --check, clean/stable tree and HEAD, six HOSTS Ãƒâ€”
PLATFORMS cells and the actual suites from `forge-offline-ci.MATRIX`, three
regenerations, package/checksum and concrete securityAudit. T03 validates full local
report schema independently; this remote evaluator does not treat report.ok as proof.
Offline simulation never replaces native CI. Real provider smoke remains opt-in.
CI success means no new failures and no stale entries in its versioned baseline;
it does not redefine success as zero failing suites. Suite discovery is not fixed
at S01's historical count of 302; the offline baseline currently has eleven suites.
S04 may change source/jobs/coverage only with coordinated pin/mapping changes,
dependency evidence and negative fixtures. Merely changing a pin without updating
the semantic mapping fails source validation. Unknown paths stay conservative.

Tests use fake Git/remote facts and read-only real Git blob checks. They establish
local decision behavior, not live GitHub CI, branch protections, merge, installation
or human acceptance. A trusted runner remains an assumption. Same-UID compromise
and atomicity against external publication writers are outside this module's proof.


## Installed master route and operations

Release starts only from `push` on `refs/heads/master`.
Tag creation alone does not schedule Release; no tag-selected workflow is trusted.
Existing exact-SHA tags and releases still pass through the complete master barrier.
S08 resolves version and notes together with `forge-release-version.js --check --github-output --notes`.
S08 keeps label-based semver and declared-version checks; --check blocks impact-label-conflict/impact-invalid (see shared/forge-release-impact.md).
The original Breaking Changes, Features, Bug Fixes and Other Changes order remains.
S08 classifies full commit messages via the helper, including breaking signals in bodies, without shell evaluation; notes are saved under runner.temp.

Both jobs have a fixed master checkout, fetch-depth 0 and persist-credentials false.
Only fixed checkout/setup-node actions and inline builtin/Git context checks run first.
The bootstrap checks repository numeric ID/full_name against the trusted runner,
fork false, push/master, nondeleted event, complete equal after/SHA/workflow SHA,
and the exact master workflow_ref before loading any candidate source script.
Git then verifies ancestry under the observed remote master.
The candidate output is always the original complete event SHA.
A second checkout selects that exact SHA, followed by a HEAD equality check.
Advancing master never silently swaps the candidate.
This depends on trusted master workflow/runner context, not self-authentication by
arbitrary tag YAML. Remote branch protections have not been observed by this work.

The bounded event payload is copied with exclusive creation into RUNNER_TEMP.
Helper commands set GITHUB_EVENT_PATH explicitly with a fixed shell assignment.
No runner GITHUB_ENV or step env override of reserved GITHUB_* is assumed.
The copy supports the publisher's real containment/stable-read requirements.
GITHUB_OUTPUT must also physically reside under RUNNER_TEMP, as on hosted runners.
An unsupported runner layout fails closed and needs deliberate integration review.

Coordinator has contents:read/actions:read; publisher needs coordinator and has
contents:write/actions:read. That permission is job-wide, including actions that
can access github.token even without a visible GH_TOKEN environment variable.
persist-credentials:false prevents stored checkout credentials, not job privilege.
The authenticated GET-only wait is a separate coordinator step with GH_TOKEN.
Its collector shares an explicit 30 minute deadline and never waits for Release.
A subsequent prepare has empty GH_TOKEN/GITHUB_TOKEN and rejects other secret env.
It generates local gate/report/receipt together with scrubbed child environments.
The publisher independently resolves notes and runs its own token-free prepare.
No report, receipt, nonce or artifact is transferred from coordinator to publisher.
Only the final apply receives explicit GH_TOKEN in the publisher.
This is credential propagation discipline; it is not a privilege sandbox.

## Receipt, retry and residual races

Prepare binds the physical checkout, policy/source digests, complete candidate SHA,
report/notes/package bytes, repository/workflow identity and current run/attempt/job.
The unique fixed job key plus current authenticated run/attempt is the job identity.
Receipt TTL is ten minutes after generation; each job timeout is 45 minutes.
Apply receives only that prepare step's state/nonce outputs, never an imported report.
It validates identity, containment, unchanged clean HEAD, source bytes and expiry,
claims the receipt once exclusively and rechecks current gates around each effect.
Apply never regenerates offline evidence or mints a replacement receipt.
An old report, expired/cross-job receipt or double apply cannot authorize effects.
A retry needs fresh preparation; it cannot renew the old receipt or switch SHA.
The nonce is continuity evidence, not an authenticated signature against same-UID
code capable of inventing runner context or modifying files under the same account.

Existing tags are inspected/peeled against the exact candidate and never moved.
Existing releases require matching tag/repository identity and the entire barrier.
A missing tag uses explicit full-SHA ref creation; release uses verify-tag/readback.
Conflicts require exact readback; neither target_commitish nor --verify-tag alone
proves an existing tag's commit. No force, deletion or rollback masks divergence.
After partial effects, preserve state/consumption and sanitized failure diagnostics.
Separate HTTP operations leave an external writer race; publication is not atomic
without independently enforced server protection. This work does not prove one.

Release concurrency group remains release with cancel-in-progress:false.
It avoids cancellation of active publication; pending runs may still be replaced.
It is not durable FIFO and cannot promise that every push publishes.
Timeout, missing evidence and partial reruns all block rather than count as pass.
Remote aliases never replace the native CI cells or native macos-26 app execution.
The app is now scheduled for every master push; only push.paths was removed.
PR filters, app job/name/runner, cache, Swift build and real PTY command remain.
This conservative coverage can increase cost/latency; no efficiency gain is claimed.

## Evidence levels and future slices

The workflow harness reads real YAML, rejects unsupported step forms, executes its
inline bootstrap/HEAD bodies and the real version/notes argv in a temporary Git repository, without inline changelog, and dispatches helper entrypoints
through controlled argv and productive prepare/apply with fake transport/effects.
Its temporary Git index/object tree checks final blob bytes without changing the
real checkout/index. It does not publish or exercise a remote GitHub runner.
Full-schema fixtures cover six local cells, eleven suites and three regenerations.
Local simulated selectors are distinct from native Windows/macOS jobs.
CI baseline semantics remain no new failures and no stale known-failure entries.
A clean committed full local gate is run by the owner; a dirty worktree is pending,
never an allowDirty pass. Suite discovery remains dynamic through run-tests --list.
Implementation, local simulation, remote CI, independent review, merge, installation
and human UAT are independent facts. Remote CI/review/UAT remain pending unless
separate concrete evidence establishes each one; local positives cannot infer them.
S04 may narrow coverage only with proven dependencies, negative fixtures and joint
policy/mapping/pin updates. Unknown paths remain conservative until then.
S08 changes only the version/notes steps of this route; note generation now depends on the candidate helper from the same validated SHA, without an individual script pin. Markdown and URLs remain arbitrary data passed to gh --notes-file, bounded by the existing 4 MiB prepare limit.
S09 consumes explicit evidence/acceptance and may not turn a simulated pass into UAT.

## S04: CI concurrency and observed shard profile

CI and app now declare workflow concurrency between permissions and jobs. Fresh
pull_request arrivals share ci-pr-<number> or app-pr-<number>, respectively, with
cancel-in-progress true only for pull_request. Every other event gets a unique
ci-run-<run_id> or app-run-<run_id> group. This preserves independent master push
validation for the exact-SHA release collector: a newer push cannot cancel or
replace an older push through these groups. Group inputs are only event_name,
the PR number and run_id, with distinct workflow prefixes; no head_ref, title or
other author-selected string is evaluated. No job concurrency is introduced.

The fixed-path, builtin-only forge-ci-concurrency reader accepts only reviewed
group/cancellation scalar forms and rejects unknown keys, including queue. Its
local rehearsal reads the actual three workflow byte sequences, records SHA-256
and models fresh-arrival bursts with one active and one pending run per group.
Cancellation latency and waiting for cancellation completion are model assumptions,
not observed GitHub scheduler behavior. Invariants are checked at multiple latency
choices; this does not measure GitHub timings. The official concurrency reference
consulted on 2026-10-25 is
https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency.
No queue option is used or verified. Older manual reruns of PR attempts may share
the current head's group; preservation of the newest head in that case is
unverified and excluded from fresh-arrival claims. Separate hosted validation is
pending, including cancellation, remote check consumers and rerun behavior.

S08 updates both release workflow byte pins together; exact reversal preserves the historical S04 evidence. Group release and
cancel-in-progress:false preserve active publication. The existing limitation
release-pending-may-be-replaced remains: a third arrival can replace a pending
candidate while the first publishes. This is not durable FIFO and does not
promise publication for every push. No collector deadline or queue policy changes.
The seven CI aliases remain unchanged; their always() behavior on cancelled PR
runs may leave failed checks on superseded SHAs, an expected effect to observe in
hosted validation. Unknown remote consumers are not evidence to remove a check.
The app's existing PR path filter, cache, build and PTY commands remain unchanged;
cache population after cancellation is unverified and is a separate measurement
stratum. Master still schedules app for every push.

Run test suites keeps its known-failures baseline and now passes
--shard-profile scripts/fixtures/ci-shards/shard-profile.json before the final
shard-index/count flags. The versioned profile is read from the checkout as
bounded, closed-schema data; it is never generated or downloaded by CI. Every
test matrix platform/count partitions the full discoverTests universe completely
and disjointly, with consistent partition fingerprints across indices and no
fallback when this profile is present. New unprofiled suites receive the default
weight; stale entries are reported, not manually repaired. No selection by path,
changed, match or fail-fast flags is introduced. CI triggers have no path filter.

Job keys, rendered names, runners, needs, all 14 CI executions plus app, matrices,
seven aliases, two Windows shards, offline gates, SVN provisioning and smoke
steps remain unchanged. Section 76 of the smoke receives structural checks here;
the full smoke is not executed by this task. CI/app SHA-256 and Git blob SHA-1 pins
are updated together with this workflow change and unchanged semantic mappings.
Until the owner commits those bytes, the release-checks suite must take
pending-source-drift-rejected-at-committed-head rather than claim a committed gate.
S02/offline local tests, the rehearsal and shard partition checks provide local
evidence only. No coverage reduction, hosted performance improvement, remote
protection, publication, installation or human UAT is established by this S04 work.

## Cross-event CI reuse (#249): design, not enabled

### Status

Cross-event reuse is not enabled. The only path is the exact-candidate
push/master barrier (`collectChecks` → `evaluateChecks`); it is the full CI fallback.
There is no eligible item, no reuse manifest in `POLICY`, no reuse API,
no new workflow and no new permission. Job counts come from `POLICY`; the
collector bound comes from `DEFAULT_LIMITS.deadlineMs`. Neither changes here.
No latency or runner-time gain is claimed. Implementation, local tests, hosted CI,
review, merge and UAT remain separate facts; this design establishes none of them.

### Threat boundary

Trusted: the `release.yml` bootstrap on master for a push, the authenticated GET
facts read by the coordinator, and the blob pins and `policyDigest` at the exact SHA.
Hostile: everything a `pull_request` run executes or emits. Its workflow and
permissions come from the PR merge commit, so a same-repository author controls
steps, names, logs, artifacts, uploaded JSON, check/status names and aggregates.
Also hostile: embedded `pull_requests[]`, the PR `merge_commit_sha`, tree equality
and ancestry arithmetic.

### Observed API evidence (2026-10-28)

- Run 40619617436 had head_sha 987cd55e…, but `pull_requests[0].head.sha`
  already named d067c1d4…, the later PR267 head. Embedded metadata is mutable.
- Run 40623979994, attempt 1, job 122604819731 and its check suite exposed only
  head_sha d067c1d4…. No enumerated key carried the tested merge SHA. This is a
  limitation of those endpoints as observed, not proof that no such field exists.
- The events reference
  (https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
  states that `pull_request` `GITHUB_SHA` and checkout use `refs/pull/N/merge`;
  the run head is therefore not the tested commit.
- The merge ref is recomputed when the base moves. A squash merge has other
  parents and possibly another tree.
- OIDC (https://docs.github.com/en/actions/reference/security/oidc) offers signed
  claims such as run_id, run_attempt, workflow_sha, job_workflow_sha,
  repository_id and runner_environment.
- Attestations (https://docs.github.com/en/rest/repos/attestations) require
  signature, timestamp and signer verification by the consumer.
- None of this was validated experimentally here. Signed claims do not prove
  that a suite consumed particular inputs or that it passed.

### Rejected provenance

Alone or combined, these are not proof:

- status or check names;
- aggregate checks and `always()` aliases;
- artifacts, logs, uploaded JSON and job outputs;
- tree equality;
- ancestry or tree arithmetic;
- `pull_requests[].head.sha` / `pull_requests[].base.sha`;
- `merge_commit_sha` as history;
- a PR run head_sha as the tested commit.

### Input classification

The eligible set is empty. Default class: exact-only.

| Unit | Class | Reason |
| --- | --- | --- |
| `Tests (*)` jobs | exact-only | Mix `run-tests.js` with baseline, `forge-release-version.js --check` (Linux, tags and history, `fetch-depth: 0`), `forge-smoke.js` (non-Windows, shard 0) and SVN provisioning; the API gives only the job conclusion. |
| `Offline both / *` | exact-only | Not audited; `fetch-depth: 0`. |
| `required-*` aliases | never evidence | Aggregates over needs. |
| App Swift/PTY | exact-only | Not audited; the PR path filter may leave the run absent. |
| Version/semver/impact labels, diff/applicability `before..after`, release gate, prepare/apply/publication | always exact-only | Read history, refs or the exact candidate. |
| Individual suites | unclassified, so exact-only | No independence audit exists. |

Future rule: the unit is one explicit check in its own job, whose API job
conclusion is the only evidence. It needs complete declared inputs, a test of
independence from history, tags, refs, `GITHUB_EVENT_NAME` and `GITHUB_REF`, and a
reviewed manifest in `POLICY` (which changes `policyDigest`).

### Attestation and consumer boundary

- The issuer never executes candidate code: a separate job or a reusable
  workflow pinned by full master SHA, with no caller inputs.
- The issuer signs repository_id, run_id, run_attempt, job ids, the tested
  commit, blob OIDs of the pinned workflows and of each declared input, the
  runner environment/image and `policyDigest`.
- The consumer in the push/master coordinator fetches it through the
  authenticated API and verifies signature, timestamp and a pinned signer.
- It also requires: same-repository PR, merged, base master, `merge_commit_sha`
  equal to the candidate, `fork:false`; a `pull_request` run of the pinned
  workflow, `completed/success`; complete, duplicate-free current-attempt jobs
  with re-snapshot before and after; no newer or pending run; head equal to the
  latest PR head; input blobs equal to the candidate's.
- Any failure falls back to full CI with an explicit reason code.
- Exact-only checks always run in the push run of the exact SHA. The publisher
  stays `release.yml` on push/master only.
- A future gain would exist only if a future collector accepted an eligible job
  skipped on push with a verified attestation. Today `skipped` blocks with
  `job-not-success`. The push trigger and push checks remain.
- Unproven links: an immutable tested commit; a nonexistent issuer; per-suite
  granularity only through logs/artifacts; binding of consumed inputs.

### Alternatives

- (a) Same-repository attestation with a per-check manifest: the only reuse
  route, blocked today by the unproven links above.
- (b) Merge queue `merge_group`: tests a group of changes. Whether the tested
  SHA equals the final master commit is not asserted here; it needs a contract
  and real payloads for the merge strategy in use, not validated. It requires
  repository configuration (operator), a `merge_group` trigger with pin/mapping
  updates, a collector accepting `merge_group` with head_sha equal to the
  candidate, and event-sensitive checks still on push.
- (c) Full CI with suite optimization (#266/PR267): baseline and fallback.
- (d) Tree equality, aggregate checks or JSON: rejected.

### Negative cases

| Case | Current behavior | Test | Future consumer requirement |
| --- | --- | --- | --- |
| Forged or swapped head/run_id/workflow | Blocks | `github-run-repository-fork-event-branch-sha-path-and-id-bound`, `checks-foreign-repository-workflow-sha-run-id-and-source-block`, `github-cross-event-approved-pr-evidence-never-substitutes-exact-push`, `checks-cross-event-evidence-and-annotations-never-substitute-constituents` | Signed binding to run/attempt/workflow |
| Fork or foreign head.repo | Blocks | Same as above | `fork:false`, same repository |
| PR not merged, base or merge SHA | Not read: the collector never queries PRs | Endpoint allowlist in `github-cross-event-approved-pr-evidence-never-substitutes-exact-push` | Merged, base master, merge SHA equal to candidate |
| Workflow or policy changed | Blocks before HTTP | `github-git-policy-source-drift-blocks-before-http` | Equal pinned blobs and `policyDigest` |
| Attempt, rerun or race | Blocks or retries | `github-reread-run-attempt-and-entire-index-detect-races`, `github-partial-current-attempt-does-not-inherit-old-green` | Re-snapshot, current attempt |
| Cancelled or superseded | Blocks | `github-terminal-failure-skipped-neutral-and-invalid-states-do-not-poll`, `github-latest-rerun-old-run-governs-and-overlap-is-ambiguous` | No newer or pending run |
| Job missing, duplicate or skipped | Blocks | Existing job tests and `checks-cross-event-evidence-and-annotations-never-substitute-constituents` | Complete current-attempt jobs |
| Mutable embedded metadata | Inert | `github-embedded-pr-metadata-mutation-is-inert` | Never read as provenance |
| Unclassified item | Exact-only | Empty eligible set; `POLICY` has no reuse manifest | Reviewed manifest entry |
| Exact-only check without an exact run | Blocks at deadline | PR-only world in `github-cross-event-approved-pr-evidence-never-substitutes-exact-push` | Exact push run required |
| PR context publishes | Rejected at origin | `workflow-origin-rejections-before-candidate-code-both-jobs`, `origin-rejects-tag-pr-fork-ref-before-candidate-git` | Publisher only on push/master |

Positive: `github-complete-exact-sha-current-attempt-public-apis-and-get-only`
stays unchanged. There is no synthetic reuse positive: it would mark
speculative provenance as validated.

### Activation prerequisites

Each needs separate evidence:

1. A real payload proving immutable tested-commit identity bound to
   run_id/run_attempt, captured outside CI without credentials.
2. An implemented, security-reviewed issuer.
3. Per-item audit, independence test and dedicated job, with a `POLICY` manifest.
4. A consumer with the complete negative matrix and a positive built on real shapes.
5. A prospective measurement baseline (see `shared/forge-ci-efficiency.md`).

Operator decisions, not requested by this task: granting `id-token: write` or
`attestations: write` to a PR-triggered issuer, or enabling merge queue.
Until then the full CI fallback applies.
