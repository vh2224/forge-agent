# Profile refresh, 2026-10-27

Generated with `node scripts/forge-ci-profile.js build-shard-profile` from raw
GitHub job logs in run https://github.com/vh2224/forge-agent/actions/runs/40433398717:
jobs 121956342154, 121956342250, 121956342303 and 121956342319, supplied through
four `--input` arguments. Download raw logs with `gh api repos/vh2224/forge-agent/actions/jobs/JOB/logs`;
`gh run view --log` adds display columns and is not a parser input.

Each platform has 340 measured passing suites and zero parser anomalies. The
profile records source hashes, runner versions, observation times and weights.
Checkout `ffac8b9e8893ed962b6d696633e6f6f2b529deff` has the same tree as PR245's
head and merged commit `1e0e48479a87f968d8fa0559f2a56c96a6ea4d2f`.
This is historical pull-request timing, not push/release authorization.

The new archive test has no observation and uses the explicit default weight.
Historical Windows repartition predicts a maximum shard reduction of 70.12s
(3.9%); that is not an observed speedup. Suite cost and runner variance remain.
Coverage, shard count, known-failure policy and release gates are unchanged.
