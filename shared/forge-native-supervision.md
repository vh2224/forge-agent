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
