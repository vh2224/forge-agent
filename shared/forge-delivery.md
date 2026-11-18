# Forge delivery by acceptance criterion

## Committed task without delivery: current verification successor

New single-task sidecar execution uses the unit adapter on both engines. The
workflow's `complete` refuses a successful execute-task without canonical delivery
before creating a completion intent; the existing begin and lease remain held.
Publish through the unit adapter and complete that same begin, not a new inference.
For a new or incomplete completion, captures must be inside that begin's time
window and their declared source blobs must match the current workspace. The
owner records the begin checksum and exact capture fingerprints in its completion
result; worker-provided fields cannot substitute this measured binding. Already
committed history keeps historical validation and is not compared to later code.

An old release may already have committed completion before delivery existed.
The next selection now returns `execution-delivery-recovery-required` with exact
begin/completion locators instead of dispatching the same task again. Preserve
that original transaction, event, result, SUMMARY, source changes and timestamps.
An envelope captured today cannot prove that earlier completion.

The trusted host may use `forge-completion-delivery-recovery.createRepair` for an
explicit **verification-only** successor. It composes the real serial controller
begin and workflow complete; it does not invoke a provider or replay implementation.
Use this API in one owner process, not serialized JSON approvals:

```js
const repair = require('./scripts/forge-completion-delivery-recovery').createRepair({
  cwd: owner, milestone, slice, task, runId, ownerToken, hostRuntime,
  beginKey: originalBeginKey, completionKey: originalCompletionKey,
  executionContract, assertAuthority, attestStoppedWriter, readPendingQuestions,
});
const next = repair.start(); // verify-only, distinct deterministic begin_key
// Run the plan's real checks now. Build/reverify the canonical delivery with
// contemporaneous root/workspace/source captures and explicit criterion bindings.
const completed = repair.complete();
```

After that genuine completion, resume the **same saved loop snapshot** with the
existing loop adapter's `resume-delivery` command and `repair_begin_key` from
`start()`. This read-only administrative admission revalidates the old block,
new published lineage, saved baseline digest, owner capture binding and canonical
historical delivery. It clears only that delivery block, preserves workflow ID,
step count, time budgets and pending questions, and returns `continue`. Then use
normal `next`; no worker step is charged by the administrative resume. A missing
or forged successor cannot resume the workflow. Do not edit the snapshot to idle
or start another workflow to escape the blocked state.

The callbacks are live host adapters. `assertAuthority(scope)` revalidates the
operator's existing authorization, owned run, held nonempty claim, isolation and
absence of conflicting writers for every physical root. `attestStoppedWriter`
must return true only after actual writer/process join and reconciliation in all
roots; PID absence, an inactive run or a JSON flag are insufficient.
`readPendingQuestions` must inspect the original receipt/checkpoint and current
continuation; every unresolved question still blocks. Do not supply empty stubs
for a real user task. Unknown authority, process state or questions means stop.

Retain any invalid old delivery/captures by exact bytes and hash before current
publication. Reuse the unchanged plan and source work; do not run the executor.
The helper validates the physical execution contract, held claim, original
published lineage, current code snapshots and original plan/records across both
operations. New captures must be at or after the new begin and before its new
completion. It refuses code/claim/root/plan/history drift or pending questions.
Before that new begin, it saves a bounded baseline under the task's existing
artifact directory. The baseline digest forms part of the new begin identity.
Restart reuses that exact saved state and compares current roots and code to it;
missing, changed or linked baseline files refuse instead of capturing a new basis.
Do not edit or delete this state to accept changed code. A changed claim or source
needs a separately reconciled owner continuation, not a silent baseline refresh.
The old completion stays unproven and immutable; the new completion records
current verification, never backdated implementation evidence. No saved worker
receipt is invented. A crash keeps the canonical new begin/transaction for
reconciliation; it does not authorize another executor or an automatic reset.

## Retained partial execution

An `executed` standalone partial with a failed delivery capture retains valuable
code but cannot publish by replay. Recovery returns
`execution-partial-continuation-required` before any reset, disposition or model
fallback. A complete saved response still replays; an unverified partial may run
verification once, and a verified environment-only partial keeps the existing
`forge-env-promote` checks without requiring another writer.

The owner handles this result using `forge-execution-continuation.create`:

```js
const continuation = require(FORGE_SCRIPTS_DIR + '/forge-execution-continuation.js').create({
  request: originalRequest,
  paths: residualQualifiedPaths,
  processProbe: joinedProcessObservation
});
const result = await require(FORGE_SCRIPTS_DIR + '/forge-unit-sidecar.js').runUnitSidecar(
  continuation.request, { ...liveRuntime, partialContinuation: continuation.capability });
```

Derive the exact residual file paths from unmet implementation criteria and the
original plan, not from a newly broadened scope. The live process callback must
prove the actual previous writer joined; unknown/live processes refuse. The
helper rechecks original source hashes, every code root, held claim generation,
pending task questions and receipt identity. The child uses a separate immutable
request/result/receipt and native prompt file with the same explicit route; normal
plan, security, claim and verification admission still run. Exact residual paths
are enforced on declarations and independently observed deltas. Its deterministic
identity replays an existing child rather than creating another inference.
Preserve the original receipt/result/state; never patch a failed capture to pass.

## Protected-window hook observations

During a coordinated native preparation window, `forge-hook` retains observational
tool evidence under `forge-owner-transport-window.controlRoot(owner)` in
`hook-evidence/<binding_sha256>/<canonical-evidence-name>.jsonl`. This private
external journal survives window settlement; it is not replayed as an authorized
owner append and grants no consent or publication authority. The strict owner
snapshot and live join requirements remain in force. Other `.gsd` writes still
refuse. Legacy uncoordinated embedding must supply the supported owner transport
adapter; absence of a protected window is not evidence of compatibility.

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

### Documentary continuation

An explicit documentary/manual acceptance requirement may use independent review
of exact preserved bytes. This is `coverage: documentary`, never behavioral
evidence. File extensions and lexical presence checks do not establish eligibility:
the live reviewer must read the plan and identify each eligible criterion, its
rationale, reviewed documents and hashes, and the observed content. Implementation,
remote CI, UAT and unresolved functional questions remain outside this evidence.

`forge-native-recovery-delivery.createDocumentaryContinuation` requires live host
authority, a stopped-writer attestation and independent review. Imported JSON is
not a capability. It binds an immutable executed partial, its manifest and receipt,
and preserved bytes matching the returned code state. The original pre-write tree
must have been restored. A fresh request, claim and preparation capture current
metadata after maintenance; the old manifest is never renewed or published.
Keep repaired runtime separate until restoration when maintenance would move the
original CODE revision. No provider is invoked by this continuation.

The capability restores only declared reviewed bytes, derives a separate result,
and rechecks commands, structural artifacts, authority, hashes and protected
surfaces before canonical publication. Review provenance stays outside the closed
worker result schema, in the new manifest and artifact capture envelope. The old
partial remains unchanged. Failed restoration requires reconciliation before
another writer; creating a capability alone is not publication.

After a restart, pass the derived `continuationManifestFile` to a newly attested
capability and its exact saved manifest to preparation. Reopening requires the
original revision and complete restored dirty set, including reviewed hashes.
It never restores the files again. Executed results can be verified under fresh
authority; ready records recompose their saved canonical captures and publish
idempotently without another provider or command invocation. A saved manifest or
ready record alone does not grant the documentary capability.
This is an explicit documentary API, not the original recovery-reservation
`replay({request,recovery,...})` path. A host bridge must durably retain the original
manifest/result/receipt references, preserved documents and hashes, independent
review reference, new request/manifest and immutable receipt references. On restart
it obtains fresh live attestations, calls `createDocumentaryContinuation` with
`continuationManifestFile`, then `prepare` with that exact saved manifest. For a
ready receipt call `replayReady` directly; do not call `start` or restore owner
metadata after publication has begun. For an executed receipt, normal verification
and publication follow. This continuation never consumes or relabels the old
partial attempt as delivered.

Documentary observations are read from fingerprinted artifact envelopes with exact
criterion text, root, reviewer/producer identity, review reference and document
hashes. Published evidence uses the existing capture/aggregation trust boundary:
fingerprints detect modification but are not cryptographic authenticity. Historical
aggregation does not issue new live authority or imply behavioral verification.

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

Positive observations for one criterion must share one recorded revision. Distinct
revisions add a stable `revision_mismatch:<sorted revisions>` criterion limitation and
prevent `verificado`, while preserving every observation and source revision. Reordering
bindings does not change this decision. Different criteria remain independent, and child
aggregation recomputes the same rule instead of trusting a child status.

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
delivery JSON are rejected before publication. After an execute-mode sidecar succeeds,
the adapter builds a neutral input with no evidence bindings, runs the same delivery
helper, validates SUMMARY, input and output against the exact unit rules, and publishes
them durably. Worker `must_haves_status` values are not converted into positive delivery
evidence; later contemporaneous envelopes and explicit bindings may enrich the projection.

For long summaries, `--table-limit N` shows problem rows first, prints exact omitted
counts by situation and points to the complete JSON. Pipes, newlines and Markdown
markup are escaped. The JSON remains the complete reconstructible detail.

## Evidência de múltiplas raízes

### Initial documentary and mixed capture

A caller that omitted the initial documentary policy may supplement an immutable
executed partial receipt through `prepare({savedManifest, supplementalCoverage})`.
This is replay-only: it cannot write another worker return or alter the original
manifest/result. The supplement supplies `policy`, `returnedReceiptFile`, a live
`attestStoppedWriter` and independent `attestEligibility` callback bound to the
original manifest/receipt hashes and policy digest. Only unknown non-artifact
criteria are eligible; existing behavioral evidence retains behavioral coverage.
The ordinary `reviewDocumentary`, concrete verification, claims, gates and source
hash checks still apply. Eligibility is not a successful content review.

Derived review evidence and ready receipts retain the supplemental provenance.
Canonical replay requires fresh `runtime.supplementalCoverage` and
`runtime.documentaryReview`; a ready receipt or serialized approval alone cannot
grant this authority. Missing authority, changed original bytes, changed source
evidence or an unreconciled writer refuses publication. Execution evidence does
not settle independent code-review findings, CI, integration or human acceptance.

The native delivery adapter accepts an explicit `coveragePolicy` before `prepare`.
The immutable manifest seals each selected criterion's exact text, read-only
source paths and required `(aspect, root_id, coverage)` tuples. Documentary
policies support only each built-in criterion's sole aspect (`default` for a
truth, `declared-link` for a key link); unsupported or multiple aspects refuse
before preparation. External inputs require a SHA-256 pin at preparation and
stable bounded reads (1 MiB per file, 8 MiB unique files per capture), with no
symlink or junction components. The same reads and pins are checked again at
review and publication. Locally produced sources are captured after return.
Documentary
eligibility is an independent review assertion about the plan, never a filename
extension or a worker's `met` flag. Unselected criteria keep ordinary behavioral
verification. Mixed criteria require both declared coverages; neither positive
documentary evidence nor a successful command cancels a negative or limitation.

After the actual worker return is persisted as an immutable executed receipt and
the writer is stopped, `session.reviewDocumentary` requires live host authority,
a live stopped-writer callback and independent review of the exact returned
bytes. It writes a separate content-addressed review record and returns a derived
result; it does not change the original result, manifest or claim and does not
invoke a provider. External sources explicitly listed by the policy remain
read-only inputs, not authorized writes. Unknown documentary outcomes may be
adjudicated; unmet outcomes cannot be promoted. Real command capture remains
mandatory, including behavioral assertions for every mixed obligation.

Restart uses `prepare({savedManifest, ...liveAuthority})`, then reattests through
`reviewDocumentary` using the original immutable executed receipt. Saved review
JSON is evidence, not a live capability. `replayReady` recomposes saved captures
and validates the same policy, review and bytes without repeating the provider
or commands. This explicit API does not extend the legacy reservation replay
API automatically. Publication retries preserve the original returned receipt.

Bindings carry `required_coverages` to delivery and child aggregation. The native
adapter derives these obligations from the sealed policy, checks representation
before composition and attaches them to every binding of that criterion. The
classifier requires every concrete tuple, preserving negatives, limitations and
revision mismatches. As with behavioral captures, local envelope fingerprints
detect changes; they are not cryptographic authentication.

forge-verify.captureRootDelivery(execution_contract,planText,options) gera envelopes próprios de verification/artifact por root_id, identidade física, contract hash, cwd real, revisão/workspace, environment e captured_at contemporâneos. Os comandos rodam em cada checkout e expected_output é conferido em sua raiz. Input de delivery v2 conserva execution_contract e bindings com root_id; fonte estrangeira ou identidade alterada falha. Truth global requer binding explícito para cada raiz; artifact requer sua raiz e key_link as raízes de from/to. Um comando global, sucesso de outra raiz ou mero arquivo existente não cobre comportamento. CI/review/merge/install/aceite humano continuam fatos independentes.

Na captura Git, uma política raiz `.gitignore` suja é persistida como o blob
exato vinculado ao hash do snapshot, após leitura regular, limitada e estável.
Isso não altera working tree nem index e não persiste todos os arquivos sujos.
As leituras current/historical não escrevem objetos nem usam regras atuais para
preencher uma política histórica ausente. O glob mantém seu universo capturado;
uma regra de ignore só é descartada quando seu prefixo raiz literal é
comprovadamente disjunto. Regras relevantes ou ambíguas continuam recusadas.
