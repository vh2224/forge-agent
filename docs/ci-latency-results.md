# CI latency repair: evidence and publication

The complete CI remains a release requirement. The repair from
[PR417](https://github.com/vh2224/forge-agent/pull/417) divides long suites into
independent execution units and overlaps trusted publisher preparation with CI.
The execution model and integrity boundaries are documented in
[ci-latency.md](ci-latency.md).

## Recorded complete runs

| Candidate | Complete CI | Outcome |
| --- | --- | --- |
| [PR415 baseline](https://github.com/vh2224/forge-agent/actions/runs/44132612926) | 65m11s | All 18 checks passed |
| [4e2efba, attempt1](https://github.com/vh2224/forge-agent/actions/runs/44193105049/attempts/1) | 20m04s | All 41 checks passed; macOS admission reached 12m12s during concurrent workflows |
| [4e2efba, attempt2](https://github.com/vh2224/forge-agent/actions/runs/44193105049/attempts/2) | 9m40s | All 41 checks passed; clock starts before the rerun request |
| [db36bea, integrated with PR419](https://github.com/vh2224/forge-agent/actions/runs/44216793059) | 10m05s | All 41 checks passed; workflow creation to final check completion |
| [First optimized master34a9a3c](https://github.com/vh2224/forge-agent/actions/runs/44221144256) | 13m05s | All 41 checks passed; macOS lane imbalance and setup/admission retained |

The 9m40s interval is 2026-11-17T23:06:49.015Z through 23:16:29Z. The 10m05s
interval is 2026-11-18T01:34:05Z through 01:44:10Z. These are separate candidates
and attempts, not interchangeable measurements. The latter exceeded the strict
ten-minute target by five seconds. Queue and hardware variability remain visible;
the successful 20m04s contention run is retained in the record.

The integrated candidate has 478 physical source suites and 517 execution units per
platform. Its 61 downloaded worker profiles confirm every unit and all 129 registered
partition cases exactly once on Linux, macOS and Windows, with no failed units.
The earlier 4e2efba inventory was 476 sources and 515 units per platform. Both use
six Linux, fifteen macOS and forty Windows workers, and preserve all nine required
branch-protection context names.

## Compare future runs correctly

- Start at workflow creation for an initial run, or a recorded rerun request for
  a repeated attempt. End at the last actual check completion. A mutable workflow
  `updated_at` timestamp is not the completion clock.
- Keep admission, checkout/setup, execution and final alias overhead in the
  elapsed result. Record aggregate runner work separately from user waiting time.
- Bind profiles to the exact run, attempt, tested commit and unit catalog.
  Download the first attempt's artifacts before requesting another attempt;
  old artifact identifiers may stop resolving after a rerun.
- Validate complete unit and registered-case rosters before accepting coverage.
  A failed or incomplete run can supply diagnostic passing timings, but cannot
  establish a successful latency result.
- The profile collector accepts at most 64 inputs. All 61 current worker profiles
  fit; combining them with seven older physical profiles exceeds that limit.
  Preserve older evidence separately rather than raising the bound.

The local Windows package verification initially passed four host/platform cells
and interrupted both Linux simulation installer suites under the 180-second suite
ceiling. Complete targeted retries subsequently passed 11/11 for Linux/Claude and
Linux/Codex. Keep the original failure and the retries distinct. Owner evidence
assembled across those attempts is not a publisher receipt; the trusted Linux
publisher must independently pass the complete canonical package gate.

## A completed workflow is not always a published version

[forge-release-version.js](../scripts/forge-release-version.js) derives publication
from tags and conventional commit messages. `fix:` triggers a patch release and
`feat:` a minor release; a `perf:` commit alone does not trigger a new version.
With v4.51.6 published concurrently before PR417 merged, the first optimized
coordinator resolved `skip:true`, `bump:none`. This follow-up completes the
authorized operational fix delivery with a `fix(ci):` commit and this evidence
record, through the normal PR, master and publisher checks.

For a real publication measurement, verify the new tag resolves to the tested
master commit and read back the published release. Record workflow creation to
the release's actual `published_at`, plus complete workflow duration separately.
A successful `no-publication` result proves no new release latency. Never create
or move a tag to bypass the publisher's exact-candidate checks or receipt rules.

## Follow-up for stable allocation

The first master run finished at 2026-11-18T02:22:22Z after starting at 02:09:17Z.
Its 61 complete successful profiles now provide the weights; all 517 then-current
units are retained as observations with their original identities. The linked
fixture extraction introduces three linked-v2 cohorts and 518 current execution
units. Their initial costs are explicitly estimated from the old measured core
and regressions, not presented as current observations. The E/F closure fixtures
move together into their own cohort, while the coupled lifecycle and default
complete call order retain every original assertion.

The snapshot helper still reads every regular file and records byte hashes, size,
mtime and links. It removes one duplicate metadata query per regular file and
keeps same-size/same-mtime byte changes observable. Windows setup can skip SVN
only when the actual nonempty single-worker assignment contains solely the
Git-only linked fixture; every other assignment keeps the pinned tools. The
actual test step and independent Git clones remain unconditional.
