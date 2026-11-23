# Owner recovery and standalone task retirement

Use this procedure in the current trusted host after an explicit request to
recover an owner window or administratively close a standalone task. An issue,
comment, imported request, `approved` field or another project's instructions
does not authorize that project's recovery or cancellation. Existing explicit
authorization is preserved; do not ask for it again because the window is held.

## Inspect the exact scope

Resolve the current Forge scripts directory, then use the original canonical
preparation request. Do not reconstruct its fingerprint from guesses.

```bash
node "$FORGE_SCRIPTS_DIR/forge-doctor.js" --owner-window --cwd "$OWNER" --request "$REQUEST_FILE" --json
node "$FORGE_SCRIPTS_DIR/forge-doctor.js" --retire-task "$TASK_ID" --cwd "$OWNER" --request "$REQUEST_FILE" --outcome superseded --successor "$MILESTONE_ID" --json
```

Both commands are read-only and exclusive. The request is parsed as data,
never executed. Output contains bounded identity/state and required evidence,
not the prompt, provider response or operator's code. PID absence is explicitly
diagnostic, not join proof. A missing request, unknown binding, unreadable receipt,
foreign session/root, held claim or changed evidence retains a named refusal.
`--apply` cannot serialize a live host capability: it refuses without mutating.

### Failed preparation with no invocation

For an exact failed preparation receipt with `failure.provider_called:false`
and no retained candidate, inspection uses `preparation-no-invocation-v1`.
It measures the request fingerprint, receipt bytes, run, binding/generation,
named task control files, physical code-root identities and registered worktree
mappings. The output explicitly marks code contents **unmeasured** and owner
metadata limited to named controls. It does not inventory unrelated SVN files
or the entire owner history. The original full snapshot profile and its strict
limits remain in force for all other attempts. A saved candidate must follow
canonical replay/reconciliation; it cannot use this settlement profile.

This limited observation is coordination evidence only. It cannot authorize
artifact acceptance, replay, code reset, another writer, claim release or a
successful task outcome. `provider_called:false` establishes eligibility,
never proof that an external native tool was not invoked. Recovery still needs
the actual host/session, complete writer joins, root reconciliation and fenced
remeasurement. In addition, its writer callback must report
`no_invocation_observed:true`, `coverage_complete:true` and
`unmeasured_code_contents_acknowledged:true` from actual observations.
Unknown invocation or descendants retain the window. Administrative retirement
preserves its separate explicit decision, personal binding and claim gates.

For the same observed owner, the assistant can settle the failure through the
shipped API after obtaining actual native-tool and CLI termination evidence:

```javascript
const doctor = require(`${FORGE_SCRIPTS_DIR}/forge-doctor.js`);
const adapter = doctor.createPreparationSettlementAdapter({
  hostRuntime: HOST_RUNTIME,
  observeWriters, // synchronous callback over actual joined tool/CLI observations
  reconcile      // synchronous callback over exact controls and physical roots
});
const settled = await doctor.settleFailedPreparation(request, adapter);
```

The trusted host authors these live callbacks in its current Node/Bash bridge;
the operator does not implement challenge hashing. `observeWriters` returns the
three explicit fields above, `writers:[{state:'joined',reference}]`, `joined:true`,
`possible_writers:0` and a real tool/event `reference`. `reconcile` returns
`reconciled:true` and its actual evidence `reference`. The factory binds the
current observed session and exact fresh challenge itself. A Bash process does
not independently discover another Claude/Codex session's descendants: the host
must obtain that evidence from tools it actually has before constructing the
callbacks. JSON files, a terminal receipt and PID absence cannot supply it.

#### Executable native-decline example

The example below is deliberately limited to a fresh canonical request whose
caller already explicitly selected `worker_mode:native` or `workerMode:native`.
Do not add that flag to a retained request or use this example to replace a
selected sidecar. It declines before calling any native tool. Its evidence is
the wrapper's real CLI close events plus the in-process branch that calls no
tool; no transcript JSON or invented host SDK supplies authority. A failure
before that branch, an older held attempt, or unknown writers stays held.

Save this complete block as an owned `decline-native.cjs` outside the code roots:

<!-- forge:preparation-native-decline-example:start -->
```javascript
'use strict';
const fs = require('node:fs'), path = require('node:path');
const [scripts, requestFile, acceptanceFile] = process.argv.slice(2);
if (!scripts || !requestFile || !acceptanceFile) throw Error('scripts, request and external acceptance paths required');
const load = name => require(path.join(path.resolve(scripts), name));
const prep = load('forge-task-preparation'), windows = load('forge-owner-transport-window');
const doctor = load('forge-doctor'), roots = load('forge-code-roots');
const source = fs.readFileSync(requestFile), raw = JSON.parse(source);
if ((raw.workerMode || raw.worker_mode) !== 'native') throw Error('an already explicit native request is required');
const request = prep.validateRequest(raw), owner = request.contextRoot || request.cwd;
const contract = roots.validateContract(request.execution_contract || roots.singleContract(owner, request.cwd), { revalidate: true });
let declinedBeforeTool = false;
const adapter = doctor.createPreparationSettlementAdapter({
  hostRuntime: request.hostRuntime,
  observeWriters(challenge) {
    if (!declinedBeforeTool || !Array.isArray(challenge.cli_joins) || !challenge.cli_joins.length
        || challenge.cli_joins.some(row => row.closed !== true)) throw Error('live no-invocation/CLI coverage unavailable');
    return {
      coverage_complete: true, no_invocation_observed: true,
      unmeasured_code_contents_acknowledged: true,
      writers: challenge.cli_joins.map(row => ({ state: 'joined', reference: `actual ${row.mode} close pid=${row.pid} status=${row.status}` })),
      joined: true, possible_writers: 0,
      reference: 'this in-process callback deliberately invoked no native tool; wrapper observed its CLI closes'
    };
  },
  reconcile(challenge) {
    if (!fs.readFileSync(requestFile).equals(source)) throw Error('request changed');
    roots.validateContract(contract, { revalidate: true });
    if (challenge.scope) {
      const current = load('forge-owner-window-recovery').capture({ owner, request: raw });
      if (current.observation_sha256 !== challenge.scope_sha256) throw Error('named controls or physical roots changed');
    }
    return { reconciled: true, reference: 'actual request bytes, named control observation and physical-root identities; code contents unmeasured' };
  }
});
windows.runCliPreparation(requestFile, {
  acceptanceFile, ownerTransportAdapter: adapter,
  async invokeNative() {
    declinedBeforeTool = true; // This branch calls no Agent/spawn/tool API.
    throw Object.assign(new Error('declined before native tool'), {
      code: 'host-declined-before-tool', provider_called: false
    });
  }
}).then(result => process.stdout.write(JSON.stringify(result) + '\n'))
  .catch(error => { process.stderr.write((error.code || 'preparation-decline-failed') + '\n'); process.exitCode = 1; });
```
<!-- forge:preparation-native-decline-example:end -->

Both launchers run the same program with three actual absolute arguments:

```text
node <owned>/decline-native.cjs <FORGE_SCRIPTS_DIR> <request.json> <external-acceptance.json>
```

- **Codex:** use the actually exposed foreground `exec_command`; if it returns
  a running `session_id`, join that exact handle with `write_stdin` until its
  real terminal result. Those handles prove this controlled CLI family only.
- **Claude Code:** use the actually exposed foreground `Bash`. A background
  acknowledgment is not a join. If the session exposes no supported way to join
  its exact background family, retain the window and report the missing coverage.

The example is exercised with real CLI processes under both synthetic host
identities; that does not prove a live Claude Code tool schema or an actual
provider invocation. To execute native work instead of declining it, a real
in-process host binding must track and join that tool's complete family. Neither
`Bash`/Node nor a separate Codex command can independently discover another
session's native agents. A later standalone `settleFailedPreparation` call is
conditional on genuine host observations; it is not a generic unlock command.
Without that bridge/evidence, keep the window and use the supported owner
recovery path after obtaining the required actual observations. Do not fill the
callbacks with `true` copied from a file or an unverified transcript.

`runCliPreparation` attempts this same supported settlement after either failed
CLI return, using its actual close observations. Missing or insufficient live
proof keeps the original failed result and reports `owner_window.status:held`
with a named reason. Successful settlement reports `closed`, preserves the
failure outcome and never rewrites the receipt or invokes a provider. A new
owner uses the existing recovery API with its additional previous-owner proof.

### Registered isolated worktrees

Keep the original preparation request unchanged, including its `cwd` and
fingerprint. A legacy request can name the original repository while its run
records an isolated worktree. The reconciliation census measures both checkouts
after validating the registered repository, worktree, exact branch and physical
identity. An explicit contract already naming the isolated checkout also retains
its owner repository in the census. This adds observed roots for reconciliation;
it does not rewrite the execution contract or grant another code-writing scope.
Foreign repositories, wrong branches, duplicate/aliased registrations, malformed
records and changed mappings refuse. Nested registered Git checkouts remain
separate measured roots even when the original repository ignores their folder.

### An already preserved receipt copy

Prefer a durable external result directory when starting a new preparation.
Do not reconstruct or edit a historical request to relocate its result path.
For an existing preparation whose original temporary receipt has disappeared,
an already preserved copy may be supplied explicitly:

```bash
node "$FORGE_SCRIPTS_DIR/forge-doctor.js" --owner-window --cwd "$OWNER" --request "$REQUEST_FILE" --receipt-copy "$TASK_EVIDENCE/retained.receipt.json" --json
```

Use the same optional `--receipt-copy` with `--retire-task`; the host APIs accept
`receiptCopy: ABSOLUTE_FILE` with inspection, recovery and retirement. The copy
must be a bounded stable ordinary file inside this exact task's
`.gsd/tasks/$TASK_ID/` directory, with no symlink ancestors. Its dispatch and
preparation-request fingerprint must match. If the original is still present,
their bytes must be identical; a conflict or unreadable original never triggers
automatic fallback. The original path stays in the scope together with the
selected copy, its hash and the original presence/hash. Changes invalidate the
observation, including removal of the original while reconciling a copy.

The copy supplies historical data only. The live host must reconcile its actual
provenance along with both code roots; a file cannot attest writers, answer a
question, accept artifacts or authorize replay. There is no automatic search or
copy creation through a held owner window. Without an original or trustworthy
preserved copy, retirement remains `task-retirement-receipt-required`; do not
fabricate a receipt or promote a result/request JSON to one.

## Observe writers in the real host

The assistant performs this step; the operator need not implement a lock wrapper.
Use only tools actually exposed by the current host, with their real schemas.
Identify the previous owner session and the complete set of its possible native
agents, background commands, CLI children and descendants for this request.
Obtain actual completion/join results, or stop only the explicitly scoped writers
when already authorized and then observe their termination. An empty task checklist,
a terminal receipt, an old transcript, PID death, TTL, elapsed time or a parent exit
alone is insufficient. Preserve receipts and reconcile the exact owner surface
and every measured code root, including dirty changes retained as history.

For Claude, `TaskList` is task tracking, not a process-family census. Current
documentation removes `TaskOutput` in favor of reading the background output
file; `TaskStop` is usable only if exposed and the target is established. An old
"done" message does not prove current quiescence or prevent later resumption.
See the [official tool reference](https://code.claude.com/docs/en/tools-reference)
and [subagent resumption contract](https://code.claude.com/docs/en/sub-agents#resume-subagents).
For Codex, current-tree collaboration tools do not establish an inventory of a
different session. Actual closed CLI handles can attest only their proved family.

If the host cannot establish complete coverage for a legacy session, report
`owner-window-writer-unproven` and the concrete missing evidence. Do not remove
the lock, change its baseline, transfer the run, add a force flag, claim that
restarting/joining the parent proved descendants stopped, or recommend reinstalling.
The supported path is conditional on real host evidence, not universal automatic
recovery of every historical window.

`coverage_complete` means the trusted host can account for the complete possible
writer family and bind actual termination observations to this attempt. For
example, a host that tracked all native-agent IDs and background-command handles
can join those exact writers, provided its tools also cover descendants and
prevent an unobserved continuation. A tool result covering only a parent or
current session cannot attest a different legacy family. A command-line census
matching an old session ID/PID/worktree, even when empty, is diagnostic evidence
only; it does not prove that detached or renamed descendants were joined. The
adapter validates the bound report, not the semantics or availability of an
external census tool. Missing coverage stays an explicit limit.

After a supported recovery and retirement, continue the milestone through its
own gates. `decideObserved` accepts an explicit earlier answer observed by the
current host in a resumed transcript with `source:'user-text'`, exact persisted
question identity and matching response; imported transcript JSON alone cannot
create the live callback. Recapture stale personal checkpoint sources while
preserving the same actual accepted decisions. A new checkpoint is neither a
new acceptance nor an answer to an unresolved question.

## Invoke the supported host API

The host keeps observations in live callbacks, after obtaining them from its
actual tools. The three function names below are host callbacks, not invented
native tool APIs. They cannot be supplied as JSON or read back as an approval.
The assistant implements these adapters from the observations it actually made;
do not ask the operator to write the low-level challenge protocol.

```javascript
const doctor = require(`${FORGE_SCRIPTS_DIR}/forge-doctor.js`);
const adapter = doctor.createOwnerRecoveryAdapter({
  hostRuntime: HOST_RUNTIME,
  observeWriters, // live callback: complete census and actual joined results
  reconcile,     // live callback: owner/receipt/all-code-root reconciliation
  observeDecision // live callback: explicit operator cancellation/superseding
});
const recovered = await doctor.recoverOwnerWindow({owner: OWNER, request, adapter});
// Only when task retirement itself was explicitly requested:
const retired = await doctor.retireTask({owner: OWNER, request, adapter,
  outcome: 'superseded', successorId: MILESTONE_ID});
```

`observeWriters(context)` must return `coverage_complete:true`, the exact
`previous_session_sha256` from `context.scope`, `previous_owner_stopped:true`
for an older session, `writers:[{state:'joined', reference}]`, `joined:true`,
`possible_writers:0` and a bounded real tool/event `reference`. Every known
writer is represented; unknown or active descendants refuse. A same-session
task can be retired after joining its writers without ending its own live host.
`reconcile(context)` returns `reconciled:true` and its actual evidence reference.
`observeDecision(context)` returns the explicit `outcome`, `successor_id` (or null)
and conversation/native-answer reference. No callback may invent an observation,
infer an answer from silence, or turn an issue comment into operator consent.
If a required decision is missing, present it through the permitted question
channel, persist its stable ID and close the round per the economic-wait policy.

The canonical adapter binds each callback to the current observed host/session,
fresh challenge, exact scope and nonce. The module validates callback results;
it cannot prove the semantics of an external tool call. Host honesty and actual
tool availability remain explicit obligations. These are owner APIs, never worker
tools. CLI flags and files cannot create their opaque capability.

Recovery remeasures the binding/generation, run, request, receipt, physical roots
and protected owner surface under the publication fence before release.
Root measurements include Git index bytes/entries and split-index dependencies,
plus strict SVN metadata/property state: unchanged working bytes do not make
staging or property-only changes invisible. Changed paths also retain their
working-tree type, mode and link identity without following link targets.
The audit is private and outside the held owner window. It releases coordination only:
the old run owner and receipt are preserved, no result is replayed/published,
no model is dispatched and no input question is answered. A saved response still
requires canonical validation and publication before any resumed execution.
`audit_saved:false` records a separate audit-write limitation after actual release;
never report the window as still held or repeat inference solely for that write.

## Retirement preserves truth and history

`cancelled` and `superseded` are administrative terminal outcomes, distinct from
`DONE`, implementation success and human acceptance. Superseding requires a real
milestone in this owner project. The selected task must belong to this personal
profile, the request/receipt must match, and a held code claim requires its own
canonical reconciliation before retirement. No blanket claim clearing occurs.

The helper retains code, dirty changes, commits, worktree and failed/partial
receipts. Its immutable retirement record states the successor, real actor,
decision, stopped-writer and reconciliation references and `retained` disposition.
It never deletes a worktree, branch or receipt. Any later cleanup is separately
explicit and uses canonical isolation checks.

The run becomes inactive with a checked retirement reference. Historical
questions and personal checkpoints stay untouched and unanswered. Full personal
inspection shows the cancellation/superseding and retained evidence; active
summary/selection omits only a validated retirement. It is `all-closed`, not
`no-bindings`, when only retired bindings remain. Missing/changed evidence remains
visible as unknown, and stale heartbeat/resume writes cannot reactivate the run.

Publication failure is reported separately. A retirement file without its exact
committed run reference is not terminal authority and cannot hide the task.
Reconcile actual run/file state; a fresh authorized retry preserves the orphan
record and obtains fresh live observations. An already published identical
retirement returns `already-retired` without requesting the accepted decision again.

## Legacy coordination retirement: explicit operator origin and current OS epoch

This is a separate opt-in administrative path. It never supplies a historical
join, accepts work, replays a result, resets code, or broadens the strict recovery
adapters. Implementation approval for this feature is not consent for any window.

Each use names the unchanged canonical request and the exact observed window.
The current host presents the canonical per-window question returned by the
operation, using its actually exposed permitted question tool or explicit user
text. It records the real answer/reference, its question ID/hash and exact target.
The operator separately attests that this old window originated on this current
computer and authorizes cancellation of this task and retirement of this window.
No historical machine ID is reconstructed: that origin remains human-attested.

The module itself queries local Windows through a fixed bounded command and
observes the actual child close. Root paths travel only as bounded base64 JSON
in the child environment, never as interpolated PowerShell code. A closed SO
observation includes every root ancestor's File.GetAttributes flags and current
logical-volume filesystem/type/serial. Independent lstat/realpath.native walks
before and after each identity measurement reject links, junctions, arbitrary
reparse tags, aliases, device changes/mounts, unstable dev/ino/birth identity and
unknown filesystems. Only observed fixed NTFS/ReFS roots qualify; inability to
measure a root refuses instead of inferring locality from its drive letter.
It binds current machine/boot observation, monotonic consistency, local physical
volumes, exact request/receipt/run/window and root/control hashes. The old window
must predate this boot. Current writers
and native tool families still require genuine current-host observation and
reconciliation. A reboot date, PID absence, transcript, feature answer, imported
JSON, nonce, or a `coverage_complete` flag does not establish those observations.
Any current writer or native agent that the host cannot account for is unknown
and refuses. The OS census is a diagnostic input, not a native-agent inventory.

Supported entry points after the feature is installed:

```javascript
const legacy = require(`${scripts}/forge-legacy-preparation-retirement`);
const result = await legacy.retire({ owner, request, receiptCopy }, {
  askExactOperatorDecision: currentHost.askExactOperatorDecision,
  observeCurrentWriters: currentHost.observeCurrentWriters,
  reconcileCurrentScope: currentHost.reconcileCurrentScope
});
```

These are live functions from the current trusted host. They must actually ask
or reuse an already observed answer for this exact window, account for the
current native/CLI families and actual joins, and remeasure the current scope.
They are not unconditional callbacks reconstructed from a past transcript. No
function needs the former session's process handle: boot plus explicit origin
is the separate legacy premise; current families still need current evidence.

The same library is exposed as an owned, host-supervised Node stdio process:

```text
node <FORGE_SCRIPTS_DIR>/forge-doctor.js --legacy-preparation-retirement --cwd <owner> --request <unchanged-request.json>
```

An optional explicit `--receipt-copy` follows the existing bounded-copy rules.
There are no `--approved`, `--joined`, `--local-origin` or `--force` shortcuts.
While that exact process remains alive it emits `host-observation-required`
messages with correlation ID, operation and frozen challenge. The actual host
performs the indicated current question/observation/reconciliation using real
tools, and replies on that process's owned stdin as
`{id,kind:"actual-current-host-observation",result:...}`. The callbacks and opaque
permit remain in that same Node process. The ID/JSON channel correlates an
observation; it does not authenticate a human answer or prove a tool result.
Those semantics remain the obligation of the actual supervising host.

On Claude, use an actually available supervisor/runtime that can keep this
owned process and deliver those real callback observations; no new Claude SDK
or tool schema is assumed. Ordinary foreground Bash alone cannot manufacture
current native-agent coverage or continue a process stdin it does not expose.
When the current host cannot supervise those operations, refuse
`legacy-retirement-live-current-host-required` or
`legacy-retirement-current-writer-unmeasured`; keep the window. The library path
with live current callbacks is available to a genuine host integration. Do not
present the plain CLI as a universal unlock command.

After revalidation under the existing reconciliation lock, a private capability
uses the original exact binding/token/generation. It publishes the canonical
cancelled task record with the new proof kind and coordination-only limitations,
then uses the existing binding release primitive. The original
failed receipt and code stay unchanged, the run becomes inactive, the task's
canonical terminal record prevents a late replay, and all worktrees stay retained.
The audit explicitly states `historical_join:not-observed`, operator-attested
origin, `code_contents:unmeasured`, `artifacts_accepted:false` and
`code_completed:false`. A publication exception is reconciled against the actual
canonical record; a genuinely committed cancellation may continue, retaining a
sanitized `publication_reconciled_after_error` diagnostic in result/audit.

Binding restoration on release failure does not restore a marker or metadata
already changed by the lock release operation. If cancellation was published
but release fails, return `status:partial`, `cancellation_published:true`,
`coordination_retired:false` when the original binding is actually observed, or
`unknown` when it cannot be established. Retain the audit and a named release
diagnostic, exit nonzero, and do not claim successful retirement or automatic
retry. The strict lock engine is unchanged. An intact, already published exact
terminal may be recognized by fresh valid observations without rewriting it;
that does not promise recovery from partially removed lock metadata/markers.

Tests distinguish pure policy fixtures, canonical mutation fixtures with a
synthetic private OS observer, and a real Windows observer check. No fixture
proves a real reboot or consent for another project's actual window. Existing
strict recovery and SVN inventory limits are unchanged.

## Exact retained resource append in a code root

An existing owner approval does not authorize a later resource-event append in
another protected root. The recovery caller preserves the original receipt, S0,
owner answer and event bytes, and obtains a separate exact-byte decision:

```javascript
const question = activity.codeRootAppendDecision(request, {
  ownerDecision, rootId, originalBytes, appendedBytes
});
```

Present and persist that canonical question, then obtain its actual explicit
answer. Pass its new identity through `codeRootAppendApproval` when creating the
owner reconciliation, with the same root/prefix/suffix and a live
`attestOperatorAnswer` callback. That callback must observe the real exact answer
and bind the canonical challenge digest and host observation reference. Imported
JSON, an old approval or a label claiming user text does not supply consent.

After creating a genuine verification-repair or timeout successor, use
`successor.bindOwnerReconciliation(actualSuccessor, request, sameReconciliation)`.
Pass that same opaque reconciliation and genuine successor to verification-only
recovery. A serialized replacement, another handle, changed question carrier,
later append or any other protected-file difference refuses. Only the approved
resource JSONL append is projected in the complete original root comparison;
the old baselines and provenance stay unchanged. Existing writer reconciliation,
claims, live authority, single-use and publication gates still apply. This API
does not grant permission to recover another project's retained window.

The focused fixture cases retain separate result/request/acceptance files and
owners for release refusal before marker mutation, refusal after the real marker
rename, and a reconciled post-publication error. Canonical Buffer/string/object
digest semantics are tested directly; Buffer hashes are never JSON(Buffer).
