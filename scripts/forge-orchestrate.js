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
const milestoneTime = require('./forge-milestone-time-admission');
const timeSelection = require('./forge-milestone-time-selection');

// Closed summaries, not exception text: messages/paths/stack can contain private
// context. Like sidecar diagnostics, this boundary retains only allowlisted data.
function failureDiagnostic(cause, input, stage, transactionKey) {
  const messages = { EPERM: 'operation not permitted', EACCES: 'permission denied',
    ENOENT: 'file or directory not found', EIO: 'input/output error',
    EBUSY: 'resource busy', ENOSPC: 'no space left on device', EEXIST: 'file already exists' };
  const syscalls = ['rename', 'open', 'read', 'write', 'close', 'mkdir', 'unlink', 'rmdir',
    'stat', 'lstat', 'realpath', 'scandir', 'copyfile', 'fsync', 'chmod'];
  const known = Object.prototype.hasOwnProperty.call(messages, cause?.code);
  const diagnostic = { version: 1, layer: 'orchestrator-controller', stage,
    message: known ? messages[cause.code] : 'error details withheld',
    message_source: known ? 'code-summary' : 'withheld',
    syscall: syscalls.includes(cause?.syscall) ? cause.syscall : null,
    errno: Number.isSafeInteger(cause?.errno) && Math.abs(cause.errno) <= 2147483647 ? cause.errno : null,
    transaction: null };
  if (transactionKey) {
    diagnostic.transaction = { status: 'unknown', reference: null, phase: null };
    try {
      const file = forgeController.transactionFile(input.cwd, transactionKey);
      const name = path.basename(file);
      if (/^transaction-v1-[a-f0-9]{64}\.json$/.test(name)) diagnostic.transaction.reference = `.gsd/forge/transactions/${name}`;
      const record = forgeController.lookupRecord(input.cwd, 'transaction', transactionKey);
      diagnostic.transaction.status = record ? 'observed' : 'absent';
      const phases = ['intent', 'result-published', 'event-published', 'boundary-pending',
        'state-published', 'lease-release-pending', 'lease-released', 'boundary-ready', 'committed'];
      if (record && phases.includes(record.phase)) diagnostic.transaction.phase = record.phase;
    } catch { /* Secondary read failures never erase the original diagnostic. */ }
  }
  return diagnostic;
}

const PROTOCOL_VERSION = '1.0.0';
const OPERATIONS = Object.freeze(['init', 'status', 'next', 'complete', 'consume-failure', 'reenter', 'resume-budget', 'resume-time-option']);
const OUTCOMES = Object.freeze(['needs_input', 'completed', 'blocked', 'no_work', 'failed']);
// Named results of the owner budget-resume boundary, including the explicit
// consumed-failure continuation that only a linked entry may take.
const BUDGET_RESUME_REASON_CODES = Object.freeze(['budget-resume-ready', 'budget-resume-invalid',
  'budget-checkpoint-required', 'budget-extension-required', 'budget-retained-claim-changed',
  'linked-reentry-required', 'budget-entry-invalid']);
// S02 refusals are blocked boundaries, never failures. A pending decision
// continues only through the named resume-time-option operation; an answered
// re-estimate continues to the canonical estimate of the current owner basis.
const TIME_OPTION_BLOCK_CODES = Object.freeze([...new Set(['time-option-pending', ...timeSelection.TIME_OPTION_REASON_CODES,
  ...forgeController.TIME_ADMISSION_CODES])]);
const TIME_OPTION_CONTINUATION_CODES = Object.freeze(['time-option-reestimate-ready']);
const REASON_CODES = Object.freeze([
  'initialized', 'already-initialized', 'status-ready', 'selected', 'unit-selected',
  'no-next-unit', 'needs-input', 'needs-input-boundary', 'not-initialized',
  'prefs-invalid', 'lease-active', 'transaction-pending', 'invalid-request', 'failed',
  'handoff-ready', 'boundary-missing', 'boundary-not-transferable', 'response-invalid',
  ...milestoneTime.TIME_REASON_CODES, ...BUDGET_RESUME_REASON_CODES,
  ...timeSelection.TIME_OPTION_REASON_CODES, ...timeSelection.TIME_OPTION_RESUME_CODES,
  ...forgeController.TIME_ADMISSION_CODES, ...TIME_OPTION_CONTINUATION_CODES,
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
  if (own(input, 'time_session')) output.time_session = typeof input.time_session === 'string' ? input.time_session : null;
  // Operational locator of the investigated CODE_DIR (root, files, labels): the
  // owner re-measures every identity and hash; it never carries authority.
  if (own(input, 'code') && input.code !== undefined && input.code !== null) {
    if (!input.code || typeof input.code !== 'object' || Array.isArray(input.code)) throw error('invalid-request', 'code deve ser objeto');
    output.code = input.code;
  }
  return output;
}
function recordTimePresence(input, boundary, options = {}) {
  if (!input.milestone) return;
  const time = require('./forge-milestone-time'), current = time.readContract({ cwd: input.cwd, milestone: input.milestone });
  if (current.status === 'valid' && typeof input.time_session === 'string' && input.time_session.trim()) {
    const now = typeof options.now === 'function' ? options.now() : options.now ?? Date.now();
    time.appendJournal({ cwd: input.cwd, milestone: input.milestone, record: { type: 'presence', boundary,
      session_sha256: crypto.createHash('sha256').update(input.time_session).digest('hex'), at: new Date(now).toISOString() } });
  }
}
// Safe owner boundary after a committed terminal transaction: the trusted live
// reader (an in-process adapter, never JSON) names already observed invocation
// sources. Absent reader or contract-free work: nothing is read or written.
function observeWorkers(input, unitKey, beginKey, completionKey, completion, options = {}) {
  if (!input.milestone || require('./forge-milestone-time').readContract({ cwd: input.cwd, milestone: input.milestone }).status !== 'valid') return null;
  const workers = require('./forge-milestone-worker-observations');
  try {
    return workers.publicResult(workers.observeCompletion({ cwd: input.cwd, milestone: input.milestone, unit: unitKey,
      begin_key: beginKey, completion_key: completionKey, completion, reader: options.workerObservationReader, now: options.now }));
  } catch { return { status: 'unknown', reason: 'observation-failed' }; }
}
function attachWorkers(output, workers) {
  if (workers) output.details = { ...(output.details || {}), time: { ...(output.details?.time || {}), worker_observations: workers } };
  return output;
}
function publicTime(status) {
  return { ...milestoneTime.summarizeTimeStatus(status), contract: status.contract, contract_version: status.contract_version,
    open_writers: status.open_writers || [], unknowns: status.unknowns || [] };
}
function attachTimeRefusal(result, cause, input, options) {
  if (TIME_OPTION_BLOCK_CODES.includes(cause.code)) {
    result.outcome = 'blocked';
    result.details = { ...(result.details || {}), time_options: timeOptionsDetails(input, cause.details?.time_options ?? null, options),
      ...(cause.details?.task_dag ? { task_dag: cause.details.task_dag } : {}), ...(cause.details?.review ? { review: cause.details.review } : {}) };
    return result;
  }
  if (!milestoneTime.TIME_REASON_CODES.includes(cause.code)) return result;
  result.outcome = 'blocked';
  result.details = { ...(result.details || {}), time: cause.details || publicTime(milestoneTime.readTimeStatus(input.cwd, input.milestone, options)) };
  return result;
}
// Public owner projection of a blocked S02 state. A pending decision also names
// its offered positions (owner-computed numbers only), the rendered record and
// whether a contracted choice is compatible with the effective review mode.
function timeOptionsDetails(input, state, options = {}) {
  if (!state || typeof state !== 'object') return state ?? null;
  const details = { ...state };
  if (state.status === 'decision-pending') {
    details.contract_compatibility = timeSelection.contractCompatibility(input.cwd, input.milestone,
      { prefsReader: input.prefsReader || (options && options.prefsReader) });
  }
  if (state.status === 'decision-pending' && /^[a-f0-9]{64}$/.test(state.options_sha256 || '')) {
    try {
      const read = require('./forge-milestone-time').readOptions({ cwd: input.cwd, milestone: input.milestone, options_sha256: state.options_sha256 });
      if (read.status === 'valid') {
        details.rendered = `.gsd/milestones/${input.milestone}/${input.milestone}-OPTIONS.md`;
        details.positions = (read.record.estimate?.positions || []).map(row => ({ position_id: row.position_id, status: row.status,
          low_ms: row.low_ms ?? null, high_ms: row.high_ms ?? null, ceiling_ms: row.ceiling_ms ?? null, confidence: row.confidence ?? null,
          critical_path: row.critical_path ?? null }));
      }
    } catch { details.positions = null; }
  }
  return details;
}
// The owner captures the estimate producer basis on the physical roots right
// before begin and proves it is the exact basis behind the selected key.
function estimateProducerBasis(input, selection) {
  const roots = require('./forge-code-roots'), milestone = input.milestone, code = input.code || {};
  const state = timeSelection.readSelectionState(input.cwd, milestone, input.code ? { code: input.code } : {});
  if (!state || state.status !== 'estimate-required' || state.key_suffix !== selection.key_suffix) throw error('time-options-invalid', 'estimativa sem base atual do owner');
  const owner = fs.realpathSync.native(input.cwd);
  const real = roots.realDirectory(path.resolve(typeof code.root === 'string' ? code.root : owner));
  const stat = fs.statSync(real, { bigint: true });
  const physical = roots.digest({ policy: 'forge-milestone-code-root-v1', physical_path: roots.key(real), dev: String(stat.dev), ino: String(stat.ino) });
  const fingerprint = (root, relative) => {
    const file = path.join(root, ...relative.split('/'));
    return fs.existsSync(file) ? roots.digest(fs.readFileSync(file)) : roots.digest({ policy: 'forge-milestone-estimate-basis-v1', absent: relative });
  };
  const documents = [...['SCOPE', 'CONTEXT', 'BRAINSTORM'].map(kind => `.gsd/milestones/${milestone}/${milestone}-${kind}.md`), '.gsd/REQUIREMENTS.md'];
  const files = [...new Set((Array.isArray(code.files) ? code.files : []).map(file => roots.assertRelative(file)))].sort();
  const basis = { milestone, previous_options_sha256: state.previous_options_sha256 ?? null, inputs: {
    documents: documents.map(relative => ({ path: relative, sha256: fingerprint(owner, relative) })),
    code_root: { identity_sha256: code.identity_sha256 ?? physical, revision: code.revision ?? 'unversioned', workspace: code.workspace ?? 'primary' },
    code_files: files.map(relative => ({ path: relative, sha256: fingerprint(real, relative) })) } };
  if (timeSelection.estimateKeySuffix(basis) !== state.key_suffix) throw error('time-options-invalid', 'base do produtor diverge da captura do owner');
  return basis;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function checksum(value) { return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
function validatePending(inputValue, decision, options = {}) {
  const input = normalizeInput(inputValue), binding = decision?.details?.transaction;
  if (!binding) return { ok: false, reason: 'unit-identity-mismatch' };
  const begun = forgeController.lookupRecord(input.cwd, 'transaction', binding.idempotency_key);
  if (!begun || begun.action !== 'begin' || begun.phase !== 'committed'
    || own(binding, 'begin_checksum') && checksum(begun) !== binding.begin_checksum
    || begun.unit.key !== decision.unit?.key || begun.milestone !== input.milestone || begun.host_runtime !== input.host_runtime
    || begun.owner_digest !== `sha256:${crypto.createHash('sha256').update(input.owner_token.normalize('NFC').trim()).digest('hex')}`) return { ok: false, reason: 'unit-identity-mismatch' };
  if (forgeController.pendingTransactions(input.cwd).length) return { ok: false, reason: 'transaction-pending' };
  const leaseApi = forgeController.dependencies.forgeLease;
  const held = leaseApi.readLease(leaseApi.leaseFile(input.cwd, begun.unit.key));
  if (!leaseApi.validRecord(held.record, begun.unit.key) || held.record.owner_token !== input.owner_token
    || held.record.generation !== begun.lease_generation) return { ok: false, reason: 'lease-owner-mismatch' };
  const consumed = forgeController.failureProjection(input.cwd, input.milestone).some(item => item.begin.idempotency_key === begun.idempotency_key);
  if (consumed) return { ok: false, reason: 'failure-deferred' };
  const boundary = forgeController.lookupRecord(input.cwd, 'boundary', begun.unit.key);
  if (boundary?.kind === 'needs-input') return { ok: false, reason: 'pending-questions' };
  const context = typeof options.inspectAttempt === 'function'
    ? options.inspectAttempt({ cwd: input.cwd, begin: begun, references: {} }) : null;
  const currentQuestions = begun.linked_entry
    ? forgeController.validateLinkedEntry(input.cwd, begun.idempotency_key, { ...options, ownerToken: input.owner_token,
      observedPendingQuestions: context?.pending_questions || [] }).pending_questions : null;
  if (context) {
    if (context?.pending_questions?.some(item => item.status === 'pending'
      && !currentQuestions?.some(q => q.id === item.id && q.question === item.question && q.status === 'resolved'))) {
      return { ok: false, reason: 'pending-questions', pending_questions: require('./forge-interaction').mergePendingQuestions(currentQuestions || [], context.pending_questions) };
    }
  }
  return { ok: true, ...(currentQuestions ? { pending_questions: currentQuestions } : {}) };
}
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
function complete(inputValue, options) {
  const input = normalizeInput(inputValue);
  const selected = unit(inputValue.unit);
  const key = inputValue.begin_key;
  if (!selected || !key || !inputValue.result || inputValue.result.status !== 'done') {
    return base('complete', 'blocked', 'unit-result-required', input);
  }
  const begun = forgeController.lookupRecord(input.cwd, 'transaction', key);
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
    }, { ...options, ...(input.prefsReader ? { prefsReader: input.prefsReader } : {}) });
    const output = base('complete', 'completed', committed.reason, input);
    output.unit = selected; output.boundary = committed.transaction.boundary;
    try { recordTimePresence(input, 'complete', options); }
    catch { output.details = { time: { presence: 'unknown', unknowns: ['time-presence-unrecorded'] } }; }
    return attachWorkers(output, observeWorkers(input, selected.key, key, `${key}:complete`, 'complete', options));
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
  // Only IDs returned by the personal snapshot (or explicit inspection) may be
  // read here. Never recover the old workspace focus through a global census.
  const milestones = model.works.filter((work) => work.kind === 'milestone');
  const focused = input.milestone
    ? milestones.find((work) => work.id === input.milestone)
    : milestones.length === 1 ? milestones[0] : null;
  result.milestone = focused ? focused.id : input.milestone;
  result.state = focused ? focused.state : null;
  result.details = {
    status_schema_version: '2.0.0',
    scope: model.scope,
    works: model.works,
    runs: model.works.filter((work) => work.activity === 'active')
      .map((work) => ({ id: work.id, kind: work.kind, activity: work.activity })),
    autonomous_tasks: model.works.filter((work) => work.kind === 'task')
      .map((work) => ({ id: work.id, status: work.workStatus })),
  };
  result.warnings = [...(model.warnings || []), ...model.works
    .filter((work) => work.reliability !== 'current')
    .map((work) => work.id + ': ' + work.reliability)];
  if (model.status === 'error') { result.outcome = 'failed'; result.reason_code = 'failed'; }
  else if (!model.works.length) { result.outcome = 'no_work'; result.reason_code = 'no-next-unit'; }
  return result;
}
// Safe owner boundary of the S02 selection: materialize an accepted proposal and
// publish a conformant delegated allocation. Without enrollment or selection it
// only checks existence, so contract-free milestones keep identical records.
function prepareTimeOptions(input, options) {
  const now = typeof options.now === 'function' ? options.now() : options.now ?? Date.now();
  const prepared = timeSelection.prepareBoundary(input.cwd, input.milestone, { now, ...(input.code ? { code: input.code } : {}) });
  return prepared && prepared.status !== 'no-op' ? prepared : null;
}
function withPrepared(result, prepared) {
  if (prepared) result.details = { ...(result.details || {}), time_options: { ...(result.details?.time_options || {}), boundary: prepared } };
  return result;
}
function next(inputValue, options = {}) {
  const input = normalizeInput(inputValue);
  if (!input.milestone) return nextInside(inputValue, options);
  // Before any time read or selection: the boundary output is what they observe.
  const prepared = prepareTimeOptions(input, options);
  return withPrepared(nextTimed(inputValue, input, options), prepared);
}
function nextTimed(inputValue, input, options) {
  let status, boundary;
  try {
    status = milestoneTime.readTimeStatus(input.cwd, input.milestone, options);
    if (status.contract !== 'absent') {
      recordTimePresence(input, 'next', options);
      boundary = milestoneTime.observeBoundary(input.cwd, input.milestone, { ...options, kind: 'slice-boundary' });
    }
  } catch (cause) {
    const result = base('next', 'blocked', 'milestone-time-invalid', input);
    result.details = { time: { state: null, unknown: true, unknowns: ['time-source-unreadable'] } }; return result;
  }
  if (status.contract === 'absent') return nextInside(inputValue, options);
  const result = nextInside(inputValue, options);
  // Blocked selections never reach begin, but are still forecast boundaries.
  // A replay/paused continuation remains governed solely by the controller.
  const observed = ['units-blocked', 'failure-deferred'].includes(result.reason_code)
    ? milestoneTime.observeBoundary(input.cwd, input.milestone, { ...options, kind: 'blocked', reason: result.reason_code,
      units: result.unit ? [result.unit] : [] }) : boundary;
  status = milestoneTime.readTimeStatus(input.cwd, input.milestone, options);
  const details = { ...publicTime(status), ...(result.details?.time || {}) };
  const contract = require('./forge-milestone-time').readContract({ cwd: input.cwd, milestone: input.milestone });
  if (contract.status === 'valid') details.contract_sha256 = contract.sha256;
  details.diagnostic_command = `node scripts/forge-milestone-time-admission.js --status --milestone ${input.milestone} --json`;
  if (observed?.status === 'recorded' && observed.record.warning) details.warning = observed.record;
  if (Number.isSafeInteger(status.remaining_ms) && status.remaining_ms <= 0) {
    details.checkpoint = require('./forge-milestone-time-drain').checkpointIfDrained(input.cwd, input.milestone, options);
    if (['no_work', 'blocked'].includes(result.outcome) && !milestoneTime.TIME_REASON_CODES.includes(result.reason_code)) {
      result.outcome = 'blocked'; result.reason_code = status.open_writers.length ? 'milestone-budget-draining' : 'milestone-budget-exhausted';
    }
  }
  result.details = { ...(result.details || {}), time: details };
  return result;
}
function nextInside(inputValue, options) {
  const input = normalizeInput(inputValue);
  // Older embedding tests supplied an executable preference reader together
  // with their inventory. JSON callers cannot create this trusted fixture seam.
  options = { ...(options || {}) };
  if (!options.inventoryReader && input.prefsReader && input.inventory) options.inventoryReader = () => input.inventory;
  if (!input.milestone) throw error('invalid-request', 'milestone é obrigatório para next');
  if (input.response !== undefined && !input.boundary) {
    const result = base('next', 'blocked', 'needs-input-boundary', input);
    return result;
  }
  if (input.response !== undefined && input.boundary) return resumeResponse(input, options);
  // The same CODE_DIR locator reaches selection and the mutating guard, so both
  // derive the estimate key from one owner capture.
  if (input.code) options.timeOptionsCode = input.code;
  else delete options.timeOptionsCode;
  let selection;
  try {
    selection = forgeController.select(input.cwd, { milestone: input.milestone }, { ...options, ...(input.prefsReader ? { prefsReader: input.prefsReader } : {}) });
  } catch (cause) {
    if (cause && cause.code === 'CONTROLLER_FAILPOINT') throw cause;
    const code = cause.code || 'failed';
    const result = base('next', code === 'prefs-invalid' ? 'blocked' : 'failed', code, input);
    result.diagnostic = failureDiagnostic(cause, input, 'select');
    return result;
  }
  if (!selection.ok) {
    const result = base('next', selection.done === true ? 'no_work' : 'blocked', selection.reason || 'no-next-unit', input);
    result.details = { blocked: selection.blocked || [],
      ...(own(selection, 'time_options') ? { time_options: timeOptionsDetails(input, selection.time_options, options) } : {}),
      ...(selection.task_dag ? { task_dag: { slice: selection.slice, ...selection.task_dag } } : {}) };
    result.state = publicState(forgeState.read(input.cwd, input.milestone));
    return result;
  }
  const selectedUnit = unit(selection.unit);
  const legacyKey = `forge-orchestrate-next:${input.milestone}:${selectedUnit.key}`;
  let key = input.idempotency_key || (selection.slice ? `${legacyKey}:${selection.slice}` : legacyKey);
  // A new estimate basis gets a new begin, never the committed begin of a stale estimate.
  if (!input.idempotency_key && selection.key_suffix) key = `${legacyKey}:${selection.key_suffix}`;
  const txOptions = { ...(options || {}), ...(input.prefsReader ? { prefsReader: input.prefsReader } : {}) };
  let stage = 'prepare';
  let diagnosticKey;
  let producer = null;
  if (selectedUnit.type === 'estimate-milestone') {
    try {
      if (key !== timeSelection.estimateBeginKey(input.milestone, selection.key_suffix)) throw error('time-options-invalid', 'chave da estimativa divergente');
      producer = estimateProducerBasis(input, selection);
    } catch (cause) {
      const result = base('next', 'blocked', 'time-options-invalid', input);
      result.unit = selectedUnit;
      result.details = { time_options: { status: 'estimate-required', key_suffix: selection.key_suffix ?? null,
        reason: cause.code === 'time-options-invalid' ? 'producer-basis-mismatch' : 'producer-basis-unreadable' } };
      return result;
    }
  }
  try {
    if (!input.idempotency_key && selection.slice) {
      // Resume pre-slice keys only when their durable state proves the same scope.
      const prior = forgeController.readJson(forgeController.transactionFile(input.cwd, legacyKey));
      if (prior && prior.action === 'begin' && prior.milestone === input.milestone
        && prior.unit.key === selectedUnit.key && prior.after.state.active_slice === selection.slice) key = legacyKey;
    }
    const request = { milestone: input.milestone, unit: selectedUnit, slice: selection.slice, host_runtime: input.host_runtime, owner_token: input.owner_token, session: input.session, idempotency_key: key,
      state_patch: { active_slice: selection.slice || '—' } };
    // Recovery is explicit and uses the durable S02 transaction record. It is
    // harmless when no transaction exists and makes crash retry deterministic.
    stage = 'resume';
    diagnosticKey = key;
    forgeController.resume(input.cwd, { idempotency_key: key, owner_token: input.owner_token }, txOptions);
    stage = 'begin';
    const begun = forgeController.begin(input.cwd, request, txOptions);
    let paused = null;
    if (input.needs_input) {
      stage = 'pause';
      const beginRecord = forgeController.readJson(forgeController.transactionFile(input.cwd, key)) || begun.transaction;
      diagnosticKey = `${key}:needs-input`;
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
    stage = 'readback';
    diagnosticKey = key;
    const result = base('next', input.needs_input ? 'needs_input' : 'completed', input.needs_input ? 'needs-input' : 'unit-selected', input);
    result.unit = selectedUnit;
    result.state = publicState(forgeState.read(input.cwd, input.milestone));
    result.events = [{ event: 'unit-began', action: 'begin', unit: selectedUnit.key, milestone: input.milestone, reason_code: 'selected' }];
    if (paused && paused.transaction && paused.transaction.boundary) result.boundary = paused.transaction.boundary;
    const durableBegin = forgeController.lookupRecord(input.cwd, 'transaction', key);
    result.details = { transaction: begun.transaction ? { idempotency_key: key, phase: begun.transaction.phase,
      begin_checksum: checksum(durableBegin), generation: durableBegin.lease_generation, owner_digest: durableBegin.owner_digest,
      host_runtime: durableBegin.host_runtime, milestone: durableBegin.milestone, unit: durableBegin.unit.key } : null, selection_reason: selection.reason };
    // The dispatcher forwards this owner capture as the sidecar producerBasis.
    if (producer) result.details.time_options = { status: 'estimate-required', key_suffix: selection.key_suffix, begin_key: key, producer_basis: producer };
    return result;
  } catch (cause) {
    if (cause && cause.code === 'CONTROLLER_FAILPOINT') throw cause;
    const code = cause.code || 'failed';
    const result = base('next', code === 'lease-active' || code === 'transaction-pending' || code === 'prefs-invalid' ? 'blocked' : 'failed', code, input);
    result.unit = selectedUnit;
    result.diagnostic = failureDiagnostic(cause, input, stage, diagnosticKey);
    return attachTimeRefusal(result, cause, input, options);
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
    return attachTimeRefusal(result, cause, input, options);
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
function linkedOperation(operation, inputValue, options) {
  const input = normalizeInput(inputValue);
  try {
    const result = operation === 'consume-failure' ? forgeController.consumeFailure(input.cwd, { ...inputValue, ...input }, options)
      : forgeController.reenter(input.cwd, { ...inputValue, ...input }, options);
    const output = base(operation, operation === 'reenter' ? 'completed' : 'failed', result.reason, input);
    output.unit = unit(result.transaction.unit); output.boundary = result.transaction.boundary;
    output.details = result;
    output.details.transaction = { ...result.transaction,
      begin_checksum: operation === 'reenter' ? checksum(forgeController.lookupRecord(input.cwd, 'transaction', result.transaction.idempotency_key)) : undefined };
    // A consumed terminal failure is also a reconciled owner boundary: actual
    // invocation evidence may be observed; a pre-provider refusal adds no interval.
    if (operation === 'consume-failure') attachWorkers(output, observeWorkers(input, output.unit.key, inputValue.begin_key,
      result.failure_key, 'consume-failure', options));
    return output;
  } catch (cause) {
    if (cause.code === 'CONTROLLER_FAILPOINT') throw cause;
    const result = base(operation, 'blocked', cause.code || 'linked-operation-refused', input);
    if (cause.pending_questions) result.details = { pending_questions: cause.pending_questions };
    return attachTimeRefusal(result, cause, input, options);
  }
}
// A named owner boundary for a budget-blocked loop. A serialized resume flag
// cannot extend a contract: the canonical amendment must already contain its
// live-attested decision. Reconcile current durable state before next can run.
function resumeBudget(inputValue, options = {}) {
  const input = normalizeInput(inputValue), blocked = inputValue.time_block;
  const refuse = (reason, details) => Object.assign(base('resume-budget', 'blocked', reason, input), details ? { details } : {});
  if (!blocked || blocked.milestone !== input.milestone) return refuse('budget-resume-invalid');
  const time = require('./forge-milestone-time'), current = time.readContract({ cwd: input.cwd, milestone: input.milestone });
  if (current.status !== 'valid') return refuse('milestone-time-invalid');
  const checkpoint = time.readCheckpoints({ cwd: input.cwd, milestone: input.milestone });
  const record = checkpoint.status === 'valid' ? checkpoint.records.find(row => row.version === blocked.contract_version
    && row.contract_sha256 === blocked.contract_sha256 && row.drain?.state === 'drained') : null;
  if (!record) return refuse('budget-checkpoint-required');
  if (!current.chain.some(row => row.version > blocked.contract_version && row.kind === 'extension')) return refuse('budget-extension-required');
  const status = milestoneTime.readTimeStatus(input.cwd, input.milestone, options);
  if (!Number.isSafeInteger(status.remaining_ms) || status.remaining_ms <= 0) return refuse('milestone-budget-exhausted');
  // A linked entry already recorded for this entry_id is replayed by the
  // controller itself, which revalidates authority, baseline, roots and lease.
  const entry = inputValue.entry;
  if (entry && typeof entry.entry_id === 'string' && forgeController.lookupRecord(input.cwd, 'transaction',
    `linked-entry:${crypto.createHash('sha256').update(entry.entry_id, 'utf8').digest('hex')}`)) return linkedOperation('reenter', inputValue, options);
  // The proof covered one exact claim, receipt, root set and code state. Fresh
  // live adapters recheck it after restart; any drift or successor refuses.
  if (record.drain.claim === 'retained-reconciled') {
    const proof = require('./forge-milestone-time-drain').verifyRetainedCheckpoint(input.cwd, input.milestone, record, options);
    if (!proof.ok) return refuse('budget-retained-claim-changed', { retained: { reason: proof.reason } });
  }
  if (forgeController.pendingTransactions(input.cwd).length) return refuse('transaction-pending');
  if (status.open_writers.length) return refuse('milestone-budget-draining');
  const questions = require('./forge-pending-questions').listPendingQuestions({ cwd: input.cwd,
    filter: { type: 'milestone', id: input.milestone } });
  if (questions.census.invalid || questions.census.excess || !['no-questions', 'no-matching-questions', null].includes(questions.empty_reason)) return refuse('pending-questions');
  if (questions.questions.some(row => row.status === 'pending')) return refuse('pending-questions');
  const leases = forgeController.dependencies.forgeLease;
  const directory = leases.leasesDir(input.cwd);
  if (fs.existsSync(directory)) {
    if (fs.lstatSync(directory).isSymbolicLink()) return refuse('lease-active');
    for (const name of fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const file = path.join(directory, name);
      if (fs.lstatSync(file).isSymbolicLink()) return refuse('lease-active');
      const held = leases.readLease(file);
      if (held.corrupt || !held.record || !leases.validRecord(held.record, held.record.unit)) return refuse('lease-active');
      const transaction = held.record.request_id && forgeController.lookupRecord(input.cwd, 'transaction', held.record.request_id);
      if (!transaction || transaction.milestone === input.milestone) return refuse('lease-active');
    }
  }
  // A failure this workflow consumed stays failure-deferred after an extension.
  // next would skip it or select other work; only an explicit linked entry
  // continues it, and the controller admits that entry again before any lease.
  // The snapshot locator can only narrow this path, never authorize an entry.
  const failures = forgeController.failureProjection(input.cwd, input.milestone);
  const deferred = failures.filter(item => !item.entry), consumed = inputValue.consumed_failure;
  const locator = item => ({ unit: item.begin.unit.key, slice: item.slice || null,
    failure_key: item.transaction.idempotency_key, failure_checksum: checksum(item.transaction) });
  if (consumed) {
    const known = failures.find(item => item.transaction.idempotency_key === consumed.failure_key);
    if (!known || consumed.failure_checksum !== checksum(known.transaction)) return refuse('budget-entry-invalid');
    if (!known.entry && !entry) return refuse('linked-reentry-required', { failures: [locator(known)] });
  }
  if (!entry) return base('resume-budget', 'completed', 'budget-resume-ready', input);
  const target = deferred.find(item => item.transaction.idempotency_key === entry.failure_key);
  if (!target || entry.failure_checksum !== checksum(target.transaction) || unit(inputValue.unit)?.key !== target.begin.unit.key
    || consumed && consumed.failure_key !== entry.failure_key) return refuse('budget-entry-invalid');
  return linkedOperation('reenter', inputValue, options);
}
// Named continuation of a snapshot blocked by time-option-pending. The block is
// only a locator: the canonical resumeCheck rereads the owner selection, so a
// serialized flag, an approved:true field or an edited snapshot never decides.
// Nothing is written here; next is delegated by the loop on the same snapshot.
function resumeTimeOption(inputValue, options = {}) {
  const input = normalizeInput(inputValue), block = inputValue.time_option_block;
  const refuse = (reason, details) => Object.assign(base('resume-time-option', 'blocked', reason, input), details ? { details } : {});
  if (!input.milestone || !block || typeof block !== 'object' || Array.isArray(block) || block.milestone !== input.milestone) return refuse('time-option-resume-invalid');
  const checked = timeSelection.resumeCheck(input.cwd, input.milestone, block);
  const details = { time_options: { status: checked.status, options_sha256: checked.options_sha256 } };
  if (checked.ok) return Object.assign(base('resume-time-option', 'completed', 'time-option-ready', input), { details });
  // An explicit re-estimate (or changed sources before the choice) needs the
  // estimate of the current basis, which next selects; it decides nothing.
  if (checked.reason_code === 'time-option-pending' && checked.status === 'estimate-required') {
    return Object.assign(base('resume-time-option', 'completed', 'time-option-reestimate-ready', input), { details });
  }
  return refuse(checked.reason_code || 'time-option-resume-invalid', details);
}
function run(operation, input, options) {
  if (!OPERATIONS.includes(operation)) throw error('invalid-request', `operation inválida: ${operation}`);
  if (operation === 'init') return init(input);
  if (operation === 'status') return status(input);
  if (operation === 'complete') return complete(input, options);
  if (operation === 'resume-budget') return resumeBudget(input, options);
  if (operation === 'resume-time-option') return resumeTimeOption(input, options);
  if (operation === 'consume-failure' || operation === 'reenter') return linkedOperation(operation, input, options);
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
    if (args.help) { output('Usage: forge-orchestrate --init|--status|--next|--complete|--consume-failure|--reenter|--resume-budget|--resume-time-option --json JSON\n'); return 0; }
    const operation = OPERATIONS.find(name => args[name]);
    if (!operation) throw error('invalid-request', 'use --init, --status, --next, --complete, --consume-failure, --reenter, --resume-budget ou --resume-time-option');
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
module.exports = { PROTOCOL_VERSION, OPERATIONS, OUTCOMES, REASON_CODES, BUDGET_RESUME_REASON_CODES, TIME_OPTION_BLOCK_CODES,
  TIME_OPTION_CONTINUATION_CODES, normalizeInput, normalizeHost, init, status, next, handoff, run, parseArgs, main, checksum, validatePending };
