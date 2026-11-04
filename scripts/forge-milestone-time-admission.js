#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const TIME_REASON_CODES = Object.freeze(['milestone-budget-exhausted', 'milestone-budget-draining',
  'milestone-time-invalid', 'milestone-clock-unknown', 'time-option-pending']);
const TRANSPORT_REFUSAL_CODES = Object.freeze(TIME_REASON_CODES.slice(0, 4));
const ADMISSION_DECISIONS = Object.freeze(['admitted', 'no-contract', 'boundary-continuation']);
const TIME_STATES = Object.freeze(['active', 'warning', 'exhausted', 'draining', 'checkpointed', 'extended']);
const FORECAST_CLASSES = Object.freeze(['fits', 'at-risk', 'exceeds', 'unknown']);
const BLOCKED_REASONS = Object.freeze(['units-blocked', 'failure-deferred', 'pending-questions']);
const MAX_WRITERS = 256;
function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function nowOf(options) { return typeof options.now === 'function' ? options.now() : options.now ?? Date.now(); }
function unitKey(unit) {
  const value = typeof unit === 'string' ? unit : unit?.key || (unit?.type && unit?.id ? unit.type + '/' + unit.id : '');
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{1,50}\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}(?:\.\d{1,9})?$/.test(value)) throw Error('Unidade inválida');
  return value;
}
function reasonCode(reason) { return typeof reason === 'string' && /^[a-z][a-z0-9-]{0,100}$/.test(reason) ? reason : 'time-source-unreadable'; }
// Use the canonical bounded/stable reader and event parser; never parse a second
// lifecycle stream. Missing suffixes are allowed, links anywhere are not.
function boundedSource(file, limit) {
  let cursor = path.resolve(file);
  for (;;) {
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw Error('link'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  try {
    const expectedReal = fs.realpathSync.native(file);
    const result = require('./forge-autonomy-sources').readBoundedStableFile(file, limit, { expectedReal });
    if (result.error) throw Error('source'); return result.buffer;
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function openWriters(cwd, milestone, now, clock) {
  const phase = require('./forge-phase-cost');
  const reference = `.gsd/milestones/${milestone}/${milestone}-events.jsonl`;
  const bytes = boundedSource(path.join(cwd, reference), phase.MAX_BYTES);
  const source = clock.sources?.find(r => r.path === reference);
  if (!source || (bytes === null ? source.status !== 'absent' : hash(bytes) !== source.sha256)) throw Error('source');
  const events = phase.analyzeEventIntervals(bytes || Buffer.alloc(0));
  const rows = [...events.open.filter(r => r.start <= now).map(r => ({ unit: unitKey(r.unit), ambiguous: false })),
    ...events.ambiguous.filter(r => r.end === null && r.starts.some(at => at <= now))
      .map(r => ({ unit: unitKey(r.unit), ambiguous: true }))];
  if (events.milestones.some(m => m !== milestone) || rows.length > MAX_WRITERS) throw Error('source');
  return rows.sort((a, b) => a.unit.localeCompare(b.unit));
}
function pausedContinuation(cwd, options) {
  if (typeof options.key !== 'string' || !options.key.startsWith('forge-orchestrate-resume:')) return false;
  try {
    const unit = unitKey(options.unit), key = options.key.slice('forge-orchestrate-resume:'.length);
    if (!key || key.length > 512) return false;
    const controller = require('./forge-unit-controller');
    // Bound both modern and legacy files before the controller's authoritative
    // lookup, which validates their checksums and rejects divergent copies.
    const files = [controller.boundaryFile(cwd, unit), controller.transactionFile(cwd, key), controller.resultFile(cwd, key)];
    for (const [index, file] of files.entries()) {
      // lookupRecord also checks the legacy base64url copy. Guard only that
      // exact sibling, without inventorying unrelated work in shared folders.
      const identity = index === 0 ? unit : key, legacy = Buffer.from(identity).toString('base64url') + '.json';
      if (legacy.length <= 255) boundedSource(path.join(path.dirname(file), legacy), 1024 * 1024);
    }
    for (const file of files) {
      const bytes = boundedSource(file, 1024 * 1024);
      if (!bytes || !/^[a-f0-9]{64}$/.test(JSON.parse(bytes).storage_checksum)) return false;
    }
    const boundary = controller.lookupRecord(cwd, 'boundary', unit);
    if (boundary?.kind !== 'paused' || boundary.handoff_ready !== true || boundary.milestone !== options.milestone
        || boundary.unit !== unit || boundary.idempotency_key !== key || !Number.isFinite(Date.parse(boundary.committed_at))) return false;
    const tx = controller.lookupRecord(cwd, 'transaction', key), result = controller.lookupRecord(cwd, 'result', key);
    const { digest } = require('./forge-code-roots');
    return tx?.phase === 'committed' && tx.action === 'pause' && tx.milestone === options.milestone && tx.unit?.key === unit
      && result?.milestone === options.milestone && result.unit === unit && result.idempotency_key === key
      && digest(tx.boundary) === digest(boundary) && digest(tx.result) === digest(result);
  } catch { return false; }
}
function warningRows(listing, version) {
  return (listing.records || []).filter(r => r.version === version && FORECAST_CLASSES.includes(r.classification)
    && /^[a-f0-9]{64}$/.test(r.id) && Number.isSafeInteger(r.sequence) && r.sequence > 0)
    .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
}
function checkpointProjection(record) {
  if (!record) return null;
  const numeric = key => Number.isSafeInteger(record[key]) ? record[key] : null;
  return { version: record.version, decision_pending: record.decision_pending !== false,
    ceiling_ms: numeric('ceiling_ms'), consumed_ms: numeric('consumed_ms'), overshoot_ms: numeric('overshoot_ms') };
}
function observeTime(cwd, milestone, options) {
  const time = require('./forge-milestone-time');
  const now = nowOf(options), input = { ...options, cwd, milestone, now };
  const read = time.readContract(input);
  if (read.status === 'absent') return { status: { contract: 'absent' }, read };
  const diagnostic = `node scripts/forge-milestone-time-admission.js --status --milestone ${milestone} --json`;
  const base = { contract: read.status, state: null, horizon: null, clocks: null, remaining_ms: null,
    forecast: { status: 'unknown' }, last_warning: null, open_writers: [], checkpoint: null, unknowns: [] };
  if (read.status !== 'valid') {
    base.unknowns.push(reasonCode(read.reason)); return { status: base, read, diagnostic };
  }
  const clocks = require('./forge-milestone-time-clock');
  let clock = clocks.readClock(input), writers = [];
  // A frozen endpoint keeps its terminal consumption when the live writer metadata is unavailable;
  // writers are then explicitly unknown (never inferred as zero).
  const writersUnknown = [];
  if (clock.status === 'measured') {
    try { writers = openWriters(cwd, milestone, now, clock); }
    catch {
      if (clock.frozen) writersUnknown.push('open-writers-unknown');
      else clock = { status: 'unknown', reason: 'clock-source-unstable' };
    }
  }
  const warnings = time.listWarnings(input), checkpoints = time.readCheckpoints(input);
  const rows = warningRows(warnings, read.version), last = rows.at(-1) || null;
  const checkpoint = checkpoints.records?.find(r => r.version === read.version) || null;
  const forecast = clocks.readForecast(input), contract = read.contract;
  if (clock.status === 'measured') {
    try {
      for (const source of clock.sources.filter(r => ['valid', 'absent'].includes(r.status))) {
        const bytes = boundedSource(path.join(cwd, source.path), 2 * 1024 * 1024);
        if (bytes === null ? source.status !== 'absent' : hash(bytes) !== source.sha256) throw Error('source');
      }
    } catch {
      writers = [];
      if (clock.frozen) { if (!writersUnknown.length) writersUnknown.push('open-writers-unknown'); }
      else clock = { status: 'unknown', reason: 'clock-source-unstable' };
    }
  }
  const consumption = clock.status === 'measured' ? clock.consumption : null;
  const consumed = consumption?.consumed_ms ?? null;
  const remaining = consumed === null ? null : contract.ceiling_ms - consumed;
  const atCap = remaining !== null && remaining <= 0;
  // Read-only label projection: a delegated technical allocation is not a
  // functional decision, so the last decided amendment keeps its label.
  const lastDecided = read.chain.filter(row => !row.delegation).at(-1);
  // An unreadable writer census at the cap is never an empty one: it keeps the conservative draining label and no checkpoint.
  const censusKnown = writersUnknown.length === 0;
  const state = atCap ? writers.length || !censusKnown ? 'draining' : checkpoint ? 'checkpointed' : 'exhausted'
    : lastDecided?.kind === 'extension' && remaining > 0 ? 'extended'
      : last?.warning === true && ['at-risk', 'exceeds'].includes(last.classification) ? 'warning' : 'active';
  const unknowns = [clock.status !== 'measured' && reasonCode(clock.reason),
    warnings.status === 'invalid' && reasonCode(warnings.reason), checkpoints.status === 'invalid' && reasonCode(checkpoints.reason),
    forecast.status === 'unknown' && reasonCode(forecast.reason)].filter(Boolean);
  if (consumption?.unknown_ms > 0) unknowns.push('unattributed-time');
  unknowns.push(...writersUnknown);
  const after = time.readContract(input);
  if (after.status !== 'valid' || after.sha256 !== read.sha256 || after.version !== read.version) {
    base.contract = 'invalid'; base.unknowns = ['time-source-unstable']; return { status: base, read: after, diagnostic };
  }
  return { read, clock, diagnostic, status: {
    contract: 'valid', contract_version: read.version, state,
    horizon: { ceiling_ms: contract.ceiling_ms, endpoint: structuredClone(contract.endpoint), task: null, chain: null },
    clocks: clock.status === 'measured' ? { elapsed_ms: clock.elapsed.since_activation_ms, preselection_ms: clock.elapsed.preselection_ms,
      consumed_ms: consumed, unknown_ms: consumption.unknown_ms, effort: clock.effort, waits: clock.waits,
      gaps: clock.gaps.slice(0, 256), gap_count: clock.gaps.length, gaps_truncated: clock.gaps.length > 256 }
      : { consumed_ms: null, unknown_ms: null }, remaining_ms: remaining,
    forecast: { status: FORECAST_CLASSES.includes(forecast.status) ? forecast.status : 'unknown', reason: reasonCode(forecast.reason),
      projection: forecast.projection || { low_ms: null, high_ms: null }, burn_ratio: forecast.burn_ratio ?? null },
    last_warning: last ? { id: last.id, classification: last.classification, warning: last.warning === true } : null,
    open_writers: writers, checkpoint: atCap && !writers.length && censusKnown ? checkpointProjection(checkpoint) : null, unknowns: [...new Set(unknowns)]
  } };
}
function readTimeStatus(cwd, milestone, options = {}) { return observeTime(cwd, milestone, options).status; }
function summarizeTimeStatus(status) {
  const number = n => Number.isSafeInteger(n) ? n : null;
  return { state: TIME_STATES.includes(status?.state) ? status.state : null,
    ceiling_ms: number(status?.horizon?.ceiling_ms), consumed_ms: number(status?.clocks?.consumed_ms),
    unknown_ms: number(status?.clocks?.unknown_ms), remaining_ms: number(status?.remaining_ms),
    forecast: FORECAST_CLASSES.includes(status?.forecast?.status) ? status.forecast.status : 'unknown',
    last_warning: /^[a-f0-9]{64}$/.test(status?.last_warning?.id) ? status.last_warning.id : null,
    unknown: status?.contract === 'invalid' || (status?.unknowns?.length || 0) > 0 || status?.forecast?.status === 'unknown',
    decision_pending: status?.checkpoint?.decision_pending === true };
}
function decideAdmission(cwd, options = {}) {
  // Legacy callers need no time-specific unit vocabulary without a contract.
  // readContract still validates the owner/milestone and fails closed on damage.
  if (require('./forge-milestone-time').readContract({ cwd, milestone: options.milestone }).status === 'absent') {
    return { allowed: true, decision: 'no-contract' };
  }
  const unit = unitKey(options.unit), now = nowOf(options);
  // A paused boundary continues owner bookkeeping only. Transport never passes
  // this key and therefore cannot inherit the continuation's exception.
  require('./forge-milestone-time').timePaths({ cwd, milestone: options.milestone });
  const continuation = pausedContinuation(cwd, { ...options, unit });
  const observed = observeTime(cwd, options.milestone, { ...options, now }), s = observed.status;
  const details = { contract: s.contract, ceiling_ms: s.horizon?.ceiling_ms ?? null,
    consumed_ms: s.clocks?.consumed_ms ?? null, unknown_ms: s.clocks?.unknown_ms ?? null,
    remaining_ms: s.remaining_ms ?? null, open_writers: s.open_writers || [], state: s.state ?? null,
    unknowns: s.unknowns || [], diagnostic_command: observed.diagnostic || null };
  if (continuation) return { allowed: true, decision: 'boundary-continuation', details };
  if (s.contract === 'absent') return { allowed: true, decision: 'no-contract' };
  let reason;
  if (s.contract !== 'valid') reason = 'milestone-time-invalid';
  else if (observed.clock?.status !== 'measured') reason = 'milestone-clock-unknown';
  else if (s.remaining_ms <= 0) reason = s.open_writers.some(r => r.unit !== unit) ? 'milestone-budget-draining' : 'milestone-budget-exhausted';
  if (reason) return { allowed: false, reason_code: reason, details };
  return { allowed: true, decision: 'admitted', details, record: {
    decision: 'admitted', contract_version: observed.read.version, contract_sha256: observed.read.sha256,
    policy: observed.read.contract.clock_policy, consumed_ms: details.consumed_ms, unknown_ms: details.unknown_ms,
    ceiling_ms: details.ceiling_ms, at: new Date(now).toISOString() } };
}
function assertTransportEntry({ cwd, milestone, unit, now }) {
  let result;
  try { result = decideAdmission(cwd, { milestone, unit, now, kind: 'begin' }); }
  catch { result = { allowed: false, reason_code: 'milestone-time-invalid' }; }
  if (!result.allowed) throw Object.assign(new Error('Entrada recusada pelo contrato de tempo da milestone'), {
    code: result.reason_code, provider_called: false, stage: 'milestone-time-admission', layer: 'milestone-time-admission', details: result.details });
  return result;
}
// Explicit owner context is operational input, never an authorization. When a
// retained request exists, it determines the scope and cannot be overridden by
// a context pointing at another (possibly contract-free) milestone or owner.
function assertOwnerTransportEntry(options = {}) {
  const request = options.request || options.telemetryIdentity;
  const context = options.milestoneTimeContext;
  const milestoneRequest = request && (request.scope === 'milestone'
    || request.scope !== 'standalone-task' && request.milestoneId);
  if (context === undefined && !milestoneRequest) return;
  const invalid = () => { throw Object.assign(new Error('Contexto de tempo da milestone inválido'), {
    code: 'milestone-time-invalid', provider_called: false, stage: 'milestone-time-admission', layer: 'milestone-time-admission' }); };
  const retained = milestoneRequest ? { cwd: request.contextRoot || request.cwd, milestone: request.milestoneId,
    unit: request.unitType + '/' + (request.taskId || request.sliceId || request.milestoneId) } : null;
  const bound = context === undefined ? retained : context;
  try {
    if (!bound || typeof bound !== 'object' || Array.isArray(bound)
        || Object.keys(bound).some(key => !['cwd', 'milestone', 'unit'].includes(key))
        || !['cwd', 'milestone', 'unit'].every(key => typeof bound[key] === 'string' && bound[key])) invalid();
    if (request?.scope && !['milestone', 'standalone-task'].includes(request.scope)) invalid();
    if (context !== undefined && request && !milestoneRequest) invalid();
    if (retained && (fs.realpathSync(bound.cwd) !== fs.realpathSync(retained.cwd)
        || bound.milestone !== retained.milestone || bound.unit !== retained.unit)) invalid();
    if (options.contextRoot && fs.realpathSync(bound.cwd) !== fs.realpathSync(options.contextRoot)) invalid();
    return assertTransportEntry({ ...bound, now: options.now });
  } catch (error) {
    if (TRANSPORT_REFUSAL_CODES.includes(error.code)) throw error;
    invalid();
  }
}
function observeBoundary(cwd, milestone, options = {}) {
  const time = require('./forge-milestone-time'), input = { ...options, cwd, milestone, now: nowOf(options) };
  const current = time.readContract(input);
  if (current.status === 'absent') return { status: 'no-contract' };
  if (current.status !== 'valid') return { status: 'invalid', reason_code: 'milestone-time-invalid' };
  if (!['slice-boundary', 'blocked'].includes(options.kind)
      || options.kind === 'blocked' && !BLOCKED_REASONS.includes(options.reason)) return { status: 'ignored' };
  const clocks = require('./forge-milestone-time-clock');
  const deliveries = clocks.readHistoricalDeliveries(input), forecast = clocks.readForecast(input), clock = clocks.readClock(input);
  if (options.kind === 'slice-boundary' && (deliveries.status !== 'observed' || !deliveries.proven.length)) return { status: 'unchanged' };
  const proven = [...new Set((deliveries.proven || []).map(r => r.slice))].sort();
  const units = [...new Set((options.units || []).map(unitKey))].sort();
  if (units.length > MAX_WRITERS) return { status: 'invalid', reason_code: 'milestone-time-invalid' };
  const key = options.kind === 'slice-boundary' ? JSON.stringify(proven) : JSON.stringify([options.reason, units]);
  const listing = time.listWarnings(input);
  if (listing.status !== 'valid') return { status: 'invalid', reason_code: 'milestone-time-invalid' };
  const rows = warningRows(listing, current.version), last = rows.at(-1), classification = FORECAST_CLASSES.includes(forecast.status) ? forecast.status : 'unknown';
  const lastBoundary = rows.filter(r => r.kind === options.kind).at(-1);
  if (lastBoundary?.boundary_key === key && lastBoundary.classification === classification || last?.classification === classification) return { status: 'unchanged' };
  const id = hash(JSON.stringify([milestone, current.version, options.kind, key, classification]));
  const existing = rows.find(r => r.id === id); if (existing) return { status: 'unchanged', record: existing };
  const warning = ['at-risk', 'exceeds'].includes(classification);
  const record = { id, version: current.version, sequence: rows.length + 1, kind: options.kind, boundary_key: key,
    classification, warning, at: new Date(input.now).toISOString(), cause: reasonCode(forecast.reason),
    progress: { proof_kind: deliveries.proof_kind, current_integrated_acceptance: 'not-evaluated',
      proven_slices: proven, units: options.kind === 'blocked' ? units : [] },
    consumed_ms: clock.status === 'measured' ? clock.consumption.consumed_ms : null,
    remaining_ms: clock.status === 'measured' ? current.contract.ceiling_ms - clock.consumption.consumed_ms : null,
    alternatives: warning ? ['extend', 'reduce-scope', 'continue-to-cap'] : [] };
  const after = time.readContract(input);
  if (after.status !== 'valid' || after.version !== current.version || after.sha256 !== current.sha256) return { status: 'invalid', reason_code: 'milestone-time-invalid' };
  // recordWarning owns the canonical owner lock and immutable publication.
  // The owner calls this API only at serialized safe lifecycle boundaries.
  return { status: 'recorded', record: time.recordWarning({ ...input, record }).record };
}
function main(argv = process.argv.slice(2), io = process) {
  let cwd = '.', milestone, unit, operation, json = false;
  const seen = new Set();
  const invalid = () => { io.stderr.write('Uso inválido: informe operação, milestone e unidade quando necessária\n'); return 2; };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]; if (seen.has(arg)) return invalid(); seen.add(arg);
    if (arg === '--status' || arg === '--admit-transport') { if (operation) return invalid(); operation = arg; }
    else if (arg === '--json') json = true;
    else if (['--cwd', '--milestone', '--unit'].includes(arg)) {
      const value = argv[++i]; if (!value || value.startsWith('--')) return invalid();
      if (arg === '--cwd') cwd = value; else if (arg === '--milestone') milestone = value; else unit = value;
    } else return invalid();
  }
  if (!operation || !milestone || !json || operation === '--admit-transport' && !unit || operation === '--status' && unit) return invalid();
  try {
    require('./forge-milestone-time').timePaths({ cwd, milestone });
    if (unit) unitKey(unit);
  } catch { return invalid(); }
  try {
    const result = operation === '--status' ? readTimeStatus(cwd, milestone) : assertTransportEntry({ cwd, milestone, unit });
    io.stdout.write(JSON.stringify(result) + '\n'); return 0;
  } catch (error) {
    const result = { allowed: false, reason_code: TRANSPORT_REFUSAL_CODES.includes(error.code) ? error.code : 'milestone-time-invalid',
      provider_called: false, stage: 'milestone-time-admission', details: error.details || null };
    io.stdout.write(JSON.stringify(result) + '\n'); return 3;
  }
}
module.exports = { TIME_REASON_CODES, TRANSPORT_REFUSAL_CODES, ADMISSION_DECISIONS, TIME_STATES,
  decideAdmission, assertTransportEntry, assertOwnerTransportEntry, readTimeStatus, summarizeTimeStatus, observeBoundary, main };
if (require.main === module) process.exitCode = main();
