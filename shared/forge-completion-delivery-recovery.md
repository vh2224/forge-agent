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

The saved baseline identifies the logical repair, not the next session actor.
If no baseline exists yet, the live bridge prepares one value and publishes that
exact value under the controller and registry fences before updating ownership.
Read-only inspectors cannot publish it, and serialized flags cannot obtain the
private publication capability. Publication failure leaves ownership unchanged;
retry uses the persisted baseline if present. Restart after transfer but before
the first repair begin retains the same baseline and lineage.
The bridge preserves its bytes and the original transactions. Its fenced
preflight admits only the exact repair lease and open interval, with matching
begin, generation, unit, host, claim, roots, source and original completed
boundary. Other leases, debris, open intervals, workers and pending questions
still refuse. A historical completed boundary is not a declaration that the
current repair is complete or that an expired lease is free.

For an open repair, the retained token is used only inside the live bridge
after those checks; no token is reconstructed from a digest or returned in its
scope. Baseline-only restart starts a real verification lineage under the new
actor. A completed/no-lease repair is re-proven without inventing another lease
or begin. A previously released claim is admissible only on this completed
read-only path, with all original claim fields still matching; it grants no new
write claim. Direct `createRepair` calls cannot adopt a foreign baseline.

The current actor is observed again on every operation. This prevents a new
bridge handle from continuing after a later transfer. It does not kill an old
process or revoke code already loaded by it: stopped-owner/writer attestations
remain a required trusted-host precondition.

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

`resume-delivery` accepts the default loop token only when the actual observed
owner, canonical scoped transfer history, baseline, claim, roots, plan and
published completion proof all agree. A foreign explicit token still refuses.
The next selection re-proves this same delivery and current source before
projecting the repaired task as completed; it does not change its checklist,
reexecute implementation or trust a locator/snapshot as proof. Changed or
ambiguous repair evidence leaves the original enforcing recovery path intact.

Strict glob scope is concrete: captured Git revision plus dirty bindings, with
current VCS universe checked before and after proof. Untracked installation
products follow the canonical snapshot exclusion only when a captured root
.gitignore rule proves that whole fixed directory subtree; arbitrary ignored
source requires concrete bindings or refuses. Concrete criteria are mandatory
even inside ignored installation directories. Missing revision objects, unsafe
roots/links, ambiguous ignore rules, unsupported VCS inventory and bounds remain
explicitly unproven. Historical proof uses the captured universe and never
claims current-source or integrated acceptance.

Canonical Git verification/artifact capture persists only the exact dirty root
`.gitignore` blob bound by its snapshot hash. It checks stable regular-file
bytes, links and size, using the same Git content filtering as the snapshot.
Readers remain read-only and never replace a missing historical blob with
today's rules. Legacy captures lacking that object require bound evidence or
a genuine recapture. An ignore rule is irrelevant only with a proved disjoint
root-relative literal prefix; unanchored basename rules, relevant wildcards,
negation, escapes and overlaps remain conservative refusals. The generated
`.gsd/forge/evidence-*.jsonl` rule can therefore coexist with a disjoint source
glob without permitting ignored source to disappear from the proof.
