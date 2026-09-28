# Standalone task preparation

Canonical contract for the `brainstorm`, `discuss`, `research` and `plan` phases
owned by `forge-task`. The executable owner is
`scripts/forge-task-preparation.js`; the skill supplies phase inputs and invokes
the host tool only when the caller returns a native action.

## Identity has two axes

Routing identity and artifact scope answer different questions and remain
separate in every request:

| Phase | Resolver unit | Agent | Required task artifact |
|---|---|---|---|
| `brainstorm` | `plan-slice` | `forge-planner` | `{TASK_ID}-BRAINSTORM.md` |
| `discuss` | `discuss-milestone` | `forge-discusser` | `{TASK_ID}-CONTEXT.md` |
| `research` | `research-milestone` | `forge-researcher` | `{TASK_ID}-RESEARCH.md` |
| `plan` | `plan-milestone` | `forge-planner` | `{TASK_ID}-PLAN.md` |

The resolver unit preserves existing tier, model and effort preferences. The
request fields `scope: "standalone-task"` and `phase` select the prompt and
artifact contract. A resolver unit never authorizes a milestone path. The
caller never creates or selects a milestone for a standalone task.

## Request and route

The request is versioned data with a validated task ID, canonical working and
context roots, actual host runtime, workflow and dispatch identities, external
result file, constraints, and either bounded prompt text or a validated prompt
file. A continuation adds recorded answers, the prior dispatch identity and its
external result path.

Task IDs delegate to `forge-ids.isValid()` and require
`forge-ids.entityKind(id) === "task"`. This includes sequential IDs, compact
timestamp IDs and accepted dashed timestamp IDs. The destination is derived
only after that validation.

The caller invokes `forge-dispatch-resolve.js` once with the mapped resolver
unit and actual host. It does not pass `worker_mode` by default. An explicitly
authorized mode remains explicit input and keeps the resolver's normal
semantics. The complete route is retained; model, effort, worker and transport
are never reconstructed from prose or inferred from the host.

## Transport

An allowed `native` route produces structured native invocation arguments from
`forge-native-invocation.js`. Codex receives the complete model ID, reasoning
effort and bounded fork history. Claude receives the mapped alias and an
observed agent-frontmatter effort binding. Callers invoke those arguments
unchanged and return the result to the acceptance command. The native host-tool
schemas do not expose a per-call read-only sandbox. Native preparation therefore
uses an output-only contract plus a comparison between the recorded
protected-target baseline and the state at acceptance. It refuses observable
changes. This comparison cannot prove that no restored write or write elsewhere
occurred, so it must never be described as OS-enforced read-only execution.

Every native outcome crosses `--accept-native`. Success carries `route`,
`rawResult`, `invocationTelemetry` and `providerCalled:true`. A tool or adapter
refusal before provider start carries
`{route,nativeFailure:{reason_code,provider_called:false}}`. A failure after a
positively observed provider start carries `provider_called:true` plus the exact
invocation telemetry shape. The reason code is sanitized adapter data, not raw
provider output. True requires positive provider-start evidence from the host;
submitting a tool request alone is insufficient. False means provider start was
not observed and is not proof of absence when the host reports an ambiguous
refusal. These failure acceptances close the durable `started` receipt; they do
not parse or publish an artifact.

An allowed `sidecar` route enters the declared sidecar adapter with the resolved
model and effort under its enforced read-only profile. Both transports return
the same envelope:

```json
{
  "status": "done | partial | blocked",
  "summary": "bounded text",
  "questions": [],
  "artifacts": [{ "path": ".gsd/tasks/<id>/<id>-<SUFFIX>.md", "content": "..." }]
}
```

Workers are instructed never to write canonical preparation artifacts, decision
fragments, STATE, ROADMAP or milestone files. The sidecar enforces its sandbox;
native acceptance refuses protected destinations whose observed state changed
from the recorded baseline. The parent owns validation and publication.

## Validation and publication

`done` requires exactly the one artifact named by the phase and forbids pending
questions. `partial` and `blocked` may carry questions and must carry no
artifacts. Unknown keys, missing or duplicate artifacts, wrong task or phase
paths, backslashes, traversal, control characters, absolute paths, links,
oversized content and untrusted control data are refused before publication.

The parent captures hashes for every allowed destination before provider work.
It persists an exclusive `started` receipt, validates the complete envelope,
persists `ready` before publication, checks all conflicts before the first
write, then publishes atomically. A crash after `ready` replays publication
without another provider call. A changed fingerprint, ambiguous `started`
receipt, failed receipt, symlink or concurrent edit fails closed.

Native acceptance also validates the complete adapter telemetry against the
resolved route. Requested, resolved, argument and observed identities remain
separate. An argument sent to a provider is not evidence that the provider
applied it.

## Questions and continuation

A `partial` or `blocked` discussion returns its questions to the parent without
publishing CONTEXT or marking the phase complete. The host applies
`shared/forge-interaction.md`; a required question remains pending until the
operator answers it explicitly.

Continuation uses a new `dispatchId` and `resultFile`. Its `continuation`
object carries the prior `dispatchId` as `from_dispatch_id`, the prior external
result path as `result_file`, and the recorded explicit `answers`. These fields
participate in the request fingerprint and prompt. The caller verifies that the
prior result is the recorded partial or blocked attempt. Replaying the old
dispatch returns the old pending result; it never treats a later answer as if
it belonged to that attempt. Replaying the completed continuation republishes
only from its `ready` receipt.

## Diagnostic layers

Report the first layer that refused, without collapsing it into provider error:

1. request, task ID, scope or phase validation;
2. preference and route resolution;
3. runtime authorization and declared transport capability;
4. native model, effort, alias, binding or active-tool compatibility;
5. provider process or callback;
6. envelope, artifact and untrusted-output validation;
7. receipt, replay, conflict and publication.

Every outcome retains host, resolved worker, worker mode, requested/resolved
model and effort when those facts exist. `dispatch_allowed:true` proves only the
runtime authorization layer. A refusal before the provider callback records
`provider_called:false` and must not be described as authentication, network or
provider rejection.

Before recommending a host/model change, preference edit or reinstall, inspect
the real caller arguments, current source, installed bytes actually loaded,
route, native compatibility, phase/scope capability, receipt and destination.
Investigation after refusal is read-only. It does not authorize inline
execution, silent fallback, a fabricated milestone or an empty artifact.

## Historical scope

On 2026-09-28, at base `c026685`, the standalone-task preparation caller forced
native transport while publication accepted only milestone paths. This contract
corrects that defect with resolved transport and task-local publication. Treat
the incident as historical evidence: revalidate the current caller and the
installed bytes actually loaded instead of preserving it as a permanent host
limitation.

## Evidence boundary

Offline fixtures may prove routing identity, invocation arguments, validation,
receipts, publication, continuation and replay. They do not prove provider
authentication, real model access, a real installation in an operator profile,
or completion of the originating product ticket.

**Native questions:** Before asking questions, read
`shared/forge-interaction.md` from the source or Forge home and apply its host
adapter. Required unanswered decisions remain pending.
