#!/usr/bin/env node
'use strict';

// Provider-neutral long-workflow loop. Selection, leases, boundaries and
// durable resume remain owned by forge-orchestrate; this module never spawns.
const orchestrateDefault = require('./forge-orchestrate.js');
const runtime = require('./forge-runtime.js');

const PROTOCOL_VERSION = runtime.PROTOCOL_VERSION;
const MODES = Object.freeze(['auto', 'task']);
const COMMANDS = Object.freeze(['next', 'pause', 'resume', 'status', 'complete']);
const TERMINAL = new Set(['completed', 'blocked', 'failed']);

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
    boundary: state.boundary || null,
    snapshot: state,
    controller_result: delegate || null,
  };
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
  if (state.lifecycle === 'dispatch_required' && state.last_decision) return { ...state.last_decision, snapshot: state };
  if (state.lifecycle === 'paused') return publicResult('next', state, 'needs_input', 'pause-active', 'pause', null);
  if (TERMINAL.has(state.lifecycle)) return publicResult('next', state, state.lifecycle, 'workflow-terminal', 'stop', null);
  const refusedNext = taskScopeRefusal(state, input, 'next');
  if (refusedNext) return refusedNext;
  if (state.step_count >= state.max_steps) {
    state.lifecycle = 'blocked';
    return publicResult('next', state, 'blocked', 'step-budget-exhausted', 'stop', null);
  }
  const delegated = orchestrate.run('next', delegateInput(input, state));
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
  return publicResult('next', state, state.lifecycle, delegated.reason_code || 'controller-refused', 'stop', delegated);
}
function pause(state, input, orchestrate) {
  if (state.lifecycle === 'paused') return publicResult('pause', state, 'needs_input', 'already-paused', 'pause', null);
  if (TERMINAL.has(state.lifecycle)) return publicResult('pause', state, state.lifecycle, 'workflow-terminal', 'stop', null);
  const refusedPause = taskScopeRefusal(state, input, 'pause');
  if (refusedPause) return refusedPause;
  const delegated = orchestrate.run('next', { ...delegateInput(input, state), needs_input: true });
  if (delegated.outcome !== 'needs_input' || !delegated.boundary) {
    state.lifecycle = delegated.outcome === 'failed' ? 'failed' : 'blocked';
    return publicResult('pause', state, state.lifecycle, delegated.reason_code || 'pause-refused', 'stop', delegated);
  }
  state.lifecycle = 'paused'; state.current_unit = safeUnit(delegated.unit); state.boundary = delegated.boundary;
  return publicResult('pause', state, 'needs_input', delegated.reason_code || 'needs-input', 'pause', delegated);
}
function resume(state, input, orchestrate) {
  if (state.lifecycle !== 'paused' || !state.boundary) return publicResult('resume', state, 'blocked', 'boundary-missing', 'stop', null);
  if (!own(input, 'response')) return publicResult('resume', state, 'blocked', 'response-required', 'pause', null);
  const targetHost = host(input.host_runtime || input.hostRuntime || state.host_runtime);
  const delegated = orchestrate.run('next', { ...delegateInput(input, { ...state, host_runtime: targetHost }), boundary: state.boundary, response: input.response });
  if (delegated.outcome !== 'completed') {
    state.lifecycle = delegated.outcome === 'failed' ? 'failed' : 'blocked';
    return publicResult('resume', state, state.lifecycle, delegated.reason_code || 'resume-refused', 'stop', delegated);
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
function advance(snapshot, commandValue, input = {}, dependencies = {}) {
  const state = validateSnapshot(snapshot);
  const command = String(commandValue || '').toLowerCase();
  if (!COMMANDS.includes(command)) throw error('invalid-command', `command inválido: ${commandValue}`);
  const requestedHost = input.host_runtime || input.hostRuntime;
  if (requestedHost && command !== 'resume' && host(requestedHost) !== state.host_runtime) throw error('host-runtime-mismatch', 'host só muda em resume com boundary durável');
  const orchestrate = dependencies.orchestrate || orchestrateDefault;
  if (!orchestrate || typeof orchestrate.run !== 'function') throw error('invalid-controller', 'forge-orchestrate indisponível');
  if (command === 'next') return next(state, input, orchestrate);
  if (command === 'pause') return pause(state, input, orchestrate);
  if (command === 'resume') return resume(state, input, orchestrate);
  if (command === 'complete') return complete(state, input, orchestrate);
  return status(state, input, orchestrate);
}

module.exports = { PROTOCOL_VERSION, MODES, COMMANDS, create, validateSnapshot, advance };
