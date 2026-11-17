# Profile refresh, 2026-10-31

Canonical `forge-ci-profile.readInput/sourceFrom/profileFromSources` generated this profile from seven completed raw GitHub job logs in master run https://github.com/vh2224/forge-agent/actions/runs/41222428048 at `48568c6a52fee9a273983d5b35989012810eb98f` (released4.47.3). Download raw logs with `gh api repos/vh2224/forge-agent/actions/jobs/JOB/logs`; formatted `gh run view --log` output is not parser input.

Windows jobs:124599594752,124599594760,124599594789,124599594831. macOS jobs:124599594790,124599594843. Linux job:124599594888. All seven sources have zero parser anomalies. Each platform has376 measured passing suites; profile source records retain exact hashes, byte counts, observed image/version, timestamps and available Node version (unknown stays unknown). The former profile had342 observations per platform; all34 previously unprofiled suites now have historical observations. New future suites remain explicitly unprofiled and receive the declared default weight.

Measured Windows suite sums by existing shard:990.27,1205.44,1175.09,1807.62 seconds. Aggregate suite time5178.42s is not wall time, queue or billed minutes. Largest measured suites:agent-phase638.84s, native-recovery-delivery563.76s, native-execution555.89s. The latter two already use isolated partitions; this repair isolates agent-phase scenarios in four owned cohorts with concurrency capped at2, preserving each original case.

Replaying existing and refreshed assignments against the SAME measured376-suite Windows cost table predicts old shard sums(ms) [990110,1205270,1807430,1174950] and refreshed [1294440,1294440,1294440,1294440]. These are historical-allocation predictions, not a hosted speedup. They do not include the new agent-phase cohort gain, queue, job setup or runner variance. Actual before/after CI results must be recorded separately.

Every test job now emits a bounded structured profile under runner.temp and preserves it for14days. No raw child output or environment dump is uploaded. Required checks, shard counts, failure baseline, smoke and exact-candidate push release policy remain unchanged. Verified PR reuse is a fail-closed design in docs/ci-validation-reuse.md; it is not enabled by these timing observations.

## Refresh2026-11-17

Seven complete structured artifacts from PR415/run44132612926, actual tested merge0f84655ff6e1f59a3b7608fcce46285e4a46a853, provide470passing suite observations per platform. Canonical profile collector generated this refresh. CI virtual unit estimates divide historical source costs by declared partition factors; these are allocation estimates, not observed per-case durations. Virtual units remain explicitly unprofiled until hosted measurements exist. Previous observations and source pins remain historical evidence. Full coverage, baseline, smoke and exact-push release authority stay enforcing.
