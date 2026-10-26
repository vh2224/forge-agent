# Forge long-workflow lifecycle

`scripts/forge-loop-controller.js` is the provider-neutral loop boundary for
`auto` and `task`. It delegates selection, leases, durable boundaries and
resume/handoff to `forge-orchestrate`; it does not spawn or choose workers.

Both modes are milestone-scoped: `task` is the same controller with a one-unit
budget and a terminal resume, not a second selection domain. Selection lives in
`forge-orchestrate` → `forge-unit-controller.selectNextUnit`, whose every branch
reads a milestone's roadmap/slices, over state that `forge-state` reads only from
`.gsd/milestones/<id>/<id>-STATE.md`. A **standalone task** (`/forge-task`, whose
artifacts live in `.gsd/tasks/<id>/` with no STATE and no roadmap) is therefore
outside this boundary, and `next`/`pause` refuse it by name: `outcome: blocked`,
`reason_code: task-scope-unsupported`, `action: stop`, snapshot unchanged. That
refusal is the defined answer, not a malfunction — the caller proceeds under its
own authority. Supplying an unrelated milestone id to reach a dispatch is never
the workaround: it selects that milestone's next unit and commits a lease and a
transaction against it.

States are `idle → dispatch_required | paused | completed | blocked | failed`.
`next` returns a dispatch intent while the S02 lease remains authoritative.
`pause` creates a durable boundary through `forge-orchestrate`. Only `resume`
may explicitly change `host_runtime`, and only with that boundary. A repeated
command with the same snapshot/idempotency key is safe and does not acquire a
second lease or increment the step counter.

The adapter supplies only `host_runtime`, mode, normalized input and
presentation. It must not read provider homes, infer worker/model, spawn a CLI,
or fall back to another host. Dispatch remains the S06 boundary.

## Milestone selection authority

`forge-unit-controller.select` owns milestone phase selection. Do not reproduce
its dispatch table in a skill or advance STATE by hand to skip a phase.

In auto mode, consume the loop adapter's selected unit and keep its snapshot;
do not call the read-only selector again after a unit has been leased. Stop on
`pause`, `stop`, a pending human decision, or an error as the lifecycle requires.

In step mode without a leased unit, resolve the active milestone ID from the
run/per-milestone STATE (the workspace STATE is only a dashboard), then call:

```bash
SELECTION_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-unit-controller.js" --select "$MILESTONE_ID" --cwd "$WORKING_DIR")
SELECTION_EXIT=$?
```

No active milestone means stop and report no active milestone. A nonzero exit
means stop and show the diagnostic; never fall back to interpreting STATE prose.
For `ok: true`, use `unit.type`, `unit.id` and `slice` as `unit_type`, `unit_id`
and `SLICE_ID`. For `done: true`, emit the completion report and stop. Any other
result stops without dispatch. Selection is read-only: it does not acquire a
lease or write STATE, and is not permission to bypass dispatch or approval gates.

The selector applies canonical `skip_discuss`, `skip_research` and
`skip_slice_research` preferences. The two research preferences are independent.
The existing `forge-parallelism.js` picker remains responsible for task
dependencies and batches, after phase selection and before dispatch. A live
controller lease must never be retargeted to a different task or slice by a
second picker; stop on a mismatch and preserve the snapshot for recovery.

For the selected unit, set `agent_name` by family: `plan-*` uses `forge-planner`,
`discuss-*` uses `forge-discusser`, `research-*` uses `forge-researcher`,
`execute-task` uses `forge-executor`, and `complete-*` uses `forge-completer`.
Model/engine/effort still come from `forge-dispatch-resolve.js`; these agent names
do not select a host, delivery mode or model.
Standalone `/forge-task` remains outside milestone selection.

## Personal status payload (2.0.0)

The provider-neutral forge-orchestrate status operation keeps the operation
envelope protocol_version at 1.0.0; init, next, complete and handoff are unchanged.
Its details.status_schema_version is 2.0.0. Consumers must use this status-specific
version when interpreting state and details; the old workspace status payload
is not the personal queue contract.

Without an ID, status lists only explicitly bound personal work. Explicit ID
inspection reads that work without binding it. A single personal milestone can
provide state; multiple personal milestones have no implicit focus. Empty
bindings return no_work; a task-only personal view still returns completed.
Snapshot read errors return failed with warnings rather than a workspace fallback.

- details.scope identifies personal or inspection; details.works carries canonical
  workStatus, reliability, nextAction, checkpoint and terminalEvidence.
- state is a validated snapshot projection: milestone, phase, active_slice,
  active_task, auto_mode and next_action. It never causes another state-file read.
  Invalid/missing/unreadable/changed state or stale checkpoint evidence yields
  state=null and the work diagnostic remains visible. next_action, when present,
  comes from the snapshot action, including a current personal checkpoint.
- The former state.progress roadmap aggregate is absent. Status does not scan
  peer roadmaps to populate it.
- details.runs contains only bound work with activity=active, with id, kind and
  activity. Former phase/stale run fields are absent; process activity is separate
  from work completion and evidence reliability.
- details.autonomous_tasks contains only personal/explicitly inspected tasks.
  Its status is the workStatus enum: open, pending, unknown or completed, not the
  previous workspace task-plan status. Use details.works for diagnostic/action
  information.
- warnings includes per-work reliability diagnostics and snapshot errors.

No read operation creates bindings, rewrites checkpoints or synchronizes project
instruction files. Workspace census remains an explicitly separate API.

## Failed-unit consumption and linked reentry

The public bridge is `forge-long-workflow-adapter.invoke(host, mode, command,
input, snapshot, dependencies)`. Both Claude and Codex use `consume-failure` and
`reenter`; `mode` is `auto` or `task`. The returned `.result.snapshot` is the next
snapshot. The host persists it through its existing checkpoint owner. CLI JSON
can carry references and identities, but cannot supply the live dependencies.

Consumption binds the cached snapshot to the checksummed committed begin,
milestone, unit, host, owner and lease generation. The controller inspects the
original request and receipt, checks termination through `processProbe`, and
requires reconciliation of every physical owner/code root if a writer is possible
or unknown. An omitted request root, live/unknown process, corrupt lease, successor,
incomplete transaction or divergent evidence blocks publication. A saved candidate
requires validation/replay through the original delivery contract first; it is
never converted into a failed result merely to advance the loop.

The lease process guard stays held through the terminal WAL, including the exact
release and committed boundary. Guard callbacks are synchronous. A matching
expired lease is releasable; proven absence does not create or renew one. A guard
whose process is alive or unknown cannot be stolen by TTL. Recovery requires a
dead-process observation and unchanged owner/generation metadata. Each terminal
phase can resume after process death. Committed replay preserves a successor lease
and does not republish an event or increment `step_count`.

The result remains `failed`, with its historical reason and provenance gaps.
`claude-timeout` alone establishes no provider cause. Current termination and root
observations are separate evidence, never invented historical facts. Auto returns
to `idle` after safe consumption; task mode terminates `failed`. Required question
IDs and status survive consumption; pending questions keep the boundary blocked.
Consumption does not approve gates or complete a slice or milestone.

Canonical records defer the failed unit and its unentered slice across restart
and consumers. An arbitrary begin key or `active_slice` cannot bypass this state.
Roadmap selection requires a literal explicit declaration such as `depends:[]`
or `depends:[S01,S02]` in backticks. Missing declarations, malformed or duplicate
declarations/IDs, unknown references, self dependencies and cycles block the
affected unit. An independent valid slice may proceed. Pending units with no
eligible candidate return `blocked`, never a completion inferred from JSON input.

Reentry is an explicit new unit, not continuation of the timed-out chain. It binds
the committed failure checksum, stable `entry_id`, current baseline digest,
unchanged physical roots, owner and host. The same baseline SHA is allowed. Same
entry/content replays; changed content conflicts. The host reattests scoped live
authority on entry and at the real sidecar boundary. A reference, `approved:true`,
serialized handle or expired capability is not authority. A fresh entry consumes
one step once and respects `max_steps`. Pending functional questions still block.

Repeated failures traverse the full immutable failure → begin → linked failure
chain. Only ancestors with matching checksums, unit, milestone, slice, host,
owner and physical roots are exempt from the unresolved-failure guard. Missing,
cyclic, altered or foreign links fail closed; unrelated failures remain blockers.

For current functional answers, the trusted host supplies `questionStateAdapter`
in loop dependencies and in sidecar `linkedEntryOptions`. This synchronous callback
receives `{identity, historical, previous, questions}` and returns
`{answers: [{id, answer}], questions?: [{id, question}]}`. It must verify its own
conversation/evidence provenance and reattest all previously resolved explicit
answers; it must not merely echo arbitrary JSON. Reattestation after restart uses
persisted evidence and does not require asking the user again. Empty, foreign,
duplicate or conflicting answer entries cannot resolve a question. New questions
start pending regardless of imported status flags. Identity binds the failure
checksum, unit, milestone/slice, owner, host and physical roots.

Current state is stored separately under `.gsd/forge/entry-questions/` through the
interaction helper; historical failure/begin/receipt bytes remain unchanged.
Partial answers are returned in the blocked loop snapshot. Reentry and real
linked dispatch revalidate the live adapter; restart without it cannot promote
persisted answers into authority. Newly observed pending questions block cached
dispatch and remain pending until explicitly answered. Missing or altered scoped
state, path links and changed roots fail closed. This embedding contract does not
authenticate a host that deliberately supplies a dishonest live callback.

The old begin, receipt and recovery bytes, attempted destinations and cumulative
60000 ms deadline remain unchanged. `linked_begin_key` is passed to
`forge-unit-sidecar.runUnitSidecar` with trusted `linkedEntryOptions`. The adapter
validates the committed lineage and current lease, creates an opaque in-process
binding and carries the `new-unit` identity into its own receipt/recovery chain.
Changing a dispatch ID, output path, SHA or recovery key cannot renew the old
deadline. Claims, isolation, original publication checks, gates, review and the
canonical resolver's explicit model/tier/effort remain required.

### Executable temporary-root example

Run this CommonJS example from the Forge checkout using `node` and stdin, or save
it outside the repository and adjust the require path. It creates only temporary
fixtures, never invokes a provider, and cleans up its temporary root. These test
adapters deliberately simulate trusted host observations; they must not be used
as operational process, reconciliation, baseline or authorization proofs.

```js
const assert = require('assert');
const demo = require('./scripts/forge-loop-failure.test');
const f = demo.fixture('codex', 'auto');
try {
  const before = demo.history(f);
  const consumed = demo.consume(f);
  assert.strictEqual(consumed.reason_code, 'failure-consumed');
  const entry = demo.entryInput(f, consumed, 'example-entry-1');
  const entered = demo.invoke(f, 'reenter', consumed.snapshot, entry);
  assert.strictEqual(entered.reason_code, 'entry-ready');
  assert.strictEqual(entered.snapshot.step_count, consumed.snapshot.step_count + 1);
  assert.deepStrictEqual(demo.history(f), before);
  console.log(JSON.stringify({ failure: entry.entry.failure_key,
    begin: entered.controller_result.details.transaction.idempotency_key,
    step_count: entered.snapshot.step_count }));
} finally {
  demo.cleanup(f);
}
```

`node scripts/forge-loop-failure.test.js` runs the full fixture matrix: the real
public bridge and sidecar with simulated transport, both host/mode combinations,
original byte preservation, separate owner/code roots, nine process crashpoints,
IPC-controlled live guard contention and concurrent consumers. Host vectors on
Windows do not establish execution on another operating system.

### Host integration and historical S03 mapping

The following is an integration template, not an operational command. `live` is
constructed by the trusted host from its retained original snapshot/request and
current observations; no callback below may be reconstructed from imported JSON.

```js
const adapter = require('./scripts/forge-long-workflow-adapter');
const sidecar = require('./scripts/forge-unit-sidecar');
async function consumeAndReenter(live, snapshot) {
  const input = { cwd: live.owner, milestone: live.milestone,
    workflow_id: snapshot.workflow_id, ...live.ownerIdentity };
  const consumed = adapter.invoke(snapshot.host_runtime, 'auto', 'consume-failure',
    { ...input, failure: live.failureReferences }, snapshot, live.dependencies).result;
  if (consumed.reason_code !== 'failure-consumed') return consumed;
  const entered = adapter.invoke(snapshot.host_runtime, 'auto', 'reenter',
    { ...input, unit: live.unit, entry: {
      entry_id: live.entryId,
      failure_key: consumed.controller_result.details.failure_key,
      failure_checksum: consumed.controller_result.details.failure_checksum,
      authorization_ref: live.currentEntryAuthorizationReference,
    } }, consumed.snapshot, live.dependencies).result;
  if (entered.reason_code !== 'entry-ready') return entered;
  // newRequest is separately prepared by the canonical resolver/builder, with
  // fresh output paths and the complete gates/claims/execution contract.
  return sidecar.runUnitSidecar({ ...live.newRequest,
    linked_begin_key: entered.controller_result.details.transaction.idempotency_key,
  }, { linkedEntryOptions: { ...live.dependencies,
    ownerToken: live.ownerIdentity.owner_token } });
}
```

The live dependency contract is:

- `inspectAttempt({cwd, begin, references})` returns the actual original `request`,
  `receipt_path`, complete `roots:[{root_id,path}]`, question IDs/status and any
  `provenance_gaps`. A failure reference is only a locator. Historical reason is
  read from the original receipt unless the host supplies its evidenced reason.
- `processProbe` implements the existing `inspectReceipt` probe contract and
  returns a current stopped/alive/unknown observation. Missing PID is insufficient.
- `reconcileRoots({root, context, inspection, begin})` supplies trusted proof for
  each possible writer root as `{root_id, process_stopped:true, reconciled:true}`.
  Use the original baseline and the existing reconciliation/reset helpers when
  available; reset still requires proved authorship and process termination.
- `replaySavedResponse` uses the original request's validation/publication path.
  Consumption stays blocked while a candidate requires that path.
- `captureEntryBaseline` returns `{sha256, roots}` from a fresh verified baseline;
  its roots must match the consumed physical roots, including owner and CODE_DIR.
- `entryAuthority` is an in-process `forge-attempt-recovery.createAuthority`
  adapter backed by the host's live authorization lookup. That lookup must return
  the same reference, `status:'resolved'`, `answer:'authorize'` and `resolved_at`
  for an actual current authorization of this new linked unit. The controller
  issues/validates the scoped opaque capability; it does not persist it.

For the historical S03 case, the mapping is `live.owner = C:/dev/forge-agent`,
`live.milestone = M-20261020200139-memoria-explicavel`, `live.unit =
plan-slice/S03`, and code root
`C:/dev/.forge-worktrees/M-20261020200139-memoria-explicavel/forge-agent`.
`input.cwd` is the owner; the retained original request and newly prepared request
use their actual code cwd/contextRoot. Supply both physical roots with stable
IDs, including the execution contract's actual primary root ID. Preserve the
original snapshot's workflow/host/begin checksum/generation and the host's current
owner identity. Obtain receipt/request/recovery locators from the retained attempt,
never by guessing a new dispatch filename. The historical planning evidence under
`.gsd/milestones/M-20261020200139-memoria-explicavel/evidence/s03/planning/`
is a reference for investigation, not current termination or authorization proof.

A legacy original request/receipt without `resolution_provenance` or resolver
context can be consumed: those fields are not prerequisites for terminal
inspection. Record their absence in `provenance_gaps`; validate original identity,
receipt, process and every root using current trusted observations. Missing old
writer metadata remains unknown and requires reconciliation. Historical gaps do
not become a permanent ban when current sufficient evidence exists. New entry
still needs its own current baseline and explicit live scope authorization;
standing permission to try another route in the old recovery chain alone does
not classify a new unit. This implementation was verified in temporary fixtures;
no consumption, reentry or writer was applied to the operational S03 snapshot.
