# CI efficiency, coverage and evidence

This contract describes the additive S04 profiling and scheduling interfaces.
It preserves complete platform coverage, sequential suite execution and S02 gates.
Implementation, hosted CI, review, merge, installation and human acceptance are separate facts.
Local fixtures and scheduler models do not establish hosted speed or acceptance.

## Canonical modules

- `scripts/forge-suite-profile.js` owns `forge-suite-profile/v1`.
- `scripts/forge-ci-shards.js` owns `forge-shard-profile/v1` and shard planning.
- `scripts/run-tests.js` discovers and executes suites in isolated child processes.
- `scripts/forge-ci-profile.js` collects bounded offline observations.
- `scripts/forge-ci-concurrency.js` reads reviewed workflow forms and rehearses them.
- `shared/forge-release-checks.md` owns the exact-SHA S02 release barrier.

## Evidence levels

Observed suite durations describe a particular execution and condition.
Derived job intervals are timestamp differences, subject to API completeness.
Estimated shard loads sum historical weights over the current suite universe.
No level implies another: an estimated lower load is not a measured improvement.
The report never emits percentage improvements.
Unknown values remain null with a reason; absence is never converted to zero.
The hosted-after result remains unavailable until a comparable run is captured.
Local Windows and hosted Windows are different conditions even with matching suites.

## Suite execution profile

`forge-suite-profile/v1` is an optional, closed-schema runner output.
Its top-level fields are schema, started_at, finished_at, elapsed_ms and condition.
The remaining fields are selection, shard, mode, suites, totals and verdict.
Wall-clock UTC timestamps identify the interval; elapsed_ms uses a monotonic clock.
Selection records discovered and selected counts and the universe sha256.
The shard field is null without a profiled shard plan.
A shard records index, count, algorithm, fallback and profile/partition hashes.
It also records predicted_ms and unprofiled/stale counts.
Mode records baseline, fail_fast, match, changed and isolation.
Each suite has id, ordinal, status, elapsed_ms, exit_code, signal and error_code.
Suite exit_code preserves native integer statuses from 0 through 4294967295, or null.
IDs are stable test basenames; ordinals are one-based execution order.
Statuses are pass, fail and not-run; not-run execution fields remain null.
Totals record executed, passed, failed and not_run.
Verdict retains the runner exit and the bidirectional baseline result.
Profile-writing failure emits a diagnostic to stderr and preserves the suite/baseline verdict.
A successful runner exit does not guarantee a profile was written; consumers must check
artifact availability separately.

The document is bounded to 2 MiB, 5000 suites and 200-character general fields.
CPU model text has a separate 100-character limit and excludes path separators.
Validators check counts, identities, timestamps, coherence and closed keys.
The writer validates first, creates an exclusive temporary file and renames it.
No suite stdout or stderr enters the profile.
No complete environment, home path, token or command text enters the profile.

## Condition and privacy allowlist

Condition records platform, architecture, Node version, OS release and CPU summary.
CI context accepts only the explicitly validated values of these environment keys:
- GITHUB_ACTIONS, GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT.
- GITHUB_JOB, GITHUB_WORKFLOW and GITHUB_EVENT_NAME.
- GITHUB_REF, GITHUB_SHA and GITHUB_REPOSITORY.
- RUNNER_OS, RUNNER_ARCH and RUNNER_ENVIRONMENT.
- ImageOS and ImageVersion.

Invalid formats become null with invalid-format; absent values have an absent reason.
Actor, display_title, arbitrary environment variables and child output are excluded.
Queue is unavailable inside the runner: not-observable-inside-runner.
Cache remains unknown: runner-does-not-observe-actions-cache.

## Shard profile and deterministic planning

`forge-shard-profile/v1` records schema, algorithm, sources and platforms.
Only string annotations with underscore-prefixed keys are additionally accepted.
Sources identify logical basenames, sha256, bytes, job, image, Node and time window.
Sources also retain declared/observed/failed suite counts and unavailable reasons.
No raw log content or absolute source path is stored in the profile.
Each platform contains status, reason, default_weight_ms, observations, weights_ms and excluded.
Weights are integer milliseconds, bounded from 1 to 86400000.
The file is bounded to 1 MiB, 64 sources and 5000 suite identities per platform.
Supported platform keys are win32, linux and darwin.

`buildShardProfile` aggregates only PASS observations into weights.
For repeated passing observations it uses the lower median, clamped to at least 1 ms.
FAIL and ambiguous observations never become passing weights.
An identity with no passing observation is listed in excluded with its reason.
The default weight is the lower median of observed suite weights.
A platform without passing observations is unavailable, with no default weight.
The historical failed observations remain visible in source/report counts.

`loadShardProfile` distinguishes an absent ENOENT file from malformed input.
Only ENOENT returns state absent; other read failures fail-closed.
Symlinks, non-files, excess size, invalid UTF-8, JSON and schema are rejected.
`planShards` accepts the canonical suite universe, index, count, platform and loaded profile.
The opt-in planner bounds counts to 1 through 64 and universes to 5000 unique IDs.
The legacy path without new flags retains its existing independent input bounds.

`weighted-lpt-v1` orders suites by decreasing weight, then ID by code units.
Each suite goes to the lowest-load shard; equal loads choose the lowest index.
Execution within each shard follows canonical discoverTests order.
That execution order is distinct from the assignment order.
An unprofiled suite receives default_weight_ms and appears in unprofiled.
A stale profile identity absent from the universe is ignored and listed as stale.
Weights affect placement, never the selection universe or membership completeness.
Every computed partition is checked for missing, duplicate and unknown suites.

## Fallback and diagnostic fingerprints

Absent profile uses positional-v1 with fallback profile-absent.
An absent platform uses positional-v1 with fallback platform-missing.
An unavailable platform uses positional-v1 with fallback platform-unavailable.
Malformed profiles fail before suite execution with exit 2; they never silently fall back.
Without --shard-profile the runner preserves its existing positional selection path.
No CI path filtering or --changed selection is introduced.

`Shard plan:` is one bounded diagnostic line with shard, algorithm and fallback.
It includes selected/universe counts, unprofiled/stale counts and estimated milliseconds.
universe_sha256 hashes sorted universe IDs; profile_sha256 hashes actual profile bytes.
partition_sha256 hashes algorithm, count and sorted members of every shard.
Matching partition fingerprints require the same inputs and platform weights.
These hashes establish identity and partition reproducibility, not speed or trust.

## Runner invocation

Use --shard-profile with the reviewed versioned profile to opt into weighted planning.
Use --profile-out with an explicit output file to capture a suite execution profile.
The existing --shard-index and --shard-count select the partition member.
--baseline continues to compare observed failures and stale baseline entries in both directions.
Baseline resolution uses the complete universe before filtering by shard.
Suite children execute sequentially with the existing isolated home/environment contract.
No intra-runner parallelism or new action upload is enabled.
CI retains two Windows shards, native Linux/macOS cells, smokes and aliases.

## Offline collector

The `scripts/forge-ci-profile.js` CLI has build-shard-profile and report commands.
Repeated --input accepts strict UTF-8 runner logs or validated suite profiles.
--local-log platform=file explicitly labels a local log as a separate condition.
Repeated --jobs and --runs accept bounded offline API JSON snapshots.
--shard-profile loads reviewed weights; repeated --partition platform:count estimates placement.
--json and --markdown select report outputs; build-shard-profile uses --out.
Inputs are limited to 64 files, 16 MiB per file and 64 KiB per log line.
Jobs/runs are limited to 1000 rows; each job is limited to 200 steps.
Stable bounded reads reject unsafe links and output/input collisions.
Input text is data and is never executed.

Logs recognize strict PASS/FAIL duration records, Running counts and Shard plan diagnostics.
Missing identity, duplicate suites, truncation and ambiguous observations stay diagnostic.
The collector does not infer a passing historical run from the current empty baseline.
UTF-16 physical logs must be converted externally with encoding provenance before ingestion.
Preserve original and derivative sha256 and byte counts; never replace original evidence.

Report strata include source kind, platform, semantic job, image/version and Node.
They also include event, cache, shard count, algorithm and universe size.
Jobs expose created-to-started wait, started-to-completed execution and step intervals.
Wait includes queue, dependencies and provisioning; aliases wait for needs.
Run updated-minus-created is approximate and is not billed runtime.
Only equivalent strata can be compared; missing condition fields prevent unsupported comparisons.
Local/hosted strata remain separate, and no percentages are produced.

## Reproducible profile update outside CI

1. Obtain authorized logs or suite profiles from identified hosted runs outside CI.
2. Obtain jobs/runs through authorized GET capture outside CI when comparison needs them.
3. Keep physical evidence immutable; verify sha256, encoding and strict suite counts.
4. If conversion is needed, record both physical and derivative digests and sizes externally.
5. Run `node scripts/forge-ci-profile.js build-shard-profile --input input.log --out profile.json`.
6. Repeat --input in the reviewed deterministic source order for multiple logs.
7. Review PASS-only weights, excluded identities, defaults and source metadata in the diff.
8. Rebuild into a temporary file and compare exact bytes and sha256 to the proposed profile.
9. Exercise the full platform partition and runner/collector integration before owner review.
10. Commit only the reviewed profile through the ordinary owner workflow.

Never generate, download or mutate the versioned profile during CI.
The example logical filenames above are arguments to supply, not executable source data.

## Workflow concurrency

`readConcurrency` accepts only reviewed workflow-level scalar forms.
CI and app use distinct ci-/app- prefixes and pr-number groups for pull_request.
Other events use run-id groups; cancel-in-progress is true only for pull_request.
Group inputs are event_name, pull_request.number and run_id, never title or head_ref.
Release retains literal group release and cancel-in-progress false.
Unknown keys including queue, string form, job concurrency and unknown expressions fail-closed.
The release workflow bytes and its S02 pin remain unchanged.

`rehearse` reads final workflow bytes, records hashes and models fresh arrivals.
It checks push-never-cancelled, pr-superseded-only and last-pr-run-completes.
It also checks groups-disjoint, no-pr-controlled-group-input and release-active-never-cancelled.
Cancellation latency is an explicit model assumption, not a measured scheduler property.
The six invariants are exercised across latencies 0, 1, 10 and 100.
The model retains release-pending-may-be-replaced as an explicit limitation.
One active and one pending release do not constitute a durable FIFO queue.
queue options are unused; their behavior is unverified by this worker.
Manual reruns of old PR attempts may supersede a newer head; hosted validation is pending.
Cancelled PR aliases using always() may fail on an obsolete SHA; consumers remain unknown remotely.
App cache population after cancellation is unverified and must remain a comparison stratum.

## S02 coupling and rejected optimizations

CI/app byte changes require simultaneous blob SHA-1 and sha256 pin updates and mapping checks.
Rendered names, runners, needs, matrices and aliases remain stable: 14 CI cells plus app.
The exact-SHA collector's existing 30-minute deadline is unchanged and is not a completion guarantee.
Historical Windows execution plus provisioning can approach or exceed that window.
See `shared/forge-release-checks.md` for applicability and fail-closed publication policy.
Do not consolidate aliases while remote consumers remain unknown; HTTP 404 proves no absence.
Do not add CI path filters or reuse --changed without a complete dependency graph and negatives.
Do not parallelize suites without fixture isolation and demonstrated coverage equivalence.
Do not change smokes, Windows coverage or app PR filtering without separate dependency evidence.
Do not change collector deadlines or add artifact upload without reviewed need and security evidence.

## Downstream limits

S09 receives conditions, hashes, partition estimates and unresolved hosted comparisons.
S08 classifies the additive flags and workflow changes; this slice chooses no version bump.
The original research all-pass claim was contradicted by physical historical FAIL records.
The original local 18/18 baseline is separate evidence and cannot erase those failures.
The complete smoke and full local suite are not executed by the proportional S04 closure.
Review, hosted runs, merge, installation and UAT remain pending until independently evidenced.
