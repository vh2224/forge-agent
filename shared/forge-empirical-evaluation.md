# Empirical evaluation contract v1

`scripts/forge-empirical-evaluation.js` produces a descriptive report from
explicitly supplied evidence. It does not enroll, run or select experiments.
The schema is `shared/schemas/empirical-evaluation.schema.json`.

## Read-only API and CLI

```js
const { buildEmpiricalEvaluation, renderEmpiricalEvaluation } =
  require('./scripts/forge-empirical-evaluation');
const report = buildEmpiricalEvaluation(input, { roots: [authorizedRoot] });
const markdown = renderEmpiricalEvaluation(report);
```

The caller supplies absolute physical roots. Imported JSON cannot authorize
additional directories. The CLI requires a hash pin for the input itself:

```text
node scripts/forge-empirical-evaluation.js --input C:/evidence/evaluation.json --sha256 <64-hex-sha256> --root C:/evidence
node scripts/forge-empirical-evaluation.js --input C:/evidence/evaluation.json --sha256 <64-hex-sha256> --root C:/evidence --markdown
```

Output goes only to stdout. Invalid CLI input exits 2 with a fixed sanitized
message. No imported command runs, no provider is called and no file is written.
The caller may redirect stdout explicitly. No installation or UAT is implied.

## Source inventory and integration

Input has `schema_version: 1`, `kind: empirical-evaluation-input`, `sources`,
`candidates` and `cases`. Every source specifies `id`, `kind`, `path`, `sha256`,
`revision`, `captured_at`, `timezone` and the explicit boolean `synthetic`.
Paths are relative to the first authorized root; absolute paths, traversal,
alternate streams, symlinks and junction ancestors are rejected.

Sources are stable descriptor reads pinned by SHA-256: at most 1 MiB each,
8 MiB total, 100 sources, 100 selected cases and 32 candidates.
Nested observation files consume the same total budget. Source errors become
diagnostics and unavailable evidence, retaining every selected case row.
Hash pins establish byte identity, not authenticity or trusted chronology.
Use sanitized published evidence, never private original prompts as reports.

Supported raw source kinds reuse existing APIs:

| Kind | Payload and existing reader |
| --- | --- |
| baseline | S02 raw `{schema_version:1,cases:[...]}` passed to `buildEmpiricalBaseline` with explicit roots |
| context-comparison | S03 raw case/variants passed to `buildContextComparison` |
| procedure-evidence | S04 `{schema_version:1,before,after}` passed to `buildProcedureEvidence` |
| protocol | Predeclared candidate, frozen split, registrations |
| outcome | Executed controls, case identity, timestamp, completed/failed status, optional repetition |

The baseline's nested observation references also need revision, capture time,
hash and explicit origin/format. Raw `input` or `autonomy` manifests are refused
as `baseline_nested_manifest_unsupported`: they can trigger further reads whose
sources are not yet independently bound by this contract. This limitation is
fail closed and remains visible in diagnostics and exclusions. It never drops
selected observations silently. In particular, duration is unknown without a
separately bound canonical source; it is not reconstructed from a summary.

Existing published S02/S03/S04 catalogs can be supplied directly using
`baseline-report`, `context-report` and `procedure-report`. These accept the
actual output shapes of the three builders, including the S02 semantic digest.
Their source byte hashes, versions and original report conditions are retained.
They are marked `replay_only`; any case using them receives
`historical_report_replay_only` and cannot become a prospective observation.
Synthetic markers in a report cannot be erased by a false source flag.
This supports historical catalogs without reconstructing private inputs.

## Policy, enrollment and controls

A candidate identifies `id`, `arm` and `protocol_source`. Arms are baseline,
memory, procedure, preparation, review and combined.
The protocol contains `candidate`, `split` and `registrations`.
Candidate policy declares hypothesis, primary dimension, numeric non-regression
limits, risk, review, rejection criteria and minimum deliveries/families.
It also records declaration/update times and the frozen split's canonical hash.
Each registration binds case/family/split, policy hash, original input hash,
acceptance hash, enrollment time and actual controls.
Split freeze and policy update must precede enrollment; all precede outcome.
Missing criteria and post-outcome changes remain visible exclusions.

Controls record version, component/input/template SHA-256, model, effort,
host, transport, preparation, review, resolved numeric budgets, memory SHA-256
and procedure SHA-256. Outcome controls must match registered controls.
Baseline controls must match every axis except the declared treatment axis.
Combined requires explicit isolated memory/procedure/preparation/review controls.
Memory and procedure additionally require their existing technical comparator.
These metadata checks are not proof that an untrusted producer ran the case.
Optional repetition numbers are reported; missing repetitions are not invented.
No causal variability estimate is inferred from a few repeated package rows.

## Populations, metrics and decisions

Historical diagnostic, adjustment, reserved and prospective populations remain
separate in both formats. A family used for adjustment cannot enter reserved
or prospective populations, even through a different protocol.
Failed executions remain visible; completion alone proves neither quality nor UAT.
No agent view is built. The existing `forge-empirical-input` reserved barrier
remains closed; reserved outcomes are never fed to preparation or tuning.

Every case preserves independent functional, tests, UAT, canonical autonomy,
exception, interruptions, interventions, human effort, duration, package bytes,
package tokens, provider input/output tokens and cost dimensions.
Metrics retain value, unit, method, numerator, denominator, references and limits.
States observed, derived, estimated, unknown, invalid and conflict are distinct.
Estimated package tokens never become billed provider usage or monetary cost.
Unknown is null, not zero. No cross-dimensional score is computed.

Coverage uses unique delivery identity per dimension, with state counts and
explicit numerator/denominator. Duplicate case rows deduplicate exactly;
conflicting identities or delivery measurements retain rows and exclusions.
Conflicting delivery values contribute one conflict, never extra deliveries.
Candidates show dimensions by split; source provenance and observed controls
appear in JSON and Markdown, including hashes, dates and revisions.

Synthetic cases never contribute to real denominators or prospective counts.
The fixture suite also uses adversarial false metadata solely to exercise
eligibility branches; these temporary records are not empirical observations.
Two reserved families are only an eligibility floor. Even sufficient metadata
leaves `comparative_ready:false`, `functional_gain:null`, `apply_policy:false`
and `preserve-defaults`. With zero eligible prospective cases the reason is
`zero_eligible_prospective_cases`; otherwise validation remains pending.
T04 owns the recommendation adapter. This module exposes facts for it and
does not implement policy application, p-values or a prospective executor.

## Verification

```text
node --check scripts/forge-empirical-evaluation.js
node scripts/forge-empirical-evaluation.test.js
```

Tests cover real builder payload/report shapes, provenance, control mismatches,
prior criteria, splits, failures, duplicates, conflicts, unknowns, estimates,
bounds, path escapes, CLI presentation and conservative decisions.
They use public synthetic inputs without provider calls. Passing demonstrates
the reporting contract, not functional gain, installed behavior or human acceptance.
