#!/usr/bin/env node
'use strict';

// Owner-side observed worker invocation evidence for milestone time contracts.
// A trusted live reader, created in-process by the host, only names sources;
// this module reads their bounded stable bytes, binds them to the committed
// unit/dispatch/request/root and publishes sanitized immutable records through
// the canonical time owner lock. Import is inert. It measures observed
// invocation wall duration (including documented host startup/transport), never
// CPU, active-LLM time or billing, and never falls back to controller unit time.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KINDS = Object.freeze(['native-supervision', 'sidecar-transport']);
const POLICY = Object.freeze({ id: 'forge-milestone-worker-observations', version: 1,
  basis: 'observed-invocation-wall-intervals',
  boundaries: Object.freeze({ 'native-supervision': 'native-supervised-invocation-start-to-terminal',
    'sidecar-transport': 'sidecar-transport-process-including-startup' }),
  excludes: Object.freeze(['cpu', 'active-llm', 'billing', 'owner-preparation', 'verification', 'publication', 'receipt-lifetime']) });
const LIMITATIONS = Object.freeze(['observed-invocation-wall-duration-including-startup-and-transport',
  'not-cpu-active-llm-or-billing', 'sidecar-receipt-lifetime-not-worker-time', 'parallel-invocations-summed']);
const COMPLETIONS = Object.freeze(['complete', 'consume-failure']);
const MAX_SOURCES = 64, MAX_NATIVE = 32768, MAX_RECEIPT = 1024 * 1024, MAX_ROOTS = 16;
const HASH = /^[a-f0-9]{64}$/;
const readers = new WeakMap();
function fail(code) { throw Object.assign(new Error(code), { code }); }
function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function digest(value) { return require('./forge-code-roots').digest(value); }
function object(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function exact(v, keys) { return object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k)); }
function instant(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)) return NaN;
  const t = Date.parse(v); return Number.isFinite(t) && new Date(t).toISOString() === v ? t : NaN;
}
function nowOf(options) { return typeof options.now === 'function' ? options.now() : options.now ?? Date.now(); }
function code(e, fallback) { return /^observation-[a-z0-9-]{1,80}$/.test(e?.code || '') ? e.code : fallback; }

// The host creates this capability in-process from its live adapters. Imported
// JSON, approval flags or a receipt path cannot construct or replace it.
function createObservationReader(read, options = {}) {
  if (typeof read !== 'function') fail('observation-reader-required');
  const roots = options.roots, { key } = require('./forge-code-roots');
  if (!Array.isArray(roots) || !roots.length || roots.length > MAX_ROOTS) fail('observation-roots-required');
  const trusted = roots.map(root => {
    if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) fail('observation-root-invalid');
    let real; try { real = fs.realpathSync.native(root); } catch { fail('observation-root-invalid'); }
    if (key(real) !== key(path.resolve(root)) || fs.lstatSync(root).isSymbolicLink() || !fs.statSync(real).isDirectory()) fail('observation-root-invalid');
    return real;
  });
  const handle = Object.freeze({}); readers.set(handle, Object.freeze({ read, roots: Object.freeze(trusted) })); return handle;
}
function trustedReader(handle) { return object(handle) && readers.has(handle); }

// Bounded stable bytes under one trusted physical root; no link anywhere below it.
function readSource(file, roots, limit) {
  const { key, within } = require('./forge-code-roots');
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) fail('observation-source-path-invalid');
  const resolved = path.resolve(file), root = roots.find(r => within(r, resolved) && key(r) !== key(resolved));
  if (!root) fail('observation-source-foreign-root');
  for (let cursor = resolved; key(cursor) !== key(root); cursor = path.dirname(cursor)) {
    let stat; try { stat = fs.lstatSync(cursor); } catch (e) { fail(e.code === 'ENOENT' ? 'observation-source-missing' : 'observation-source-unreadable'); }
    if (stat.isSymbolicLink()) fail('observation-source-link');
    if (cursor === resolved && !stat.isFile()) fail('observation-source-invalid');
  }
  let real; try { real = fs.realpathSync.native(resolved); } catch { fail('observation-source-unreadable'); }
  if (key(real) !== key(resolved)) fail('observation-source-link');
  const read = require('./forge-autonomy-sources').readBoundedStableFile(resolved, limit, { expectedReal: real });
  if (read.error) fail(read.error === 'source_too_large' ? 'observation-source-oversized' : 'observation-source-unstable');
  let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.buffer)); } catch { fail('observation-source-malformed'); }
  if (!object(value)) fail('observation-source-malformed');
  return { value, sha256: hash(read.buffer), bytes: read.buffer.length, root };
}
function chronology(start, end, ctx) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) fail('observation-time-invalid');
  if (end > ctx.now) fail('observation-time-future');
  if (start < ctx.begin_at) fail('observation-time-before-unit');
}
function record(ctx, kind, invocation, d, source, start, end, duration, extra) {
  const { key } = require('./forge-code-roots');
  return { schema_version: 1, id: digest(JSON.stringify([ctx.milestone, kind, invocation])), milestone: ctx.milestone, unit: ctx.unit,
    kind, invocation_sha256: invocation, dispatch_sha256: digest(d.dispatch_id), request_sha256: d.request_sha256,
    root_sha256: digest(key(source.root)), source: { kind: kind === 'native-supervision' ? 'native-journal' : 'sidecar-receipt',
      sha256: source.sha256, bytes: source.bytes }, started_at: new Date(start).toISOString(), finished_at: new Date(end).toISOString(),
    duration_ms: duration, ...extra, boundary: POLICY.boundaries[kind] };
}
// Work identity comes from the retained canonical request itself (the same
// fields owner transport admission binds), never from reader-declared labels.
function identity(d, keys, request, ctx) {
  if (!exact(d, keys) || !object(request)) fail('observation-descriptor-invalid');
  const dispatch = require('./forge-attempt-telemetry').dispatchCode(request.dispatchId);
  const unit = request.unitType + '/' + (request.taskId || request.sliceId || request.milestoneId);
  if (!dispatch || typeof request.unitType !== 'string') fail('observation-identity-invalid');
  if (request.scope === 'standalone-task' || request.milestoneId !== ctx.milestone || unit !== ctx.unit) fail('observation-work-mismatch');
  if (request.contextRoot !== undefined || request.cwd !== undefined) {
    const { key } = require('./forge-code-roots');
    let owner; try { owner = fs.realpathSync.native(request.contextRoot || request.cwd); } catch { fail('observation-root-mismatch'); }
    if (key(owner) !== key(ctx.owner)) fail('observation-root-mismatch');
  }
  return dispatch;
}
// Native: the supervision journal is the source; its identity is recomputed from
// the live invocation and request exactly as invokeNative supervised it. The
// live lifecycle must equal the journal bytes. final_evidence spans packaging
// too, so it only bounds the journal interval and is never the worker duration.
function native(d, ctx, roots) {
  const dispatch = identity(d, ['kind', 'file', 'invocation', 'telemetry_identity', 'lifecycle', 'final_evidence'], d?.telemetry_identity, ctx);
  if (!object(d.invocation)) fail('observation-descriptor-invalid');
  const expected = require('./forge-native-supervision').digest(JSON.stringify({ invocation: d.invocation, identity: d.telemetry_identity }));
  const { linkedEntryBinding: _ignored, ...wire } = d.telemetry_identity;
  d = { ...d, dispatch_id: dispatch, request_sha256: digest(wire) };
  const source = readSource(d.file, roots, MAX_NATIVE), j = source.value, l = d.lifecycle;
  if (j.schema_version !== 1 || j.identity !== expected) fail('observation-identity-mismatch');
  if (j.host_identity && j.host_identity.dispatch_id !== dispatch) fail('observation-dispatch-mismatch');
  if (!['terminal', 'interrupted'].includes(j.phase)) fail('observation-nonterminal');
  if (!object(l) || l.identity !== j.identity || l.phase !== j.phase || l.start_wall_ms !== j.start_wall_ms || l.last_wall_ms !== j.last_wall_ms) fail('observation-source-changed');
  const start = j.start_wall_ms, end = j.last_wall_ms; chronology(start, end, ctx);
  const total = d.final_evidence?.duration_ms;
  if (!Number.isSafeInteger(total) || total < 0 || total + 1000 < end - start) fail('observation-duration-inconsistent');
  const terminal = j.phase === 'terminal', provider = terminal ? true : j.provider_called === true ? true : j.provider_called === false ? false : 'unknown';
  // Persisted bytes cannot prove a zero-call refusal; only the live witness can.
  if (provider === false) fail('observation-not-invoked-unwitnessed');
  return { observation: record(ctx, 'native-supervision', j.identity, d, source, start, end, end - start,
    { placement: 'exact', bound: terminal ? 'complete' : 'lower', terminal: j.phase, provider_called: provider }), recheck: () => readSource(d.file, roots, MAX_NATIVE).sha256 === source.sha256 };
}
// Sidecar: the receipt lifetime includes owner preparation, verification and
// publication. Only the transport process duration (startup included) counts,
// contained in the receipt window. A verification-only successor clones its
// parent and resolves to the same parent invocation, never a new interval.
function sidecar(d, ctx, roots) {
  const keys = ['kind', 'file', 'request'];
  const dispatch = identity(d, Object.hasOwn(d || {}, 'parent_file') ? [...keys, 'parent_file'] : keys, d?.request, ctx);
  let fingerprint; try { fingerprint = require('./forge-unit-sidecar').artifactFingerprint(d.request); } catch { fail('observation-identity-invalid'); }
  d = { ...d, dispatch_id: dispatch, request_fingerprint: fingerprint, request_sha256: digest(fingerprint) };
  let source = readSource(d.file, roots, MAX_RECEIPT), r = source.value, successor = false;
  const checks = [[d.file, source.sha256]];
  if (r.dispatch_id !== d.dispatch_id || r.fingerprint !== d.request_fingerprint) fail('observation-identity-mismatch');
  if (r.verification_successor !== undefined) {
    const info = r.verification_successor;
    if (!object(info) || info.provider_called !== false || !HASH.test(info.parent_receipt_sha256 || '')) fail('observation-successor-invalid');
    if (typeof d.parent_file !== 'string') fail('observation-successor-parent-unavailable');
    source = readSource(d.parent_file, roots, MAX_RECEIPT); r = source.value; successor = true; checks.push([d.parent_file, source.sha256]);
    if (source.sha256 !== info.parent_receipt_sha256 || r.verification_successor !== undefined
        || r.dispatch_id !== d.dispatch_id || r.fingerprint !== d.request_fingerprint) fail('observation-successor-parent-mismatch');
  } else if (d.parent_file !== undefined) fail('observation-descriptor-invalid');
  const o = r.telemetry?.observation;
  if (!object(o) || o.version !== 1 || !Number.isSafeInteger(o.transport_ms)) fail('observation-boundary-unavailable');
  if (!['closed', 'terminal'].includes(o.phase) || o.process_exit_observed !== true) fail('observation-nonterminal');
  const start = instant(r.started_at), lifetime = r.final_evidence?.duration_ms;
  if (!Number.isFinite(start) || !Number.isSafeInteger(lifetime)) fail('observation-time-invalid');
  if (o.transport_ms < 0 || !Number.isSafeInteger(o.elapsed_ms) || o.transport_ms > o.elapsed_ms || o.elapsed_ms > lifetime + 1000) fail('observation-duration-inconsistent');
  chronology(start, start + lifetime, ctx);
  const invocation = digest(JSON.stringify([d.dispatch_id, d.request_fingerprint, r.started_at]));
  return { successor, observation: record(ctx, 'sidecar-transport', invocation, d, source, start, start + lifetime, o.transport_ms,
    { placement: 'contained', bound: 'complete', terminal: 'terminal', provider_called: r.provider_called === true ? true : 'unknown' }),
  recheck: () => checks.every(([file, sha]) => readSource(file, roots, MAX_RECEIPT).sha256 === sha) };
}
function observe(d, ctx, roots) {
  if (d?.kind === 'native-not-invoked') {
    identity(d, ['kind', 'outcome', 'telemetry_identity'], d?.telemetry_identity, ctx);
    // Process-local zero-call witness minted by invokeNative; clones carry none.
    const witness = require('./forge-native-invocation').notInvokedWitness(d.outcome);
    const { linkedEntryBinding: _ignored, ...wire } = d.telemetry_identity;
    if (!witness || witness.provider_called !== false || witness.host_callbacks !== 0) fail('observation-not-invoked-unwitnessed');
    if (witness.request_sha256 !== digest(wire)) fail('observation-work-mismatch');
    return { not_invoked: true };
  }
  if (d?.kind === 'native-supervision') return native(d, ctx, roots);
  if (d?.kind === 'sidecar-transport') return sidecar(d, ctx, roots);
  fail('observation-kind-unsupported');
}
function validObservation(r) {
  if (!exact(r, ['schema_version', 'id', 'milestone', 'unit', 'kind', 'invocation_sha256', 'dispatch_sha256', 'request_sha256', 'root_sha256',
    'source', 'started_at', 'finished_at', 'duration_ms', 'placement', 'bound', 'terminal', 'provider_called', 'boundary'])) return false;
  const start = instant(r.started_at), end = instant(r.finished_at);
  return r.schema_version === 1 && KINDS.includes(r.kind) && [r.id, r.invocation_sha256, r.dispatch_sha256, r.request_sha256, r.root_sha256].every(v => HASH.test(v || ''))
    && r.id === digest(JSON.stringify([r.milestone, r.kind, r.invocation_sha256])) && typeof r.unit === 'string' && /^[a-z][a-z0-9-]{1,50}\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(r.unit)
    && exact(r.source, ['kind', 'sha256', 'bytes']) && HASH.test(r.source.sha256 || '') && Number.isSafeInteger(r.source.bytes) && r.source.bytes > 0
    && Number.isFinite(start) && Number.isFinite(end) && end >= start && Number.isSafeInteger(r.duration_ms) && r.duration_ms >= 0
    && (r.placement === 'exact' ? r.duration_ms === end - start : r.placement === 'contained' && r.duration_ms <= end - start)
    && ['complete', 'lower'].includes(r.bound) && ['terminal', 'interrupted'].includes(r.terminal) && [true, 'unknown'].includes(r.provider_called)
    && r.boundary === POLICY.boundaries[r.kind];
}
function validCoverage(r) {
  return exact(r, ['schema_version', 'id', 'milestone', 'unit', 'begin_sha256', 'completion', 'coverage', 'inventory', 'observations', 'not_invoked', 'successors', 'refused', 'reader'])
    && r.schema_version === 1 && HASH.test(r.id || '') && HASH.test(r.begin_sha256 || '') && COMPLETIONS.includes(r.completion)
    && ['complete', 'partial'].includes(r.coverage) && ['complete', 'partial'].includes(r.inventory) && r.reader === 'trusted-live'
    && Array.isArray(r.observations) && r.observations.length <= MAX_SOURCES && r.observations.every(v => HASH.test(v))
    && Number.isSafeInteger(r.not_invoked) && r.not_invoked >= 0 && Number.isSafeInteger(r.successors) && r.successors >= 0
    && Array.isArray(r.refused) && r.refused.length <= MAX_SOURCES && r.refused.every(v => /^observation-[a-z0-9-]{1,80}$/.test(v));
}

// Safe owner boundary only: after the controller committed the unit's terminal
// transaction (writers reconciled, lease released) and before the next unit.
// The provider is never invoked here; a missing reader leaves coverage unknown.
function observeCompletion(options) {
  const time = require('./forge-milestone-time'), base = { cwd: options.cwd, milestone: options.milestone };
  const contract = time.readContract(base);
  if (contract.status === 'absent') return { status: 'no-contract' };
  if (contract.status !== 'valid') return { status: 'unknown', reason: 'observation-contract-invalid' };
  const entry = trustedReader(options.reader) ? readers.get(options.reader) : null;
  if (!entry) return { status: 'unknown', reason: 'observation-reader-unavailable', limitation: 'host-supplied-no-trusted-live-reader' };
  if (!COMPLETIONS.includes(options.completion)) return { status: 'unknown', reason: 'observation-completion-unbound' };
  const controller = require('./forge-unit-controller');
  if (controller.pendingTransactions(options.cwd).length) return { status: 'deferred', reason: 'observation-protected-writer-window' };
  const begin = controller.lookupRecord(options.cwd, 'transaction', options.begin_key);
  const done = controller.lookupRecord(options.cwd, 'transaction', options.completion_key);
  if (!begin || begin.action !== 'begin' || begin.phase !== 'committed' || begin.milestone !== options.milestone || begin.unit?.key !== options.unit
      || !done || done.phase !== 'committed' || done.action === 'begin' || done.milestone !== options.milestone || done.unit?.key !== options.unit
      || done.lease_generation !== begin.lease_generation) return { status: 'unknown', reason: 'observation-completion-unbound' };
  const ctx = Object.freeze({ milestone: options.milestone, unit: options.unit, begin_key: options.begin_key, owner: fs.realpathSync.native(options.cwd),
    begin_at: instant(begin.created_at), now: nowOf(options), completion: options.completion });
  if (!Number.isFinite(ctx.begin_at) || !Number.isSafeInteger(ctx.now) || ctx.now < ctx.begin_at) return { status: 'unknown', reason: 'observation-time-invalid' };
  let reported; try { reported = entry.read(structuredClone(ctx)); } catch { return { status: 'unknown', reason: 'observation-reader-failed' }; }
  if (!object(reported) || !['complete', 'partial'].includes(reported.inventory) || !Array.isArray(reported.sources)
      || reported.sources.length > MAX_SOURCES) return { status: 'unknown', reason: 'observation-inventory-invalid' };
  const found = new Map(), conflicts = new Set(), refused = [], rechecks = [];
  let notInvoked = 0, successors = 0;
  for (const descriptor of reported.sources) {
    try {
      const result = observe(descriptor, ctx, entry.roots);
      if (result.not_invoked) { notInvoked++; continue; }
      if (result.successor) successors++;
      rechecks.push(result.recheck);
      const previous = found.get(result.observation.id);
      if (previous && digest(previous) !== digest(result.observation)) conflicts.add(result.observation.id);
      found.set(result.observation.id, result.observation);
    } catch (e) { refused.push(code(e, 'observation-source-unreadable')); }
  }
  for (const id of conflicts) { found.delete(id); refused.push('observation-duplicate-conflict'); }
  // Any source that changed after validation voids the whole batch.
  let stable; try { stable = rechecks.every(check => check()); } catch { stable = false; }
  if (!stable) { refused.push('observation-source-mutated'); found.clear(); }
  if (!reported.sources.length) refused.push('observation-inventory-empty');
  const observations = [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
  const complete = reported.inventory === 'complete' && !refused.length && observations.every(r => r.bound === 'complete');
  const coverage = { schema_version: 1, id: digest(JSON.stringify([options.milestone, options.unit, options.begin_key])),
    milestone: options.milestone, unit: options.unit, begin_sha256: digest(options.begin_key), completion: options.completion,
    coverage: complete ? 'complete' : 'partial', inventory: reported.inventory, observations: observations.map(r => r.id),
    not_invoked: notInvoked, successors, refused: [...new Set(refused)].sort(), reader: 'trusted-live' };
  try {
    const written = time.recordWorkerEvidence({ ...base, observations, coverage });
    return { status: 'recorded', coverage: coverage.coverage, observations: observations.length, observed_ms: observations.reduce((s, r) => s + r.duration_ms, 0),
      not_invoked: notInvoked, successors, refused: coverage.refused, published: written.published, unchanged: written.unchanged };
  } catch (e) { return { status: 'unknown', reason: e.code === 'time-record-conflict' ? 'observation-record-conflict' : e.code === 'time-record-limit' ? 'observation-record-limit' : 'observation-publication-refused' }; }
}

// Read-only, bounded projection of the persisted immutable records.
function readWorkerEvidence(options) {
  const time = require('./forge-milestone-time');
  const observations = time.readObservations(options), coverage = time.readCoverage(options);
  if (observations.status === 'no-contract') return { status: 'no-contract' };
  if (observations.status !== 'valid' || coverage.status !== 'valid') return { status: 'unknown', reason: 'observation-record-unreadable' };
  if (!observations.records.every(r => validObservation(r) && r.milestone === options.milestone)
      || !coverage.records.every(r => validCoverage(r) && r.milestone === options.milestone)) return { status: 'unknown', reason: 'observation-record-invalid' };
  return { status: 'valid', observations: observations.records, coverage: coverage.records,
    sha256: digest(JSON.stringify([observations.records, coverage.records])), records: observations.records.length + coverage.records.length };
}

// Pure: parallel invocation durations are summed. Controller units only decide
// coverage; their duration is never reassigned to workers.
function projectWorkerEffort(input) {
  const { start, now, units = [], open = [], ambiguous = [], evidence } = input || {};
  const output = { status: 'unknown', reason: 'worker-evidence-absent', basis: POLICY.basis, worker_ms: null, observed_worker_ms: null,
    invocations: 0, coverage: { units: units.length, covered: 0, partial: 0, unobserved: units.length, open_units: open.length,
      ambiguous_units: ambiguous.length }, policy: POLICY, limitations: [...LIMITATIONS] };
  if (evidence?.status !== 'valid') return { ...output, reason: evidence?.reason || output.reason };
  const counted = new Map();
  for (const r of evidence.observations) {
    const a = instant(r.started_at), b = instant(r.finished_at);
    if (b > now) continue;
    if (a < start) { if (!output.limitations.includes('observation-before-activation-excluded')) output.limitations.push('observation-before-activation-excluded'); continue; }
    counted.set(r.id, r);
  }
  let covered = 0, partial = 0;
  for (const unit of units) {
    const row = typeof unit.begin_key === 'string'
      ? evidence.coverage.find(r => r.unit === unit.unit && r.begin_sha256 === digest(unit.begin_key)) : null;
    if (!row) continue;
    if (row.coverage === 'complete' && row.observations.every(id => counted.has(id))) covered++; else partial++;
  }
  const observed = [...counted.values()].reduce((sum, r) => sum + r.duration_ms, 0);
  const complete = units.length > 0 && covered === units.length && !open.length && !ambiguous.length;
  return { ...output, status: complete ? 'complete' : counted.size ? 'partial' : 'unknown',
    reason: complete ? 'observed-coverage-complete' : counted.size ? 'observed-coverage-incomplete' : output.reason,
    worker_ms: complete ? observed : null, observed_worker_ms: complete || counted.size ? observed : null, invocations: counted.size,
    coverage: { ...output.coverage, covered, partial, unobserved: units.length - covered - partial } };
}
// Bounded public projection for orchestrator results; no paths or raw identities.
function publicResult(result) {
  const keys = ['status', 'reason', 'limitation', 'coverage', 'observations', 'observed_ms', 'not_invoked', 'successors', 'refused', 'published', 'unchanged'];
  return Object.fromEntries(keys.filter(k => result?.[k] !== undefined).map(k => [k, Array.isArray(result[k]) ? result[k].slice(0, MAX_SOURCES) : result[k]]));
}

module.exports = { POLICY, LIMITATIONS, KINDS, createObservationReader, trustedReader, observeCompletion, readWorkerEvidence,
  projectWorkerEffort, publicResult, validObservation, validCoverage };
