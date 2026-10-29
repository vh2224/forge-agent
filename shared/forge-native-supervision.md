# Native lifecycle supervision

`forge-native-invocation.invokeNative` supervises the actual callback through a
terminal result. Its caller supplies a **live** `terminalResult(value)` predicate
for the existing unit contract. Returning an agent identifier is acknowledgment,
not completion. Preparation, memory, execution and recovery adapters explicitly
provide their terminal contract; validation/publication and model readback still
run afterwards. Callers of the low-level primitive must supply this predicate.

External preparation/recovery handoffs expose `invoke(callback)`. Use that closure
to retain supervision and the original guards. Manually calling printed tool
arguments and then the legacy acceptance API does not acquire supervision. Legacy
acceptance and canonical saved-result replay retain their validation/authority
requirements; neither invents a native observation channel.

## Injected host seam

Internal consumers accept `nativeLifecycle` in their live runtime/dependencies
(memory uses its live request object). The low-level primitive names this option
`lifecycle`. The optional adapter has separately declared Boolean capabilities:
`result`, `remote_events`, `open_tools`, `cancel`, `resume`, `stop_proof`. Missing
capabilities are unknown, never a negative observation. These are injected Forge
interfaces, not APIs asserted to exist in Codex, Claude or another host.

- `acknowledge(value, {identity})` synchronously returns the stable opaque handle.
- `subscribe(handle, listener, {identity})` synchronously returns a cleanup
  function. It reports only trusted observations with the exact identity and an
  increasing integer sequence. `terminal` carries the unit result; `work` carries
  nonempty observed text; `tool` carries a Boolean `open`. Work text is inspected
  and discarded, not persisted. Administrative running/wait/lease reports,
  foreign identities and empty/stale events do not advance activity.
- `cancel(handle, {identity})` is optional and is never awaited at cutoff. Its
  return is not proof of stop. This implementation conservatively retains unknown
  stop status until terminal; existing live stopped-writer census and root
  reconciliation remain necessary for recovery/publication.
- `resume(state)` is a live host operation reattaching the original handle; it
  must return that acknowledgment or an observed terminal. The supervisor never
  calls the original launch callback when restoring a journal. The host must
  establish authority and identity independently. A journal is not authority.

The existing liveness policy handles declared remote observations, including
bounded open-tool extension. Without a remote channel, activity stays unknown;
the tier safety ceiling still applies. Neither unknown activity nor cutoff proves
provider unavailability. Cancellation and observation promises cannot delay that
ceiling. Timers/subscriptions are cleaned up at terminal/cutoff. Observation after
cleanup requires the host's reattachment/saved-result path, not a hidden watcher.

## Host identity observer

The launch callback receives `invoke(args, invocation, observer)`. `observer` is
a frozen Forge capability with one method, `hostIdentity(value)`; it is not a
tool argument, and the tool still receives exactly the same arguments. A host
adapter passes the opaque identifier its tool actually returned (for example
`/root/<name>`), never one derived from `task_name`. The first valid value wins
and is kept as `host_identity { value, source: host-tool-return, observed_ms,
dispatch_id, conflict }`, with `dispatch_id` from the trusted request. The same
value again is a no-op; a different value keeps the first and marks
`conflict: true`; values after terminal or cutoff are refused without changing
the journal. With a journal the record is saved in the same external evidence
location, outside protected owner/code snapshots; without one it stays in the
in-memory lifecycle. Restart accepts only a valid saved record bound to the same
dispatch and elapsed clock; older journals without it resume as before. The
durable `agent-identity` event is appended only after publication or the
recorded failure, through a proven owner channel (`forge-agent-identity.js`).
Callbacks that ignore the observer behave as before and report no identity.
Offline tests prove these transitions, not that a host adapter calls the observer.

## External evidence and restart

There is no implicit TEMP durability promise. The host can provide
`journal: {root, file, authorize}`: an existing physical external evidence root,
a direct child file, and a live synchronous authorization callback binding that
location to `identity`. The host must select a location outside protected
owner/code snapshots and apply its retention/access policy. The implementation
checks physical paths, symlinks, collisions, bounded JSON, identity and clock
continuity; writes reuse Forge's atomic JSON helper. Public evidence contains a
hash reference, not the host's path. No prompts, work text or credentials are
saved. Missing journal is explicitly `persistence: unavailable`; requesting
resume without it fails closed.

Original wall deadline, tier ceiling, policy, event cursor and handle hash survive
restart. Backward/inconsistent clocks and foreign state refuse; new waits,
heartbeats or handles do not create a fresh budget. Existing started receipts
continue to block a second writer. A host must use the existing recovery protocol
before reattaching through this seam; journal availability alone does not bypass
a consumer's receipt/claims/authority checks.

The deadline wins a simultaneous terminal race. A late terminal from the original
callback can call `captureLateResult` once through the consumer's existing capture
path, without publication. Native execution uses its immutable returned-response
capture; milestone recovery uses `session.returned`. Other hosts/consumers must
provide their canonical capture callback or receive `late_capture: unavailable`.
No second inference is authorized by this metadata. Saved responses still require
canonical validation, stopped-writer census and reconciliation before replay.

Offline adapter/clock tests establish these transitions, not the availability of
remote observation, cancellation, reattachment or stop proof in a real host.
