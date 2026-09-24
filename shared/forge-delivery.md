# Forge delivery by acceptance criterion

This contract builds a deterministic delivery projection for review, QA and human
acceptance. It does not change verification gates, workflow state or approval. The
projection lives beside the unit SUMMARY as `<unit>-DELIVERY.json`; the SUMMARY
contains a generated `## Entrega por critério` section that points to that file.

The projection always starts from the unit plan. Every structured `truth`,
`artifact` and `key_link` receives a qualified identity made from unit, origin and
index. A binding may add evidence to an inventory item, but cannot remove it.
Additional textual acceptance criteria are allowed only through explicit entries
with a unique ID, exact source reference, type and optional required aspects. The
helper never extracts new acceptance criteria from prose with a regular expression.

## Input schema v1

The orchestrator writes a bounded JSON input with this shape:

```json
{
  "schema_version": 1,
  "unit": { "type": "task", "id": "T01", "milestone": "M001", "slice": "S01" },
  "plan": ".gsd/milestones/M001/slices/S01/tasks/T01/T01-PLAN.md",
  "plan_fingerprint": "sha256 of the exact plan bytes",
  "additional_criteria": [
    { "id": "qa-acceptance", "text": "QA approved the scenario", "reference": "ticket#qa", "type": "functional", "aspects": ["browser"] }
  ],
  "bindings": [
    {
      "criterion": { "kind": "truth", "index": 0 },
      "aspect": "default",
      "coverage": "behavioral",
      "source": { "kind": "verification", "path": ".gsd/.../T01-VERIFY-ENVELOPE.json", "check_index": 0 }
    },
    {
      "criterion": { "kind": "artifact", "index": 0 },
      "aspect": "declared-property",
      "coverage": "structural",
      "source": { "kind": "artifact", "path": ".gsd/.../T01-ARTIFACT-ENVELOPE.json", "row_index": 0, "property": "substantive" }
    }
  ],
  "expected_children": [
    { "unit": { "type": "task", "id": "T01", "milestone": "M001", "slice": "S01" }, "delivery": ".gsd/.../T01-DELIVERY.json" }
  ],
  "facts": {
    "implementation": { "status": "committed", "reference": "commit abc123" },
    "review": { "status": "completed with 0 open", "reference": "T01-REVIEW.md" }
  }
}
```

`unit.type` is `task`, `slice` or `milestone`. `plan` is relative to OWNER_ROOT.
Evidence paths may resolve under OWNER_ROOT or CODE_DIR. Child deliveries resolve
only under OWNER_ROOT. Realpath containment is checked after symlink resolution;
files outside the explicit roots, malformed JSON and files above 1 MiB become
diagnostics and never positive evidence. Inputs are capped at 1,000 criteria,
5,000 bindings and 100 children; evidence per criterion and aggregate depth are
also bounded. Commands and prose found in evidence are data and are never run.

Verification and artifact sources use a small contemporaneous envelope:

```json
{
  "schema_version": 1,
  "kind": "verification",
  "unit": { "type": "task", "id": "T01", "milestone": "M001", "slice": "S01" },
  "plan_fingerprint": "...",
  "code_dir": "/observed/worktree",
  "revision": "observed revision or workspace identity",
  "environment": "Node 22 on Windows",
  "captured_at": "2026-09-24T12:00:00Z",
  "result": { "passed": true, "checks": [{ "command": "npm test", "exitCode": 0 }] }
}
```

For artifact evidence, use `kind: "artifact"` and place the unmodified verifier
result in `result`. Capture this envelope when the check runs. A later HEAD,
environment or timestamp cannot fill missing historical context. Fingerprint,
revision and workspace associate observations with a unit; they do not authenticate
the author or make the observation trustworthy on their own.

## Classification

- `verificado` requires explicit compatible positive coverage for every required
  aspect, without a relevant failure, skip, conflict, approximation or missing
  context. A functional criterion requires `coverage: "behavioral"`.
- `parcialmente verificado` requires at least one valid positive observation and
  leaves every uncovered, limited, failed or conflicting aspect visible.
- `não verificado` covers no sufficient positive observation, including only
  failures, timeouts, skips, an empty check list or invalid sources.

`passed: true` with no concrete check proves nothing. Non-zero exit and timeout are
failures. Every check needs a nonempty command identity and integer outcome, and the
aggregate `passed` boolean must agree with the complete check set. A consistent mixed
suite may have `passed: false` while one explicitly bound named check still proves its
own criterion; a failing selected check remains negative evidence. Structural verifier
rows must name the exact normalized artifact path and can prove only the exact declared
property. Generic `wired` rows never prove a declared directed key link; that criterion
requires an explicitly bound behavioral check. Structural rows cannot prove a functional
truth. `legacy`, `approximate` and advisory
`verification_evidence` pointers remain limitations. Conflicts are never resolved
by file order, timestamps or automatic supersession.

Malformed rows, property types, flags or flag entries produce stable invalid-source
observations instead of aborting the projection. When the per-criterion observation cap
is reached, every affected aspect receives an `evidence_truncated` limitation. Omitted
evidence therefore cannot leave a criterion `verificado`, regardless of binding order.

Parent units list expected children explicitly. The helper validates each child
projection fingerprint and identity, then recomputes its criterion statuses from
normalized observations; it never trusts status strings supplied by child JSON.
Missing, malformed, legacy, cyclic or over-depth children remain diagnostics.
Criteria with equal text or paths in different units retain separate qualified IDs.
Parent-specific criteria still need parent bindings.

Implementation, CI, review, merge, installation and human acceptance are rendered
as six independent facts. A referenced fact never promotes another fact. Missing
facts read `não informado/pendente`.

## Materialization

Resolve `FORGE_SCRIPTS_DIR` from the checkout or Forge home. OWNER_ROOT owns `.gsd`
and CODE_DIR owns product code; do not substitute one for the other:

```bash
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-delivery.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
node "$FORGE_SCRIPTS_DIR/forge-delivery.js" \
  --input "$WORKING_DIR/.gsd/.../T01-DELIVERY-INPUT.json" \
  --owner-root "$WORKING_DIR" --code-dir "$CODE_DIR" --json \
  > "$WORKING_DIR/.gsd/.../T01-DELIVERY.json"
node "$FORGE_SCRIPTS_DIR/forge-delivery.js" \
  --input "$WORKING_DIR/.gsd/.../T01-DELIVERY-INPUT.json" \
  --owner-root "$WORKING_DIR" --code-dir "$CODE_DIR" --markdown \
  --detail-reference "./T01-DELIVERY.json"
```

The CLI only reads and prints. The orchestrator writes envelopes, input, JSON and
the rendered SUMMARY section using its normal file-writing mechanism. Sidecar
workers return source results and bindings to the orchestrator; they do not write
`.gsd`. Re-run materialization after review only when review or a review fix adds a
real source or fact. Do not infer merge, installation or human acceptance.

Artifact-mode sidecars return content for exact unit-scoped paths; the sidecar
publisher validates and writes them. The allowlist contains `<unit>-DELIVERY-INPUT.json`,
`<unit>-DELIVERY.json`, `<unit>-VERIFY-ENVELOPE.json` and
`<unit>-ARTIFACT-ENVELOPE.json` only for the selected task/slice/milestone identity.
Input and output are required on a completed closing unit; envelopes are optional when
that unit has no contemporaneous check. Foreign-unit names, traversal and malformed
delivery JSON are rejected before publication. Execute-mode sidecars continue to return
execution results for orchestrator materialization rather than writing `.gsd` directly.

For long summaries, `--table-limit N` shows problem rows first, prints exact omitted
counts by situation and points to the complete JSON. Pipes, newlines and Markdown
markup are escaped. The JSON remains the complete reconstructible detail.
