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
| execution-start | Case identity, `started_at`, `registration_sha256`, and executed `controls` |

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
Split freeze and policy update must precede enrollment. Each case identifies an
`execution_start_source` whose hash-pinned `execution-start` document binds the
case, the canonical fingerprint of its complete registration, and controls equal
to the outcome's executed controls. Exactly one registration must match the case.
Freeze, policy declaration/update and enrollment must strictly precede that start;
start must strictly precede outcome completion. Declaration cannot follow update.
Missing starts, equal timestamps, reversed chronology and mismatched bindings are
explicit exclusions, never inferred prospective evidence. Legacy captures without
start evidence remain readable and excluded; historical snapshots are not repaired.

Controls record version, component/input/template SHA-256, model, effort,
host, transport, preparation, review, resolved numeric budgets, memory SHA-256
and procedure SHA-256. Outcome controls must match registered controls.
Baseline controls must match every axis except the declared treatment axis.
Combined requires `isolated_comparisons` in its registration: exactly four entries
with `arm`, `case_id`, `protocol_sha256` and `outcome_sha256`, one per isolated
memory/procedure/preparation/review arm. These reference selected cases evaluated
by this same evaluator, not supplied validity flags or component names. Each must
be eligible after identity and split checks, nonsynthetic, successful, from the
same family and split, with the same frozen split hash, acceptance hash and full
baseline controls. Its isolated outcome must finish before combined enrollment.
Each isolated treatment must equal the combined treatment and differ from baseline;
all other control axes remain subject to the isolated-arm checks. Protocol/outcome
pins must match the actually read sources. Memory/procedure comparator outputs must
also bind their baseline/current input/template hashes, model, effort, host,
transport and budgets to the isolated executed controls. Missing, replay-only,
unrelated or internally invalid comparisons yield `combined_isolation_unproven`.
Memory and procedure additionally require their existing technical comparator.
These metadata checks are not proof that an untrusted producer ran the case.
The context comparator explicitly rejects own budget keys `__proto__`,
`constructor` and `prototype` at every depth, including a declared budget policy.
They cannot normalize into an accepted empty observation or matched binding.
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

## Pre-dispatch preflight v1

`buildEmpiricalPreflight(input, { roots: [authorizedRoot] })` inspects the
available enrollment evidence without requiring or constructing an outcome.
It shares the posterior evaluator's policy, split, registration, start,
13-control validator, untreated-axis comparison, source reader and identity
conflict checks. The posterior still requires its actual outcome, executed
controls, technical comparators, combined isolation and population checks.
A positive preflight never substitutes for those later checks.

The separate input envelope has `schema_version: 1`,
`kind: empirical-preflight-input`, and the same `sources`, `candidates` and
case identities/references as the evaluation input. Each case supplies `id`,
`delivery_id`, `candidate_id`, `family_id`, `split`, `evidence_type`, `synthetic`,
`baseline_source`, `baseline_case_id` and its `execution_start_source`.
Optional context/procedure references retain their existing source kinds.
`outcome_source` and sources of kind `outcome` are incompatible with preflight;
they are rejected rather than silently ignored. The published posterior schema
continues to require outcome references and does not describe this new envelope.

```js
const { buildEmpiricalPreflight } = require('./scripts/forge-empirical-evaluation');
const preflight = buildEmpiricalPreflight(preflightInput, { roots: [authorizedRoot] });
```

```text
node scripts/forge-empirical-evaluation.js --preflight --input C:/evidence/preflight.json --sha256 <64-hex-sha256> --root C:/evidence
```

Preflight emits JSON only; `--preflight --markdown`, duplicate switches, unknown
options and missing input hash/caller roots are invalid (exit 2). Input/IO errors
produce the same fixed sanitized stderr message as the existing CLI. A source
read error keeps the report's selected case rows and sanitized diagnostics in
stdout, with exit 2 in preflight mode. Empirical exclusions such as late
registration produce a JSON report with exit 0; inspect the case fields rather
than treating the process exit as empirical eligibility. Existing evaluation
JSON and Markdown invocations retain their behavior.

Roots come exclusively from the trusted API caller or CLI `--root`, never
imported JSON. Preflight uses the existing stable bounded source reads, hash
pins, path/ancestor checks and source error codes. Limits remain 1 MiB per
input/source, 8 MiB cumulative source bytes including nested observations,
100 top-level sources, 100 cases, 32 candidates and 16 caller roots. There is
no truncation, provider call, policy change, prefs update or state write.

### Independent baseline controls

Preflight reads baseline controls only from the identified raw `baseline`
source after its hash/root/bounded validation. Its additional case property is:

```js
// Within a raw baseline { schema_version: 1, cases: [...] }:
{
  id: 'baseline-case', delivery_id: 'delivery', conditions: [], sources: [],
  baseline_controls: {
    version: 'captured-version', component_sha256: '<64 lowercase hex>',
    input_sha256: '<64 lowercase hex>', template_sha256: '<64 lowercase hex>',
    model: 'captured-model', effort: 'high', host: 'codex', transport: 'native',
    preparation: 'full', review: 'required', budgets: { context: 3000 },
    memory_sha256: '<64 lowercase hex>', procedure_sha256: '<64 lowercase hex>'
  }
}
```

This is a shape example, not evidence. Supply the actual available observation
references in `sources`. Selection requires exactly one raw case matching
`baseline_case_id` and the selected delivery identity. Missing, invalid or
duplicate matches yield `baseline_controls_unbound` or
`baseline_controls_unavailable`; untreated-axis differences yield
`non_equivalent_controls`. Baseline report replays cannot provide independent
controls, even if an extra imported field claims them. Controls are never copied
from the treatment to fill a missing baseline. The baseline builder/report and
its public contract are unchanged.

Exactly the 13 documented controls are accepted; extra/missing keys, invalid
hashes, non-label identity values and empty/negative/non-finite numeric budgets
fail validation. Registration and start controls must agree; the original input
hash must equal `input_sha256`. The baseline must agree on every untreated
axis. Memory/procedure/preparation/review arms allow only their existing axis;
combined allows the same four existing axes while its isolation remains a
posterior responsibility.

### Chronology and report meaning

The shared chronology requires real timezone-qualified timestamps with
`declared_at <= updated_at < enrolled_at < started_at` and
`frozen_at < enrolled_at`. Equality at a strict boundary, impossible calendar
dates, reversed clocks, duplicate registrations, unbound policy/split/start
fingerprints and missing controls cannot establish prospective enrollment.
An exposed/adjustment family is not promoted to reserved/prospective. Synthetic,
historical-diagnostic, replay-only and conflicting family/delivery rows retain
their exclusions and source diagnostics. Hashes bind bytes or canonical
semantic fingerprints; they authenticate neither provenance, chronology,
execution nor consent. Supplied baseline controls do not prove causal
independence.

The report kind is `empirical-preflight-report`. `enrollment_valid` describes
the shared policy/registration/start/control checks; it alone is insufficient:
each row also exposes `controls_available`, `baseline_controls_available`,
`exclusions`, `synthetic` and `prospective_enrollment`. Only a prospective row
without any exclusion has `prospective_enrollment:true`. An unexcluded reserved
or prospective row is classified `awaiting-outcome`; all other rows are
`observational`. Adjustment remains observational even with complete controls.
Every row has `eligible:false`, `outcome:null`, `outcome_pending:true`.
The report always preserves `eligible:false`, `comparative_ready:false`,
`functional_gain:null`, `decision.apply_policy:false` and
`authorization.granted:false`. No functional gain, sample-floor completion,
final eligibility or dispatch permission follows from this result.

### Owner sequence and enforcement boundary

1. Prepare the actual package, fixed policy/split and independently identified
   baseline controls. Publish immutable registration and prepared start records
   before dispatch, with explicit timestamps, identities, controls and hashes.
2. Reread those published sources through preflight before the real call. Store
   its exact input hash, source references and result. Distinguish a prepared
   start record from observed execution; a timestamp in JSON does not prove a
   provider started. Already observed/exposed work remains observational.
3. Retain the lifecycle's plan/security/claim/routing gates and existing execution
   authorization. Missing empirical eligibility permits previously authorized
   observational continuation; integrity errors and real lifecycle gate failures
   remain blocking and cannot be relabeled as observational permission.
4. Capture the effective attempt at the real adapter seam, preserving its
   original receipt/final evidence, actual model/effort/host/transport and
   unknowns. Never reconstruct missing historical enrollment from later data.
5. After an actual outcome, publish its independent source and invoke the
   posterior evaluator with the original bound enrollment plus outcome evidence.
   Retain exclusions, review and human acceptance as separate facts.

This module installs no adapter dispatch gate and performs no publication.
The owner must interpose the sequence at its authorized real seam. If the seam
does not allow this, disclose that operational limit and remain observational;
documentation or a retrospectively captured record cannot prove enforcement.
The current S01 family is already exposed and remains observational regardless
of later completeness of its controls.

## Verification

```text
node --check scripts/forge-empirical-evaluation.js
node --check scripts/forge-empirical-evaluation.test.js
node scripts/forge-empirical-evaluation.test.js
```

Tests cover real builder payload/report shapes, provenance, control mismatches,
prior criteria, splits, failures, duplicates, conflicts, unknowns, estimates,
bounds, path escapes, CLI presentation and conservative decisions.
They use public synthetic inputs without provider calls. Passing demonstrates
the reporting contract, not functional gain, installed behavior or human acceptance.
