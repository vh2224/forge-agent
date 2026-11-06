#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const phaseCost = require('./forge-phase-cost');
const { unionDuration } = require('./forge-autonomy');
const time = require('./forge-milestone-time');
const { continuation } = require('./forge-pending-questions');
const { readBoundedStableFile } = require('./forge-autonomy-sources');
const observations = require('./forge-milestone-worker-observations');
const CLASSES = Object.freeze(['unit-work', 'owner-session', 'human-wait', 'pause', 'ci-wait', 'external-wait', 'unknown']);
const CONSUMES = Object.freeze(Object.fromEntries(CLASSES.map(k => [k, ['unit-work', 'owner-session', 'unknown'].includes(k)])));
const CLOCK_POLICY = Object.freeze({ id: 'forge-milestone-time-clock', version: 1,
  classes: CLASSES, priority: CLASSES, consumption: CONSUMES });
const FORECAST_POLICY = Object.freeze({ id: 'forge-milestone-time-forecast', version: 1 });
const DELIVERY_PROOF_MODES = Object.freeze(['current-source-strict', 'historical-delivery']);
const MAX_JSON = 1024 * 1024;
function fail(code) { throw Object.assign(new Error(code), { code }); }
function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function instant(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : NaN;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return NaN;
  const result = Date.parse(value); return Number.isFinite(result) && new Date(result).toISOString() === value ? result : NaN;
}
function unknown(reason, sources = []) { return { status: 'unknown', reason, policy: CLOCK_POLICY, sources }; }
// All paths, including missing suffixes, stay under one explicit owner/code root.
function safeFile(root, reference) {
  if (typeof reference !== 'string' || !reference || path.isAbsolute(reference) || reference.includes('\\')
      || reference.split('/').some(p => !p || p === '.' || p === '..') || /[\x00-\x1f:]/.test(reference)) fail('clock-path-invalid');
  const file = path.resolve(root, reference), base = path.resolve(root);
  if (!file.startsWith(base + path.sep)) fail('clock-path-invalid');
  let cursor = file;
  for (;;) {
    try { if (fs.lstatSync(cursor).isSymbolicLink()) fail('clock-path-link'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  return file;
}
function readSource(root, reference, limit = MAX_JSON, json = false) {
  const file = safeFile(root, reference);
  let stat; try { stat = fs.lstatSync(file); }
  catch (e) { if (e.code === 'ENOENT') return { status: 'absent', path: reference, sha256: null, bytes: 0, records: 0 }; throw e; }
  if (!stat.isFile()) fail('clock-source-invalid');
  const read = readBoundedStableFile(file, limit, { expectedReal: fs.realpathSync.native(file) });
  if (read.error) fail(read.error === 'source_too_large' ? 'clock-source-limit'
    : read.error === 'source_unreadable' ? 'clock-source-unreadable' : 'clock-source-unstable');
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(read.buffer); }
  catch { fail('clock-source-encoding'); }
  const result = { status: 'valid', path: reference, sha256: hash(read.buffer), bytes: read.buffer.length,
    records: json ? 1 : text.split(/\r?\n/).filter(x => x.trim()).length, buffer: read.buffer };
  if (json) { try { result.value = JSON.parse(text); } catch { fail('clock-source-json-invalid'); } }
  return result;
}
function publicSource(source) { const { buffer, value, ...metadata } = source; return metadata; }
function deliverySource(options, root, reference, limit = MAX_JSON, json = false) {
  const key = path.resolve(root) + '\0' + reference, cache = options.deliveryCache;
  let result = cache.files.get(key);
  if (!result) {
    const source = readSource(root, reference, limit, json);
    cache.bytes += source.bytes;
    if (cache.files.size >= 1024 || cache.bytes > 8 * MAX_JSON) fail('delivery-source-limit');
    result = { root, reference, limit, source }; cache.files.set(key, result);
  }
  if (result.source.bytes > limit) fail('delivery-source-limit');
  if (json && result.source.value === undefined && result.source.buffer) {
    try { result.source.value = JSON.parse(result.source.buffer.toString('utf8')); } catch { fail('clock-source-json-invalid'); }
  }
  return result.source;
}
function revisionBlobHash(cwd, revision, relative) {
  const { git } = require('./forge-git-process');
  const options = { maxBuffer: 1024, env: { GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' } };
  try {
    if (git(cwd, ['cat-file', '-t', revision], options).trim() !== 'commit') return { ok: false };
    const object = git(cwd, ['rev-parse', '--verify', `${revision}:${relative}`], options).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(object) || git(cwd, ['cat-file', '-t', object], options).trim() !== 'blob') return { ok: false };
    return { ok: true, hash: object };
  } catch { return { ok: false }; }
}
// The physical code root is retained evidence, never the artifact owner by default:
// an explicit caller root wins; schema-v2 deliveries use their revalidated execution
// contract; schema-v1 deliveries need one agreed envelope root that is a real checkout.
function deliveryRoots(options, input, envelopes) {
  if (options.codeDir) return { codeDir: options.codeDir, contract: null };
  const roots = require('./forge-code-roots');
  try {
    const owner = fs.realpathSync.native(options.cwd);
    if (input.schema_version === 2) {
      const contract = roots.validateContract(input.execution_contract, { owner, revalidate: true });
      return { codeDir: contract.code_roots.find(r => r.id === contract.primary_root_id).path, contract };
    }
    const dirs = new Map();
    for (const read of envelopes.values()) {
      const dir = read.value?.code_dir;
      if (typeof dir !== 'string' || !path.isAbsolute(dir)) continue;
      const real = roots.realDirectory(dir); dirs.set(roots.key(real), real);
    }
    if (!dirs.size) return { codeDir: options.cwd, contract: null };
    if (dirs.size !== 1) fail('delivery-code-root-mismatch');
    const [real] = dirs.values();
    if (roots.key(real) === roots.key(owner)) return { codeDir: options.cwd, contract: null };
    roots.measureRoot({ id: 'primary', path: real });
    return { codeDir: real, contract: null };
  } catch (e) { fail(/^delivery-/.test(e.code || '') ? e.code : 'delivery-code-root-mismatch'); }
}
function sameRoot(left, right) {
  try {
    const roots = require('./forge-code-roots');
    return roots.key(fs.realpathSync.native(left)) === roots.key(fs.realpathSync.native(right));
  } catch { return false; }
}
// Multiroot envelopes bind one contract root; scope paths are mapped into it.
function captureScope(options, envelope, scope) {
  const contract = options.executionContract;
  if (!contract) return { codeRoot: options.codeDir || options.cwd, scope };
  const row = contract.code_roots.find(r => r.id === envelope?.root_id);
  if (!row) fail('delivery-code-root-mismatch');
  const mapped = [];
  for (const value of scope) {
    let resolved;
    try { resolved = require('./forge-code-roots').resolvePath(contract, value, { legacy: contract.code_roots.length === 1 }); }
    catch { fail('delivery-code-root-mismatch'); }
    if (resolved.root_id === row.id) mapped.push(resolved.path);
  }
  return { codeRoot: row.path, scope: mapped };
}
function capturedSourceHash(options, envelope, relative, root) {
  const cache = options.deliveryCache, codeRoot = root || options.codeDir || options.cwd;
  const entries = envelope.workspace.filter(r => r.path === relative);
  if (entries.length > 1) fail('delivery-workspace-conflicting-path');
  if (entries.length) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entries[0].hash)) fail('delivery-current-source-binding-missing');
    return entries[0].hash;
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(envelope.revision)) fail('delivery-current-source-binding-missing');
  const key = codeRoot + '\0' + envelope.revision + '\0' + relative;
  if (!cache.blobs.has(key)) {
    if (cache.blobs.size >= 256) fail('delivery-revision-limit');
    const read = (options.revisionBlobReader || revisionBlobHash)(codeRoot, envelope.revision, relative);
    if (!read?.ok || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(read.hash)) fail('delivery-revision-unreadable');
    cache.blobs.set(key, read.hash);
  }
  return cache.blobs.get(key);
}
function validateCurrentSources(options, envelope, fullScope) {
  const cache = options.deliveryCache, { codeRoot, scope } = captureScope(options, envelope, fullScope);
  if (!envelope || !Array.isArray(envelope.workspace) || !scope.length) fail('delivery-current-source-binding-missing');
  if (!sameRoot(envelope.code_dir, codeRoot)) fail('delivery-code-root-mismatch');
  for (const relative of scope) {
    const source = deliverySource(options, codeRoot, relative, phaseCost.MAX_BYTES);
    if (source.status !== 'valid') fail('delivery-current-source-changed');
    const expected = capturedSourceHash(options, envelope, relative, codeRoot);
    const key = codeRoot + '\0' + relative;
    if (!cache.hashes.has(key)) {
      if (cache.hashes.size >= 256) fail('delivery-revision-limit');
      const read = (options.currentHashReader || ((cwd, file) => require('./forge-vcs').hashPath(cwd, file,
        { vcs: 'git', maxBuffer: 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' } })))(codeRoot, relative);
      if (!read?.ok || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(read.hash)) fail('delivery-current-source-unreadable');
      if (readSource(codeRoot, relative, phaseCost.MAX_BYTES).sha256 !== source.sha256) fail('clock-source-unstable');
      cache.hashes.set(key, read.hash);
    }
    if (cache.hashes.get(key) !== expected) fail('delivery-current-source-changed');
  }
}
// Historical source bindings describe the captured workspace. They do not compare
// it to today's files, and cannot stand in for integrated verification/review.
function historicalCapture(options, reference, read, fullScope, expected) {
  const envelope = read.value;
  const { codeRoot, scope } = captureScope(options, envelope, fullScope);
  if (!Array.isArray(envelope?.workspace) || envelope.workspace.length > 256
      || !sameRoot(envelope.code_dir, codeRoot)) fail('delivery-current-source-binding-missing');
  const capturedAt = instant(envelope.captured_at);
  if (!Number.isFinite(capturedAt) || capturedAt > options.completionAt) fail('delivery-capture-time-invalid');
  const paths = new Set();
  const workspace = envelope.workspace.map(row => {
    if (!row || paths.has(row.path)) fail('delivery-workspace-conflicting-path');
    safeFile(codeRoot, row.path); paths.add(row.path);
    // Out-of-scope dirty metadata can include deleted paths. Only scoped files
    // are positive source evidence and require a concrete captured blob hash.
    return { path: row.path, hash: /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(row.hash) ? row.hash : null };
  }).filter(row => scope.includes(row.path));
  const bindings = scope.map(relative => ({ path: relative, hash: capturedSourceHash(options, envelope, relative, codeRoot) }));
  return { unit: require('./forge-delivery').unitKey(expected), reference, sha256: read.sha256,
    revision: /^(?:[a-f0-9]{40}|[a-f0-9]{64}|[a-z][a-z0-9.-]{0,99})$/.test(envelope.revision) ? envelope.revision : null,
    workspace, workspace_scope: 'declared-source-paths-only', captured_at: envelope.captured_at,
    plan_fingerprint: envelope.plan_fingerprint, source_bindings: bindings, current_source_conformity: 'not-evaluated' };
}
function sourceReason(error) {
  return /^(?:clock-|phase-cost-|time-|delivery-)/.test(error.code || '') ? error.code : 'clock-source-unreadable';
}
function observationOptions(options) {
  return { ...options, cwd: path.resolve(options.cwd || '.'),
    now: typeof options.now === 'function' ? options.now() : options.now ?? Date.now() };
}

// Pure input: {contract, now, events: analyzeEventIntervals(...), journal: [], pending: [source.ref],
// workers: readWorkerEvidence(...)}. Every boundary is explicit; presence never
// extends beyond its last observation. Worker effort comes only from observed
// invocation records; controller unit intervals are reported separately.
function computeClock(input) {
  const { contract, events, journal = [], pending = [], workers } = input;
  if (!time.validateContract(contract).valid) return unknown('time-contract-schema-invalid');
  const start = instant(contract.activated_at), now = instant(input.now);
  if (!Number.isFinite(now) || now < start) return unknown('clock-now-invalid');
  if (!events || !Array.isArray(events.intervals) || !Array.isArray(events.open) || !Array.isArray(events.ambiguous)
      || !Array.isArray(events.pauses) || !Array.isArray(journal)) return unknown('clock-input-invalid');
  const spans = [], reasons = [];
  function add(kind, a, b, reason) {
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) fail('clock-interval-invalid');
    const left = Math.max(start, a), right = Math.min(now, b);
    if (right > left) (reason ? reasons : spans).push({ start: left, end: right, class: kind, ...(reason ? { reason } : {}) });
  }
  try {
    const units = events.intervals.filter(r => r.milestone === contract.milestone);
    const open = events.open.filter(r => r.milestone === contract.milestone && r.start <= now);
    const ambiguous = events.ambiguous.filter(r => r.milestone === contract.milestone);
    for (const r of units) add('unit-work', r.start, r.end);
    for (const r of open) add('unit-work', r.start, now);
    for (const r of ambiguous) add('unknown', Math.min(...r.starts, r.end ?? now), Math.max(...r.starts, r.end ?? now), 'no-source');
    const sessions = new Map(), waits = new Map();
    let previousPresence = null;
    for (const r of journal.slice().sort((a, b) => instant(a.at) - instant(b.at))) {
      const at = instant(r.at); if (!Number.isFinite(at) || at > now) { if (!Number.isFinite(at)) fail('clock-journal-invalid'); continue; }
      if (r.type === 'presence') {
        if (r.session_sha256 !== null && !/^[a-f0-9]{64}$/.test(r.session_sha256)) fail('clock-session-invalid');
        const previous = r.session_sha256 && sessions.get(r.session_sha256);
        if (previous !== undefined && previous !== null && r.boundary !== 'session-start') add('owner-session', previous, at);
        if (previousPresence && previousPresence.session !== r.session_sha256)
          add('unknown', previousPresence.at, at, 'session-change');
        if (r.session_sha256) {
          if (r.boundary === 'session-end') sessions.delete(r.session_sha256);
          else sessions.set(r.session_sha256, at);
        } else sessions.clear();
        previousPresence = { session: r.session_sha256, at };
      } else if (r.type === 'wait-start') {
        if (waits.has(r.wait_id) || !['human', 'pause', 'ci', 'external'].includes(r.class)
            || !r.source || typeof r.source.ref !== 'string') fail('clock-wait-invalid');
        waits.set(r.wait_id, r);
      } else if (r.type === 'wait-end') {
        const first = waits.get(r.wait_id);
        if (!first || first.class !== r.class || first.source.kind !== r.source?.kind || first.source.ref !== r.source?.ref) fail('clock-wait-conflict');
        const kind = first.class === 'pause' ? 'pause' : first.class + '-wait';
        if (first.class === 'human' && first.source.kind !== 'pending-question') add('unknown', instant(first.at), at, 'wait-end-missing');
        else add(kind, instant(first.at), at);
        waits.delete(r.wait_id);
      } else fail('clock-journal-invalid');
    }
    for (const first of waits.values()) {
      const valid = first.class !== 'human' || first.source.kind === 'pending-question' && pending.includes(first.source.ref);
      add(valid ? first.class === 'pause' ? 'pause' : first.class + '-wait' : 'unknown', instant(first.at), now,
        valid ? null : 'wait-end-missing');
    }
    for (const pause of events.pauses.filter(r => r.milestone === contract.milestone)) {
      const next = [...units, ...open].filter(r => r.unit === pause.unit && r.start >= pause.at).map(r => r.start);
      add('pause', pause.at, next.length ? Math.min(...next) : now);
    }
    const points = new Map([[start, []], [now, []]]);
    for (const span of [...spans, ...reasons]) {
      for (const [at, delta] of [[span.start, 1], [span.end, -1]]) {
        if (!points.has(at)) points.set(at, []);
        points.get(at).push({ key: span.reason || span.class, reason: !!span.reason, delta });
      }
    }
    const boundaries = [...points.keys()].sort((a, b) => a - b), activeClasses = new Map(), activeReasons = new Map();
    const byClass = Object.fromEntries(CLASSES.map(k => [k, 0])), segments = [], gaps = [];
    for (let i = 1; i < boundaries.length; i++) {
      const a = boundaries[i - 1], b = boundaries[i];
      for (const change of points.get(a)) {
        const active = change.reason ? activeReasons : activeClasses;
        active.set(change.key, (active.get(change.key) || 0) + change.delta);
      }
      const kind = CLASSES.find(k => activeClasses.get(k) > 0) || 'unknown';
      byClass[kind] += b - a; segments.push({ start: a, end: b, class: kind });
      if (kind === 'unknown') {
        const reason = ['wait-end-missing', 'session-change', 'source-limit', 'no-source'].find(k => activeReasons.get(k) > 0) || 'no-source';
        const last = gaps.at(-1); if (last && last.end === a && last.reason === reason) last.end = b;
        else gaps.push({ start: a, end: b, reason });
      }
    }
    // Union cross-check is also used for the public unit-work total, never the sum.
    byClass['unit-work'] = unionDuration(spans.filter(r => r.class === 'unit-work'));
    const consumed = CLASSES.filter(k => CONSUMES[k]).reduce((sum, k) => sum + byClass[k], 0);
    // Controller unit-began..unit-transition sum: owner preparation/publication
    // included, so it is a unit proxy and never labeled as worker effort.
    const unitSum = [...units, ...open.map(r => ({ ...r, end: now }))]
      .reduce((sum, r) => sum + Math.max(0, Math.min(now, r.end) - Math.max(start, r.start)), 0);
    // Unusable worker evidence leaves effort unknown; it never voids the clock.
    let worker;
    try { worker = observations.projectWorkerEffort({ start, now, units, open, ambiguous, evidence: workers }); }
    catch { worker = observations.projectWorkerEffort({ start, now, units, open, ambiguous, evidence: { status: 'unknown', reason: 'observation-record-invalid' } }); }
    return { status: 'measured', policy: CLOCK_POLICY, now, elapsed: { since_activation_ms: now - start,
      preselection_ms: start - instant(contract.preselection_started_at) },
      consumption: { consumed_ms: consumed, unknown_ms: byClass.unknown, by_class: byClass },
      effort: { unit_interval_sum_ms: unitSum, basis: 'controller-unit-intervals', units: units.length, open_units: open.length,
        ambiguous_units: ambiguous.length, unit_complete: ambiguous.length === 0 && open.length === 0, worker },
      waits: Object.fromEntries(CLASSES.filter(k => !CONSUMES[k]).map(k => [k, byClass[k]])), gaps, segments };
  } catch (e) { return unknown(sourceReason(e)); }
}

function eventSource(options) {
  const reference = `.gsd/milestones/${options.milestone}/${options.milestone}-events.jsonl`;
  const source = readSource(options.cwd, reference, phaseCost.MAX_BYTES);
  if (source.status === 'absent') return { source, events: phaseCost.analyzeEventIntervals(Buffer.alloc(0)) };
  const analysis = phaseCost.measurePhaseCost(safeFile(options.cwd, reference));
  if (analysis.source_sha256 !== source.sha256) fail('clock-source-unstable');
  const events = phaseCost.analyzeEventIntervals(source.buffer);
  if (events.milestones.some(milestone => milestone !== options.milestone)) fail('clock-event-milestone-mismatch');
  return { source, events };
}
// Bounded live event-stream metadata for a frozen clock whose live consumption is unavailable (invalid
// journal, limit, race): listed independently so observeTime/openWriters can recheck the stream and
// keep the frozen consumption. An unreadable or oversized stream stays unlisted: writers are unknown.
function liveEventMetadata(options, sources) {
  const reference = `.gsd/milestones/${options.milestone}/${options.milestone}-events.jsonl`;
  if (sources.some(r => r.path === reference)) return;
  try { sources.push(publicSource(eventSource(options).source)); } catch { /* writer metadata stays unknown */ }
}
function readClock(options) {
  const sources = []; let terminal = null;
  try {
    options = observationOptions(options);
    const paths = time.timePaths(options), contract = time.readContract(options);
    if (contract.status === 'absent') return { status: 'no-contract', sources };
    if (contract.status !== 'valid') return unknown(contract.reason, sources);
    const base = readSource(paths.owner, `.gsd/forge/time/${options.milestone}/contract.json`, MAX_JSON, true);
    sources.push(publicSource(base));
    for (let version = 2; version <= contract.version; version++) {
      const reference = `.gsd/forge/time/${options.milestone}/amendments/${String(version).padStart(4, '0')}.json`;
      sources.push(publicSource(readSource(paths.owner, reference, 64 * 1024, true)));
    }
    // Frozen-first: a valid immutable endpoint and its ownership are resolved before any live
    // consumption is recomputed, so later journal/event growth or loss never overturns the snapshot.
    terminal = terminalSnapshot(options, paths, sources);
    if (terminal === INVALID_TERMINAL) return unknown('clock-endpoint-invalid', sources);
    const journal = time.readJournal(options);
    if (journal.status !== 'valid') {
      if (terminal) liveEventMetadata(options, sources);
      return terminal ? frozenClock(terminal, contract, options, null, sources, journal.reason || 'clock-journal-invalid')
        : unknown(journal.reason || 'clock-journal-invalid', sources);
    }
    const journalSource = readSource(paths.owner, `.gsd/forge/time/${options.milestone}/journal.jsonl`, phaseCost.MAX_BYTES);
    if (journalSource.status !== 'absent' && hash(Buffer.from(journal.records.map(JSON.stringify).join('\n')))
        !== hash(Buffer.from(journalSource.buffer.toString('utf8').trimEnd().split('\n').map(line => JSON.stringify(JSON.parse(line))).join('\n')))) fail('clock-source-unstable');
    sources.push(publicSource(journalSource));
    const observed = eventSource(options); sources.push(publicSource(observed.source));
    const pending = [];
    for (const r of journal.records.filter(r => r.type === 'wait-start' && r.class === 'human' && r.source.kind === 'pending-question')) {
      const match = /^([a-f0-9]{64}):([a-zA-Z0-9_-]+)$/.exec(r.source.ref);
      if (!match) continue;
      try {
        const state = continuation({ cwd: paths.owner, identity: match[1] });
        const origin = readSource(paths.owner, `.gsd/forge/questions/${match[1]}.origin.json`, 256 * 1024, true);
        const questionState = readSource(paths.owner, `.gsd/forge/questions/${match[1]}.json`, 256 * 1024, true);
        if (origin.value?.identity?.milestone === options.milestone && state.pending_ids?.includes(match[2])) pending.push(r.source.ref);
        sources.push(publicSource(origin), publicSource(questionState));
      }
      catch { /* Without a readable matching question an open wait is unknown. */ }
    }
    sources.push(...['.gsd/forge/events.jsonl', '.gsd/forge/receipts'].map(reference => ({ path: reference,
      status: 'nested-not-counted', sha256: null, bytes: null, records: null, reason: 'already-contained-in-unit-intervals' })));
    // Immutable owner observations are read separately and rechecked; damage or
    // a race leaves worker effort unknown without touching consumption.
    const workerRead = () => { try { return observations.readWorkerEvidence(options); } catch { return { status: 'unknown', reason: 'observation-record-unreadable' }; } };
    let workers = workerRead();
    const compute = () => computeClock({ contract: contract.contract, now: options.now, events: observed.events, journal: journal.records, pending, workers });
    let result = compute();
    if (workers.status === 'valid' && workerRead().sha256 !== workers.sha256) {
      workers = { status: 'unknown', reason: 'observation-source-unstable' }; result = compute();
    }
    sources.push(...['observations', 'coverage'].map(kind => ({ path: `.gsd/forge/time/${options.milestone}/${kind}`,
      status: workers.status === 'valid' ? 'record-set' : 'unavailable', sha256: workers.status === 'valid' ? workers.sha256 : null, bytes: null,
      records: workers.status === 'valid' ? workers[kind].length : null, reason: workers.status === 'valid' ? 'worker-evidence-only' : workers.reason || 'no-worker-evidence' })));
    // Contract/journal APIs are rechecked after collection, across amendment races.
    const after = time.readContract(options);
    if (after.status !== 'valid' || after.sha256 !== contract.sha256) fail('clock-source-unstable');
    for (const source of sources.filter(r => r.status === 'valid' || r.status === 'absent')) {
      if (readSource(paths.owner, source.path, phaseCost.MAX_BYTES).sha256 !== source.sha256) fail('clock-source-unstable');
    }
    return terminal ? frozenClock(terminal, contract, options, result, sources) : { ...result, sources };
  } catch (e) {
    if (terminal && terminal !== INVALID_TERMINAL) {
      liveEventMetadata(options, sources);
      try { return frozenClock(terminal, time.readContract(options), options, null, sources, sourceReason(e)); } catch { /* contract unreadable: unknown below */ }
    }
    return unknown(sourceReason(e), sources);
  }
}
// Terminal horizon: a valid immutable endpoint.json of the current contract chain (bound to its
// publication anchor by readEndpoint) stops consumption at its snapshot (effort, waits and gaps
// included); elapsed time continues separately. Later amendments, journal records or events never
// reopen it, even when the live sources outgrow their bounded reader or become unavailable: the
// failure stays listed as bounded live-source metadata. A tampered, foreign, unanchored or
// out-of-chain record leaves the clock unknown, and no record keeps today's output. The current
// sources stay listed so observeTime/openWriters keep rechecking them.
const INVALID_TERMINAL = Object.freeze({ invalid: true });
function terminalSnapshot(options, paths) {
  const read = require('./forge-milestone-endpoint').readEndpoint({ cwd: paths.owner, milestone: options.milestone });
  if (read.status === 'absent') return null;
  if (read.status !== 'valid') return INVALID_TERMINAL;
  const at = instant(read.record.endpoint_at), now = instant(options.now);
  if (!Number.isFinite(now) || now < at) return null;
  const source = readSource(paths.owner, `.gsd/forge/time/${options.milestone}/endpoint.json`, 64 * 1024, true);
  if (source.status !== 'valid' || require('./forge-code-roots').digest(source.value) !== read.sha256) fail('clock-source-unstable');
  return { record: read.record, sha256: read.sha256, at, source };
}
function frozenClock(terminal, contract, options, result, sources, liveReason) {
  const { record, at } = terminal, now = instant(options.now), start = instant(contract.contract.activated_at), snapshot = structuredClone(record.clock);
  const reason = liveReason || (result.status === 'measured' ? null : result.reason || 'clock-live-unknown');
  const elapsed = result?.status === 'measured' ? result.elapsed
    : { since_activation_ms: now - start, preselection_ms: start - instant(contract.contract.preselection_started_at) };
  return { status: 'measured', policy: CLOCK_POLICY, now, frozen: true,
    endpoint: { at: record.endpoint_at, sha256: terminal.sha256 },
    elapsed: { ...elapsed, after_endpoint_ms: now - at },
    consumption: { consumed_ms: snapshot.consumed_ms, unknown_ms: snapshot.unknown_ms, by_class: snapshot.by_class },
    effort: snapshot.effort, waits: snapshot.waits, gaps: snapshot.gaps, gap_count: snapshot.gap_count, gaps_truncated: snapshot.gaps_truncated,
    sources: [...sources, ...(reason ? [{ path: 'live-consumption', status: 'unavailable', sha256: null, bytes: null, records: null, reason }] : []),
      publicSource(terminal.source)] };
}

// Declared source paths of one plan: its writes plus every criterion path.
function declaredScope(planText, planReference, expected, structured) {
  const fields = structured ? require('./forge-must-haves').parseExecutionFields(planText) : {};
  const inventory = require('./forge-delivery').inventoryPlan(planText, planReference, expected);
  return [...new Set([...(fields.writes || []), ...inventory.criteria.flatMap(c => [c.artifact_path, c.link_from, c.link_to].filter(Boolean))])];
}
// Rebuild immutable canonical history in both modes. Only strict mode also
// establishes current source conformity; neither mode grants endpoint authority.
function validateDelivery(options, reference, expected, seen = new Set()) {
  if (seen.has(reference) || seen.size >= 64) fail('delivery-cycle-or-limit'); seen.add(reference);
  const delivery = require('./forge-delivery');
  const stored = deliverySource(options, options.cwd, reference, MAX_JSON, true);
  if (stored.status !== 'valid') fail('delivery-missing');
  const inputReference = reference.replace(/-DELIVERY\.json$/, '-DELIVERY-INPUT.json');
  if (inputReference === reference) fail('delivery-path-invalid');
  const inputRead = deliverySource(options, options.cwd, inputReference, MAX_JSON, true), input = inputRead.value;
  if (!input || delivery.unitKey(input.unit) !== delivery.unitKey(expected)
      || delivery.unitKey(stored.value?.unit) !== delivery.unitKey(expected)) fail('delivery-unit-mismatch');
  const plan = deliverySource(options, options.cwd, input.plan, MAX_JSON);
  if (plan.status !== 'valid') fail('delivery-plan-missing');
  const planText = plan.buffer.toString('utf8');
  if (!Array.isArray(input.bindings || []) || !Array.isArray(input.expected_children || [])) fail('delivery-binding-invalid');
  // Bound every source before the canonical builder opens it; the final cache
  // reread detects changes across the recursive rebuild.
  const envelopes = new Map();
  for (const binding of input.bindings || []) {
    if (!binding?.source?.path || !['verification', 'artifact'].includes(binding.source.kind)) fail('delivery-binding-invalid');
    envelopes.set(binding.source.path, deliverySource(options, options.cwd, binding.source.path, MAX_JSON, true));
  }
  for (const child of input.expected_children || []) {
    if (!child?.unit || !child.delivery) fail('delivery-child-invalid');
    validateDelivery(options, child.delivery, child.unit, seen);
  }
  const roots = deliveryRoots(options, input, envelopes);
  options = { ...options, codeDir: roots.codeDir, ...(roots.contract ? { executionContract: roots.contract } : {}) };
  const rebuilt = delivery.buildDelivery(input, { ownerRoot: options.cwd, codeDir: roots.codeDir });
  if (rebuilt.delivery_fingerprint !== stored.value.delivery_fingerprint
      || delivery.finalizeOutput(stored.value).delivery_fingerprint !== stored.value.delivery_fingerprint) fail('delivery-projection-changed');
  const legacySlice = expected.type === 'slice' && input.expected_children?.length > 0;
  // A milestone ROADMAP is an aggregate plan: only its own legacy marker and the legacy
  // markers reported by its expected slice children are tolerated (endpoint proof only).
  const aggregate = expected.type === 'milestone' && input.expected_children?.length > 0
    ? new Set(['plan_legacy', ...input.expected_children.flatMap(c => ['child_plan_legacy_or_unstructured:', 'child_reported:plan_legacy:']
      .map(prefix => prefix + delivery.unitKey(c.unit)))]) : null;
  if (rebuilt.generated_by !== 'forge-delivery' || rebuilt.diagnostics.some(r => !(legacySlice && r === 'plan_legacy') && !aggregate?.has(r)) || !rebuilt.criteria.length
      || rebuilt.criteria.some(c => c.status !== 'verificado' || c.pending.length)) fail('delivery-criteria-unproven');
  if (expected.type === 'slice') {
    const tasks = require('./forge-status').parsePlanTasks(planText);
    const children = input.expected_children || [];
    if (tasks.length && (tasks.length !== children.length || tasks.some(task => !children.some(child => child.unit.type === 'task'
        && child.unit.id === task.id && child.unit.slice === expected.id && child.unit.milestone === expected.milestone)))) fail('delivery-child-inventory-mismatch');
    if (!rebuilt.plan.structured && !tasks.length) fail('delivery-child-inventory-missing');
  }
  const scope = declaredScope(planText, input.plan, expected, rebuilt.plan.structured);
  for (const [sourceReference, read] of envelopes) {
    if (options.executionContract && !captureScope(options, read.value, scope).scope.length) continue;
    if (options.proofMode === 'current-source-strict') validateCurrentSources(options, read.value, scope);
    const capture = historicalCapture(options, sourceReference, read, scope, expected);
    options.proof.captures.push({ ...capture, current_source_conformity: options.proofMode === 'current-source-strict' ? 'matched' : 'not-evaluated' });
  }
  options.proof.units.push({ unit: delivery.unitKey(expected), reference, delivery_sha256: stored.sha256,
    input_sha256: inputRead.sha256, plan_sha256: plan.sha256, criteria: rebuilt.criteria.filter(c => delivery.unitKey(c.unit) === delivery.unitKey(expected)).length });
  return rebuilt;
}
// The single canonical completion check of a scoped complete-slice or complete-milestone
// unit: the last succeeded complete event of this milestone, its committed transaction,
// succeeded result and the checksummed completed/handoff-ready boundary the transaction
// retains, the published event identical but for sequence, and the order of the recorded
// instants (created <= event <= committed <= updated <= now). Paths and sizes are bounded
// before the canonical controller readers run.
function canonicalCompletion(options, rows, unit) {
  const controller = require('./forge-unit-controller');
  const event = rows.filter(r => r.milestone === options.milestone && r.unit === unit && r.event === 'unit-transition'
    && r.action === 'complete' && r.outcome === 'succeeded').at(-1);
  if (!event || typeof event.idempotency_key !== 'string') fail('delivery-completion-missing');
  // Guard parent paths and sizes before calling canonical controller readers.
  for (const kind of ['transaction', 'result']) {
    const file = kind === 'transaction' ? controller.transactionFile(options.cwd, event.idempotency_key)
      : controller.resultFile(options.cwd, event.idempotency_key);
    const ref = path.relative(options.cwd, file).split(path.sep).join('/');
    const read = deliverySource(options, options.cwd, ref, MAX_JSON, true); if (read.status !== 'valid') fail('delivery-completion-record-missing');
    if (!/^[a-f0-9]{64}$/.test(read.value?.storage_checksum)) fail('delivery-completion-checksum-missing');
    // lookupRecord may also inspect a legacy copy. Bound and reject links
    // in the record directory without implementing its storage parser.
    const directory = path.dirname(file), directoryRef = path.relative(options.cwd, directory).split(path.sep).join('/');
    safeFile(options.cwd, directoryRef);
    const names = fs.readdirSync(directory);
    if (names.length > 256) fail('delivery-record-limit');
    let bytes = 0;
    for (const name of names.filter(n => n.endsWith('.json'))) {
      bytes += deliverySource(options, options.cwd, directoryRef + '/' + name, MAX_JSON).bytes;
      if (bytes > phaseCost.MAX_BYTES) fail('delivery-record-limit');
    }
  }
  const tx = controller.lookupRecord(options.cwd, 'transaction', event.idempotency_key);
  const result = controller.lookupRecord(options.cwd, 'result', event.idempotency_key);
  // The committed transaction retains its checksummed boundary. The public
  // handoff slot is mutable and may now describe another milestone's S01.
  const boundary = tx?.boundary;
  // The controller adds sequence only when publishing the event stream.
  const { sequence, ...publishedEvent } = event;
  if (!tx || tx.action !== 'complete' || tx.phase !== 'committed' || tx.milestone !== options.milestone || tx.unit?.key !== unit
      || result?.status !== 'succeeded' || result.unit !== unit || result.milestone !== options.milestone
      || boundary?.kind !== 'completed' || boundary.outcome !== 'succeeded' || boundary.handoff_ready !== true
      || boundary.milestone !== options.milestone || boundary.unit !== unit || boundary.idempotency_key !== event.idempotency_key
      || !Number.isFinite(instant(boundary.committed_at)) || !Number.isFinite(instant(tx.updated_at))
      || !Number.isFinite(instant(tx.created_at)) || instant(tx.created_at) > instant(event.ts)
      || instant(event.ts) > instant(boundary.committed_at) || instant(boundary.committed_at) > instant(tx.updated_at)
      || !Number.isFinite(instant(options.now)) || instant(tx.updated_at) > instant(options.now)
      || boundary.state_checksum !== tx.after.state_checksum
      || !Number.isSafeInteger(sequence) || sequence < 1
      || require('./forge-delivery').fingerprint(tx.event) !== require('./forge-delivery').fingerprint(publishedEvent)
      || require('./forge-delivery').fingerprint(tx.result) !== require('./forge-delivery').fingerprint(result)
      || boundary.result_ref !== path.relative(options.cwd, controller.resultFile(options.cwd, event.idempotency_key)).split(path.sep).join('/')) fail('delivery-completion-unproven');
  return { event, publishedEvent, tx, result, boundary };
}
function readDeliveries(options) {
  const proven = [], unproven = [], sources = [];
  const proofKind = options?.proofMode ?? 'current-source-strict';
  const purpose = { proof_kind: proofKind, current_integrated_acceptance: 'not-evaluated',
    current_source_conformity: proofKind === 'historical-delivery' ? 'not-evaluated' : 'unknown',
    limitations: ['canonical-fingerprints-are-not-authorship-or-live-authority',
      'workspace-and-capture-time-are-recorded-metadata-not-fully-bound-by-delivery-fingerprint',
      'capture-times-do-not-prove-worker-duration', 'integrated-endpoint-verification-and-review-required-separately'] };
  try {
    if (!DELIVERY_PROOF_MODES.includes(proofKind)) fail('delivery-proof-mode-invalid');
    options = observationOptions(options);
    options.proofMode = proofKind;
    options.deliveryCache = { files: new Map(), hashes: new Map(), blobs: new Map(), bytes: 0 };
    time.timePaths(options);
    const observed = eventSource(options); sources.push(publicSource(observed.source));
    const controller = require('./forge-unit-controller');
    const rows = observed.source.status === 'absent' ? [] : controller.readEvents(safeFile(options.cwd, observed.source.path));
    const after = deliverySource(options, options.cwd, observed.source.path, phaseCost.MAX_BYTES);
    if (after.sha256 !== observed.source.sha256) fail('clock-source-unstable');
    const slices = options.slices || [...new Set(rows.filter(r => r.unit?.startsWith('complete-slice/')).map(r => r.unit.split('/')[1]))];
    if (!Array.isArray(slices) || slices.length > 256) fail('delivery-slice-limit');
    for (const slice of [...new Set(slices)].sort()) {
      if (!/^S\d{2,}$/.test(slice)) fail('delivery-slice-invalid');
      try {
        const { event, boundary } = canonicalCompletion(options, rows, 'complete-slice/' + slice);
        const reference = `.gsd/milestones/${options.milestone}/slices/${slice}/${slice}-DELIVERY.json`;
        options.completionAt = instant(event.ts);
        options.proof = { units: [], captures: [] };
        const projection = validateDelivery(options, reference, { type: 'slice', id: slice, milestone: options.milestone });
        proven.push({ slice, reference, fingerprint: projection.delivery_fingerprint, completion_sha256: hash(event.idempotency_key),
          proof_kind: proofKind, completed_at: event.ts, committed_at: boundary.committed_at,
          current_source_conformity: proofKind === 'current-source-strict' ? 'matched' : 'not-evaluated',
          current_integrated_acceptance: 'not-evaluated', coverage: { status: 'complete',
            units: options.proof.units.length, captures: options.proof.captures.length, criteria: projection.criteria.length },
          history: options.proof.units, captures: options.proof.captures });
      } catch (e) { unproven.push({ slice, reason: sourceReason(e) === 'clock-source-unreadable' ? 'delivery-completion-invalid' : sourceReason(e) }); }
    }
    for (const read of options.deliveryCache.files.values()) {
      if (readSource(read.root, read.reference, read.limit).sha256 !== read.source.sha256) fail('clock-source-unstable');
    }
    if (proofKind === 'current-source-strict') purpose.current_source_conformity =
      unproven.some(row => row.reason === 'delivery-current-source-changed') ? 'changed' : unproven.length || !proven.length ? 'unknown' : 'matched';
    return { status: 'observed', ...purpose, proven, unproven, sources };
  } catch (e) { return { status: 'unknown', ...purpose, reason: sourceReason(e), proven: [], unproven, sources }; }
}
function readHistoricalDeliveries(options) { return readDeliveries({ ...options, proofMode: 'historical-delivery' }); }
// Narrow read-only proof of ONE completed task for controller admission. The same canonical
// rebuild and historical capture checks as the slice proof (captured_at finite and not after the
// committed completion, physical owner/code roots and contract, every declared source path bound
// to a concrete captured blob), plus: the task's own plan, a nonempty declared source inventory
// fully covered by its root captures, and verification/artifact captures of one root agreeing on
// revision, identity and source bindings. Today's sources are never compared, so a later
// legitimate code change keeps the history; the caller supplies the committed completion instant.
function readHistoricalTaskDelivery(options = {}) {
  const purpose = { proof_kind: 'historical-delivery', current_source_conformity: 'not-evaluated', current_integrated_acceptance: 'not-evaluated' };
  try {
    options = observationOptions(options);
    const { milestone, slice, task } = options;
    if (typeof slice !== 'string' || !/^S\d{2,}$/.test(slice) || typeof task !== 'string' || !/^T\d+(?:\.\d+)?$/.test(task)) fail('delivery-task-invalid');
    time.timePaths(options);
    const completionAt = instant(options.completedAt);
    if (!Number.isFinite(completionAt)) fail('delivery-completion-time-invalid');
    Object.assign(options, { proofMode: 'historical-delivery', completionAt, proof: { units: [], captures: [] },
      deliveryCache: { files: new Map(), hashes: new Map(), blobs: new Map(), bytes: 0 } });
    const delivery = require('./forge-delivery'), roots = require('./forge-code-roots');
    const expected = { type: 'task', id: task, slice, milestone }, key = delivery.unitKey(expected);
    const base = `.gsd/milestones/${milestone}/slices/${slice}/tasks/${task}`, reference = `${base}/${task}-DELIVERY.json`;
    const input = deliverySource(options, options.cwd, `${base}/${task}-DELIVERY-INPUT.json`, MAX_JSON, true).value;
    if (input?.plan !== `${base}/${task}-PLAN.md`) fail('delivery-plan-foreign');
    const projection = validateDelivery(options, reference, expected);
    const stored = deliverySource(options, options.cwd, reference, MAX_JSON, true).value;
    if (!Array.isArray(stored?.lineage) || !stored.lineage.includes(key) || !Number.isInteger(stored.depth)
        || projection.diagnostics.length || !projection.criteria.some(c => delivery.unitKey(c.unit) === key)) fail('delivery-criteria-unproven');
    const plan = deliverySource(options, options.cwd, input.plan, MAX_JSON);
    const scope = declaredScope(plan.buffer.toString('utf8'), input.plan, expected, projection.plan.structured);
    if (!scope.length) fail('delivery-source-inventory-missing');
    const captures = options.proof.captures.filter(c => c.unit === key);
    if (!captures.length) fail('delivery-source-capture-missing');
    // Every declared path is bound by a capture of the root that owns it.
    const contract = input.schema_version === 2 ? roots.validateContract(input.execution_contract, { owner: fs.realpathSync.native(options.cwd), revalidate: true }) : null;
    const envelopeOf = capture => deliverySource(options, options.cwd, capture.reference, MAX_JSON, true).value;
    const rootOf = capture => (contract ? envelopeOf(capture).root_id : 'primary');
    for (const relative of scope) {
      let root = 'primary', mapped = relative;
      if (contract) {
        try { const r = roots.resolvePath(contract, relative, { legacy: contract.code_roots.length === 1 }); root = r.root_id; mapped = r.path; }
        catch { fail('delivery-code-root-mismatch'); }
      }
      if (!captures.some(c => rootOf(c) === root && c.source_bindings.some(b => b.path === mapped))) fail('delivery-source-inventory-incomplete');
    }
    // Captures of one root describe one workspace: identical identity, revision and scoped blobs,
    // and the artifact capture never precedes the verification capture.
    const groups = new Map();
    for (const capture of captures) groups.set(rootOf(capture), [...(groups.get(rootOf(capture)) || []), capture]);
    for (const group of groups.values()) {
      const [first, ...rest] = group, identity = c => { const e = envelopeOf(c);
        return JSON.stringify([c.revision, e.root_id ?? null, e.root_identity_sha256 ?? null, e.execution_contract_sha256 ?? null,
          [...c.source_bindings].sort((a, b) => a.path.localeCompare(b.path))]); };
      if (rest.some(c => identity(c) !== identity(first))) fail('delivery-capture-inconsistent');
      const at = kind => group.filter(c => envelopeOf(c).kind === kind).map(c => instant(c.captured_at));
      if (at('verification').length && at('artifact').length && Math.max(...at('verification')) > Math.min(...at('artifact'))) fail('delivery-capture-inconsistent');
    }
    for (const read of options.deliveryCache.files.values()) {
      if (readSource(read.root, read.reference, read.limit).sha256 !== read.source.sha256) fail('clock-source-unstable');
    }
    return { status: 'proven', ...purpose, unit: key, reference, fingerprint: projection.delivery_fingerprint, completed_at: options.completedAt,
      coverage: { criteria: projection.criteria.length, captures: captures.length, sources: scope.length },
      captures: captures.map(c => ({ reference: c.reference, sha256: c.sha256, captured_at: c.captured_at, revision: c.revision })) };
  } catch (e) { return { status: 'unproven', ...purpose, reason: sourceReason(e) }; }
}

// Positive, read-only proof of the verified-integrated-delivery endpoint of one contracted
// milestone. Children are aggregated historically (never compared with today's sources, so a
// later legitimate change does not deadlock); only the FRESH endpoint envelopes of every
// physical root bind the current sources. Nothing is inferred from SUMMARY, checkboxes,
// ledger, inactive runs, imported status or caller objects: every input is re-read here.
const ENDPOINT_PROOF_POLICY = Object.freeze({ id: 'forge-milestone-endpoint-proof', version: 1, endpoint: 'verified-integrated-delivery',
  completion: 'complete-milestone-canonical', children: 'historical-delivery', review: 'slice-closure', integrated: 'fresh-root-verification',
  envelope: '.gsd/milestones/{milestone}/{milestone}-ENDPOINT-VERIFICATION-{root}-ENVELOPE.json',
  commands: 'deduplicated-union-of-declared-verify', scope: 'union-of-declared-writes-outputs-and-criterion-paths',
  limitations: Object.freeze(['fresh-verification-proves-exit-codes-of-the-declared-verify-union-not-every-behavior',
    'behavioral-coverage-comes-from-the-historical-criteria', 'publication-ci-merge-release-installation-and-uat-are-separate-facts']) });
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
function endpointRefusal(code, extra = {}, status = 'unproven') { return Object.assign(new Error(code), { code, endpoint: status, extra }); }
function endpointGit(cwd, args) {
  const { git } = require('./forge-git-process');
  return git(cwd, args, { maxBuffer: 4096, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' } }).trim();
}
function readEndpointProof(options = {}) {
  const base = { policy: ENDPOINT_PROOF_POLICY, milestone: typeof options?.milestone === 'string' ? options.milestone : null };
  let plan = null;
  const refuse = (code, extra, status) => { throw endpointRefusal(code, extra, status); };
  // Damaged or forged history is a named refusal with its typed detail; a source that
  // changes while it is being read stays unknown.
  const mapped = (e, code) => (e.endpoint || e.code === 'clock-source-unstable' ? e : endpointRefusal(code, { detail: sourceReason(e) }));
  try {
    // Only the owner root, milestone and instant are inputs: caller roots, reader seams,
    // proof objects or flags never reach the canonical readers.
    const caller = options && typeof options === 'object' ? options : {};
    if (typeof caller.cwd !== 'string' || !caller.cwd) refuse('endpoint-owner-invalid');
    options = observationOptions({ cwd: caller.cwd, milestone: caller.milestone, now: caller.now });
    try { time.timePaths(options); } catch { refuse('endpoint-milestone-invalid'); }
    const M = options.milestone, owner = options.cwd, dir = `.gsd/milestones/${M}`;
    const delivery = require('./forge-delivery'), roots = require('./forge-code-roots'), controller = require('./forge-unit-controller');
    Object.assign(options, { proofMode: 'historical-delivery', deliveryCache: { files: new Map(), hashes: new Map(), blobs: new Map(), bytes: 0 } });
    // milestone_cleanup archive/delete moves or removes these before any proof: a named refusal.
    for (const ref of [dir, `${dir}/${M}-events.jsonl`, `${dir}/${M}-ROADMAP.md`]) {
      try { fs.lstatSync(safeFile(owner, ref)); } catch (e) { if (e.code === 'ENOENT') refuse('endpoint-sources-missing', { detail: ref }); throw e; }
    }
    const contract = time.readContract(options);
    if (contract.status === 'absent') refuse('endpoint-contract-missing');
    if (contract.status !== 'valid' || contract.contract.endpoint.kind !== 'verified-integrated-delivery') refuse('endpoint-contract-invalid', { detail: contract.reason || 'endpoint-kind' });
    const observed = eventSource(options);
    const rows = controller.readEvents(safeFile(owner, observed.source.path));
    if (deliverySource(options, owner, observed.source.path, phaseCost.MAX_BYTES).sha256 !== observed.source.sha256) fail('clock-source-unstable');
    const unit = 'complete-milestone/' + M;
    let completion;
    try { completion = canonicalCompletion(options, rows, unit); }
    catch (e) { throw e.code === 'delivery-completion-missing' ? endpointRefusal('endpoint-completion-missing') : mapped(e, 'endpoint-completion-unproven'); }
    // Historical milestone delivery: canonical rebuild of the INPUT/ROADMAP and every child.
    const reference = `${dir}/${M}-DELIVERY.json`, inputReference = `${dir}/${M}-DELIVERY-INPUT.json`, expected = { type: 'milestone', id: M };
    Object.assign(options, { completionAt: instant(completion.event.ts), proof: { units: [], captures: [] } });
    let projection;
    try { projection = validateDelivery(options, reference, expected); }
    catch (e) { throw e.code === 'delivery-missing' ? endpointRefusal('endpoint-delivery-missing') : mapped(e, 'endpoint-delivery-unproven'); }
    const stored = deliverySource(options, owner, reference, MAX_JSON, true), inputRead = deliverySource(options, owner, inputReference, MAX_JSON, true);
    const input = inputRead.value, roadmapRead = deliverySource(options, owner, `${dir}/${M}-ROADMAP.md`, MAX_JSON);
    if (input.plan !== `${dir}/${M}-ROADMAP.md`) refuse('endpoint-delivery-unproven', { detail: 'delivery-plan-foreign' });
    const slices = require('./forge-status').parseRoadmap(roadmapRead.buffer.toString('utf8')).slices.map(row => row.id);
    const children = input.expected_children || [];
    if (!slices.length || new Set(slices).size !== slices.length || children.length !== slices.length
        || !slices.every(id => children.some(c => c?.unit?.type === 'slice' && c.unit.id === id && c.unit.milestone === M
          && c.delivery === `${dir}/slices/${id}/${id}-DELIVERY.json`))) refuse('endpoint-child-inventory-mismatch');
    // Applicable review: each slice closed by the controller's own canonical closure.
    const reviews = [];
    for (const slice of slices) {
      const closure = controller.sliceClosure(owner, M, slice, options.now);
      if (closure) refuse('endpoint-slice-unclosed', { slice, detail: closure.reason, proof: closure.proof });
      const ref = `${dir}/slices/${slice}/${slice}-REVIEW.md`, review = deliverySource(options, owner, ref, MAX_JSON);
      if (review.status !== 'valid') refuse('endpoint-slice-unclosed', { slice, detail: 'slice-unreviewed', proof: 'slice-review-missing' });
      reviews.push({ slice, reference: ref, sha256: review.sha256 });
    }
    // Selection: an enrolled milestone needs its decided selection and a conformant roadmap;
    // an S01 contract needs an allocation coherent with the current roadmap identity.
    let identity = null; try { identity = time.roadmapIdentity(roadmapRead.buffer); } catch { identity = null; }
    const state = require('./forge-milestone-time-selection').readSelectionState(owner, M);
    let selection;
    if (state === null) {
      const allocation = contract.contract.allocation;
      if (!allocation) refuse('endpoint-allocation-missing');
      const structural = !!allocation.structure_sha256 && identity?.structure_sha256 === allocation.structure_sha256;
      if (allocation.roadmap_sha256 !== roadmapRead.sha256 && !structural) refuse('endpoint-roadmap-nonconformant', { detail: 'allocation-roadmap-mismatch' });
      selection = { status: 'not-enrolled', sha256: null };
    } else {
      if (state.status !== 'decided' || state.choice !== 'option' || state.contract?.sha256 !== contract.sha256) refuse('endpoint-selection-undecided', { detail: state.status || 'selection-unknown' });
      if (state.roadmap?.status !== 'conformant') refuse('endpoint-roadmap-nonconformant', { detail: state.roadmap?.status || 'roadmap-missing' });
      if (state.roadmap.roadmap_sha256 !== roadmapRead.sha256) fail('clock-source-unstable');
      selection = { status: 'decided', sha256: state.selection_sha256 };
    }
    // Complete question census: unreadable, invalid or excess state is unknown, never zero.
    let listed;
    try { listed = require('./forge-pending-questions').listPendingQuestions({ cwd: owner, filter: { type: 'milestone', id: M } }); }
    catch { refuse('endpoint-question-census-unknown', {}, 'unknown'); }
    if (listed.census.invalid || listed.census.excess || !['no-questions', 'no-matching-questions', null].includes(listed.empty_reason)) {
      refuse('endpoint-question-census-unknown', { detail: listed.empty_reason || 'census-incomplete' }, 'unknown');
    }
    const pending = listed.questions.filter(q => q.status === 'pending');
    if (pending.length) refuse('endpoint-question-pending', { questions: pending.length });
    // The integrated roots come only from the measured execution contract of the delivery.
    if (input.schema_version !== 2) refuse('endpoint-verification-unavailable', { detail: 'execution-contract-missing' });
    let measured;
    try { measured = roots.validateContract(input.execution_contract, { owner: fs.realpathSync.native(owner), revalidate: true }); }
    catch (e) { refuse('endpoint-verification-foreign', { detail: e.code || 'execution-contract-invalid' }); }
    const contractSha = roots.digest(measured);
    // Union of every structured plan in the proven history: declared scope plus expected
    // outputs, and the deduplicated declared verify commands of each plan's primary root.
    const plans = new Map(), verify = require('./forge-verify'), must = require('./forge-must-haves');
    const visit = (child, depth) => {
      if (depth > 4 || plans.size >= 256) fail('delivery-cycle-or-limit');
      const childInput = deliverySource(options, owner, child.delivery.replace(/-DELIVERY\.json$/, '-DELIVERY-INPUT.json'), MAX_JSON, true).value;
      const text = deliverySource(options, owner, childInput.plan, MAX_JSON).buffer.toString('utf8');
      if (must.hasStructuredMustHaves(text) && !plans.has(childInput.plan)) plans.set(childInput.plan, { unit: child.unit, text });
      for (const next of childInput.expected_children || []) visit(next, depth + 1);
    };
    for (const child of children) visit(child, 1);
    const union = new Set(), commands = new Map(measured.code_roots.map(r => [r.id, []]));
    for (const [planReference, row] of [...plans].sort(([a], [b]) => a.localeCompare(b))) {
      const fields = must.parseExecutionFields(row.text);
      for (const value of [...declaredScope(row.text, planReference, row.unit, true), ...(fields.expected_output || [])]) union.add(value);
      const declared = verify.parsePlanVerify(row.text), rootId = String(fields.roots_schema) === '2' ? fields.primary_root_id : measured.primary_root_id;
      if (!commands.has(rootId)) refuse('endpoint-verification-foreign', { detail: 'plan-root-unknown' });
      const found = declared && declared.trim() ? verify.discoverCommands({ cwd: owner, taskPlanVerify: declared }) : null;
      for (const command of found?.source === 'task-plan' ? found.commands : []) if (!commands.get(rootId).includes(command)) commands.get(rootId).push(command);
    }
    const empty = measured.code_roots.find(r => !commands.get(r.id).length);
    if (empty) refuse('endpoint-verification-unavailable', { detail: 'commands-empty', root_id: empty.id });
    if (!union.size) refuse('endpoint-scope-missing', { detail: 'scope-empty' });
    plan = { execution_contract_sha256: contractSha, plan_fingerprint: projection.delivery_fingerprint,
      roots: measured.code_roots.map(r => ({ root_id: r.id, commands: [...commands.get(r.id)] })) };
    const scopeOptions = { ...options, executionContract: measured }, committedAt = instant(completion.boundary.committed_at);
    const rootRows = [];
    for (const root of measured.code_roots) {
      const envelopeRef = ENDPOINT_PROOF_POLICY.envelope.replace(/\{milestone\}/g, M).replace('{root}', root.id);
      const read = deliverySource(options, owner, envelopeRef, MAX_JSON, true), e = read.value;
      if (read.status !== 'valid') refuse('endpoint-verification-missing', { root_id: root.id });
      if (e?.schema_version !== 1 || e.kind !== 'verification' || delivery.unitKey(e.unit) !== delivery.unitKey(expected) || e.root_id !== root.id
          || e.root_identity_sha256 !== root.identity_sha256 || e.execution_contract_sha256 !== contractSha
          || e.plan_fingerprint !== projection.delivery_fingerprint || !REVISION.test(e.revision || '') || !sameRoot(e.code_dir, root.path)) {
        refuse('endpoint-verification-foreign', { root_id: root.id });
      }
      const capturedAt = instant(e.captured_at);
      if (!Number.isFinite(capturedAt) || capturedAt <= committedAt || capturedAt > options.now) refuse('endpoint-verification-stale', { root_id: root.id });
      const checks = e.result?.checks, expectedCommands = commands.get(root.id);
      if (e.result?.passed !== true || e.result.skipped || e.result.stopped || !Array.isArray(checks) || !checks.length
          || checks.some(c => c?.exitCode !== 0 || c.skipped)) refuse('endpoint-verification-failed', { root_id: root.id });
      if (checks.length !== expectedCommands.length || checks.some((c, i) => c.command !== expectedCommands[i])) {
        refuse('endpoint-verification-foreign', { root_id: root.id, detail: 'commands-mismatch' });
      }
      // Post-capture drift: the checkout moved or a scoped file differs from the capture.
      let head; try { head = endpointGit(root.path, ['rev-parse', '--verify', 'HEAD']); } catch { refuse('endpoint-revision-unreadable', { root_id: root.id }, 'unknown'); }
      if (head !== e.revision) refuse('endpoint-source-drift', { root_id: root.id, detail: 'revision-moved' });
      let scope;
      try { scope = captureScope(scopeOptions, e, [...union]).scope; } catch { refuse('endpoint-scope-missing', { root_id: root.id, detail: 'scope-root-unresolved' }); }
      if (scope.length > 256) refuse('endpoint-scope-limit', { root_id: root.id });
      for (const relative of scope) {
        if (deliverySource(options, root.path, relative, phaseCost.MAX_BYTES).status !== 'valid') refuse('endpoint-scope-missing', { root_id: root.id, path: relative });
      }
      if (scope.length) {
        try { validateCurrentSources(scopeOptions, e, [...union]); }
        catch (error) {
          const code = error.code || '';
          if (['delivery-current-source-changed', 'delivery-revision-unreadable'].includes(code)) refuse('endpoint-source-drift', { root_id: root.id, detail: code });
          if (code === 'delivery-current-source-binding-missing') refuse('endpoint-scope-missing', { root_id: root.id, detail: code });
          if (code === 'delivery-revision-limit') refuse('endpoint-scope-limit', { root_id: root.id });
          if (code === 'delivery-code-root-mismatch') refuse('endpoint-verification-foreign', { root_id: root.id, detail: code });
          throw error;
        }
      }
      let branch = null; try { branch = endpointGit(root.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || null; } catch { branch = null; }
      rootRows.push({ root_id: root.id, root_identity_sha256: root.identity_sha256, revision: e.revision, branch, envelope_sha256: read.sha256,
        checks: checks.length, scope: scope.map(relative => ({ path: relative, hash: capturedSourceHash(scopeOptions, e, relative, root.path) })) });
    }
    for (const read of options.deliveryCache.files.values()) {
      if (readSource(read.root, read.reference, read.limit).sha256 !== read.source.sha256) fail('clock-source-unstable');
    }
    const after = time.readContract(options);
    if (after.status !== 'valid' || after.sha256 !== contract.sha256) fail('clock-source-unstable');
    const units = new Map(options.proof.units.map(row => [row.unit, row]));
    return { status: 'proven', ...base, completion_key: completion.event.idempotency_key, proof: {
      contract: { version: contract.version, sha256: contract.sha256, base_sha256: contract.chain[0].sha256 },
      completion: { unit, transaction_sha256: delivery.fingerprint(completion.tx), result_sha256: delivery.fingerprint(completion.result),
        boundary_sha256: delivery.fingerprint(completion.boundary), event_sha256: delivery.fingerprint(completion.publishedEvent),
        completed_at: completion.event.ts, committed_at: completion.boundary.committed_at },
      delivery: { reference, sha256: stored.sha256, input_sha256: inputRead.sha256, fingerprint: projection.delivery_fingerprint,
        criteria: projection.criteria.length, children: children.map(c => ({ unit: delivery.unitKey(c.unit), reference: c.delivery,
          sha256: units.get(delivery.unitKey(c.unit))?.delivery_sha256 ?? null })) },
      selection, roadmap: { sha256: roadmapRead.sha256, structure_sha256: identity?.structure_sha256 ?? null },
      reviews, roots: rootRows, questions: { pending: 0 } }, verification_plan: plan };
  } catch (e) {
    const status = e.endpoint || 'unknown', reason = e.endpoint ? e.code : sourceReason(e);
    const verification = plan && /^endpoint-(?:verification|scope|source)-/.test(reason) ? { verification_plan: plan } : {};
    return { status, ...base, reason, ...(e.extra || {}), ...verification };
  }
}

function computeForecast({ contract, clock, deliveries }) {
  const base = { policy: FORECAST_POLICY, deliveries: deliveries?.proven || [], pending: [], burn_ratio: null,
    projection: { low_ms: null, high_ms: null }, remaining_ms: null };
  if (!time.validateContract(contract).valid) return { ...base, status: 'unknown', reason: 'time-contract-schema-invalid' };
  if (!contract.allocation) return { ...base, status: 'unknown', reason: 'allocation-missing' };
  if (clock?.status !== 'measured' || !Number.isSafeInteger(clock.consumption?.consumed_ms)
      || clock.consumption.consumed_ms < 0) return { ...base, status: 'unknown', reason: 'clock-unknown' };
  if (deliveries?.status !== 'observed' || !Array.isArray(deliveries.proven)) return { ...base, status: 'unknown', reason: 'deliveries-unknown' };
  const proven = new Set(deliveries.proven.map(r => r.slice)), items = contract.allocation.items;
  const pending = items.filter(r => r.kind !== 'preparation' && !(r.kind === 'slice' && proven.has(r.slice)));
  const pendingMs = pending.reduce((sum, r) => sum + r.ms, 0), consumed = clock.consumption.consumed_ms;
  const remaining = contract.ceiling_ms - consumed;
  const output = { ...base, pending: pending.map(r => ({ ...r })), remaining_ms: remaining };
  if (!proven.size) return { ...output, status: pendingMs > remaining ? 'exceeds' : 'unknown', reason: 'no-proven-delivery',
    projection: { low_ms: pendingMs, high_ms: null } };
  const allocated = items.filter(r => r.kind === 'preparation' || r.kind === 'slice' && proven.has(r.slice)).reduce((sum, r) => sum + r.ms, 0);
  if (allocated <= 0) return { ...output, status: 'unknown', reason: 'proven-allocation-missing' };
  const ratio = consumed / allocated, low = Math.min(pendingMs, pendingMs * ratio), high = Math.max(pendingMs, pendingMs * ratio);
  return { ...output, burn_ratio: ratio, projection: { low_ms: low, high_ms: high },
    status: high <= remaining ? 'fits' : low <= remaining ? 'at-risk' : 'exceeds', reason: 'evidence-based-projection' };
}
function readForecast(options) {
  options = observationOptions(options);
  const contract = time.readContract(options);
  if (contract.status === 'absent') return { status: 'no-contract' };
  if (contract.status !== 'valid') return { status: 'unknown', reason: contract.reason, policy: FORECAST_POLICY };
  try {
    if (contract.contract.allocation) {
      const roadmap = readSource(options.cwd, `.gsd/milestones/${options.milestone}/${options.milestone}-ROADMAP.md`), allocation = contract.contract.allocation;
      // With structure_sha256, the same structure (e.g. a checked box) is the same
      // allocation; without it the raw comparison is kept.
      let structural = false;
      if (roadmap.sha256 !== allocation.roadmap_sha256 && allocation.structure_sha256 && roadmap.status === 'valid') {
        try { structural = time.roadmapIdentity(roadmap.buffer).structure_sha256 === allocation.structure_sha256; } catch { structural = false; }
      }
      if (roadmap.sha256 !== allocation.roadmap_sha256 && !structural) return { status: 'unknown', reason: 'allocation-roadmap-mismatch', policy: FORECAST_POLICY };
    }
    const clock = readClock(options), slices = contract.contract.allocation?.items.filter(r => r.kind === 'slice').map(r => r.slice);
    return computeForecast({ contract: contract.contract, clock, deliveries: readHistoricalDeliveries({ ...options, ...(slices ? { slices } : {}) }) });
  } catch (e) { return { status: 'unknown', reason: sourceReason(e), policy: FORECAST_POLICY }; }
}
function main(argv = process.argv.slice(2), io = process, options = {}) {
  let cwd = '.', milestone;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd') cwd = argv[++i];
    else if (argv[i] === '--milestone') milestone = argv[++i];
    else if (argv[i] !== '--json') { io.stderr.write('Argumento inválido\n'); return 2; }
  }
  if (!milestone || !cwd) { io.stderr.write('Informe a milestone\n'); return 2; }
  const input = { cwd, milestone, now: options.now ?? Date.now(), ...(options.codeDir ? { codeDir: options.codeDir } : {}) };
  const result = { clock: readClock(input), forecast: readForecast(input) };
  io.stdout.write(JSON.stringify(result) + '\n'); return 0;
}
module.exports = { CLOCK_POLICY, FORECAST_POLICY, DELIVERY_PROOF_MODES, computeClock, readClock, readDeliveries, readHistoricalDeliveries, readHistoricalTaskDelivery, computeForecast, readForecast, main,
  ENDPOINT_PROOF_POLICY, readEndpointProof };
if (require.main === module) process.exitCode = main();
