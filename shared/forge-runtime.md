# Forge runtime-neutral protocol

`scripts/forge-runtime.js` is the executable, canonical source for this
protocol. This document explains the stable meaning of its fields; it does not
duplicate the module's executable tables.

Protocol version: `1.0.0`.

## Purpose

Forge has two independent concerns that older configuration often called
“engine”:

- the CLI process hosting Forge;
- the engine that will execute a particular worker.

The protocol keeps those concerns apart. It also gives units, results,
lifecycle records and security metadata a provider-neutral shape. A consumer
may retain its legacy routing and model choices while gradually adding these
fields.

The contract is semantic only. It starts no process, chooses no model, grants
no filesystem access and does not implement a sandbox.

## Versioning

Every normalized object includes `protocol_version`. Version `1.0.0` is
accepted by the schema and emitted by the module. An incompatible field or
meaning change requires a protocol-version change.

The JSON schema at `schemas/forge-runtime.schema.json` is a machine-readable
projection of this protocol. The standalone test checks the version and closed
enums for drift against the executable source.

## Host runtime

`host_runtime` names the CLI that is currently hosting Forge:

- `claude`
- `codex`

It is not a model family, a routed model ID, a sidecar trigger, or a user
preference. In particular, `gpt-*` belongs to a model-family adapter concern;
it does not make `host_runtime` equal to `gpt`.

When `host_runtime` is omitted, it defaults to `claude`. This preserves the
Claude-first compatibility behavior of Forge 3.1.4. A supplied unknown value
fails with `invalid-host-runtime`; it never degrades to another provider.

## Worker engine and mode

`worker_engine` identifies the execution target independently of the host. Its
closed values are `native`, `claude`, `codex`, and `agy`.

`worker_mode` declares how that target is reached:

- `native` executes inside the current host runtime;
- `sidecar` denotes an explicitly requested separate worker combination.

Omitted worker fields normalize to `worker_engine: native` and
`worker_mode: native`. With the legacy host default this resolves to Claude.

`native` is resolved only from `host_runtime`. It never reads a model ID,
`engine`, `dispatch_engine`, `workers.*`, or a model-family fallback. Therefore
`{ host_runtime: "codex", worker_engine: "native" }` resolves to Codex even
when a current route happens to contain a Claude model.

### Concrete identity seam

`resolveWorkerIdentity()` is the canonical, pure identity seam. It normalizes
only `host_runtime` and `worker_engine`, then returns their concrete identity:

```js
const { resolveWorkerIdentity } = require('./scripts/forge-runtime.js');

resolveWorkerIdentity({
  host_runtime: 'codex',
  worker_engine: 'native',
});
// {
//   host_runtime: 'codex',
//   worker_engine: 'native',
//   resolved_engine: 'codex'
// }
```

The seam has no `worker_mode`, model, route, preference, or dispatch-engine
input. Extra fields on a JavaScript object have no bearing on its result. An
unknown host or worker engine still fails with `invalid-host-runtime` or
`invalid-worker-engine`, respectively.

`resolveWorker()` uses this seam before it normalizes and validates mode. This
keeps the `native` → `host_runtime` rule in one executable location while
leaving mode policy in the full worker validator.

### Direct core calls and dispatch adaptation

There are two distinct normalization levels:

1. A direct `resolveWorker()` call applies the canonical field defaults
   `worker_engine: native` and `worker_mode: native`.
2. The dispatch adapter `runtimeFields()` may first project the routed worker
   engine and derive a mode when the caller omitted `worker_mode`.

The second step belongs exclusively to the adapter. It uses the concrete
identity from `resolveWorkerIdentity()` to compare the worker with the host;
it does not move `dispatch_engine`, model IDs, routing, or `workers.*` into the
core module. The projected fields are then sent through `resolveWorker()`, so
the core remains responsible for all mode validation and stable reason codes.

In particular, a direct cross-host core call does not infer `sidecar`:

```js
resolveWorker({
  host_runtime: 'claude',
  worker_engine: 'codex',
});
// throws RuntimeContractError with code native-engine-host-mismatch
```

The omitted mode defaults to `native`, and that explicit normalized
combination is incompatible with a concrete Codex worker on a Claude host.
Only dispatch callers that pass through `runtimeFields()` receive adapter
projection. Library callers do not acquire routing behavior implicitly.

When the caller supplies `worker_mode`, the adapter treats it as authoritative
and never replaces it with a mode derived from a route. Thus this remains a
core validation error even at the dispatch boundary:

```json
{
  "host_runtime": "claude",
  "worker_engine": "codex",
  "worker_mode": "native"
}
```

It fails with `native-engine-host-mismatch`. A model, `dispatch_engine`, or
preference cannot turn that explicit incompatible mode into a sidecar.

The ownership split is therefore:

| Concern | Owner |
| --- | --- |
| Normalize host and worker engine | `resolveWorkerIdentity()` |
| Resolve `worker_engine: native` to the host | `resolveWorkerIdentity()` |
| Project a routed engine | dispatch `runtimeFields()` |
| Derive an omitted dispatch mode | dispatch `runtimeFields()` |
| Validate native/sidecar combinations | core `resolveWorker()` |
| Preserve reason codes | core `resolveWorker()` |

## Valid worker examples

Native execution on the Claude host:

```json
{ "host_runtime": "claude", "worker_engine": "native", "worker_mode": "native" }
```

Native execution on the Codex host:

```json
{ "host_runtime": "codex", "worker_engine": "native", "worker_mode": "native" }
```

An explicitly declared Codex sidecar from a Claude host:

```json
{
  "host_runtime": "claude",
  "worker_engine": "codex",
  "worker_mode": "sidecar",
  "sidecar_declared": true
}
```

The declaration is a protocol assertion by the caller. It is not permission to
launch a process. An adapter or later security layer can still refuse it.

## Invalid worker examples

This tries to select Codex while claiming native execution on Claude:

```json
{ "host_runtime": "claude", "worker_engine": "codex", "worker_mode": "native" }
```

It is rejected with `native-engine-host-mismatch` instead of silently becoming
a sidecar.

This makes a sidecar request without declaring it:

```json
{ "host_runtime": "claude", "worker_engine": "codex", "worker_mode": "sidecar" }
```

It is rejected with `sidecar-declaration-required`.

This is implicit recursion on the Codex host:

```json
{ "host_runtime": "codex", "worker_engine": "codex", "worker_mode": "sidecar" }
```

It is rejected with `implicit-recursion-refused`. The same combination is
representable only when an explicitly supplied `worker_mode: sidecar` is
accompanied by `sidecar` or `sidecar_declared` set to `true`.

This recursion example is about a mode typed explicitly by the caller.
`runtimeFields()` derives a mode only when `worker_mode` is absent; that
adapter derivation is not a behavior of `resolveWorker()` and cannot be
triggered by adding routing or model fields to a direct core call. The adapter
must project its derived combination back through the core validator rather
than bypassing recursion or compatibility checks.

`worker_engine: native` with `worker_mode: sidecar` is always rejected as
`native-sidecar-conflict`.

## Unit contract

A unit has `id`, `type`, and a provider-neutral state. The permitted states
cover scheduling and terminal outcomes without referring to a host:

`queued` → `leased` → `running` → `completed | failed | cancelled`.

The module does not persist this sequence and does not acquire a lease. Those
operations belong to lifecycle/stateful layers. Its job is to normalize the
record and reject an unknown state with `invalid-unit-state`.

## Result contract

A result has a `status`, stable `reason_code`, and `output`. Status is one of
`succeeded`, `failed`, or `cancelled`.

For example:

```json
{
  "status": "failed",
  "reason_code": "verification-failed",
  "output": { "exit_code": 1 }
}
```

Reason codes are plain, provider-neutral identifiers. A host adapter can add
diagnostic text outside this core contract without changing the outcome.

## Lifecycle contract

Lifecycle records describe handoff progression, not a particular CLI's event
names. The allowed lifecycle states are:

`created` → `dispatched` → `accepted` → `running` → `terminal`.

`reason_code` is available for transitions such as `lease-acquired`,
`dispatch-refused`, or `verification-failed`. This module validates the closed
state vocabulary but does not enforce a persisted transition graph.

## Security metadata

Security metadata is intentionally declarative:

```json
{
  "role": "reviewer",
  "required_capabilities": ["repo.read", "artifact.comment"]
}
```

Roles are `orchestrator`, `worker`, `reviewer`, and `observer`. The capability
array says what a unit requires. It does not mean those capabilities are
granted, available, checked, or enforced. There is no grant field in the
schema; sandboxing and permission enforcement are owned by the security layer.

## Compatibility boundaries

This protocol does not change existing `engine`, `dispatch_engine`,
`workers.*`, routing, or preference consumers. Existing dispatch code can keep
using its model-family semantics. Adapters may map legacy data into this
contract at a boundary, but must not reinterpret a model family as a host.

Unknown input is rejected deterministically. Missing host/worker input is the
only compatibility default and stays Claude-first.

## CLI and library use

The module is CommonJS and zero-dependency:

```js
const { validateRuntimeContract } = require('./scripts/forge-runtime.js');
const normalized = validateRuntimeContract({ host_runtime: 'codex' });
```

For simple inspection, pass one JSON object as the CLI argument:

```text
node scripts/forge-runtime.js '{"host_runtime":"codex","worker_engine":"native"}'
```

On invalid input the CLI writes the stable reason code to stderr and exits
nonzero. Callers that need richer policy should use the exported pure
normalizers and make enforcement decisions outside this module.
