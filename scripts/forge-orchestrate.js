#!/usr/bin/env node
'use strict';

// Provider-neutral authority for the small shared workflow boundary. Provider
// adapters only present this JSON result; they do not decide state transitions.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const forgeState = require('./forge-state.js');
const forgeStatus = require('./forge-status.js');
const forgeController = require('./forge-unit-controller.js');
const forgeRuntime = require('./forge-runtime.js');

const PROTOCOL_VERSION = '1.0.0';
const OPERATIONS = Object.freeze(['init', 'status', 'next', 'complete']);
const OUTCOMES = Object.freeze(['needs_input', 'completed', 'blocked', 'no_work', 'failed']);
const REASON_CODES = Object.freeze([
  'initialized', 'already-initialized', 'status-ready', 'selected', 'unit-selected',
  'no-next-unit', 'needs-input', 'needs-input-boundary', 'not-initialized',
  'prefs-invalid', 'lease-active', 'transaction-pending', 'invalid-request', 'failed',
  'handoff-ready', 'boundary-missing', 'boundary-not-transferable', 'response-invalid',
]);

function own(value, key) { return Object.prototype.hasOwnProperty.call(value || {}, key); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('invalid-request', `${label} deve ser objeto`);
  return value;
}
function error(code, message) { const value = new Error(message); value.code = code; return value; }
function normalizeHost(value) { return forgeRuntime.normalizeHostRuntime(value || 'claude'); }
function normalizeInput(value) {
  const input = object(value || {}, 'input');
  const output = {
    cwd: path.resolve(input.cwd || process.cwd()),
    milestone: input.milestone || null,
    host_runtime: normalizeHost(input.host_runtime || input.hostRuntime),
    owner_token: input.owner_token || input.ownerToken || 'forge-orchestrate',
    session: typeof input.session === 'string' ? input.session : null,
    idempotency_key: input.idempotency_key || input.idempotencyKey || null,
    project: typeof input.project === 'string' ? input.project : null,
    description: typeof input.description === 'string' ? input.description : null,
    needs_input: input.needs_input === true,
    response: own(input, 'response') ? input.response : undefined,
    boundary: input.boundary || null,
    inventory: input.inventory || null,
    prefsReader: typeof input.prefsReader === 'function' ? input.prefsReader : undefined,
  };
  if (output.milestone !== null && (typeof output.milestone !== 'string' || !output.milestone.trim())) throw error('invalid-request', 'milestone inválido');
  return output;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function checksum(value) { return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
function unit(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const separator = value.indexOf('/');
    return { type: separator < 0 ? value : value.slice(0, separator), id: separator < 0 ? '' : value.slice(separator + 1), key: value };
  }
  return { type: value.type, id: value.id, key: value.key || `${value.type}/${value.id}` };
}
function base(operation, outcome, reason, input) {
  return { protocol_version: PROTOCOL_VERSION, operation, outcome, reason_code: reason, milestone: input.milestone, unit: null, state: null, events: [], boundary: null };
}

// A delivery receipt does not release a lease by itself. Commit through the
// same controller transaction that began the selected unit, then acknowledge it
// to the loop. Replaying a stale loop snapshot uses the same completion key.
function complete(inputValue) {
  const input = normalizeInput(inputValue);
  const selected = unit(inputValue.unit);
  const key = inputValue.begin_key;
  if (!selected || !key || !inputValue.result || inputValue.result.status !== 'done') {
    return base('complete', 'blocked', 'unit-result-required', input);
  }
  const begun = forgeController.readJson(forgeController.transactionFile(input.cwd, key));
  if (!begun || begun.unit.key !== selected.key || begun.milestone !== input.milestone
    || begun.host_runtime !== input.host_runtime || begun.action !== 'begin') {
    return base('complete', 'blocked', 'unit-identity-mismatch', input);
  }
  try {
    const committed = forgeController.complete(input.cwd, {
      milestone: input.milestone, unit: selected, host_runtime: input.host_runtime,
      owner_token: input.owner_token, generation: begun.lease_generation,
      idempotency_key: `${key}:complete`,
      result: { status: 'succeeded', output: inputValue.result },
    }, { prefsReader: input.prefsReader });
    const output = base('complete', 'completed', committed.reason, input);
    output.unit = selected; output.boundary = committed.transaction.boundary;
    return output;
  } catch (cause) {
    return base('complete', 'blocked', cause.code || 'completion-failed', input);
  }
}
function publicState(value) {
  if (!value) return null;
  return {
    milestone: value.milestone,
    phase: value.phase || 'idle',
    active_slice: value.active_slice || '—',
    active_task: value.active_task || '—',
    auto_mode: value.auto_mode || 'off',
    next_action: value.next_action || '',
  };
}
function normalizedResponse(value) {
  if (typeof value === 'string') {
    const text = value.replace(/[\u0000\r\n]/g, ' ').trim().slice(0, 1000);
    if (!text) throw error('response-invalid', 'resposta vazia');
    return { value: text };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Object.keys(value).some((key) => /transcript|conversation|session|credential|token|password/i.test(key))) throw error('response-invalid', 'resposta contém metadado proibido');
    const choice = typeof value.choice === 'string' ? value.choice.trim().slice(0, 200) : null;
    if (choice) return { choice };
    if (typeof value.value === 'string' || typeof value.value === 'number' || typeof value.value === 'boolean') return { value: value.value };
  }
  throw error('response-invalid', 'resposta deve conter choice ou value');
}
function durableBoundary(input, boundary) {
  const durable = forgeController.readJson(forgeController.boundaryFile(input.cwd, boundary.unit));
  if (!durable) throw error('boundary-missing', `boundary ausente para ${boundary.unit}`);
  const resumedKey = `forge-orchestrate-resume:${boundary.idempotency_key}:complete`;
  if (![boundary.idempotency_key, resumedKey].includes(durable.idempotency_key) ||
      (boundary.milestone && durable.milestone !== boundary.milestone)) {
    throw error('boundary-not-transferable', 'boundary informado não corresponde ao registro durável');
  }
  return durable;
}
function init(inputValue) {
  const input = normalizeInput(inputValue);
  if (!input.milestone) throw error('invalid-request', 'milestone é obrigatório para init');
  const milestoneDir = path.join(input.cwd, '.gsd', 'milestones', input.milestone);
  const stateFile = forgeState.statePath(input.cwd, input.milestone);
  const existing = forgeState.read(input.cwd, input.milestone);
  if (!existing) {
    fs.mkdirSync(milestoneDir, { recursive: true });
    forgeState.write(input.cwd, {
      milestone: input.milestone,
      kind: 'milestone',
      phase: 'idle',
      active_slice: '—',
      active_task: '—',
      auto_mode: 'off',
      next_action: 'plan-milestone',
      host_runtime: input.host_runtime,
    });
  }
  const result = base('init', 'completed', 'initialized', input);
  result.state = publicState(forgeState.read(input.cwd, input.milestone));
  result.events = [{ event: 'initialized', milestone: input.milestone, reason_code: 'initialized' }];
  result.details = { state_file: path.relative(input.cwd, stateFile).split(path.sep).join('/') };
  return result;
}
function status(inputValue) {
  const input = normalizeInput(inputValue);
  const model = forgeStatus.collect(input.cwd, { milestoneId: input.milestone || undefined });
  const result = base('status', 'completed', 'status-ready', input);
  result.milestone = model.runs.focused || input.milestone || null;
  result.state = model.milestone ? {
    milestone: model.milestone.id,
    phase: model.milestone.phase,
    active_slice: model.milestone.active_slice,
    active_task: model.milestone.active_task,
    progress: model.milestone.progress,
  } : null;
  result.details = {
    runs: (model.runs.active || []).map((run) => ({ id: run.id, kind: run.kind, phase: run.phase, stale: run.stale })),
    autonomous_tasks: (model.autonomous_tasks || []).map((task) => ({ id: task.id, status: task.status })),
  };
  result.warnings = model.warnings || [];
  if (!result.state && !result.milestone) { result.outcome = 'no_work'; result.reason_code = 'no-next-unit'; }
  return result;
}
function next(inputValue, options) {
  const input = normalizeInput(inputValue);
  if (!input.milestone) throw error('invalid-request', 'milestone é obrigatório para next');
  if (input.response !== undefined && !input.boundary) {
    const result = base('next', 'blocked', 'needs-input-boundary', input);
    return result;
  }
  if (input.response !== undefined && input.boundary) return resumeResponse(input, options);
  if (input.inventory && input.inventory.milestone_complete === true) {
    const result = base('next', 'no_work', 'no-next-unit', input);
    result.state = publicState(forgeState.read(input.cwd, input.milestone));
    return result;
  }
  let selection;
  try {
    selection = forgeController.select(input.cwd, { milestone: input.milestone, inventory: input.inventory || undefined }, { prefsReader: input.prefsReader });
  } catch (cause) {
    if (cause && cause.code === 'CONTROLLER_FAILPOINT') throw cause;
    const code = cause.code || 'failed';
    const result = base('next', code === 'prefs-invalid' ? 'blocked' : 'failed', code, input);
    return result;
  }
  if (!selection.ok) {
    const result = base('next', 'no_work', selection.reason || 'no-next-unit', input);
    result.state = publicState(forgeState.read(input.cwd, input.milestone));
    return result;
  }
  const selectedUnit = unit(selection.unit);
  const key = input.idempotency_key || `forge-orchestrate-next:${input.milestone}:${selectedUnit.key}`;
  const request = { milestone: input.milestone, unit: selectedUnit, host_runtime: input.host_runtime, owner_token: input.owner_token, session: input.session, idempotency_key: key };
  const txOptions = { ...(options || {}), prefsReader: input.prefsReader };
  try {
    // Recovery is explicit and uses the durable S02 transaction record. It is
    // harmless when no transaction exists and makes crash retry deterministic.
    forgeController.resume(input.cwd, { idempotency_key: key, owner_token: input.owner_token }, txOptions);
    const begun = forgeController.begin(input.cwd, request, txOptions);
    let paused = null;
    if (input.needs_input) {
      const beginRecord = forgeController.readJson(forgeController.transactionFile(input.cwd, key)) || begun.transaction;
      paused = forgeController.pause(input.cwd, {
        milestone: input.milestone,
        unit: selectedUnit,
        host_runtime: input.host_runtime,
        owner_token: begun.owner_token || input.owner_token,
        generation: begun.generation || (beginRecord && beginRecord.lease_generation),
        idempotency_key: `${key}:needs-input`,
        result: { status: 'cancelled' },
      }, txOptions);
    }
    const result = base('next', input.needs_input ? 'needs_input' : 'completed', input.needs_input ? 'needs-input' : 'unit-selected', input);
    result.unit = selectedUnit;
    result.state = publicState(forgeState.read(input.cwd, input.milestone));
    result.events = [{ event: 'unit-began', action: 'begin', unit: selectedUnit.key, milestone: input.milestone, reason_code: 'selected' }];
    if (paused && paused.transaction && paused.transaction.boundary) result.boundary = paused.transaction.boundary;
    result.details = { transaction: begun.transaction ? { idempotency_key: begun.transaction.idempotency_key, phase: begun.transaction.phase } : null, selection_reason: selection.reason };
    return result;
  } catch (cause) {
    if (cause && cause.code === 'CONTROLLER_FAILPOINT') throw cause;
    const code = cause.code || 'failed';
    const result = base('next', code === 'lease-active' || code === 'transaction-pending' || code === 'prefs-invalid' ? 'blocked' : 'failed', code, input);
    result.unit = selectedUnit;
    return result;
  }
}
function resumeResponse(input, options) {
  let response;
  try { response = normalizedResponse(input.response); } catch (cause) { return base('next', 'blocked', cause.code || 'response-invalid', input); }
  const boundary = input.boundary;
  if (!boundary || !boundary.unit || !boundary.idempotency_key) return base('next', 'blocked', 'needs-input-boundary', input);
  let handoff;
  try {
    durableBoundary(input, boundary);
    handoff = forgeController.handoff(input.cwd, { unit: boundary.unit, next_host_runtime: input.host_runtime }, { prefsReader: input.prefsReader });
    const beginKey = `forge-orchestrate-resume:${boundary.idempotency_key}`;
    const completeKey = `${beginKey}:complete`;
    const txOptions = { ...(options || {}), prefsReader: input.prefsReader };
    const readTransaction = (key) => forgeController.readJson(forgeController.transactionFile(input.cwd, key));
    // A retry may observe a committed begin or a partially published complete
    // transaction. Recover from the durable records before creating anything;
    // never require a provider session to obtain the old lease generation.
    let completedRecord = readTransaction(completeKey);
    if (completedRecord && completedRecord.phase !== 'committed') {
      forgeController.resume(input.cwd, { idempotency_key: completeKey, owner_token: input.owner_token, generation: completedRecord.lease_generation }, txOptions);
      completedRecord = readTransaction(completeKey);
    }
    if (completedRecord && completedRecord.phase === 'committed') {
      const result = base('next', 'completed', 'handoff-ready', input);
      result.unit = unit(boundary.unit);
      result.events = [{ event: 'unit-resumed', action: 'complete', unit: result.unit.key, milestone: input.milestone, reason_code: 'handoff-ready' }];
      result.state = publicState(forgeState.read(input.cwd, input.milestone));
      result.boundary = completedRecord.boundary || null;
      result.details = { previous_host_runtime: handoff.previous_host_runtime, next_host_runtime: handoff.next_host_runtime };
      return result;
    }
    let beginRecord = readTransaction(beginKey);
    if (beginRecord && beginRecord.phase !== 'committed') {
      forgeController.resume(input.cwd, { idempotency_key: beginKey, owner_token: input.owner_token, generation: beginRecord.lease_generation }, txOptions);
      beginRecord = readTransaction(beginKey);
    }
    let begun;
    if (beginRecord && beginRecord.phase === 'committed') {
      begun = { transaction: beginRecord, owner_token: input.owner_token, generation: beginRecord.lease_generation };
    } else {
      begun = forgeController.begin(input.cwd, { milestone: boundary.milestone || input.milestone, unit: boundary.unit, host_runtime: input.host_runtime, owner_token: input.owner_token, idempotency_key: beginKey }, txOptions);
    }
    const completed = forgeController.complete(input.cwd, { milestone: boundary.milestone || input.milestone, unit: boundary.unit, host_runtime: input.host_runtime, owner_token: begun.owner_token || input.owner_token, generation: begun.generation || (begun.transaction && begun.transaction.lease_generation), idempotency_key: completeKey, result: { status: 'succeeded', output: response } }, txOptions);
    const result = base('next', 'completed', 'handoff-ready', input);
    result.unit = unit(boundary.unit);
    result.events = [{ event: 'unit-resumed', action: 'complete', unit: result.unit.key, milestone: input.milestone, reason_code: 'handoff-ready' }];
    result.state = publicState(forgeState.read(input.cwd, input.milestone));
    result.boundary = completed.transaction && completed.transaction.boundary ? completed.transaction.boundary : null;
    result.details = { previous_host_runtime: handoff.previous_host_runtime, next_host_runtime: handoff.next_host_runtime };
    return result;
  } catch (cause) {
    const code = cause.code || 'failed';
    const result = base('next', ['lease-active', 'transaction-pending'].includes(code) ? 'blocked' : 'failed', code, input);
    result.unit = unit(boundary.unit);
    return result;
  }
}
function handoff(inputValue) {
  const input = normalizeInput(inputValue);
  if (!input.milestone || !input.boundary || !input.boundary.unit) return base('handoff', 'blocked', 'boundary-missing', input);
  try {
    const durable = durableBoundary(input, input.boundary);
    const ready = forgeController.handoff(input.cwd, { unit: input.boundary.unit, next_host_runtime: input.host_runtime }, { prefsReader: input.prefsReader });
    const result = base('handoff', 'completed', 'handoff-ready', input);
    result.unit = unit(input.boundary.unit);
    result.boundary = { ...durable, ...ready };
    result.state = publicState(forgeState.read(input.cwd, input.milestone));
    return result;
  } catch (cause) {
    const result = base('handoff', ['lease-active', 'transaction-pending'].includes(cause.code) ? 'blocked' : 'failed', cause.code || 'failed', input);
    result.unit = unit(input.boundary.unit);
    return result;
  }
}
function run(operation, input, options) {
  if (!OPERATIONS.includes(operation)) throw error('invalid-request', `operation inválida: ${operation}`);
  if (operation === 'init') return init(input);
  if (operation === 'status') return status(input);
  if (operation === 'complete') return complete(input);
  return next(input, options);
}
function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2);
    const nextValue = argv[index + 1];
    args[key] = nextValue && !nextValue.startsWith('--') ? (index++, nextValue) : true;
  }
  return args;
}
function main(argv = process.argv.slice(2), output = process.stdout.write.bind(process.stdout), errorOutput = process.stderr.write.bind(process.stderr)) {
  try {
    const args = parseArgs(argv);
    const operation = args.init ? 'init' : args.status ? 'status' : args.next ? 'next' : null;
    if (!operation) throw error('invalid-request', 'use --init, --status ou --next');
    const payload = args.json ? JSON.parse(args.json) : {};
    if (args.cwd) payload.cwd = args.cwd;
    if (args.milestone) payload.milestone = args.milestone;
    const result = run(operation, payload);
    output(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (cause) {
    errorOutput(`forge-orchestrate: ${cause.code || 'failed'}: ${cause.message}\n`);
    return 1;
  }
}
if (require.main === module) process.exitCode = main();
module.exports = { PROTOCOL_VERSION, OPERATIONS, OUTCOMES, REASON_CODES, normalizeInput, normalizeHost, init, status, next, handoff, run, parseArgs, main, checksum };
