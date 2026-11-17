# Committed completion: retained-claim owner recovery

This path is for the original committed execute-task completion that lacks a
current delivery proof. It never reruns implementation or changes old journals.
Use `forge-completion-delivery-recovery.resumeAndCreateRepair` as the canonical
live host bridge when the milestone owner changed or became inactive.

Before calling, join/reconcile the prior owner and every possible writer/root,
inspect processes and receipts, replay eligible saved evidence, and resolve all
functional questions. An inactive record, a reboot date, or a merged PR alone
does not attest quiescence. Preserve the held claim; do not release it to bypass
owner transfer. Future auto/next claims resolve physical roots before recording.
A legacy claim without its actual code_dir still refuses: reconcile and replace
it only through the existing authorized claim protocol, preserving its history.

The host observes its session through `forge-runs.observeHostSession`, reads
`inspectOwnerResume`, and supplies that exact `record_sha256`. The bridge accepts
the same `createRepair` scope (cwd, milestone, slice, task, runId, ownerToken,
hostRuntime, beginKey, completionKey, executionContract), plus expectedSession,
expectedRecordSha256, confirmOwnerStopped and confirmWorkspaceQuiescent.
Here ownerToken is the observed current session token. Confirmation booleans are
trusted caller attestations after real investigation, not OS proof or consent.

Three live functions remain required: `assertAuthority(scope)` validates the
existing authorization for this exact repair; `attestStoppedWriter(scope)` returns
true only after reconciling all writers/roots; `readPendingQuestions(scope)` reads
current questions and returns their stable IDs/statuses. Do not replace them with
JSON approved fields, stale saved answers, or unconditional example callbacks.
They are rechecked during preflight, start, capture completion and continuation.

```javascript
const runs = require(`${scripts}/forge-runs`);
const recovery = require(`${scripts}/forge-completion-delivery-recovery`);
const actor = runs.observeHostSession(hostRuntime, expectedSession);
if (!actor) throw new Error('owner-session-unavailable');
const observed = runs.inspectOwnerResume(cwd, runId,
  { hostRuntime, expectedSession: actor.sessionId });
const repair = recovery.resumeAndCreateRepair({
  ...repairScope, cwd, runId, hostRuntime, ownerToken: actor.sessionId,
  expectedSession: actor.sessionId,
  expectedRecordSha256: observed.record_sha256,
  confirmOwnerStopped: hostEvidence.ownerStopped,
  confirmWorkspaceQuiescent: hostEvidence.workspaceQuiescent,
  assertAuthority: hostAdapter.assertAuthority,
  attestStoppedWriter: hostAdapter.attestStoppedWriter,
  readPendingQuestions: hostAdapter.readPendingQuestions
});
const next = repair.start(); // verification-required / verify-only
```

Capture verification and artifacts in the original code roots after this new
begin, publish the canonical delivery, and call `repair.complete()`. Then use
`resume-delivery` in the same saved auto/step snapshot, retaining workflow ID,
steps, budgets, root contract and pending questions. A callback failure stops
the dependent operation. Never serialize this live adapter as authority.

Strict glob scope is concrete: captured Git revision plus dirty bindings, with
current VCS universe checked before and after proof. Untracked installation
products follow the canonical snapshot exclusion only when a captured root
.gitignore rule proves that whole fixed directory subtree; arbitrary ignored
source requires concrete bindings or refuses. Concrete criteria are mandatory
even inside ignored installation directories. Missing revision objects, unsafe
roots/links, ambiguous ignore rules, unsupported VCS inventory and bounds remain
explicitly unproven. Historical proof uses the captured universe and never
claims current-source or integrated acceptance.
