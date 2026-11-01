#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const DRAIN_STATES = Object.freeze(['not-applicable', 'draining', 'drained', 'incomplete-unknown']);
const WRITER_CLASSES = Object.freeze(['terminal', 'healthy', 'dead-requires-failure-consumption',
  'saved-response-requires-publication', 'unknown']);
const MAX_WRITERS = 256, MAX_RECORDS = 4096, MAX_FILE = 1024 * 1024;
const TERMINAL_KINDS = ['completed', 'failed-persisted', 'paused', 'expired-safe'];
function fail(code) { throw Object.assign(new Error(code), { code }); }
function nowOf(options) {
  const now = typeof options.now === 'function' ? options.now() : options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) fail('time-drain-clock-invalid');
  return now;
}
function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function noLinks(file) {
  for (let cursor = path.resolve(file);;) {
    try { if (fs.lstatSync(cursor).isSymbolicLink()) fail('time-drain-source-link'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
// Canonical bounded/stable reads precede APIs whose legacy readers are unbounded.
// Rechecking the exact observed sources catches a concurrent publication without
// persisting an intermediate drain state or trusting timestamps as authorship.
function sourceReader() {
  const observed = new Map(), directories = new Map();
  let totalBytes = 0;
  function read(file, max = MAX_FILE) {
    noLinks(file); let bytes = null;
    try {
      const result = require('./forge-autonomy-sources').readBoundedStableFile(file, max,
        { expectedReal: fs.realpathSync.native(file) });
      if (result.error) fail('time-drain-source-unreadable'); bytes = result.buffer;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const fingerprint = bytes === null ? null : hash(bytes);
    if (observed.has(file) && observed.get(file).hash !== fingerprint) fail('time-drain-source-unstable');
    if (!observed.has(file)) { totalBytes += bytes?.length || 0; if (totalBytes > 8 * MAX_FILE) fail('time-drain-source-limit'); }
    observed.set(file, { hash: fingerprint, max }); return bytes;
  }
  function names(dir) {
    noLinks(dir); let names = [];
    try { names = fs.readdirSync(dir).sort(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (names.length > MAX_RECORDS) fail('time-drain-record-limit');
    const value = JSON.stringify(names);
    if (directories.has(dir) && directories.get(dir) !== value) fail('time-drain-source-unstable');
    directories.set(dir, value); return names;
  }
  function record(cwd, kind, key) {
    const controller = require('./forge-unit-controller');
    const file = kind === 'boundary' ? controller.boundaryFile(cwd, key)
      : kind === 'transaction' ? controller.transactionFile(cwd, key) : controller.resultFile(cwd, key);
    read(file);
    const legacy = Buffer.from(key).toString('base64url') + '.json';
    if (legacy.length <= 255) read(path.join(path.dirname(file), legacy));
    return controller.lookupRecord(cwd, kind, key);
  }
  return { read, names, record, recheck() {
    for (const [file, entry] of observed) read(file, entry.max);
    for (const dir of directories.keys()) names(dir);
  } };
}
function unitKey(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{1,50}\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(value)) fail('time-drain-unit-invalid');
  return value;
}
function classifyAttempt(cwd, milestone, row, options, sources) {
  const unknown = reason => ({ classification: 'unknown', state: 'inspection-required', reason });
  if (row.ambiguous) return unknown('ambiguous-begins');
  if (row.start > options.now) return unknown('begin-in-future');
  if (!row.begin_key) return unknown('begin-record-missing');
  const begin = sources.record(cwd, 'transaction', row.begin_key);
  if (!begin || begin.action !== 'begin' || begin.milestone !== milestone || begin.unit?.key !== row.unit
      || begin.host_runtime !== row.host || Date.parse(begin.created_at) !== row.start) return unknown('begin-record-mismatch');
  const boundary = row.end_key ? sources.record(cwd, 'transaction', row.end_key)?.boundary
    : sources.record(cwd, 'boundary', row.unit);
  if (boundary?.milestone === milestone && boundary.unit === row.unit && boundary.handoff_ready === true
      && TERMINAL_KINDS.includes(boundary.kind) && Date.parse(boundary.committed_at) >= row.start) {
    const transaction = sources.record(cwd, 'transaction', boundary.idempotency_key);
    if (transaction?.phase === 'committed' && transaction.milestone === milestone && transaction.unit?.key === row.unit
        && transaction.lease_generation === begin.lease_generation && transaction.host_runtime === begin.host_runtime
        && JSON.stringify(transaction.boundary) === JSON.stringify(boundary)) {
      return { classification: 'terminal', state: 'reconciled', reason: 'terminal-boundary', outcome: boundary.outcome };
    }
  }
  if (row.end !== undefined && row.end !== null) return unknown('terminal-boundary-unverified');
  if (typeof options.inspectAttempt !== 'function' || typeof options.processProbe !== 'function') return unknown('host-inspector-required');
  const context = options.inspectAttempt({ cwd, begin: structuredClone(begin), references: {} });
  if (!context || typeof context.receipt_path !== 'string' || !context.request) return unknown('attempt-evidence-missing');
  if (!sources.read(context.receipt_path)) return unknown('receipt-missing');
  const recovery = require('./forge-attempt-recovery');
  const request = recovery.canonicalRequest(context.request), identity = recovery.requestIdentity(request);
  if (`${identity.unit_type}/${identity.task_id || identity.slice_id || identity.milestone_id}` !== row.unit
      || identity.milestone_id !== milestone || identity.host !== begin.host_runtime
      || identity.slice_id && identity.slice_id !== begin.after.state.active_slice) return unknown('attempt-identity-mismatch');
  let probe = 'unknown';
  const inspection = recovery.inspectReceipt(context.receipt_path, { request: context.request,
    processProbe: receipt => { probe = options.processProbe(receipt); return probe; } });
  const receipt = inspection.receipt, digest = require('./forge-code-roots').digest;
  if (receipt.recovery_identity_sha256 && receipt.recovery_identity_sha256 !== digest(identity)
      || receipt.fingerprint && receipt.fingerprint !== require('./forge-unit-sidecar').artifactFingerprint(context.request)
      || !receipt.recovery_identity_sha256 && !receipt.fingerprint) return unknown('receipt-identity-mismatch');
  if (!['alive', 'stopped'].includes(probe)) return unknown('process-probe-unknown');
  if (inspection.process_stopped !== true) {
    const pid = receipt.process_pid || receipt.pid;
    if (probe !== 'alive' && !(Number.isInteger(pid) && pid > 0)) return unknown('process-probe-unknown');
    const timeout = require('./forge-worker-timeout');
    const window = timeout.protectedWindowMs(timeout.ceilingFromRoute(request.route).ms);
    return { classification: 'healthy', state: 'waiting-own-ceiling', reason: 'process-alive',
      bound_at: new Date(row.start + window.duration_ms).toISOString(), bound_covers_ceiling: window.covers };
  }
  if (inspection.valid_saved_response) return { classification: 'saved-response-requires-publication',
    state: 'original-publication-required', reason: 'saved-response-replay-required' };
  if (['failed', 'abandoned'].includes(inspection.phase) && typeof receipt.failure?.reason_code === 'string'
      && receipt.failure.reason_code.trim()) return { classification: 'dead-requires-failure-consumption',
    state: 'failure-consumption-required', reason: 'existing-consume-failure-required' };
  return unknown('terminal-failure-unverified');
}
function inspectDrain(cwd, milestone, options = {}) {
  const time = require('./forge-milestone-time'), input = { cwd, milestone }, now = nowOf(options);
  // timePaths validates identity even on an absent contract. Public projections
  // contain logical references only, never owner/session/receipt paths.
  time.timePaths(input);
  const contract = time.readContract(input), base = { state: 'incomplete-unknown', contract: contract.status,
    contract_version: contract.version ?? null, ceiling_ms: null, consumed_ms: null, unknown_ms: null,
    writers: [], open_begins: 0, ambiguous_groups: 0, pending_transactions: 0, claim: 'unknown', unknowns: [] };
  if (contract.status === 'absent') return { ...base, state: 'not-applicable', reason: 'no-contract', claim: 'absent' };
  if (contract.status !== 'valid') return { ...base, reason: 'milestone-time-invalid', unknowns: ['milestone-time-invalid'] };
  const status = require('./forge-milestone-time-admission').readTimeStatus(cwd, milestone, { now });
  base.ceiling_ms = contract.contract.ceiling_ms;
  if (status.contract !== 'valid' || status.contract_version !== contract.version
      || !Number.isSafeInteger(status.clocks?.consumed_ms)) return { ...base, reason: 'milestone-clock-unknown', unknowns: ['milestone-clock-unknown'] };
  base.consumed_ms = status.clocks.consumed_ms; base.unknown_ms = status.clocks.unknown_ms;
  if (base.consumed_ms < base.ceiling_ms) return { ...base, state: 'not-applicable', reason: 'not-exhausted', claim: 'not-inspected' };
  const sources = sourceReader();
  try {
    const phase = require('./forge-phase-cost'), controller = require('./forge-unit-controller'), lease = require('./forge-unit-lease');
    const events = phase.analyzeEventIntervals(sources.read(path.join(cwd, '.gsd/milestones', milestone,
      milestone + '-events.jsonl'), phase.MAX_BYTES) || Buffer.alloc(0));
    if (events.milestones.some(id => id !== milestone)) fail('time-drain-event-scope-invalid');
    const txdir = path.join(cwd, '.gsd/forge/transactions');
    for (const name of sources.names(txdir)) if (name.endsWith('.json')) sources.read(path.join(txdir, name));
    const pending = controller.pendingTransactions(cwd).filter(row => row.milestone === milestone);
    base.pending_transactions = pending.length; base.open_begins = events.open.length;
    base.ambiguous_groups = events.ambiguous.length;
    const rows = [...events.open.map(r => ({ ...r, source: 'open-begin' })),
      ...events.ambiguous.map(r => ({ ...r, start: Math.min(...r.starts), begin_key: null, ambiguous: true, source: 'ambiguous-begins' })),
      ...events.intervals.map(r => ({ ...r, source: 'terminal-event' }))];
    for (const tx of pending) if (!rows.some(r => r.begin_key === tx.idempotency_key || r.end_key === tx.idempotency_key)) {
      rows.push({ unit: tx.unit.key, host: tx.host_runtime, start: Date.parse(tx.created_at),
        begin_key: tx.action === 'begin' ? tx.idempotency_key : null, source: 'pending-transaction' });
    }
    // A crash may leave a lease before event publication. Inspect its canonical
    // request transaction as well; an unassignable lease is possible ownership,
    // never evidence that this milestone has no writers.
    const leaseDir = lease.leasesDir(cwd);
    for (const name of sources.names(leaseDir).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const file = path.join(leaseDir, name); sources.read(file);
      const observed = lease.readLease(file);
      if (observed.corrupt || !observed.record || !lease.validRecord(observed.record, observed.record.unit)) fail('time-drain-lease-unattributed');
      const tx = observed.record.request_id && sources.record(cwd, 'transaction', observed.record.request_id);
      if (!tx) fail('time-drain-lease-unattributed');
      if (tx.milestone === milestone && !rows.some(row => row.unit === tx.unit.key)) rows.push({ unit: tx.unit.key,
        host: tx.host_runtime, start: Date.parse(tx.created_at), begin_key: tx.action === 'begin' ? tx.idempotency_key : null,
        source: 'retained-lease' });
    }
    if (rows.length > MAX_WRITERS) fail('time-drain-writer-limit');
    for (const row of rows) {
      unitKey(row.unit); sources.read(lease.leaseFile(cwd, row.unit));
      const observed = lease.observe(cwd, row.unit, { now });
      let classification;
      try { classification = classifyAttempt(cwd, milestone, row, { ...options, now }, sources); }
      catch { classification = { classification: 'unknown', state: 'inspection-required', reason: 'attempt-source-unreadable' }; }
      if (!observed.ok || observed.corrupt) classification = { classification: 'unknown', state: 'inspection-required', reason: 'lease-unreadable' };
      // A retained lease remains possible ownership even after its wall-clock
      // expiry or a terminal event. Only the existing owner may reconcile it.
      if (classification.classification === 'terminal' && observed.lease) classification = {
        classification: 'unknown', state: 'inspection-required', reason: 'terminal-lease-retained' };
      base.writers.push({ unit: row.unit, begin_key: row.begin_key, source: row.source,
        ...classification, lease: { present: !!observed.lease, reason: observed.reason } });
    }
    const runFile = path.join(cwd, '.gsd/forge/runs', milestone + '.json'), bytes = sources.read(runFile);
    const run = require('./forge-runs').get(cwd, milestone);
    if (bytes && (!run || run.id !== milestone || run.kind !== 'milestone')) fail('time-drain-run-invalid');
    // Read the persisted slot: runs.get supplies compatibility defaults that
    // would turn malformed empty strings into absence. Only the canonical
    // release validator may establish that an existing claim ended.
    const rawClaim = bytes ? JSON.parse(bytes).write_claim : undefined;
    base.claim = rawClaim === null || rawClaim === undefined ? 'absent'
      : require('./forge-write-claim').isHeld(rawClaim) ? 'held' : 'released';
    sources.recheck();
    const after = time.readContract(input);
    if (after.status !== 'valid' || after.version !== contract.version || after.sha256 !== contract.sha256) fail('time-drain-source-unstable');
    if (base.writers.some(row => row.classification === 'unknown')) base.unknowns.push('writer-unknown');
    base.state = base.unknowns.length ? 'incomplete-unknown'
      : base.open_begins || base.ambiguous_groups || pending.length || base.claim === 'held'
        || base.writers.some(row => row.classification !== 'terminal') ? 'draining' : 'drained';
    return base;
  } catch (error) {
    const reason = /^time-drain-[a-z-]+$/.test(error.code) ? error.code : 'time-drain-source-unreadable';
    return { ...base, state: 'incomplete-unknown', reason, unknowns: [...new Set([...base.unknowns, reason])] };
  }
}
function refusal(drain) {
  if (drain.reason === 'no-contract') return { status: 'no-contract' };
  if (drain.reason === 'not-exhausted') return { status: 'not-exhausted', reason_code: 'time-drain-not-exhausted' };
  return { status: 'not-drained', reason_code: 'time-drain-incomplete', drain };
}
function crashpoint(options, name) { if (options.failpoint?.(name)) fail('time-drain-crashpoint'); }
function checkpointIfDrained(cwd, milestone, options = {}) {
  const before = inspectDrain(cwd, milestone, options);
  if (before.state !== 'drained') return refusal(before);
  const time = require('./forge-milestone-time'), lock = require('./forge-lock');
  noLinks(path.join(cwd, '.gsd/.locks')); noLinks(path.join(cwd, '.gsd/forge'));
  // Use the controller's real mutex and the run writer's real lock. Neither is
  // a unit lease. New begins and claim mutations cannot interleave publication.
  const controllerLock = lock.acquireProcessSync(cwd, 'unit-controller-transactions', { retries: 80, ttlMs: 10000 });
  let runLock;
  try {
    runLock = lock.acquireSync(cwd, 'run-' + milestone, { holderRunId: milestone, retries: 80 });
    const current = inspectDrain(cwd, milestone, options);
    if (current.state !== 'drained') return refusal(current);
    const input = { cwd, milestone }, contract = time.readContract(input), listing = time.readCheckpoints(input);
    if (contract.status !== 'valid' || contract.version !== current.contract_version || listing.status !== 'valid') fail('time-drain-checkpoint-invalid');
    const state = require('./forge-state'), stateFile = state.statePath(cwd, milestone);
    noLinks(stateFile); const sources = sourceReader();
    if (!sources.read(stateFile) || !state.read(cwd, milestone)) fail('time-drain-state-missing');
    const prior = listing.records.find(row => row.version === contract.version);
    const question = 'Estender por emenda explícita ou encerrar como parcial/abandonada pelo lifecycle existente?';
    const id = 'time-cap-' + hash(milestone).slice(0, 16) + '-v' + contract.version;
    const record = prior || { kind: 'time-drain', version: contract.version, at: new Date(nowOf(options)).toISOString(),
      contract_sha256: contract.sha256, ceiling_ms: current.ceiling_ms, consumed_ms: current.consumed_ms,
      unknown_ms: current.unknown_ms, overshoot_ms: Math.max(0, current.consumed_ms - current.ceiling_ms),
      drain: { state: 'drained', writers: current.writers, open_begins: 0, ambiguous_groups: 0, pending_transactions: 0, claim: current.claim },
      decision_pending: true, pending_decision: { id, question }, next_action: id + ': ' + question };
    if (record.kind !== 'time-drain' || record.contract_sha256 !== contract.sha256 || record.drain?.state !== 'drained'
        || !Array.isArray(record.drain.writers) || record.drain.writers.some(row => row.classification !== 'terminal')
        || record.drain.open_begins !== 0 || record.drain.ambiguous_groups !== 0 || record.drain.pending_transactions !== 0
        || !['absent', 'released'].includes(record.drain.claim) || record.ceiling_ms !== contract.contract.ceiling_ms
        || !Number.isSafeInteger(record.consumed_ms) || record.consumed_ms < record.ceiling_ms
        || !Number.isSafeInteger(record.unknown_ms) || record.unknown_ms < 0 || record.unknown_ms > record.consumed_ms
        || record.overshoot_ms !== record.consumed_ms - record.ceiling_ms || !Number.isFinite(Date.parse(record.at))
        || record.pending_decision?.id !== id
        || record.pending_decision.question !== question || record.next_action !== id + ': ' + question
        || record.decision_pending !== true) fail('time-drain-checkpoint-conflict');
    if (!prior) time.recordCheckpoint({ ...input, record });
    crashpoint(options, 'after-record');
    if (state.read(cwd, milestone).next_action !== record.next_action) state.updateFields(cwd, milestone, { next_action: record.next_action });
    crashpoint(options, 'after-state');
    const personal = require('./forge-personal-context'), reference = `.gsd/forge/time/${milestone}/checkpoints/${record.version}.json`;
    const personalOptions = { cwd, id: milestone, userHome: options.userHome, env: options.env };
    const snapshot = personal.readPersonalSnapshot(personalOptions);
    if (snapshot.status !== 'ok') fail('time-drain-personal-unreadable');
    const work = snapshot.works.find(row => row.id === milestone); let personalStatus = 'not-bound';
    if (work) {
      const key = require('./forge-code-roots').key;
      const sourceKey = key(fs.realpathSync(path.resolve(cwd, reference)));
      // Keep other real pending decisions and their exact current sources. A
      // changed old source needs reconciliation, never a fresh hash by accident.
      const pending = work.checkpoint.pending || [];
      if (pending.some(row => row.validity !== 'current')) fail('time-drain-personal-reconciliation-required');
      const preserved = pending.filter(row => key(row.source) !== sourceKey)
        .map(row => ({ text: row.text, source: row.source, resolved: row.resolved }));
      const captures = { pending: [...preserved, { text: id + ': ' + question, source: reference }],
        nextAction: [{ text: record.next_action, source: reference }] };
      const matches = Object.entries(captures).every(([field, entries]) => {
        const old = work.checkpoint[field];
        return old?.length === entries.length && entries.every((entry, index) => old[index].text === entry.text
          && key(old[index].source) === key(fs.realpathSync(path.resolve(cwd, entry.source)))
          && old[index].validity === 'current' && old[index].resolved === (entry.resolved === true));
      });
      if (!matches && personal.saveCheckpoint({ ...personalOptions, intent: 'checkpoint', checkpoint: captures }).status !== 'ok') fail('time-drain-personal-write-failed');
      personalStatus = 'saved';
    }
    crashpoint(options, 'after-personal');
    return { status: 'checkpointed', record, reference, personal: personalStatus };
  } finally { if (runLock) runLock.release(); controllerLock.release(); }
}
function main(argv = process.argv.slice(2), io = process, liveOptions = {}) {
  let action; const options = {};
  try {
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (['--inspect', '--checkpoint'].includes(flag)) { if (action) fail('time-drain-arguments-invalid'); action = flag; }
      else if (flag === '--json') options.json = true;
      else if (['--cwd', '--milestone'].includes(flag) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[flag.slice(2)] = argv[++i];
      else fail('time-drain-arguments-invalid');
    }
    if (!action || !options.milestone) fail('time-drain-arguments-invalid');
    const result = action === '--inspect' ? inspectDrain(options.cwd || '.', options.milestone, liveOptions)
      : checkpointIfDrained(options.cwd || '.', options.milestone, liveOptions);
    const refused = ['not-drained', 'not-exhausted'].includes(result.status);
    const message = refused ? result.reason_code === 'time-drain-not-exhausted' ? 'O teto ainda não foi atingido.'
      : 'Drain incompleto: reconcilie os writers pelo fluxo existente.' : result.status === 'checkpointed'
        ? 'Checkpoint salvo; a decisão de extensão ou encerramento parcial continua pendente.' : 'Inspeção de tempo concluída.';
    io.stdout.write(options.json ? JSON.stringify(result) + '\n' : message + '\n'); return refused ? 2 : 0;
  } catch {
    const error = { status: 'error', reason_code: 'time-drain-invalid', message: 'Não foi possível validar o drain ou os argumentos.' };
    io.stdout.write(argv.includes('--json') ? JSON.stringify(error) + '\n' : error.message + '\n'); return 3;
  }
}

module.exports = { DRAIN_STATES, WRITER_CLASSES, inspectDrain, checkpointIfDrained, main };
if (require.main === module) process.exitCode = main();
