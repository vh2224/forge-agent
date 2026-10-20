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
The source-pinned Release baseline still has the historical single `release` job;
T04 must update its blob pins and mappings when installing coordinator/publisher.
Pins do not assert that the historical workflow already enforces this new barrier.

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

The policy enumerates version --check, clean/stable tree and HEAD, six HOSTS ×
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
