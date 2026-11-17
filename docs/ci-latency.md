# CI latency and complete coverage

The target is ten minutes of hosted feedback with all PR/master tests retained.
Queue time and hosted hardware are external variables; estimates are not proof
of this target. The test-job safety ceiling is fifteen minutes and fails the
job on exhaustion. It never converts unfinished tests into success.

## What changed after the earlier optimization

PR319 refreshed historical weights and ran the phase suite in isolated cohorts.
Its observed first-to-last job span went from33m43s to23m07s, with different
suite universes/events/images. That was an improvement, not a permanent bound.
By PR415/run44132612926 there were470suites/platform and94unprofiled suites.
Windows test steps reached64m23s; one file alone took29m43s. File-only shards
cannot remove that indivisible-file floor.

The CI inventory now expands six reviewed heavy suites into independently
invocable units. Registered-case partitions preserve one complete roster,
reject duplicate/empty/malformed selection, and select each case once across
the partition. Existing native execution, delivery and phase cohort selectors
are reused instead of reimplementing their assertions. Direct source-suite
invocation keeps the complete original path.

Each hosted test job starts two canonical runners in separate Git clones,
with independent objects, refs, indexes, working directories and temp roots.
Local clone optimization/hardlinks are disabled. Checkout credentials are not
copied. Candidate HEAD and source origin/history are preserved. The canonical
runner continues to isolate HOME for each suite, compare the known-failure
baseline in both directions and produce bounded structured profiles.

Three Linux, five macOS and twelve Windows jobs produce six, ten and twenty-four
effective shards. `job_index * workers + worker_index` is the global shard index.
Every unit is assigned exactly once by the common complete partition. Every
worker is joined on failure; successful sibling profiles remain diagnostic
evidence. Failed/incompletely joined checkouts and nonempty worker temp roots are
retained for diagnosis; successful test exit alone cannot erase a fixture that
the suite explicitly preserved.

## Measurement and future additions

The versioned profile was refreshed through the canonical collector from seven
complete structured PR415artifacts, preserving actual merge-checkout provenance.
New virtual units use explicitly estimated historical source costs divided by
their declared partition factor. Already concurrent source coordinators use
conservative factors. A virtual unit remains unprofiled until it has its own
hosted passing observation. Measured unit weights always take precedence.

Each test-job timing artifact now contains both worker profiles. Feed the actual
worker JSON files to `forge-ci-profile build-shard-profile` for future refreshes.
It also contains a separate timestamped log for each worker, with the actual
matrix job-name binding and observed Node/image metadata. Feed those logs
individually to the existing raw-log collector. The combined job console has
multiple runners and intentionally remains ambiguous for that collector.
For an allocation estimate matching CI, use `forge-ci-profile report` with
`--partition-suites` and the effective counts linux:6, darwin:10, win32:24.
Leave out that option when analyzing the older whole-file runner universe.
Report execution, queue, setup and aggregate runner work separately.

New suites are still discovered automatically. Add a suite to `forge-ci-units`
only after proving its cases/selectors own their fixtures and do not depend on
state from another partition. The real runner integration tests cover complete
selection, individual failures and structured profiles. Ordinary runs keep
`known-failures.json`; partitioned CI uses `known-unit-failures.json`. Both are
human-versioned. Before execution, CI validates each universe and requires the
same source-suite/issue set after projecting unit entries to their sources.
Unknown entries or drift refuse execution. Each mode then retains its own exact
two-way failure/healed-entry comparison; neither baseline is generated or grown
automatically.

## Release boundary

Release still requires complete successful exact-candidate push CI and applicable
app checks. There is no PR-attestation reuse, nightly-only regression or skipped
platform. Original required test names are preserved by enforcing aliases,
including Linux after its matrix expansion.

The read-only coordinator waits for checks and resolves version/notes. It no
longer builds a package and a receipt that the publisher discards. The publisher
still makes its own token-free fresh preparation with the existing ten-minute
receipt TTL and applies only its own job-bound receipt. Trusted origin checks,
candidate checkout, permission split and publication readback remain enforcing.
Historical workflow bytes and their original reconstruction assertions remain
under an additive latency layer; current bytes and semantic job mappings are
independently pinned and checked.
