#!/usr/bin/env node
'use strict';

// Provider-neutral long-workflow loop. Selection, leases, boundaries and
// durable resume remain owned by forge-orchestrate; this module never spawns.
const orchestrateDefault = require('./forge-orchestrate.js');
const runtime = require('./forge-runtime.js');

const PROTOCOL_VERSION = runtime.PROTOCOL_VERSION;
const MODES = Object.freeze(['auto', 'task']);
const COMMANDS = Object.freeze(['next', 'pause', 'resume', 'status', 'complete', 'consume-failure', 'reenter', 'resume-budget', 'resume-time-option',
  'batch-status', 'batch-ack']);
const TERMINAL = new Set(['completed', 'blocked', 'failed']);
// Issue 343 U1: while a dispatched batch is active, every command that acts on one unit is
// refused by name (no delegation); only next (replay), status and the batch commands run.
const SINGLE_UNIT_COMMANDS = new Set(['pause', 'resume', 'complete', 'consume-failure', 'reenter', 'resume-budget', 'resume-time-option']);
const BATCH_ID = /^batch-[a-f0-9]{32}$/;
// S02 owner blocks that the named resume-time-option command may continue: the
// pending/invalid selection, roadmap conformance, the scoped task DAG and a review
// mode incompatible with the active contract. Budget blocks keep their own
// resume-budget continuation.
const TIME_OPTION_BLOCKS = new Set([
  'time-option-pending', 'time-options-invalid',
  'time-roadmap-nonconformant', 'time-allocation-pending', 'time-scope-unallocated',
  'time-unit-not-admitted', 'time-task-dependency-pending', 'time-task-dependency-unknown',
  'time-task-dependency-cycle', 'time-task-identity-ambiguous', 'time-roadmap-selection-missing',
  'time-review-disabled-incompatible', 'time-review-mode-unknown',
]);
const HASH = /^[a-f0-9]{64}$/;

function error(code, message) { const value = new Error(message); value.code = code; return value; }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value || {}, key); }
function cleanText(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\u0000')) throw error('invalid-request', `${label} inválido`);
  return value.trim();
}
function mode(value) { const selected = String(value || '').toLowerCase(); if (!MODES.includes(selected)) throw error('invalid-mode', `mode inválido: ${value}`); return selected; }
function host(value) { return runtime.normalizeHostRuntime(value); }
function positive(value, fallback) { const number = Number(value == null ? fallback : value); if (!Number.isInteger(number) || number < 1) throw error('invalid-request', 'max_steps inválido'); return number; }
function safeUnit(value) {
  if (!value) return null;
  return { type: value.type || '', id: value.id || '', key: value.key || `${value.type || ''}/${value.id || ''}` };
}
function create(input = {}) {
  const selectedMode = mode(input.mode);
  return {
    protocol_version: PROTOCOL_VERSION,
    workflow_id: cleanText(input.workflow_id || input.workflowId, 'workflow_id'),
    mode: selectedMode,
    host_runtime: host(input.host_runtime || input.hostRuntime || 'claude'),
    lifecycle: 'idle',
    step_count: 0,
    max_steps: positive(input.max_steps || input.maxSteps, selectedMode === 'task' ? 1 : 1000),
    current_unit: null,
    boundary: null,
    last_decision: null,
  };
}
function validateSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('invalid-snapshot', 'snapshot ausente');
  if (value.protocol_version !== PROTOCOL_VERSION) throw error('invalid-snapshot', 'protocol_version incompatível');
  mode(value.mode); host(value.host_runtime); cleanText(value.workflow_id, 'workflow_id');
  if (!Number.isInteger(value.step_count) || value.step_count < 0 || !Number.isInteger(value.max_steps) || value.max_steps < 1) throw error('invalid-snapshot', 'contadores inválidos');
  // Issue 343 U1: an older snapshot has no current_batch. A present one is only a locator of
  // a published manifest (the owner records decide), kept apart from current_unit.
  if (own(value, 'current_batch') && value.current_batch !== null) {
    const batch = value.current_batch;
    if (!batch || typeof batch !== 'object' || Array.isArray(batch) || !BATCH_ID.test(String(batch.batch_id)) || !HASH.test(String(batch.manifest_sha256))
        || !Array.isArray(batch.members) || !batch.members.length || batch.members.some(item => typeof item !== 'string' || !item.trim())) {
      throw error('invalid-snapshot', 'current_batch inválido');
    }
    if (value.current_unit) throw error('invalid-snapshot', 'current_batch e current_unit são exclusivos');
  }
  return JSON.parse(JSON.stringify(value));
}
function publicResult(command, state, outcome, reason, action, delegate) {
  return {
    protocol_version: PROTOCOL_VERSION,
    workflow_id: state.workflow_id,
    mode: state.mode,
    host_runtime: state.host_runtime,
    operation: command,
    outcome,
    reason_code: reason,
    lifecycle: state.lifecycle,
    action,
    unit: safeUnit(state.current_unit),
    ...(state.current_batch ? { batch: state.current_batch } : {}),
    boundary: state.boundary || null,
    snapshot: state,
    controller_result: delegate || null,
  };
}
// The loop's own budget and mode, passed to orchestrate as a trusted in-process option.
function workflowOf(state) {
  return { mode: state.mode, workflow_id: state.workflow_id, remaining_steps: Math.max(0, state.max_steps - state.step_count) };
}
function delegateInput(input, state) {
  const payload = { ...(input || {}), host_runtime: state.host_runtime };
  delete payload.mode; delete payload.workflow_id; delete payload.workflowId;
  delete payload.max_steps; delete payload.maxSteps; delete payload.snapshot;
  return payload;
}
// forge-orchestrate selects units *inside* a milestone: every branch of
// selectNextUnit reads that milestone's roadmap/slices, and forge-state only
// knows `.gsd/milestones/<id>/<id>-STATE.md`. A standalone task lives in
// `.gsd/tasks/<id>/` with no STATE and no roadmap, so this layer has nothing to
// select for it. Borrowing a real milestone id is worse than useless: measured,
// it dispatches THAT milestone's next unit and commits a lease + transaction
// against it. Name the refusal instead of letting the delegate throw a generic
// `invalid-request` — an unreachable path has to be readable by machine, not
// only by prose. `auto` is deliberately NOT guarded: there a milestone always
// exists, so its absence is a caller bug and must stay loud.
// What is refused is the request shape, not the workflow — no lease was taken
// and no step consumed, so the snapshot does not transition and a repeat
// returns the same answer (the idempotency invariant in shared/forge-lifecycle.md).
function taskScopeRefusal(state, input, command) {
  if (state.mode !== 'task' || (input && input.milestone)) return null;
  return publicResult(command, state, 'blocked', 'task-scope-unsupported', 'stop', null);
}
function next(state, input, orchestrate) {
  if (state.lifecycle === 'dispatch_required' && state.last_decision) {
    if (orchestrate.validatePending) {
      let checked;
      try { checked = orchestrate.validatePending(delegateInput(input, state), state.last_decision.controller_result); }
      catch (cause) { checked = { ok: false, reason: cause.code || 'pending-validation-failed', pending_questions: cause.pending_questions }; }
      if (checked.pending_questions) state.pending_questions = checked.pending_questions;
      if (!checked.ok) return publicResult('next', state, 'blocked', checked.reason, 'stop', null);
    }
    return { ...state.last_decision, snapshot: state };
  }
  if (state.lifecycle === 'paused') return publicResult('next', state, 'needs_input', 'pause-active', 'pause', null);
  if (TERMINAL.has(state.lifecycle)) return publicResult('next', state, state.lifecycle, 'workflow-terminal', 'stop', null);
  const refusedNext = taskScopeRefusal(state, input, 'next');
  if (refusedNext) return refusedNext;
  if (state.step_count >= state.max_steps) {
    state.lifecycle = 'blocked';
    return publicResult('next', state, 'blocked', 'step-budget-exhausted', 'stop', null);
  }
  const delegated = orchestrate.run('next', delegateInput(input, state), { workflow: workflowOf(state) });
  // Issue 343 U1: a dispatched batch charges max_steps once per admitted member and is held as
  // current_batch; current_unit stays empty. Replay returns last_decision above, uncharged.
  const batch = delegated.outcome === 'completed' && delegated.details && delegated.details.dispatch_batch;
  if (batch) {
    const members = Array.isArray(batch.members) ? batch.members : [];
    const keys = members.map(member => member && member.unit && member.unit.key);
    if (!members.length || !BATCH_ID.test(String(batch.batch_id)) || !HASH.test(String(batch.manifest_sha256))
        || keys.some(key => typeof key !== 'string' || !key)) {
      state.lifecycle = 'failed';
      return publicResult('next', state, 'failed', 'batch-dispatch-invalid', 'stop', delegated);
    }
    if (members.length > state.max_steps - state.step_count) {
      state.lifecycle = 'blocked';
      return publicResult('next', state, 'blocked', 'step-budget-exhausted', 'stop', delegated);
    }
    state.lifecycle = 'dispatch_required'; state.current_unit = null; state.step_count += members.length;
    state.current_batch = { batch_id: batch.batch_id, manifest_sha256: batch.manifest_sha256, members: keys };
    const result = publicResult('next', state, 'dispatch_required', 'batch-ready', 'dispatch-batch', delegated);
    const { snapshot: _snapshot, ...decision } = result;
    state.last_decision = decision;
    result.snapshot = state; return result;
  }
  if (delegated.outcome === 'completed' && delegated.unit) {
    state.lifecycle = 'dispatch_required'; state.current_unit = safeUnit(delegated.unit); state.step_count += 1;
    const result = publicResult('next', state, 'dispatch_required', 'unit-ready', 'dispatch', delegated);
    const { snapshot: _snapshot, ...decision } = result;
    state.last_decision = decision;
    result.snapshot = state; return result;
  }
  if (delegated.outcome === 'needs_input') {
    state.lifecycle = 'paused'; state.current_unit = safeUnit(delegated.unit); state.boundary = delegated.boundary || null;
    return publicResult('next', state, 'needs_input', delegated.reason_code || 'needs-input', 'pause', delegated);
  }
  if (delegated.outcome === 'no_work') {
    state.lifecycle = 'completed';
    return publicResult('next', state, 'completed', delegated.reason_code || 'no-next-unit', 'stop', delegated);
  }
  state.lifecycle = delegated.outcome === 'failed' ? 'failed' : 'blocked';
  if (['milestone-budget-exhausted', 'milestone-budget-draining'].includes(delegated.reason_code)) {
    const details = delegated.details?.time;
    state.time_block = { milestone: delegated.milestone, contract_version: details?.contract_version,
      contract_sha256: details?.contract_sha256 || null };
  }
  if (state.lifecycle === 'blocked' && TIME_OPTION_BLOCKS.has(delegated.reason_code) && delegated.milestone) {
    const options = delegated.details?.time_options?.options_sha256;
    state.time_option_block = { milestone: delegated.milestone, options_sha256: HASH.test(options || '') ? options : null };
  }
  return publicResult('next', state, state.lifecycle, delegated.reason_code || 'controller-refused', 'stop', delegated);
}
// The same persisted snapshot continues after the operator's attested choice.
// The block is a locator; the owner's resumeCheck decides and nothing is edited
// or checkpointed here. Ready clears the block and delegates next once.
function resumeTimeOption(state, input, orchestrate) {
  if (state.lifecycle !== 'blocked' || !state.time_option_block) return publicResult('resume-time-option', state, 'blocked', 'time-option-resume-invalid', 'stop', null);
  const delegated = orchestrate.run('resume-time-option', { ...delegateInput(input, state), time_option_block: state.time_option_block });
  if (delegated.outcome !== 'completed') return publicResult('resume-time-option', state, 'blocked', delegated.reason_code || 'time-option-resume-invalid', 'stop', delegated);
  state.lifecycle = 'idle'; delete state.time_option_block;
  return next(state, input, orchestrate);
}
// The same persisted snapshot continues after an extension. A failure consumed
// by this workflow is not skipped through next: the owner names the required
// linked entry, and only an explicit entry delegates the existing reenter seam.
function resumeBudget(state, input, orchestrate) {
  if (state.lifecycle !== 'blocked' || !state.time_block) return publicResult('resume-budget', state, 'blocked', 'budget-resume-invalid', 'stop', null);
  if (state.pending_questions?.some(row => row.status === 'pending')) return publicResult('resume-budget', state, 'blocked', 'pending-questions', 'stop', null);
  const consumed = state.consumed_failure;
  if (input.entry && state.step_count >= state.max_steps) return publicResult('resume-budget', state, 'blocked', 'step-budget-exhausted', 'stop', null);
  const delegated = orchestrate.run('resume-budget', { ...delegateInput(input, state), time_block: state.time_block,
    ...(consumed ? { consumed_failure: { unit: consumed.unit, failure_key: consumed.failure_key, failure_checksum: consumed.failure_checksum } } : {}) });
  if (delegated.details?.pending_questions) state.pending_questions = delegated.details.pending_questions;
  if (delegated.outcome !== 'completed') return publicResult('resume-budget', state, 'blocked', delegated.reason_code, 'stop', delegated);
  if (delegated.reason_code === 'entry-ready') {
    delete state.time_block;
    state.current_unit = safeUnit(delegated.unit); state.lifecycle = 'dispatch_required'; state.step_count += 1;
    state.last_entry_id = input.entry.entry_id;
    const result = publicResult('resume-budget', state, 'dispatch_required', 'entry-ready', 'dispatch', delegated);
    const { snapshot: _snapshot, ...decision } = result; state.last_decision = decision;
    return result;
  }
  state.lifecycle = 'idle'; delete state.time_block;
  return next(state, input, orchestrate);
}
function pause(state, input, orchestrate) {
  if (state.lifecycle === 'paused') return publicResult('pause', state, 'needs_input', 'already-paused', 'pause', null);
  if (TERMINAL.has(state.lifecycle)) return publicResult('pause', state, state.lifecycle, 'workflow-terminal', 'stop', null);
  const refusedPause = taskScopeRefusal(state, input, 'pause');
  if (refusedPause) return refusedPause;
  const current = state.lifecycle === 'dispatch_required' ? state.last_decision?.controller_result?.details?.transaction : null;
  if (state.lifecycle === 'dispatch_required' && !current) return publicResult('pause', state, 'blocked', 'unit-identity-mismatch', 'stop', null);
  const delegated = orchestrate.run('next', { ...delegateInput(input, state), ...(current
    ? { pause_current: { unit: state.current_unit, transaction: current } }
    : { needs_input: true }) });
  if (delegated.outcome !== 'needs_input' || !delegated.boundary) {
    return publicResult('pause', state, delegated.outcome === 'failed' ? 'failed' : 'blocked', delegated.reason_code || 'pause-refused', 'stop', delegated);
  }
  state.lifecycle = 'paused'; state.current_unit = safeUnit(delegated.unit); state.boundary = delegated.boundary;
  return publicResult('pause', state, 'needs_input', delegated.reason_code || 'needs-input', 'pause', delegated);
}
function resume(state, input, orchestrate) {
  if (state.lifecycle !== 'paused' || !state.boundary) return publicResult('resume', state, 'blocked', 'boundary-missing', 'stop', null);
  if (!own(input, 'response') && input.resume_intent === undefined) return publicResult('resume', state, 'blocked', state.current_unit?.type === 'execute-task' ? 'execution-resume-intent-required' : 'response-required', 'pause', null);
  const targetHost = host(input.host_runtime || input.hostRuntime || state.host_runtime);
  const delegated = orchestrate.run('next', { ...delegateInput(input, { ...state, host_runtime: targetHost }), boundary: state.boundary, ...(own(input, 'response') ? { response: input.response } : {}) });
  if (delegated.outcome !== 'completed') {
    return publicResult('resume', state, delegated.outcome === 'failed' ? 'failed' : 'blocked', delegated.reason_code || 'resume-refused', 'pause', delegated);
  }
  if (delegated.details?.resume_execution === true) {
    state.host_runtime = targetHost; state.boundary = null; state.current_unit = safeUnit(delegated.unit); state.lifecycle = 'dispatch_required';
    const result = publicResult('resume', state, 'dispatch_required', delegated.reason_code, 'dispatch', delegated);
    const { snapshot: _snapshot, ...decision } = result; state.last_decision = decision; result.snapshot = state; return result;
  }
  state.host_runtime = targetHost; state.boundary = delegated.boundary || null; state.current_unit = null; state.last_decision = null;
  state.lifecycle = state.mode === 'task' ? 'completed' : 'idle';
  return publicResult('resume', state, state.lifecycle === 'completed' ? 'completed' : 'resumed', delegated.reason_code || 'handoff-ready', state.lifecycle === 'idle' ? 'continue' : 'stop', delegated);
}
function status(state, input, orchestrate) {
  const delegated = orchestrate.run('status', delegateInput(input, state));
  return publicResult('status', state, 'status', delegated.reason_code || 'status-ready', 'observe', delegated);
}
function complete(state, input, orchestrate) {
  if (state.lifecycle !== 'dispatch_required') return publicResult('complete', state, 'blocked', 'dispatch-not-pending', 'stop', null);
  const decision = state.last_decision && state.last_decision.controller_result;
  const beginKey = decision && decision.details && decision.details.transaction && decision.details.transaction.idempotency_key;
  const delegated = orchestrate.run('complete', { ...delegateInput(input, state), unit: state.current_unit, begin_key: beginKey });
  if (delegated.outcome !== 'completed') return publicResult('complete', state, 'blocked', delegated.reason_code, 'stop', delegated);
  state.current_unit = null; state.last_decision = null; state.boundary = delegated.boundary;
  state.lifecycle = state.mode === 'task' ? 'completed' : 'idle';
  return publicResult('complete', state, 'completed', delegated.reason_code, state.lifecycle === 'idle' ? 'continue' : 'stop', delegated);
}
function consumeFailure(state, input, orchestrate) {
  const decision = state.last_decision?.controller_result;
  const transaction = decision?.details?.transaction;
  const prior = state.consumed_failure;
  if (!transaction && !prior) return publicResult('consume-failure', state, 'blocked', 'dispatch-not-pending', 'stop', null);
  const binding = transaction || prior.begin;
  const delegated = orchestrate.run('consume-failure', { ...delegateInput(input, state),
    unit: state.current_unit || prior.unit, begin_key: binding.idempotency_key, begin_checksum: binding.begin_checksum,
    generation: binding.generation });
  if (delegated.reason_code !== 'failure-consumed') return publicResult('consume-failure', state, 'blocked', delegated.reason_code, 'stop', delegated);
  state.consumed_failure = { begin: binding, unit: state.current_unit || prior.unit,
    failure_key: delegated.details.failure_key, failure_checksum: delegated.details.failure_checksum };
  state.pending_questions = delegated.details.pending_questions || [];
  state.current_unit = null; state.last_decision = null; state.boundary = delegated.boundary;
  state.lifecycle = state.pending_questions.some(item => item.status === 'pending') ? 'blocked' : state.mode === 'task' ? 'failed' : 'idle';
  return publicResult('consume-failure', state, 'failed', 'failure-consumed', state.lifecycle === 'idle' ? 'continue' : 'stop', delegated);
}
function reenter(state, input, orchestrate) {
  const replay = state.last_entry_id === input.entry?.entry_id && state.last_decision;
  if (!replay && state.step_count >= state.max_steps) return publicResult('reenter', state, 'blocked', 'step-budget-exhausted', 'stop', null);
  const delegated = orchestrate.run('reenter', delegateInput(input, state));
  if (delegated.details?.pending_questions) state.pending_questions = delegated.details.pending_questions;
  if (delegated.outcome !== 'completed') return publicResult('reenter', state, 'blocked', delegated.reason_code, 'stop', delegated);
  state.current_unit = safeUnit(delegated.unit); state.lifecycle = 'dispatch_required'; if (!replay) state.step_count += 1;
  state.last_entry_id = input.entry.entry_id;
  const result = publicResult('reenter', state, 'dispatch_required', 'entry-ready', 'dispatch', delegated);
  const { snapshot: _snapshot, ...decision } = result; state.last_decision = decision;
  return result;
}
// Issue 343 U1: the additive batch commands. The snapshot's current_batch is the only locator
// delegated (never caller JSON); a response, a done result or an approved flag in the input
// never completes, acknowledges or clears a member — only the owner's member records do.
function batchLocator(state) { return { batch_id: state.current_batch.batch_id, manifest_sha256: state.current_batch.manifest_sha256 }; }
function batchStatus(state, input, orchestrate) {
  if (!state.current_batch) return publicResult('batch-status', state, 'blocked', 'batch-not-active', 'stop', null);
  const delegated = orchestrate.run('batch-status', { ...delegateInput(input, state), batch: batchLocator(state) });
  if (delegated.outcome !== 'completed') return publicResult('batch-status', state, 'blocked', delegated.reason_code || 'batch-manifest-invalid', 'stop', delegated);
  return publicResult('batch-status', state, 'status', delegated.reason_code, 'observe', delegated);
}
// Issue 343 U5: the members the owner acknowledged (its ack progress AND the controller's committed
// completion of that member's own begin, checked by forge-orchestrate) leave current_batch one by one;
// any other member stays, and the batch itself clears only once every member is terminal.
function acknowledgedOf(delegated) {
  const listed = delegated && delegated.details && Array.isArray(delegated.details.acknowledged) ? delegated.details.acknowledged : [];
  return new Set(listed.filter(key => typeof key === 'string' && key));
}
function batchAck(state, input, orchestrate) {
  if (!state.current_batch) return publicResult('batch-ack', state, 'blocked', 'batch-not-active', 'stop', null);
  const delegated = orchestrate.run('batch-ack', { ...delegateInput(input, state), batch: batchLocator(state) });
  if (delegated.outcome !== 'completed') {
    const acknowledged = acknowledgedOf(delegated);
    const remaining = state.current_batch.members.filter(key => !acknowledged.has(key));
    if (remaining.length && remaining.length < state.current_batch.members.length) state.current_batch = { ...state.current_batch, members: remaining };
    return publicResult('batch-ack', state, 'blocked', delegated.reason_code || 'batch-members-pending', 'stop', delegated);
  }
  delete state.current_batch; state.current_unit = null; state.last_decision = null; state.boundary = null;
  state.lifecycle = state.mode === 'task' ? 'completed' : 'idle';
  return publicResult('batch-ack', state, 'completed', delegated.reason_code, state.lifecycle === 'idle' ? 'continue' : 'stop', delegated);
}
function advance(snapshot, commandValue, input = {}, dependencies = {}) {
  const state = validateSnapshot(snapshot);
  const command = String(commandValue || '').toLowerCase();
  if (!COMMANDS.includes(command)) throw error('invalid-command', `command inválido: ${commandValue}`);
  const requestedHost = input.host_runtime || input.hostRuntime;
  if (requestedHost && command !== 'resume' && host(requestedHost) !== state.host_runtime) throw error('host-runtime-mismatch', 'host só muda em resume com boundary durável');
  const controller = dependencies.orchestrate || orchestrateDefault;
  if (!controller || typeof controller.run !== 'function') throw error('invalid-controller', 'forge-orchestrate indisponível');
  const trusted = {};
  for (const name of ['prefsReader', 'inventoryReader', 'now', 'failpoint', 'inspectAttempt', 'processProbe', 'replaySavedResponse', 'reconcileRoots', 'captureEntryBaseline', 'entryAuthority', 'questionStateAdapter', 'reconcileRetainedClaim', 'userHome', 'env', 'workerObservationReader', 'routeResolver']) {
    if (dependencies[name] !== undefined) trusted[name] = dependencies[name];
  }
  // A call-scoped extra (the loop's own workflow mode/budget) joins the trusted options only.
  const orchestrate = { run: (operation, payload, extra) => controller.run(operation, payload, extra ? { ...trusted, ...extra } : trusted),
    ...(typeof controller.validatePending === 'function' ? { validatePending: (payload, decision) => controller.validatePending(payload, decision, trusted) } : {}) };
  if (state.current_batch && SINGLE_UNIT_COMMANDS.has(command)) return publicResult(command, state, 'blocked', 'batch-active', 'stop', null);
  if (command === 'batch-status') return batchStatus(state, input, orchestrate);
  if (command === 'batch-ack') return batchAck(state, input, orchestrate);
  if (command === 'consume-failure') return consumeFailure(state, input, orchestrate);
  if (command === 'reenter') return reenter(state, input, orchestrate);
  if (command === 'resume-budget') return resumeBudget(state, input, orchestrate);
  if (command === 'resume-time-option') return resumeTimeOption(state, input, orchestrate);
  if (command === 'next') return next(state, input, orchestrate);
  if (command === 'pause') return pause(state, input, orchestrate);
  if (command === 'resume') return resume(state, input, orchestrate);
  if (command === 'complete') return complete(state, input, orchestrate);
  return status(state, input, orchestrate);
}

module.exports = { PROTOCOL_VERSION, MODES, COMMANDS, create, validateSnapshot, advance };
