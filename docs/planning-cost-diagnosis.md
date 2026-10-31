# Proportional planning and observed phase cost

Issue #203 asks for investigation and proposals around excessive decomposition,
preparation, review ceremony and redundant tests. This change provides a reproducible
measurement and refines planning guidance. It does not establish a guaranteed
duration or implement the deferred time-options or communication-panel proposals.

## Reproduce the measurement

Use the existing deterministic prompt-cost harness with an explicitly selected
event source:

```sh
node scripts/forge-cost-baseline.js --cwd . --events /absolute/path/to/events.jsonl --markdown
```

The optional source is read only, bounded, fingerprinted and checked for stable
file identity. Only unambiguous `unit-began`/`unit-transition` pairs contribute
durations. Repeated task IDs can be paired sequentially; simultaneous begins for
the same identity are ambiguous and are excluded until all overlapping begins
have observed terminal boundaries; later clean attempts can then be measured.
Malformed recognized lifecycle identity/timing refuses the source rather than
guessing which begin a later transition closes. Nonterminal `running`
transitions keep the original begin open; only canonical complete, pause, fail
or expired-safe boundaries close an interval. Closed intervals do not prove
successful delivery. Conflicting idempotency keys,
malformed JSON/encoding and excessive input refuse measurement. Unmatched,
invalid and ignored legacy records remain explicit. Event text is never executed;
summaries and provider text are absent from the output.

Aggregate unit duration, the union of observed active intervals and the complete
observed span are different quantities. Concurrent units can increase aggregate
duration without increasing wall time. Gaps do not establish human waiting or
provider latency. Phase events do not separate useful work from fixed overhead.
Deterministic rendered/template token estimates remain distinct from recorded
token telemetry; missing actual per-phase attribution stays unknown.

## Historical source for #203

The exact historical events explicitly identified in the issue were inspected
on 2026-10-31. Source SHA-256:
`11c6ad4db8859568a10c6d8ae81e625a4311b0e4d28df1d9f2a740fa00355d4c`.
The 92,443-byte source currently has 275 records: 76 begins, 76 transitions and
123 legacy records without pairable lifecycle events. All 76 unit pairs match;
there are no duplicate/conflicting IDs, ambiguous pairs, invalid timestamps or
unmatched begins/transitions. The issue's older 75-unit count is not the count of
this current source. The extra historical transition's cause was not inferred.

| Phase | Paired units | Aggregate minutes |
| --- | ---: | ---: |
| research-milestone | 1 | 53.70 |
| plan-slice | 9 | 80.49 |
| research-slice | 9 | 19.77 |
| execute-task | 47 | 968.24 |
| complete-slice | 9 | 107.88 |
| complete-milestone | 1 | 4.38 |

Observed aggregate and active-union duration are both **20h 34m 27s**. The complete
span is **27h 50m 39s**; the roughly 7h 16m of gaps have no attributable cause in
these events. Non-execution phases occupy **4h 26m 13s**, approximately 21.6% of
the observed active time. This is preparation/completion time, not proof that
all of it is avoidable overhead. Execution intervals can include testing and
review; they are not a measurement of coding time alone. The legacy review
records have no separately pairable durations. Actual token telemetry for this
selected historical unit is absent. Current deterministic rendered prompts span
roughly 1,500–2,800 estimated input tokens per template with synthetic inputs;
these figures are neither the historical prompts nor billed tokens.

## Changes and bounded proposals

The historical plan audit also inspected all **47 task plans** (409,274 bytes),
retaining a SHA-256 inventory privately. Forty-three name at least one test suite.
Repeated script references include `forge-unit-sidecar.test.js` in eight plans,
`forge-claude-sidecar.test.js` in seven, `forge-sidecar-liveness.test.js` in six and
`forge-attempt-recovery.test.js` in five. These counts show repeated verification
boundaries; they do not establish redundant executions because source revisions,
arguments, environment and behavior coverage may differ. None of these historical
plans has a standalone `verify:` frontmatter field; test instructions occur in
their body and are not evidence that command discovery failed at runtime.
The historical roadmap has five high-risk, three medium-risk and one low-risk
slice declarations. The evidence therefore does not support treating every slice
as low risk or removing its security/review checks. The reported 1.7 test/code
line ratio remains an inspection signal, not a justified deletion target.

- Begin with one cohesive deliverable; consider 1–3 slices for compact outcomes
  as a hypothesis. A fourth needs a concrete dependency, risk, separate acceptance
  or context constraint. Requirements, isolation and applicable gates remain.
  Existing guidance already required a minimal dependency-safe decomposition;
  the refinement makes consolidation an explicit planning question.
- Reuse current research and resolved decisions through existing canonical entry
  and phase validation. Reference the evidence instead of repeating inference.
  Missing, stale or differently scoped evidence still needs preparation.
- Existing `forge-cost-policy.js` already supports adaptive review with risk,
  security, sensitive-path, binary and change-size signals. Honor the selected
  preferences and mandatory independent review. No global preference or implicit
  phase skip is introduced here.
- Map each behavior to an existing or missing check. A test-to-code line ratio
  of 1.7 is a signal to inspect coverage, not evidence of duplication by itself.
  Reuse equivalent, current captures through canonical provenance checks; repeat
  for changed inputs, failures, new uncertainty or an enforcing integration gate.
  CI and owner verification are preserved.

Measure later comparable deliveries with the same helper before asserting a
speedup. More slices create repeated preparation/completion boundaries, but the
observed 21.6% is not a guaranteed saving from consolidation.

## Deferred overlap

`docs/milestone-time-options.md` remains deferred: no three time choices, runtime
budgets or task-chain feature is implemented. The event-cost report is diagnostic
and does not select work or create an operational milestone. Likewise,
`docs/forge-communication-panel-distribution.md` remains deferred; this change
adds no panel installation or release-distribution feature. Human UAT and actual
future latency improvements require their own evidence.
