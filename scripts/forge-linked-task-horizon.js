#!/usr/bin/env node
'use strict';

// Linked task horizon (S03/T04): the task's own clock, admission at every real provider
// entry, the task journal, the drain of the task writers, the immutable checkpoint at the
// cap, the attested extension of the task horizon and the read-only chain status.
//
// - Clock: the S01 consumption table (CLOCK_POLICY.consumption of forge-milestone-time-clock)
//   applied to the task sources. The horizon starts at start.json and ends at closure.json
//   (frozen) or now. Human waits whose pending-question source belongs to the task workflow
//   or to a task unit (still pending, or closed by wait-end) and explicit pauses do not
//   consume; everything else consumes and what has no source is reported as unknown_ms.
//   Worker effort stays unknown (task-worker-evidence-unavailable), never zero.
// - Ceiling: the link horizon plus the attested immutable extensions. The task ceiling never
//   becomes a worker timeout; the cap blocks only NEW admission and nothing here kills a
//   process, steals a lease or releases a claim.
// - Authority: only a NEW live opaque handle from the trusted host, verified by
//   forge-milestone-time.verifyDecision against an explicit persisted owner answer
//   (linked-task:extend:<ms>), extends the horizon. JSON, flags and the standalone CLI never do.
// - Writes: only through the T01 owner record API (active contract), inside the S02
//   ownerBoundary and between the task's protected windows (a held execution claim defers).
// Import is inert: only core modules load here; local modules are required late.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HORIZON_SCHEMA_VERSION = 1;
const TASK_CLOCK_POLICY = Object.freeze({ id: 'forge-linked-task-clock', version: 1 });
// Exact closed admission vocabulary consumed by the transports (T05). Distinct from the
// milestone codes: no milestone-budget-*, no budget-exceeded-while-active, no timeout.
const LINKED_TASK_TRANSPORT_CODES = Object.freeze(['predecessor-incomplete', 'linked-task-not-started', 'linked-task-budget-exhausted',
  'linked-task-budget-draining', 'linked-task-time-invalid', 'linked-task-clock-unknown', 'linked-task-chain-closed', 'linked-task-closed']);
const TASK_STATES = Object.freeze(['not-started', 'active', 'exhausted', 'draining', 'checkpointed', 'extended', 'completed', 'chain-closed', 'unknown']);
const TASK_DRAIN_STATES = Object.freeze(['not-applicable', 'draining', 'drained', 'incomplete-unknown']);
const TASK_WRITER_CLASSES = Object.freeze(['terminal', 'healthy', 'dead-requires-failure-consumption', 'saved-response-requires-publication', 'unknown']);
const TASK_CLAIM_STATES = Object.freeze(['absent', 'released', 'held', 'unknown']);
// Closed refusal vocabulary of the horizon writers (journal, checkpoint and extension).
const HORIZON_REFUSALS = Object.freeze(['linked-task-not-linked', 'linked-task-not-started', 'linked-task-closed', 'linked-task-chain-closed',
  'linked-task-time-invalid', 'linked-task-clock-unknown', 'linked-task-boundary-deferred', 'linked-task-not-exhausted', 'linked-task-drain-incomplete',
  'linked-task-checkpoint-conflict', 'linked-task-personal-conflict', 'linked-task-authorization-required', 'linked-task-authorization-revoked',
  'linked-task-extension-request-required', 'linked-task-extension-invalid', 'linked-task-extension-conflict', 'linked-task-question-census-unknown',
  'linked-task-operation-failed']);
// Units of a standalone task: the four preparation unit types (forge-task-preparation) and execution.
const TASK_UNIT_TYPES = Object.freeze(['plan-slice', 'discuss-milestone', 'research-milestone', 'plan-milestone', 'execute-task']);
// Exact key order of every horizon record (shared/schemas/forge-linked-task-horizon.schema.json).
const HORIZON_RECORD_FIELDS = Object.freeze({
  presence: Object.freeze(['type', 'session_sha256', 'boundary', 'at']),
  wait: Object.freeze(['type', 'wait_id', 'class', 'source', 'at']),
  checkpoint: Object.freeze(['schema_version', 'kind', 'milestone', 'task_id', 'link_sha256', 'start_sha256', 'version', 'horizon_sha256', 'policy',
    'ceiling_ms', 'consumed_ms', 'unknown_ms', 'overshoot_ms', 'drain', 'decision_pending', 'pending_decision', 'next_action', 'at']),
  drain: Object.freeze(['state', 'claim', 'writers']),
  writer: Object.freeze(['unit', 'classification', 'reason']),
  pending_decision: Object.freeze(['id', 'question', 'alternatives']),
  extension: Object.freeze(['schema_version', 'kind', 'milestone', 'task_id', 'link_sha256', 'start_sha256', 'sequence', 'previous_sha256',
    'previous_ceiling_ms', 'ceiling_ms', 'decision', 'extended_at']),
  decision: Object.freeze(['reference', 'question', 'answer', 'request_sha256']),
});
const KINDS = Object.freeze({ checkpoint: 'forge-linked-task-checkpoint', extension: 'forge-linked-task-extension' });
const CHECKPOINT_ALTERNATIVES = Object.freeze(['extend-task-horizon', 'close-chain']);
const CHECKPOINT_QUESTION = 'Estender o horizonte da task ligada por decisão explícita (linked-task:extend:<ms>) ou encerrar a cadeia (linked-task:close-chain)?';
const LINKED_SET = 'milestone-time-linked-task';
const MAX_EXTENSION_GENERATIONS = 8;
const MAX_WRITERS = 64, MAX_EXTENSIONS = 64, MAX_GAPS = 256, MAX_RUN = 1024 * 1024, MAX_RECEIPT = 8 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const MESSAGES = Object.freeze({
  'predecessor-incomplete': 'a milestone predecessora não está comprovada', 'linked-task-not-started': 'a task ligada ainda não foi iniciada',
  'linked-task-budget-exhausted': 'o horizonte da task ligada foi consumido', 'linked-task-budget-draining': 'o horizonte da task ligada foi consumido e há writer aberto',
  'linked-task-time-invalid': 'os registros de tempo da task ligada são inválidos', 'linked-task-clock-unknown': 'o relógio da task ligada é desconhecido',
  'linked-task-chain-closed': 'a cadeia foi encerrada por decisão explícita', 'linked-task-closed': 'a task ligada já foi encerrada',
  'linked-task-boundary-deferred': 'há uma janela protegida da task aberta', 'linked-task-authorization-required': 'falta uma reatestação viva e nova da decisão',
  'linked-task-extension-request-required': 'falta a resposta explícita persistida do operador para esta extensão',
  'linked-task-drain-incomplete': 'o drain dos writers da task não está completo', 'linked-task-not-exhausted': 'o horizonte da task ainda não foi consumido',
});

function fail(code, detail, extra) { throw Object.assign(new Error(code), { code, ...(detail ? { detail } : {}), ...(extra || {}) }); }
function object(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function exact(v, keys) { return object(v) && Object.keys(v).length === keys.length && keys.every((k, i) => Object.keys(v)[i] === k); }
function hash(v) { return typeof v === 'string' && HASH.test(v); }
function count(v) { return Number.isSafeInteger(v) && v >= 0; }
function positive(v) { return Number.isSafeInteger(v) && v > 0; }
function codeOf(e, fallback) { return typeof e?.code === 'string' && /^[a-z][a-z0-9-]{0,100}$/.test(e.code) ? e.code : fallback; }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
// Absolute timestamps: canonical ISO with exact round trip inside the representable Date range.
function instant(v) { return typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v; }
function validMs(v) { return Number.isSafeInteger(v) && Number.isFinite(new Date(v).getTime()); }
function isoOf(ms) { if (!validMs(ms)) fail('linked-task-time-invalid', 'instant-invalid'); return new Date(ms).toISOString(); }
function nowOf(input) { const now = input?.now ?? Date.now(); if (!validMs(now)) fail('linked-task-time-invalid', 'now-invalid'); return now; }
function time() { return require('./forge-milestone-time'); }
function selection() { return require('./forge-milestone-time-selection'); }
function linkedTask() { return require('./forge-linked-task'); }
function lifecycle() { return require('./forge-linked-task-start'); }
function endpoints() { return require('./forge-milestone-endpoint'); }
function clocks() { return require('./forge-milestone-time-clock'); }
function admission() { return require('./forge-milestone-time-admission'); }
function questions() { return require('./forge-pending-questions'); }
function personal() { return require('./forge-personal-context'); }
function digest(v) { return require('./forge-code-roots').digest(v); }
function typedId(value, kind) {
  const ids = require('./forge-ids');
  return typeof value === 'string' && !/[\\/\0]/.test(value) && ids.isValid(value) && ids.entityKind(value) === kind;
}
function samePath(a, b) { return process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b; }
function canonical(v) { return Array.isArray(v) ? v.map(canonical) : object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v; }
function same(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
function noLinks(file) {
  for (let cursor = path.resolve(file); ; cursor = path.dirname(cursor)) {
    let stat = null;
    try { stat = fs.lstatSync(cursor); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (stat && stat.isSymbolicLink()) fail('linked-task-time-invalid', 'path-link');
    if (path.dirname(cursor) === cursor) return;
  }
}
// Bounded, link-free, stable read; null only when the file is absent.
function boundedBytes(file, max) {
  noLinks(file);
  let stat; try { stat = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (!stat.isFile() || stat.size > max) fail('linked-task-time-invalid', 'source-unreadable');
  const read = require('./forge-autonomy-sources').readBoundedStableFile(file, max, { expectedReal: fs.realpathSync.native(file) });
  if (read.error) fail('linked-task-time-invalid', 'source-unstable');
  return read.buffer;
}
function ownerOf(input) { try { return selection().ownerRoot(input); } catch { fail('linked-task-time-invalid', 'owner-invalid'); } }
function taskOf(input) { return input.taskId ?? input.task; }
function recordRef(name) { return 'linked-task/' + name + '.json'; }
function recordSource(owner, milestone, relative) { return path.join(owner, '.gsd', 'forge', 'time', milestone, ...relative.split('/')); }

// ---------------------------------------------------------------------------
// Link probe, lifecycle records and the immutable extension chain
// ---------------------------------------------------------------------------
// null for an unlinked task (index absent and no BRIEF marker; no time state is read).
function probeOf(owner, task) {
  const probe = linkedTask().linkedTaskFor(owner, task);
  if (probe === null) return null;
  if (probe.status !== 'linked') fail('linked-task-time-invalid', typeof probe.reason === 'string' ? probe.reason : 'link-invalid');
  return probe;
}
function probeByMilestone(owner, milestone) {
  if (!typedId(milestone, 'milestone')) fail('linked-task-time-invalid', 'milestone-invalid');
  const read = time().readOwnerRecord({ cwd: owner, milestone, path: 'linked-task/link.json' });
  if (read.status === 'absent') return null;
  if (read.status !== 'valid' || !typedId(read.record?.task_id, 'task')) fail('linked-task-time-invalid', 'link-invalid');
  const probe = probeOf(owner, read.record.task_id);
  if (!probe || probe.milestone !== milestone || probe.link_sha256 !== read.sha256) fail('linked-task-time-invalid', 'link-invalid');
  return probe;
}
// The lifecycle (T03) and its immutable start / closure / chain-closure records bound to this link.
function lifecycleOf(owner, probe) {
  const state = lifecycle().linkedLifecycle(owner, probe.task_id);
  if (!state || state.status === 'invalid' || state.link_sha256 !== probe.link_sha256) fail('linked-task-time-invalid', 'lifecycle-invalid');
  const out = { status: state.status, start: null, closure: null, chainClosure: null };
  for (const [key, name, sha] of [['start', 'start', state.start_sha256], ['closure', 'closure', state.closure_sha256], ['chainClosure', 'chain-closure', state.chain_closure_sha256]]) {
    if (sha === undefined) continue;
    const read = time().readOwnerRecord({ cwd: owner, milestone: probe.milestone, path: recordRef(name) });
    if (read.status !== 'valid' || read.sha256 !== sha) fail('linked-task-time-invalid', name + '-changed');
    out[key] = { record: read.record, sha256: read.sha256 };
  }
  if (out.start && !instant(out.start.record.started_at)) fail('linked-task-time-invalid', 'start-instant');
  if (out.closure && (!instant(out.closure.record.closed_at) || out.closure.record.start_sha256 !== out.start?.sha256
      || Date.parse(out.closure.record.closed_at) < Date.parse(out.start.record.started_at))) fail('linked-task-time-invalid', 'closure-instant');
  if (out.chainClosure && !instant(out.chainClosure.record.closed_at)) fail('linked-task-time-invalid', 'chain-closure-instant');
  return out;
}
function decisionValid(v) {
  return exact(v, HORIZON_RECORD_FIELDS.decision) && (v.reference === null || typeof v.reference === 'string' && v.reference.length <= 120)
    && exact(v.question, ['identity_sha256', 'id']) && hash(v.question.identity_sha256) && typeof v.question.id === 'string' && v.question.id.length <= 120
    && typeof v.answer === 'string' && hash(v.request_sha256);
}
function extensionValid(v) {
  return exact(v, HORIZON_RECORD_FIELDS.extension) && v.schema_version === HORIZON_SCHEMA_VERSION && v.kind === KINDS.extension
    && typedId(v.milestone, 'milestone') && typedId(v.task_id, 'task') && hash(v.link_sha256) && hash(v.start_sha256) && positive(v.sequence)
    && hash(v.previous_sha256) && positive(v.previous_ceiling_ms) && positive(v.ceiling_ms) && v.ceiling_ms > v.previous_ceiling_ms
    && decisionValid(v.decision) && v.decision.answer === 'linked-task:extend:' + v.ceiling_ms && instant(v.extended_at) && time().isPublicData(v);
}
function writerRowValid(r) {
  return exact(r, HORIZON_RECORD_FIELDS.writer) && typeof r.unit === 'string' && /^[a-z][a-z0-9-]{1,50}\/[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(r.unit)
    && r.classification === 'terminal' && typeof r.reason === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(r.reason);
}
function checkpointValid(v) {
  return exact(v, HORIZON_RECORD_FIELDS.checkpoint) && v.schema_version === HORIZON_SCHEMA_VERSION && v.kind === KINDS.checkpoint
    && typedId(v.milestone, 'milestone') && typedId(v.task_id, 'task') && hash(v.link_sha256) && hash(v.start_sha256) && positive(v.version)
    && hash(v.horizon_sha256) && exact(v.policy, ['id', 'version']) && v.policy.id === TASK_CLOCK_POLICY.id && v.policy.version === TASK_CLOCK_POLICY.version
    && positive(v.ceiling_ms) && count(v.consumed_ms) && v.consumed_ms >= v.ceiling_ms && count(v.unknown_ms) && v.unknown_ms <= v.consumed_ms
    && v.overshoot_ms === v.consumed_ms - v.ceiling_ms
    && exact(v.drain, HORIZON_RECORD_FIELDS.drain) && v.drain.state === 'drained' && ['absent', 'released'].includes(v.drain.claim)
    && Array.isArray(v.drain.writers) && v.drain.writers.length <= MAX_WRITERS && v.drain.writers.every(writerRowValid)
    && v.decision_pending === true && exact(v.pending_decision, HORIZON_RECORD_FIELDS.pending_decision)
    && v.pending_decision.id === checkpointDecisionId(v.link_sha256, v.version) && v.pending_decision.question === CHECKPOINT_QUESTION
    && same(v.pending_decision.alternatives, CHECKPOINT_ALTERNATIVES) && v.next_action === v.pending_decision.id + ': ' + CHECKPOINT_QUESTION
    && instant(v.at) && time().isPublicData(v);
}
function checkpointDecisionId(linkSha, version) { return 'linked-task-cap-' + linkSha.slice(0, 12) + '-v' + version; }
// The persisted counterpart of an extension decision: the explicit answered owner question of this
// link (milestone M, task T, workflow T) in the linked-task set whose answer names the ceiling.
// The question spec (any decision generation) an extension record was attested by; null if none matches.
function specOfExtension(probe, row) {
  for (let generation = 1; generation <= MAX_EXTENSION_GENERATIONS; generation++) {
    const spec = extensionSpec(probe, row.sequence, row.ceiling_ms, generation);
    if (row.decision.question.identity_sha256 === spec.identity && row.decision.question.id === spec.id) return spec;
  }
  return null;
}
function extensionAttested(owner, probe, row) {
  try {
    const spec = specOfExtension(probe, row);
    if (!spec || row.decision.request_sha256 !== digest(spec.request)) return false;
    const state = questions().continuation({ cwd: owner, identity: spec.identity });
    const stored = state.ok ? state.questions.find(q => q.id === spec.id) : null;
    return state.identity?.origin === 'owner' && state.identity.milestone === probe.milestone && state.identity.task === probe.task_id
      && state.identity.workflow_id === probe.task_id && state.identity.decision_set === LINKED_SET && stored?.status === 'resolved' && stored.answer === spec.answer;
  } catch { return false; }
}
// Ceiling = link horizon + attested extensions; any foreign, unchained or unattested row fails closed.
function horizonOf(owner, probe, start) {
  const base = probe.link?.linked_task?.horizon?.ceiling_ms;
  if (!positive(base)) fail('linked-task-time-invalid', 'link-horizon-invalid');
  const listed = time().listOwnerRecords({ cwd: owner, milestone: probe.milestone, path: 'linked-task/extensions' });
  if (listed.status !== 'valid') fail('linked-task-time-invalid', 'extensions-unreadable');
  if (listed.records.length > MAX_EXTENSIONS) fail('linked-task-time-invalid', 'extension-limit');
  const rows = listed.records.slice().sort((a, b) => a.id.localeCompare(b.id));
  let ceiling = base, head = start ? start.sha256 : null;
  const extensions = [];
  for (const [index, row] of rows.entries()) {
    const r = row.record;
    if (!start) fail('linked-task-time-invalid', 'extension-before-start');
    if (row.id !== String(index + 1).padStart(4, '0') || !extensionValid(r) || r.sequence !== index + 1 || r.milestone !== probe.milestone
        || r.task_id !== probe.task_id || r.link_sha256 !== probe.link_sha256 || r.start_sha256 !== start.sha256 || r.previous_sha256 !== head
        || r.previous_ceiling_ms !== ceiling || Date.parse(r.extended_at) < Date.parse(start.record.started_at)) fail('linked-task-time-invalid', 'extension-chain-invalid');
    if (!extensionAttested(owner, probe, r)) fail('linked-task-time-invalid', 'extension-unattested');
    ceiling = r.ceiling_ms; head = row.sha256;
    extensions.push({ sequence: r.sequence, ceiling_ms: r.ceiling_ms, sha256: row.sha256 });
  }
  return { base_ceiling_ms: base, ceiling_ms: ceiling, extensions, head_sha256: head, version: extensions.length + 1 };
}
function checkpointsOf(owner, probe, start, horizon) {
  const listed = time().listOwnerRecords({ cwd: owner, milestone: probe.milestone, path: 'linked-task/checkpoints' });
  if (listed.status !== 'valid') fail('linked-task-time-invalid', 'checkpoints-unreadable');
  const out = [];
  for (const row of listed.records) {
    const r = row.record;
    if (!checkpointValid(r) || row.id !== String(r.version) || r.milestone !== probe.milestone || r.task_id !== probe.task_id || r.link_sha256 !== probe.link_sha256
        || !start || r.start_sha256 !== start.sha256 || r.version > horizon.version) fail('linked-task-time-invalid', 'checkpoint-invalid');
    const generation = r.version === 1 ? start.sha256 : horizon.extensions[r.version - 2]?.sha256;
    const ceiling = r.version === 1 ? horizon.base_ceiling_ms : horizon.extensions[r.version - 2]?.ceiling_ms;
    if (r.horizon_sha256 !== generation || r.ceiling_ms !== ceiling) fail('linked-task-time-invalid', 'checkpoint-unbound');
    out.push({ record: r, sha256: row.sha256 });
  }
  return { records: out, current: out.find(c => c.record.version === horizon.version) || null };
}

// ---------------------------------------------------------------------------
// Task clock
// ---------------------------------------------------------------------------
// Questions of the task: its workflow view and every task unit view. An unreadable, invalid or
// excess census is incomplete: an unconfirmed wait then consumes as unknown, never as zero.
function taskQuestions(owner, task) {
  const seen = new Map(); let complete = true;
  for (const filter of [{ type: 'workflow', id: task }, ...TASK_UNIT_TYPES.map(type => ({ type: 'unit', id: type + '/' + task }))]) {
    let listed;
    try { listed = questions().listPendingQuestions({ cwd: owner, filter }); } catch { complete = false; continue; }
    if (listed.census.invalid || listed.census.excess || !['no-questions', 'no-matching-questions', null].includes(listed.empty_reason)) complete = false;
    for (const q of listed.questions) {
      const own = filter.type === 'workflow' ? q.origin?.workflow_id === task : q.origin?.unit === filter.id;
      if (own) seen.set(digest(q.origin) + ':' + q.id, q.status);
    }
  }
  return { seen, complete };
}
// Pure: the S01 class priority and consumption table over [start, end]; overlaps never add twice.
function computeTaskClock({ start, end, journal, census, frozen = false }) {
  const { CLOCK_POLICY } = clocks(), { unionDuration } = require('./forge-autonomy');
  const CLASSES = CLOCK_POLICY.priority, CONSUMES = CLOCK_POLICY.consumption;
  const spans = [], reasons = [], unknowns = new Set();
  const add = (kind, a, b, reason) => {
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) fail('linked-task-time-invalid', 'interval-invalid');
    const left = Math.max(start, a), right = Math.min(end, b);
    if (right > left) (reason ? reasons : spans).push({ start: left, end: right, class: kind, ...(reason ? { reason } : {}) });
  };
  const sessions = new Map(), waits = new Map();
  // A question wait is confirmed only by a complete census of the task views; otherwise it stays unknown.
  const question = ref => {
    if (!census.complete) { unknowns.add('question-census-unknown'); return undefined; }
    return census.seen.get(ref);
  };
  let previous = null;
  const ordered = journal.map((r, index) => ({ r, at: Date.parse(r.at), index })).sort((a, b) => a.at - b.at || a.index - b.index);
  for (const { r, at } of ordered) {
    if (!Number.isFinite(at)) fail('linked-task-time-invalid', 'journal-instant');
    if (at > end) continue;
    if (r.type === 'presence') {
      const last = r.session_sha256 && sessions.get(r.session_sha256);
      if (last !== undefined && last !== null && r.boundary !== 'session-start') add('owner-session', last, at);
      if (previous && previous.session !== r.session_sha256) add('unknown', previous.at, at, 'session-change');
      if (r.session_sha256) { if (r.boundary === 'session-end') sessions.delete(r.session_sha256); else sessions.set(r.session_sha256, at); }
      else sessions.clear();
      previous = { session: r.session_sha256, at };
    } else if (r.type === 'wait-start') waits.set(r.wait_id, r);
    else {
      const first = waits.get(r.wait_id);
      if (!first) fail('linked-task-time-invalid', 'wait-end-orphan');
      const kind = first.class === 'pause' ? 'pause' : first.class + '-wait';
      if (first.class === 'human' && !(first.source.kind === 'pending-question' && question(first.source.ref) !== undefined)) add('unknown', Date.parse(first.at), at, 'wait-end-missing');
      else add(kind, Date.parse(first.at), at);
      waits.delete(r.wait_id);
    }
  }
  // A wait still open at the end of a live horizon needs its question still pending. At a frozen
  // closure the horizon ended while the wait was open: a later answer never reclassifies it.
  for (const first of waits.values()) {
    const human = first.class === 'human', state = human && first.source.kind === 'pending-question' ? question(first.source.ref) : undefined;
    const pending = frozen ? state !== undefined : state === 'pending';
    if (!human || pending) add(first.class === 'pause' ? 'pause' : first.class + '-wait', Date.parse(first.at), end);
    else add('unknown', Date.parse(first.at), end, 'wait-end-missing');
  }
  const points = new Map([[start, []], [end, []]]);
  for (const span of [...spans, ...reasons]) for (const [at, delta] of [[span.start, 1], [span.end, -1]]) {
    if (!points.has(at)) points.set(at, []);
    points.get(at).push({ key: span.reason || span.class, reason: !!span.reason, delta });
  }
  const boundaries = [...points.keys()].sort((a, b) => a - b), activeClasses = new Map(), activeReasons = new Map();
  const byClass = Object.fromEntries(CLASSES.map(k => [k, 0])), gaps = [];
  for (let i = 1; i < boundaries.length; i++) {
    const a = boundaries[i - 1], b = boundaries[i];
    for (const change of points.get(a)) { const m = change.reason ? activeReasons : activeClasses; m.set(change.key, (m.get(change.key) || 0) + change.delta); }
    const kind = CLASSES.find(k => activeClasses.get(k) > 0) || 'unknown';
    byClass[kind] += b - a;
    if (kind === 'unknown') {
      const reason = ['wait-end-missing', 'session-change', 'source-limit', 'no-source'].find(k => activeReasons.get(k) > 0) || 'no-source';
      const last = gaps.at(-1);
      if (last && last.end === a && last.reason === reason) last.end = b; else gaps.push({ start: a, end: b, reason });
    }
  }
  // owner-session is the highest class a task source can produce: its total is the union of its spans.
  const sessionSpans = spans.filter(s => s.class === 'owner-session');
  if (unionDuration(sessionSpans) !== byClass['owner-session']) fail('linked-task-time-invalid', 'union-mismatch');
  const raw = spans.reduce((sum, s) => sum + (s.end - s.start), 0), covered = unionDuration(spans);
  const consumed = CLASSES.filter(k => CONSUMES[k]).reduce((sum, k) => sum + byClass[k], 0);
  return { consumption: { consumed_ms: consumed, unknown_ms: byClass.unknown, by_class: byClass }, overlap_ms: raw - covered,
    waits: Object.fromEntries(CLASSES.filter(k => !CONSUMES[k]).map(k => [k, byClass[k]])), gaps, unknowns: [...unknowns] };
}
// The clock retained in the closure record, re-verified against the policy, the closure instants (the classes
// partition the whole horizon) and the consumption table before it is trusted; any mismatch fails closed.
function retainedClock(stored, startMs, endMs) {
  const { CLOCK_POLICY } = clocks(), CLASSES = CLOCK_POLICY.priority, CONSUMES = CLOCK_POLICY.consumption, by = stored.consumption.by_class;
  const waits = Object.fromEntries(CLASSES.filter(k => !CONSUMES[k]).map(k => [k, by[k]]));
  const consumed = CLASSES.filter(k => CONSUMES[k]).reduce((sum, k) => sum + by[k], 0);
  if (stored.policy.id !== TASK_CLOCK_POLICY.id || stored.policy.version !== TASK_CLOCK_POLICY.version
      || Object.keys(by).length !== CLASSES.length || !CLASSES.every(k => Number.isSafeInteger(by[k]))
      || CLASSES.reduce((sum, k) => sum + by[k], 0) !== endMs - startMs || consumed !== stored.consumption.consumed_ms || by.unknown !== stored.consumption.unknown_ms
      || !same(waits, stored.waits)) fail('linked-task-time-invalid', 'closure-clock-invalid');
  return { status: 'measured', frozen: true, retained: true, start_ms: startMs, end_ms: endMs, journal_records: stored.journal_records,
    consumption: { consumed_ms: consumed, unknown_ms: by.unknown, by_class: { ...by } }, overlap_ms: stored.overlap_ms, waits,
    gaps: stored.gaps.map(g => ({ start: g.start, end: g.end, reason: g.reason })), gap_count: stored.gap_count, unknowns: [...stored.unknowns] };
}
// closureClock({cwd, task, now}): bounded projection of the live clock of a started, not yet closed task at
// `now`, retained by closeLinkedTask in the immutable closure record. null when it cannot be measured.
function closureClock(input = {}) {
  try {
    if (!object(input)) return null;
    const owner = ownerOf(input), now = nowOf(input), probe = probeOf(owner, taskOf(input));
    if (probe === null) return null;
    const life = lifecycleOf(owner, probe);
    if (!life.start || life.closure) return null;
    const clock = clockOf(owner, probe, life, now);
    if (clock.status !== 'measured') return null;
    return { policy: { id: TASK_CLOCK_POLICY.id, version: TASK_CLOCK_POLICY.version },
      consumption: { consumed_ms: clock.consumption.consumed_ms, unknown_ms: clock.consumption.unknown_ms, by_class: { ...clock.consumption.by_class } },
      waits: { ...clock.waits }, overlap_ms: clock.overlap_ms, gaps: clock.gaps.slice(0, 64).map(g => ({ start: g.start, end: g.end, reason: g.reason })),
      gap_count: clock.gaps.length, journal_records: clock.journal_records, unknowns: [...clock.unknowns].slice(0, 16) };
  } catch { return null; }
}
function clockOf(owner, probe, life, now) {
  if (!life.start) return { status: 'not-started' };
  const startMs = Date.parse(life.start.record.started_at);
  const frozen = !!life.closure, end = frozen ? Date.parse(life.closure.record.closed_at) : now;
  if (!frozen && now < startMs) return { status: 'unknown', reason: 'clock-now-invalid' };
  const journal = time().readOwnerJournal({ cwd: owner, milestone: probe.milestone });
  if (journal.status === 'invalid') fail('linked-task-time-invalid', 'journal-invalid');
  for (const r of journal.records) if (!instant(r.at) || Date.parse(r.at) < startMs) fail('linked-task-time-invalid', 'journal-outside-horizon');
  // A closed horizon with a retained clock never consults today's question census: unrelated later growth of
  // the global census cannot reclassify a past confirmed wait (the live horizon keeps its conservative handling).
  if (frozen && life.closure.record.clock !== undefined) return retainedClock(life.closure.record.clock, startMs, end);
  const census = taskQuestions(owner, probe.task_id);
  const computed = computeTaskClock({ start: startMs, end, journal: journal.records, census, frozen });
  return { status: 'measured', frozen, start_ms: startMs, end_ms: end, journal_records: journal.records.length, ...computed };
}
function clockView(probe, life, clock, now) {
  const { CLOCK_POLICY } = clocks();
  if (clock.status !== 'measured') return { status: clock.status, policy: TASK_CLOCK_POLICY, task_id: probe.task_id, milestone: probe.milestone, ...(clock.reason ? { reason: clock.reason } : {}) };
  return { status: 'measured', policy: TASK_CLOCK_POLICY, consumption_policy: { id: CLOCK_POLICY.id, version: CLOCK_POLICY.version },
    task_id: probe.task_id, milestone: probe.milestone, start_sha256: life.start.sha256, frozen: clock.frozen,
    horizon: { started_at: life.start.record.started_at, ended_at: clock.frozen ? life.closure.record.closed_at : null, end: clock.frozen ? 'closure' : 'now' },
    now, elapsed_ms: clock.end_ms - clock.start_ms, consumption: clock.consumption, waits: clock.waits, overlap_ms: clock.overlap_ms,
    gaps: clock.gaps.slice(0, MAX_GAPS).map(g => ({ start: isoOf(g.start), end: isoOf(g.end), reason: g.reason })), gap_count: clock.gap_count ?? clock.gaps.length,
    gaps_truncated: (clock.gap_count ?? clock.gaps.length) > Math.min(clock.gaps.length, MAX_GAPS), effort: { worker: { status: 'unknown', reason: 'task-worker-evidence-unavailable' } },
    journal_records: clock.journal_records, unknowns: clock.unknowns };
}
// readTaskClock({cwd, task, now}): pure read; never throws.
function readTaskClock(input = {}) {
  try {
    if (!object(input)) fail('linked-task-time-invalid');
    const owner = ownerOf(input), now = nowOf(input), probe = probeOf(owner, taskOf(input));
    if (probe === null) return { status: 'unlinked', policy: TASK_CLOCK_POLICY, task_id: typedId(taskOf(input), 'task') ? taskOf(input) : null };
    // The whole horizon (extension chain and checkpoints included) is validated: tampering fails closed.
    const state = horizonState(owner, probe, now);
    return clockView(probe, state.life, state.clock, now);
  } catch (e) {
    const reason = codeOf(e, 'linked-task-time-invalid');
    return { status: 'invalid', policy: TASK_CLOCK_POLICY, reason: HORIZON_REFUSALS.includes(reason) ? reason : 'linked-task-time-invalid', ...(typeof e.detail === 'string' ? { detail: e.detail } : {}) };
  }
}

// ---------------------------------------------------------------------------
// Run claim (read only) and the derived task state
// ---------------------------------------------------------------------------
function runClaim(owner, task) {
  try {
    const bytes = boundedBytes(path.join(owner, '.gsd', 'forge', 'runs', task + '.json'), MAX_RUN);
    if (bytes === null) return { status: 'unknown', reason: 'run-missing' };
    const run = JSON.parse(bytes.toString('utf8'));
    if (!object(run) || run.id !== task || run.kind !== 'task') return { status: 'unknown', reason: 'run-invalid' };
    const raw = run.write_claim;
    if (raw === null || raw === undefined) return { status: 'absent', run };
    const held = require('./forge-write-claim').isHeld(raw);
    return { status: held ? 'held' : 'released', run, claim: raw, generation: object(raw) && typeof raw.generation === 'string' ? raw.generation : null };
  } catch { return { status: 'unknown', reason: 'run-unreadable' }; }
}
function deriveState({ life, clock, horizon, checkpoint, writersOpen, censusKnown }) {
  if (life.status === 'chain-closed') return 'chain-closed';
  if (life.status === 'closed') return 'completed';
  if (!life.start) return 'not-started';
  if (clock.status !== 'measured') return 'unknown';
  const remaining = horizon.ceiling_ms - clock.consumption.consumed_ms;
  if (remaining <= 0) return writersOpen || !censusKnown ? 'draining' : checkpoint ? 'checkpointed' : 'exhausted';
  return horizon.extensions.length ? 'extended' : 'active';
}
// The complete read-only horizon of one started link (lifecycle, clock, ceiling and checkpoint).
function horizonState(owner, probe, now) {
  const life = lifecycleOf(owner, probe), horizon = horizonOf(owner, probe, life.start);
  const checkpoints = checkpointsOf(owner, probe, life.start, horizon), clock = clockOf(owner, probe, life, now);
  return { life, horizon, checkpoints, clock };
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------
function unitOf(value, task) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{1,50}\/[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value) || value.slice(value.indexOf('/') + 1) !== task) fail('linked-task-time-invalid', 'unit-invalid');
  return value;
}
function refuse(code, details) { return { allowed: false, reason_code: code, details }; }
// decideLinkedTaskEntry({cwd, taskId, unit, now, claimGeneration, reportedAttempts}). The unlinked
// fast path reads no time state. Never throws; never computes a worker timeout.
function decideLinkedTaskEntry(input = {}) {
  let probe = null;
  try {
    if (!object(input)) fail('linked-task-time-invalid');
    const owner = ownerOf(input), task = taskOf(input);
    probe = probeOf(owner, task);
    if (probe === null) return { allowed: true, decision: 'unlinked' };
    const now = nowOf(input), unit = unitOf(input.unit, probe.task_id);
    const life = lifecycleOf(owner, probe), base = { task_id: probe.task_id, milestone: probe.milestone, unit, lifecycle: life.status };
    if (life.status === 'chain-closed') return refuse('linked-task-chain-closed', base);
    if (life.status === 'closed') return refuse('linked-task-closed', base);
    if (life.status === 'blocked') return refuse('predecessor-incomplete', base);
    if (life.status !== 'started') return refuse('linked-task-not-started', base);
    // The consumed evidence (start, witness, handoff, endpoint and the BRIEF block) must still be exact.
    try { lifecycle().consumedHandoffBlock(owner, probe.task_id); }
    catch (e) { const code = codeOf(e); return refuse(code === 'linked-task-chain-closed' ? code : code === 'linked-task-not-started' ? code : 'linked-task-time-invalid', base); }
    // A close-chain decision opened or answered after this entry was selected still blocks the actual provider
    // entry (bounded read-only census; fail closed). Classified in the frozen transport vocabulary: an answered
    // closing decision is the chain being closed; a pending/unknown one keeps its reason and pending IDs in details.
    try { lifecycle().requireEntryDecisionsClear(owner, probe.task_id); }
    catch (e) {
      const code = codeOf(e);
      return refuse(code === 'linked-task-authorization-revoked' ? 'linked-task-chain-closed' : 'linked-task-time-invalid',
        { ...base, decision: typeof e.detail === 'string' ? e.detail : code, ...(Array.isArray(e.pending_ids) ? { pending_ids: e.pending_ids.slice(0, 16) } : {}) });
    }
    const horizon = horizonOf(owner, probe, life.start), checkpoints = checkpointsOf(owner, probe, life.start, horizon);
    const clock = clockOf(owner, probe, life, now);
    const details = { ...base, start_sha256: life.start.sha256, ceiling_ms: horizon.ceiling_ms, base_ceiling_ms: horizon.base_ceiling_ms, extensions: horizon.extensions.length,
      consumed_ms: clock.status === 'measured' ? clock.consumption.consumed_ms : null, unknown_ms: clock.status === 'measured' ? clock.consumption.unknown_ms : null,
      remaining_ms: clock.status === 'measured' ? horizon.ceiling_ms - clock.consumption.consumed_ms : null, checkpoint: checkpoints.current ? checkpoints.current.record.version : null };
    if (clock.status !== 'measured') return refuse('linked-task-clock-unknown', details);
    if (details.remaining_ms <= 0) {
      const claim = runClaim(owner, probe.task_id), own = typeof input.claimGeneration === 'string' && input.claimGeneration;
      const otherClaim = claim.status === 'unknown' || claim.status === 'held' && (!own || claim.generation !== own);
      const reported = Array.isArray(input.reportedAttempts) && input.reportedAttempts.some(a => !object(a) || a.unit !== unit);
      return refuse(otherClaim || reported ? 'linked-task-budget-draining' : 'linked-task-budget-exhausted', { ...details, claim: claim.status });
    }
    return { allowed: true, decision: 'admitted', task_id: probe.task_id, milestone: probe.milestone, unit, consumed_ms: details.consumed_ms, ceiling_ms: horizon.ceiling_ms,
      unknown_ms: details.unknown_ms, remaining_ms: details.remaining_ms, start_sha256: life.start.sha256, policy: TASK_CLOCK_POLICY, at: isoOf(now) };
  } catch (e) {
    const code = codeOf(e);
    return refuse(['linked-task-time-invalid', 'linked-task-clock-unknown'].includes(code) ? code : 'linked-task-time-invalid',
      { task_id: probe?.task_id ?? null, ...(typeof e.detail === 'string' ? { detail: e.detail } : {}) });
  }
}
function assertLinkedTaskEntry(input = {}) {
  const result = decideLinkedTaskEntry(input);
  if (!result.allowed) throw Object.assign(new Error('Entrada recusada pelo horizonte da task ligada'), {
    code: LINKED_TASK_TRANSPORT_CODES.includes(result.reason_code) ? result.reason_code : 'linked-task-time-invalid', provider_called: false,
    stage: 'linked-task-admission', layer: 'milestone-time-admission', details: result.details });
  return result;
}

// ---------------------------------------------------------------------------
// Owner writes between the task's protected windows
// ---------------------------------------------------------------------------
// The S02 owner boundary of the milestone, plus the task window: a held (or unreadable) execution
// claim of the task defers the write; the claim is only read, never released.
function taskBoundary(owner, probe, fn) {
  const result = selection().ownerBoundary(owner, probe.milestone, () => {
    const claim = runClaim(owner, probe.task_id);
    if (claim.status === 'held' || claim.status === 'unknown') return { status: 'deferred', reason: claim.status === 'held' ? 'task-execution-claim-held' : 'task-claim-unknown' };
    return fn();
  });
  if (result?.status === 'deferred') fail('linked-task-boundary-deferred', typeof result.reason === 'string' ? result.reason : 'deferred');
  return result;
}
function requireOpen(life) {
  if (life.status === 'chain-closed') fail('linked-task-chain-closed');
  if (life.status === 'closed') fail('linked-task-closed');
  if (!life.start) fail('linked-task-not-started');
}
function writeAnswer(probe, e, wrote, extra = {}) {
  const code = codeOf(e, 'linked-task-operation-failed'), known = HORIZON_REFUSALS.includes(code);
  return { status: wrote || e.committed ? 'partial' : 'refused', task_id: probe?.task_id ?? null, reason: known ? code : 'linked-task-operation-failed',
    ...(typeof e.detail === 'string' ? { detail: e.detail } : !known ? { detail: code } : {}), ...extra };
}
function journalRecordOf(r) {
  if (!object(r)) fail('linked-task-time-invalid', 'journal-record-invalid');
  if (r.type === 'presence') {
    const out = { type: 'presence', session_sha256: r.session_sha256 ?? null, boundary: r.boundary, at: r.at };
    if (!exact(out, HORIZON_RECORD_FIELDS.presence) || Object.keys(r).some(k => !HORIZON_RECORD_FIELDS.presence.includes(k))) fail('linked-task-time-invalid', 'journal-record-invalid');
    return out;
  }
  if (['wait-start', 'wait-end'].includes(r.type)) {
    if (Object.keys(r).some(k => !HORIZON_RECORD_FIELDS.wait.includes(k))) fail('linked-task-time-invalid', 'journal-record-invalid');
    return { type: r.type, wait_id: r.wait_id, class: r.class, source: object(r.source) ? { kind: r.source.kind, ref: r.source.ref } : r.source, at: r.at };
  }
  fail('linked-task-time-invalid', 'journal-record-invalid');
}
// appendTaskJournal({cwd, task, record}): presence / wait-start / wait-end of the started task.
// After the closure the journal is frozen (linked-task-closed); a refused append writes nothing.
function appendTaskJournal(input = {}) {
  let probe = null, wrote = false;
  try {
    if (!object(input)) fail('linked-task-time-invalid');
    const owner = ownerOf(input);
    probe = probeOf(owner, taskOf(input));
    if (probe === null) fail('linked-task-not-linked');
    const record = journalRecordOf(input.record);
    if (!instant(record.at)) fail('linked-task-time-invalid', 'journal-instant');
    const life = lifecycleOf(owner, probe);
    requireOpen(life);
    if (Date.parse(record.at) < Date.parse(life.start.record.started_at)) fail('linked-task-time-invalid', 'journal-before-start');
    return taskBoundary(owner, probe, () => {
      // Revalidated inside the boundary: a legitimate closure in between freezes the journal.
      const again = lifecycleOf(owner, probe);
      requireOpen(again);
      if (again.start.sha256 !== life.start.sha256) fail('linked-task-time-invalid', 'start-changed');
      let appended;
      try { appended = time().appendOwnerJournal({ cwd: owner, milestone: probe.milestone, record }); }
      catch (e) { fail('linked-task-time-invalid', codeOf(e, 'journal-refused')); }
      wrote = true;
      return { status: 'appended', task_id: probe.task_id, milestone: probe.milestone, type: record.type, count: appended.count };
    });
  } catch (e) { return writeAnswer(probe, e, wrote); }
}

// ---------------------------------------------------------------------------
// Drain of the task writers (live in-process host adapters only)
// ---------------------------------------------------------------------------
// One reported attempt projected onto the canonical writer classes from forge-attempt-recovery
// inspectReceipt: no second liveness policy, no PID/clock inference, nothing killed or released.
function classifyTaskAttempt(owner, probe, attempt, adapter, reads) {
  const unknown = reason => ({ classification: 'unknown', state: 'inspection-required', reason });
  if (!object(attempt) || typeof attempt.unit !== 'string' || !/^[a-z][a-z0-9-]{1,50}\/[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(attempt.unit)
      || attempt.unit.slice(attempt.unit.indexOf('/') + 1) !== probe.task_id || typeof attempt.receipt_path !== 'string' || !path.isAbsolute(attempt.receipt_path)
      || !object(attempt.request)) return unknown('attempt-evidence-invalid');
  let bytes;
  try { bytes = boundedBytes(attempt.receipt_path, MAX_RECEIPT); } catch { return unknown('receipt-unreadable'); }
  if (bytes === null) return unknown('receipt-missing');
  reads.push({ file: attempt.receipt_path, sha256: sha256(bytes) });
  const recovery = require('./forge-attempt-recovery');
  let request, identity;
  try { request = recovery.canonicalRequest(attempt.request); identity = recovery.requestIdentity(request); } catch { return unknown('attempt-identity-mismatch'); }
  if (identity.scope !== 'standalone-task' || identity.task_id !== probe.task_id || `${identity.unit_type}/${probe.task_id}` !== attempt.unit) return unknown('attempt-identity-mismatch');
  let probeResult = 'unknown', inspection;
  try {
    inspection = recovery.inspectReceipt(attempt.receipt_path, { request: attempt.request, processProbe: receipt => { probeResult = adapter.processProbe(structuredClone(receipt)); return probeResult; } });
  } catch { return unknown('receipt-unreadable'); }
  const receipt = inspection.receipt;
  let bound = false;
  try {
    bound = !!receipt && (receipt.recovery_identity_sha256 === digest(identity)
      || typeof receipt.fingerprint === 'string' && receipt.fingerprint === require('./forge-unit-sidecar').artifactFingerprint(attempt.request));
  } catch { bound = false; }
  if (!bound) return unknown('receipt-identity-mismatch');
  if (!['alive', 'stopped'].includes(probeResult)) return unknown('process-probe-unknown');
  if (inspection.process_stopped !== true) return { classification: 'healthy', state: 'waiting-own-ceiling', reason: 'process-alive' };
  // A released claim (even of the attempt's own generation) proves neither the publication of a
  // saved response nor the consumption of a failure: it never turns a stopped writer terminal.
  // A stopped ready/executed/saved_candidate result always still requires its original publication.
  if (inspection.valid_saved_response) return { classification: 'saved-response-requires-publication', state: 'original-publication-required', reason: 'saved-response-replay-required' };
  // Only the canonical pre-provider stop is terminal: the live probe attested the stopped process,
  // the receipt never reached the provider, never executed and carries no saved result.
  const providerNever = receipt.provider_called !== true && receipt.failure?.provider_called !== true
    && (receipt.provider_called === false || receipt.failure?.provider_called === false);
  if (providerNever && !receipt.execution && !receipt.saved_candidate && !['ready', 'executed', 'abandoned'].includes(inspection.phase)) {
    return { classification: 'terminal', state: 'reconciled', reason: 'pre-provider-stop' };
  }
  if (['failed', 'abandoned'].includes(inspection.phase) && typeof receipt.failure?.reason_code === 'string' && receipt.failure.reason_code.trim()) {
    return { classification: 'dead-requires-failure-consumption', state: 'failure-consumption-required', reason: 'existing-consume-failure-required' };
  }
  return unknown('terminal-failure-unverified');
}
// inspectTaskDrain({cwd, task, now, liveAdapter: {inspectAttempt, processProbe}}): read only.
function inspectTaskDrain(input = {}) {
  const base = { state: 'incomplete-unknown', task_id: null, milestone: null, ceiling_ms: null, consumed_ms: null, unknown_ms: null, writers: [], claim: 'unknown', unknowns: [],
    observability: ['live-host-adapters-only', 'reported-attempts-only', 'unknown-process-probe-never-drains'] };
  try {
    if (!object(input)) fail('linked-task-time-invalid');
    const owner = ownerOf(input), now = nowOf(input), probe = probeOf(owner, taskOf(input));
    if (probe === null) return { ...base, state: 'not-applicable', reason: 'unlinked', claim: 'absent' };
    Object.assign(base, { task_id: probe.task_id, milestone: probe.milestone });
    const state = horizonState(owner, probe, now);
    if (state.life.status !== 'started') return { ...base, state: 'not-applicable', reason: state.life.status === 'closed' ? 'linked-task-closed' : state.life.status === 'chain-closed' ? 'linked-task-chain-closed' : 'linked-task-not-started' };
    if (state.clock.status !== 'measured') return { ...base, reason: 'linked-task-clock-unknown', unknowns: ['linked-task-clock-unknown'] };
    Object.assign(base, { ceiling_ms: state.horizon.ceiling_ms, consumed_ms: state.clock.consumption.consumed_ms, unknown_ms: state.clock.consumption.unknown_ms, version: state.horizon.version });
    if (base.consumed_ms < base.ceiling_ms) return { ...base, state: 'not-applicable', reason: 'not-exhausted', claim: 'not-inspected' };
    const claim = runClaim(owner, probe.task_id);
    base.claim = claim.status;
    if (claim.status === 'unknown') base.unknowns.push('claim-unknown');
    const adapter = input.liveAdapter;
    if (typeof adapter?.inspectAttempt !== 'function' || typeof adapter?.processProbe !== 'function') {
      base.unknowns.push('host-inspector-required');
      return { ...base, state: 'incomplete-unknown', reason: 'host-inspector-required', unknowns: [...new Set(base.unknowns)] };
    }
    let reported;
    try { reported = adapter.inspectAttempt({ cwd: owner, task: probe.task_id, milestone: probe.milestone, run: structuredClone(claim.run ?? null) }); }
    catch { reported = undefined; }
    const attempts = Array.isArray(reported) ? reported : Array.isArray(reported?.attempts) ? reported.attempts : null;
    if (attempts === null) base.unknowns.push('attempt-census-invalid');
    else if (attempts.length > MAX_WRITERS) base.unknowns.push('attempt-census-overflow');
    const reads = [];
    if (attempts && attempts.length <= MAX_WRITERS) for (const attempt of attempts) {
      let classification;
      try { classification = classifyTaskAttempt(owner, probe, attempt, adapter, reads); }
      catch { classification = { classification: 'unknown', state: 'inspection-required', reason: 'attempt-source-unreadable' }; }
      base.writers.push({ unit: typeof attempt?.unit === 'string' && attempt.unit.length <= 200 && time().isPublicData(attempt.unit) ? attempt.unit : null, ...classification });
    }
    // Every observed source is rechecked: a concurrent change never yields a ready drain.
    for (const read of reads) { try { if (sha256(boundedBytes(read.file, MAX_RECEIPT) || Buffer.alloc(0)) !== read.sha256) base.unknowns.push('receipt-unstable'); } catch { base.unknowns.push('receipt-unstable'); } }
    const after = runClaim(owner, probe.task_id);
    if (after.status !== claim.status || after.generation !== claim.generation) base.unknowns.push('claim-unstable');
    if (base.writers.some(w => w.classification === 'unknown')) base.unknowns.push('writer-unknown');
    base.unknowns = [...new Set(base.unknowns)];
    base.state = base.unknowns.length ? 'incomplete-unknown' : base.claim === 'held' || base.writers.some(w => w.classification !== 'terminal') ? 'draining' : 'drained';
    return base;
  } catch (e) {
    const reason = codeOf(e, 'linked-task-time-invalid');
    return { ...base, state: 'incomplete-unknown', reason: HORIZON_REFUSALS.includes(reason) ? reason : 'linked-task-time-invalid', unknowns: [...new Set([...base.unknowns, 'linked-task-time-invalid'])] };
  }
}

// ---------------------------------------------------------------------------
// Checkpoint after a complete drain (immutable record + personal capture)
// ---------------------------------------------------------------------------
function checkpointRecord(probe, state, drain, now) {
  const version = state.horizon.version, id = checkpointDecisionId(probe.link_sha256, version), consumed = state.clock.consumption.consumed_ms;
  return { schema_version: HORIZON_SCHEMA_VERSION, kind: KINDS.checkpoint, milestone: probe.milestone, task_id: probe.task_id, link_sha256: probe.link_sha256,
    start_sha256: state.life.start.sha256, version, horizon_sha256: state.horizon.head_sha256, policy: { ...TASK_CLOCK_POLICY }, ceiling_ms: state.horizon.ceiling_ms,
    consumed_ms: consumed, unknown_ms: state.clock.consumption.unknown_ms, overshoot_ms: consumed - state.horizon.ceiling_ms,
    drain: { state: 'drained', claim: drain.claim, writers: drain.writers.map(w => ({ unit: w.unit, classification: w.classification, reason: w.reason })) },
    decision_pending: true, pending_decision: { id, question: CHECKPOINT_QUESTION, alternatives: [...CHECKPOINT_ALTERNATIVES] },
    next_action: id + ': ' + CHECKPOINT_QUESTION, at: isoOf(now) };
}
function personalOptions(owner, input) { return { project: owner, userHome: input.userHome, env: input.env }; }
function ownLifecycleSource(owner, milestone, source) {
  const dirs = [path.join(owner, '.gsd', 'forge', 'time', milestone, 'linked-task')];
  try { dirs.push(path.join(fs.realpathSync.native(owner), '.gsd', 'forge', 'time', milestone, 'linked-task')); } catch { /* owner already validated */ }
  return typeof source === 'string' && dirs.some(dir => samePath(path.dirname(source), dir) || samePath(path.dirname(path.dirname(source)), dir));
}
// Plan of the personal capture: the checkpoint decision is added to pending and becomes the next
// action; independent captures stay. Compare-and-save under the existing personal mutex.
function personalPlan(owner, probe, input, record, file) {
  const snapshot = personal().readPersonalSnapshot({ ...personalOptions(owner, input), id: probe.task_id });
  if (snapshot.status !== 'ok') fail('linked-task-personal-conflict', 'personal-unreadable');
  const work = snapshot.works.find(w => w.id === probe.task_id);
  if (!work) return { status: 'not-bound' };
  const pending = work.checkpoint?.pending || [], next = work.checkpoint?.nextAction || [];
  if ([...pending, ...next].some(c => c.validity !== 'current')) fail('linked-task-personal-conflict', 'reconciliation-required');
  const mine = { text: record.next_action, source: file, resolved: false };
  const keep = c => ({ text: c.text, source: c.source, resolved: c.resolved === true });
  const entries = { pending: [...pending.filter(c => !samePath(c.source, file)).map(keep), mine],
    nextAction: [...next.filter(c => !samePath(c.source, file) && !ownLifecycleSource(owner, probe.milestone, c.source)).map(keep), mine] };
  const done = Object.entries(entries).every(([field, rows]) => {
    const current = work.checkpoint?.[field] || [];
    return current.length === rows.length && rows.every((e, i) => current[i].text === e.text && samePath(current[i].source, e.source) && current[i].resolved === e.resolved && current[i].validity === 'current');
  });
  const expected = Object.fromEntries(Object.keys(entries).map(field => [field, (work.checkpoint?.[field] || []).map(({ text, source, hash, capturedAt, resolved }) => ({ text, source, hash, capturedAt, resolved }))]));
  return { status: done ? 'unchanged' : 'planned', entries, expected };
}
function checkpointSource(owner, milestone, source) {
  const dirs = [path.join(owner, '.gsd', 'forge', 'time', milestone, 'linked-task', 'checkpoints')];
  try { dirs.push(path.join(fs.realpathSync.native(owner), '.gsd', 'forge', 'time', milestone, 'linked-task', 'checkpoints')); } catch { /* owner already validated */ }
  return typeof source === 'string' && dirs.some(dir => samePath(path.dirname(source), dir));
}
// True only while the horizon's own checkpoint captures still await their release (read-only; any
// unreadable state is false, so a repeated extension then keeps its ordinary "ceiling not increased" refusal).
function releasePending(owner, probe, input) {
  try {
    const snapshot = personal().readPersonalSnapshot({ ...personalOptions(owner, input), id: probe.task_id });
    const work = snapshot.status === 'ok' ? snapshot.works.find(w => w.id === probe.task_id) : null;
    return !!work && ['pending', 'nextAction'].some(field => (work.checkpoint?.[field] || []).some(c => checkpointSource(owner, probe.milestone, c.source)));
  } catch { return false; }
}
// After an attested extension the checkpoint decision is decided: only the horizon's own checkpoint
// captures leave pending / nextAction (compare-and-save); every other capture stays untouched.
function personalRelease(owner, probe, input) {
  const snapshot = personal().readPersonalSnapshot({ ...personalOptions(owner, input), id: probe.task_id });
  if (snapshot.status !== 'ok') fail('linked-task-personal-conflict', 'personal-unreadable');
  const work = snapshot.works.find(w => w.id === probe.task_id);
  if (!work) return 'not-bound';
  const fields = ['pending', 'nextAction'].filter(field => (work.checkpoint?.[field] || []).some(c => checkpointSource(owner, probe.milestone, c.source)));
  if (!fields.length) return 'unchanged';
  if (fields.some(field => work.checkpoint[field].some(c => c.validity !== 'current'))) fail('linked-task-personal-conflict', 'reconciliation-required');
  const entries = Object.fromEntries(fields.map(field => [field, work.checkpoint[field].filter(c => !checkpointSource(owner, probe.milestone, c.source))
    .map(c => ({ text: c.text, source: c.source, resolved: c.resolved === true }))]));
  const expected = Object.fromEntries(fields.map(field => [field, work.checkpoint[field].map(({ text, source, hash, capturedAt, resolved }) => ({ text, source, hash, capturedAt, resolved }))]));
  const saved = personal().saveCheckpoint({ ...personalOptions(owner, input), id: probe.task_id, intent: 'checkpoint', checkpoint: entries, expectedCheckpoint: expected });
  if (saved.status !== 'ok') fail('linked-task-personal-conflict', typeof saved.reason === 'string' ? saved.reason : 'checkpoint-not-saved', { committed: saved.status === 'partial' });
  return 'saved';
}
function personalApply(owner, probe, input, record, file) {
  const plan = personalPlan(owner, probe, input, record, file);
  if (plan.status !== 'planned') return plan.status;
  const saved = personal().saveCheckpoint({ ...personalOptions(owner, input), id: probe.task_id, intent: 'checkpoint', checkpoint: plan.entries, expectedCheckpoint: plan.expected });
  if (saved.status !== 'ok') fail('linked-task-personal-conflict', typeof saved.reason === 'string' ? saved.reason : 'checkpoint-not-saved', { committed: saved.status === 'partial' });
  return 'saved';
}
// checkpointTaskIfDrained({cwd, task, now, liveAdapter, userHome, env}): writes only after a complete
// drain observed by the live adapters; an incomplete drain writes nothing.
function checkpointTaskIfDrained(input = {}) {
  let probe = null, published = false;
  try {
    if (!object(input)) fail('linked-task-time-invalid');
    const owner = ownerOf(input), now = nowOf(input);
    probe = probeOf(owner, taskOf(input));
    if (probe === null) fail('linked-task-not-linked');
    // The live adapters run here, outside every lock; their legitimate effects are honored below.
    const drain = inspectTaskDrain({ ...input, cwd: owner, task: probe.task_id, now });
    if (drain.state === 'not-applicable') {
      if (['linked-task-closed', 'linked-task-chain-closed', 'linked-task-not-started'].includes(drain.reason)) fail(drain.reason);
      fail('linked-task-not-exhausted', drain.reason);
    }
    if (drain.state !== 'drained') return { status: 'not-drained', task_id: probe.task_id, reason: 'linked-task-drain-incomplete', drain };
    const before = horizonState(owner, probe, now);
    requireOpen(before.life);
    const result = taskBoundary(owner, probe, () => {
      // Current closure, extension generation and checkpoint are revalidated AFTER the adapters and BEFORE any effect.
      const state = horizonState(owner, probe, now);
      requireOpen(state.life);
      if (state.life.start.sha256 !== before.life.start.sha256 || state.horizon.head_sha256 !== before.horizon.head_sha256 || state.horizon.version !== drain.version) fail('linked-task-checkpoint-conflict', 'horizon-changed');
      if (state.clock.status !== 'measured') fail('linked-task-clock-unknown');
      if (state.clock.consumption.consumed_ms < state.horizon.ceiling_ms) fail('linked-task-not-exhausted');
      const claim = runClaim(owner, probe.task_id);
      if (claim.status !== drain.claim) fail('linked-task-checkpoint-conflict', 'claim-changed');
      const ref = 'linked-task/checkpoints/' + state.horizon.version + '.json', file = recordSource(owner, probe.milestone, ref);
      let record, sha, status;
      if (state.checkpoints.current) { record = state.checkpoints.current.record; sha = state.checkpoints.current.sha256; status = 'unchanged'; }
      else {
        record = checkpointRecord(probe, state, drain, now);
        if (!checkpointValid(record)) fail('linked-task-time-invalid', 'checkpoint-record-invalid');
        const out = time().publishOwnerRecord({ cwd: owner, milestone: probe.milestone, path: ref, record });
        published = out.status === 'published'; sha = out.sha256; status = published ? 'checkpointed' : 'unchanged';
      }
      if (typeof input.failpoint === 'function' && input.failpoint('after-checkpoint')) fail('linked-task-operation-failed', 'failpoint-after-checkpoint', { committed: published });
      let personalStatus;
      try { personalStatus = personalApply(owner, probe, input, record, file); }
      catch (e) { e.committed = e.committed || published; e.checkpoint = { version: record.version, sha256: sha }; throw e; }
      return { status, task_id: probe.task_id, milestone: probe.milestone, version: record.version, checkpoint_sha256: sha,
        reference: '.gsd/forge/time/' + probe.milestone + '/' + ref, overshoot_ms: record.overshoot_ms, decision_pending: true,
        pending_decision: structuredClone(record.pending_decision), personal: personalStatus };
    });
    return result;
  } catch (e) { return writeAnswer(probe, e, published, e.checkpoint ? { checkpoint: e.checkpoint } : {}); }
}

// ---------------------------------------------------------------------------
// Attested extension of the task horizon
// ---------------------------------------------------------------------------
// Owner question of one explicit extension value: identity binds milestone M, task T and workflow
// T in the linked-task set, so verifyDecision (milestone view) and the task clock (workflow view)
// see the same decision. Each sequence and value is a NEW question; nothing is reused.
// Generation 1 keeps the original question id; after a COMPLETED non-authorizing choice (keep-horizon) a later
// explicit request for the same value opens generation n as a NEW question (new id, unit and identity), so no
// answered state is reused and the declined history is retained.
function extensionSpec(probe, sequence, ceilingMs, generation = 1) {
  if (!positive(sequence) || !positive(ceilingMs) || !positive(generation)) fail('linked-task-extension-invalid', 'value-invalid');
  const id = 'linked-task-extend-' + probe.link_sha256.slice(0, 12) + '-s' + sequence + '-' + ceilingMs + (generation > 1 ? '-g' + generation : ''), unit = 'milestone-time/' + id;
  const identity = digest({ schema_version: 1, origin: 'owner', unit, milestone: probe.milestone, slice: null, task: probe.task_id, workflow_id: probe.task_id,
    dispatch_id: null, request_fingerprint: null, receipt_phase: null, decision_set: LINKED_SET });
  const request = { milestone: probe.milestone, task_id: probe.task_id, link_sha256: probe.link_sha256, ceiling_ms: ceilingMs };
  return { id, unit, identity, sequence, generation, ceiling_ms: ceilingMs, answer: 'linked-task:extend:' + ceilingMs, request,
    text: { header: 'Extensão do horizonte da task ligada', question: 'Estender o horizonte da task ligada para ' + ceilingMs + ' ms? A decisão é explícita e nunca automática.',
      options: [{ label: 'Estender o horizonte da task', description: 'Novo teto da task: ' + ceilingMs + ' ms; o teto da milestone não muda.', answer: 'linked-task:extend:' + ceilingMs },
        { label: 'Manter o horizonte', description: 'Nada muda; o trabalho novo da task continua bloqueado no teto.', answer: 'linked-task:keep-horizon' }] } };
}
function persistedExtension(owner, spec) {
  const file = path.join(owner, '.gsd', 'forge', 'questions', spec.identity + '.json');
  noLinks(file);
  if (!fs.existsSync(file)) return { status: 'absent', answer: null };
  let state; try { state = questions().continuation({ cwd: owner, identity: spec.identity }); } catch { fail('linked-task-question-census-unknown', 'decision-unreadable'); }
  if (!state.ok) return { status: 'pending', answer: null };
  const row = state.questions.find(q => q.id === spec.id);
  if (!row || state.identity?.decision_set !== LINKED_SET || state.identity.task !== spec.request.task_id) return { status: 'pending', answer: null };
  return { status: 'answered', answer: row.answer };
}
// Persisted generations of one extension value in order. The chain stops at the first generation that is
// absent, still pending or answered with the authorizing choice: declined generations (keep-horizon) are
// completed history and never rewritten.
function extensionHistory(owner, probe, sequence, ceilingMs) {
  const history = [];
  for (let generation = 1; generation <= MAX_EXTENSION_GENERATIONS; generation++) {
    const spec = extensionSpec(probe, sequence, ceilingMs, generation), persisted = persistedExtension(owner, spec);
    if (persisted.status === 'absent') break;
    history.push({ generation, spec, ...persisted });
    if (persisted.status !== 'answered' || persisted.answer === spec.answer) break;
  }
  return history;
}
function extensionDeclined(entry) { return entry.status === 'answered' && entry.answer !== entry.spec.answer; }
function extensionTarget(owner, probe, ceilingMs, now, known) {
  const state = known || horizonState(owner, probe, now);
  requireOpen(state.life);
  if (!positive(ceilingMs) || ceilingMs <= state.horizon.ceiling_ms) fail('linked-task-extension-invalid', 'ceiling-not-increased');
  return { state, spec: extensionSpec(probe, state.horizon.extensions.length + 1, ceilingMs) };
}
// prepareTaskExtension({cwd, task, ceilingMs}): opens (idempotently, outside every lock) the
// canonical owner question for this explicit value. It never authorizes.
function prepareTaskExtension(input = {}) {
  let probe = null;
  try {
    if (!object(input)) fail('linked-task-extension-invalid');
    const owner = ownerOf(input), now = nowOf(input);
    probe = probeOf(owner, taskOf(input));
    if (probe === null) fail('linked-task-not-linked');
    const target = extensionTarget(owner, probe, input.ceilingMs, now);
    let listed;
    try { listed = questions().listPendingQuestions({ cwd: owner, filter: { type: 'milestone', id: probe.milestone } }); } catch { fail('linked-task-question-census-unknown'); }
    if (listed.census.invalid || listed.census.excess) fail('linked-task-question-census-unknown', 'census-incomplete');
    // An unanswered generation stays stable; only a completed declined one is followed by a new explicit generation.
    const latest = extensionHistory(owner, probe, target.spec.sequence, target.spec.ceiling_ms).at(-1) || null;
    if (latest && extensionDeclined(latest) && latest.generation >= MAX_EXTENSION_GENERATIONS) fail('linked-task-extension-invalid', 'generation-limit');
    const spec = latest && extensionDeclined(latest) ? extensionSpec(probe, target.spec.sequence, target.spec.ceiling_ms, latest.generation + 1) : latest ? latest.spec : target.spec;
    const opened = questions().openQuestions({ cwd: owner, milestone: probe.milestone, task: probe.task_id, workflow_id: probe.task_id, unit: spec.unit,
      decision_set: LINKED_SET, questions: [{ id: spec.id, question: spec.text.question }] });
    if (opened.identity_sha256 !== spec.identity) fail('linked-task-extension-invalid', 'identity-mismatch');
    const persisted = persistedExtension(owner, spec);
    return { status: persisted.status === 'answered' ? 'answered' : 'open', task_id: probe.task_id, milestone: probe.milestone, kind: 'linked-task', sequence: spec.sequence, generation: spec.generation,
      request: spec.request, request_sha256: digest(spec.request), expected: [spec.answer], question: { identity_sha256: spec.identity, id: spec.id }, answer: persisted.answer,
      decision: { id: spec.id, header: spec.text.header, question: spec.text.question, options: spec.text.options.map(o => ({ label: o.label, description: o.description })) } };
  } catch (e) { return writeAnswer(probe, e, false); }
}
// answerTaskExtension({cwd, task, ceilingMs, response, source}): records the operator's explicit
// answer through forge-pending-questions.answer; the answer alone never extends anything.
function answerTaskExtension(input = {}) {
  let probe = null;
  try {
    if (!object(input) || !['user-text', 'tool-answer'].includes(input.source)) fail('linked-task-extension-invalid', 'source-invalid');
    const owner = ownerOf(input), now = nowOf(input);
    probe = probeOf(owner, taskOf(input));
    if (probe === null) fail('linked-task-not-linked');
    const { spec: base } = extensionTarget(owner, probe, input.ceilingMs, now);
    const option = base.text.options.find(o => o.label === input.response || o.answer === input.response);
    if (!option) fail('linked-task-extension-invalid', 'answer-invalid');
    // Only the current generation can be answered; a completed one is history and never reopened.
    const latest = extensionHistory(owner, probe, base.sequence, base.ceiling_ms).at(-1);
    if (!latest) fail('linked-task-extension-request-required', 'question-not-open');
    if (latest.status === 'answered' && latest.answer !== option.answer) fail('linked-task-extension-invalid', 'decision-answered');
    const spec = latest.spec;
    questions().answer({ cwd: owner, identity: spec.identity, answers: [{ id: spec.id, answer: option.answer, source: input.source }], ...(input.channel ? { channel: input.channel } : {}) });
    return { status: 'answered', task_id: probe.task_id, answer: option.answer, question: { identity_sha256: spec.identity, id: spec.id } };
  } catch (e) { return writeAnswer(probe, e, false); }
}
function verifyExtension(owner, probe, handle, spec, now) {
  let decision;
  try { decision = time().verifyDecision({ cwd: owner, milestone: probe.milestone, now, handle, kind: 'linked-task', request: spec.request, expected: [spec.answer] }); }
  catch (e) { fail(e.code === 'time-decision-answer-mismatch' ? 'linked-task-authorization-revoked' : 'linked-task-authorization-required', codeOf(e, null)); }
  if (decision.question?.identity_sha256 !== spec.identity || decision.question.id !== spec.id || decision.request_sha256 !== digest(spec.request)) fail('linked-task-authorization-required', 'scope-mismatch');
  return decision;
}
// Idempotent recovery of the head extension (same ceiling) already immutably published: horizonOf has
// validated its chain and persisted attested decision; the original decision is reattested live (the same
// persisted answer, no new consent, no higher ceiling) and ONLY the pending personal release is completed.
// A checkpoint of the new generation owns the current pending decision and is never released here.
function recoverPublishedExtension(owner, probe, input, now, first, head) {
  const ref = 'linked-task/extensions/' + String(head.sequence).padStart(4, '0') + '.json';
  const read = time().readOwnerRecord({ cwd: owner, milestone: probe.milestone, path: ref });
  if (read.status !== 'valid' || read.sha256 !== head.sha256) fail('linked-task-extension-conflict', 'head-changed');
  const spec = specOfExtension(probe, read.record);
  if (!spec) fail('linked-task-extension-invalid', 'decision-unbound');
  let handle;
  try {
    handle = input.liveAdapter.getDecisionHandle({ cwd: owner, milestone: probe.milestone, task: probe.task_id, kind: 'linked-task', request: structuredClone(spec.request),
      request_sha256: digest(spec.request), question: { identity_sha256: spec.identity, id: spec.id }, expected: [spec.answer] });
  } catch { fail('linked-task-authorization-required', 'adapter-failed'); }
  verifyExtension(owner, probe, handle, spec, now);
  return taskBoundary(owner, probe, () => {
    const again = horizonState(owner, probe, now);
    requireOpen(again.life);
    if (again.life.start.sha256 !== first.life.start.sha256 || again.horizon.head_sha256 !== head.sha256) fail('linked-task-extension-conflict', 'generation-changed');
    verifyExtension(owner, probe, handle, spec, now);
    const personalStatus = again.checkpoints.current ? 'unchanged' : personalRelease(owner, probe, input);
    return { status: personalStatus === 'saved' ? 'extended' : 'unchanged', recovered: true, task_id: probe.task_id, milestone: probe.milestone, sequence: head.sequence,
      previous_ceiling_ms: read.record.previous_ceiling_ms, ceiling_ms: head.ceiling_ms, extension_sha256: head.sha256,
      reference: '.gsd/forge/time/' + probe.milestone + '/' + ref, personal: personalStatus };
  });
}
// extendTaskHorizon({cwd, task, ceilingMs, liveAdapter, now}): only a fresh live handle for the
// explicit persisted answer linked-task:extend:<ms> publishes the next chained immutable extension.
function extendTaskHorizon(input = {}) {
  let probe = null, wrote = false;
  try {
    // A standalone call, a flag or persisted JSON never carries live authority (refused before any read).
    if (!object(input) || typeof input.liveAdapter?.getDecisionHandle !== 'function') fail('linked-task-authorization-required');
    const owner = ownerOf(input), now = nowOf(input);
    probe = probeOf(owner, taskOf(input));
    if (probe === null) fail('linked-task-not-linked');
    const first = horizonState(owner, probe, now);
    requireOpen(first.life);
    // Recovery of an already committed matching extension: only its pending personal release is completed.
    const head = first.horizon.extensions.at(-1);
    if (head && input.ceilingMs === head.ceiling_ms && !first.checkpoints.current && releasePending(owner, probe, input)) return recoverPublishedExtension(owner, probe, input, now, first, head);
    const { state, spec: base } = extensionTarget(owner, probe, input.ceilingMs, now, first);
    // Authority binds the CURRENT generation: a declined earlier generation never authorizes.
    const current = extensionHistory(owner, probe, base.sequence, base.ceiling_ms).at(-1);
    if (!current) fail('linked-task-extension-request-required', 'absent');
    if (current.status !== 'answered') fail('linked-task-extension-request-required', current.status);
    const spec = current.spec;
    if (current.answer !== spec.answer) fail('linked-task-authorization-revoked', 'extension-declined');
    let handle;
    try {
      handle = input.liveAdapter.getDecisionHandle({ cwd: owner, milestone: probe.milestone, task: probe.task_id, kind: 'linked-task', request: structuredClone(spec.request),
        request_sha256: digest(spec.request), question: { identity_sha256: spec.identity, id: spec.id }, expected: [spec.answer] });
    } catch { fail('linked-task-authorization-required', 'adapter-failed'); }
    verifyExtension(owner, probe, handle, spec, now);
    return taskBoundary(owner, probe, () => {
      // After the host callback: closure, chain closure and the extension generation are revalidated.
      const again = horizonState(owner, probe, now);
      requireOpen(again.life);
      if (again.life.start.sha256 !== state.life.start.sha256 || again.horizon.head_sha256 !== state.horizon.head_sha256) fail('linked-task-extension-conflict', 'generation-changed');
      const decision = verifyExtension(owner, probe, handle, spec, now);
      const record = { schema_version: HORIZON_SCHEMA_VERSION, kind: KINDS.extension, milestone: probe.milestone, task_id: probe.task_id, link_sha256: probe.link_sha256,
        start_sha256: again.life.start.sha256, sequence: spec.sequence, previous_sha256: again.horizon.head_sha256, previous_ceiling_ms: again.horizon.ceiling_ms,
        ceiling_ms: spec.ceiling_ms, decision: { reference: typeof decision.reference === 'string' && decision.reference.length <= 120 && time().isPublicData(decision.reference) ? decision.reference : null,
          question: { identity_sha256: decision.question.identity_sha256, id: decision.question.id }, answer: decision.answer, request_sha256: decision.request_sha256 },
        extended_at: isoOf(now) };
      if (!extensionValid(record)) fail('linked-task-extension-invalid', 'record-invalid');
      const ref = 'linked-task/extensions/' + String(spec.sequence).padStart(4, '0') + '.json';
      const out = time().publishOwnerRecord({ cwd: owner, milestone: probe.milestone, path: ref, record });
      wrote = out.status === 'published';
      if (typeof input.failpoint === 'function' && input.failpoint('after-extension')) fail('linked-task-operation-failed', 'failpoint-after-extension', { committed: wrote });
      const personalStatus = personalRelease(owner, probe, input);
      return { status: 'extended', task_id: probe.task_id, milestone: probe.milestone, sequence: spec.sequence, previous_ceiling_ms: record.previous_ceiling_ms,
        ceiling_ms: record.ceiling_ms, extension_sha256: out.sha256, reference: '.gsd/forge/time/' + probe.milestone + '/' + ref, personal: personalStatus };
    });
  } catch (e) { return writeAnswer(probe, e, wrote); }
}

// ---------------------------------------------------------------------------
// Read-only chain status
// ---------------------------------------------------------------------------
function intOrNull(v) { return Number.isSafeInteger(v) ? v : null; }
// readLinkedStatus({cwd, task | milestone, now, userHome, env}): pure read (no lock, no directory);
// null for an unlinked task. Milestone and task ceilings each govern their own operations; the
// chain cap is a derived sum that governs nothing.
function readLinkedStatus(input = {}) {
  let probe = null;
  try {
    if (!object(input)) fail('linked-task-time-invalid');
    const owner = ownerOf(input), now = nowOf(input);
    probe = taskOf(input) !== undefined ? probeOf(owner, taskOf(input)) : probeByMilestone(owner, input.milestone);
    if (probe === null) return null;
    const unknowns = new Set(), M = probe.milestone;
    const state = horizonState(owner, probe, now), { life, horizon, checkpoints, clock } = state;
    let predecessor = { lifecycle: life.status, reason: null };
    if (['blocked', 'handoff-ready', 'open'].includes(life.status)) {
      const proof = lifecycle().provePredecessor({ cwd: owner, task: probe.task_id, now, userHome: input.userHome, env: input.env });
      predecessor = { lifecycle: life.status, status: typeof proof.status === 'string' ? proof.status : 'invalid', reason: typeof proof.reason === 'string' && /^[a-z][a-z0-9-]{0,80}$/.test(proof.reason) ? proof.reason : null };
    }
    // Milestone horizon: its own ceiling, its frozen (or live) consumption and its endpoint, read
    // through the explicit milestone-only seam (never composes the linked horizons again).
    const ms = admission().readMilestoneTimeStatus(owner, M, { now }), mclock = clocks().readClock({ cwd: owner, milestone: M, now }), endpoint = endpoints().readEndpoint({ cwd: owner, milestone: M });
    const frozen = mclock.status === 'measured' && mclock.frozen === true;
    const milestoneConsumed = frozen ? intOrNull(mclock.consumption?.consumed_ms) : intOrNull(ms.clocks?.consumed_ms);
    if (ms.contract !== 'valid') unknowns.add('milestone-time-invalid');
    for (const u of ms.unknowns || []) if (typeof u === 'string' && /^[a-z][a-z0-9-]{0,80}$/.test(u)) unknowns.add(u);
    const milestoneHorizon = { ceiling_ms: intOrNull(ms.horizon?.ceiling_ms), consumed_ms: milestoneConsumed, frozen, state: typeof ms.state === 'string' ? ms.state : null,
      endpoint: { proven: endpoint.status === 'valid', endpoint_at: endpoint.status === 'valid' && instant(endpoint.record?.endpoint_at) ? endpoint.record.endpoint_at : null } };
    // Task horizon: ceiling with extensions, consumption, unknown, balance and state.
    const claim = life.status === 'started' ? runClaim(owner, probe.task_id) : { status: 'absent' };
    if (claim.status === 'unknown') unknowns.add('claim-unknown');
    if (clock.status !== 'measured' && life.start) unknowns.add('linked-task-clock-unknown');
    for (const u of clock.unknowns || []) unknowns.add(u);
    if (clock.status === 'measured' && clock.consumption.unknown_ms > 0) unknowns.add('unattributed-time');
    const taskState = deriveState({ life, clock, horizon, checkpoint: checkpoints.current, writersOpen: claim.status === 'held', censusKnown: claim.status !== 'unknown' });
    const consumed = clock.status === 'measured' ? clock.consumption.consumed_ms : null;
    const taskHorizon = { ceiling_ms: horizon.ceiling_ms, base_ceiling_ms: horizon.base_ceiling_ms, extensions: horizon.extensions.length, consumed_ms: consumed,
      unknown_ms: clock.status === 'measured' ? clock.consumption.unknown_ms : null, remaining_ms: consumed === null ? null : horizon.ceiling_ms - consumed,
      state: taskState, frozen: clock.status === 'measured' && clock.frozen, started_at: life.start ? life.start.record.started_at : null,
      checkpoint: checkpoints.current ? { version: checkpoints.current.record.version, overshoot_ms: checkpoints.current.record.overshoot_ms, decision_pending: true } : null };
    // Chain: forecast from the contract, consumed as the sum (or null), the derived cap that governs nothing.
    const contract = time().readContract({ cwd: owner, milestone: M });
    const forecast = contract.status === 'valid' && object(contract.contract.chain_forecast)
      ? { low_ms: intOrNull(contract.contract.chain_forecast.low_ms), high_ms: intOrNull(contract.contract.chain_forecast.high_ms) } : null;
    const chain = { forecast, consumed_ms: milestoneConsumed !== null && consumed !== null ? milestoneConsumed + consumed : null,
      cap_ms: milestoneHorizon.ceiling_ms !== null ? milestoneHorizon.ceiling_ms + horizon.ceiling_ms : null, cap_basis: 'derived-sum', governs: false,
      completed: milestoneHorizon.endpoint.proven && life.status === 'closed' };
    const decisionPending = !!checkpoints.current || ms.checkpoint?.decision_pending === true;
    const view = { schema_version: HORIZON_SCHEMA_VERSION, task_id: probe.task_id, milestone: M, predecessor, milestone_horizon: milestoneHorizon, task_horizon: taskHorizon, chain,
      governs: { milestone_operations: 'milestone-ceiling', task_operations: 'task-ceiling', chain: 'none' }, decision_pending: decisionPending,
      unknowns: [...unknowns].slice(0, 32) };
    if (!time().isPublicData(view)) fail('linked-task-time-invalid', 'status-not-public');
    return view;
  } catch (e) {
    const reason = codeOf(e, 'linked-task-time-invalid');
    return { schema_version: HORIZON_SCHEMA_VERSION, status: 'invalid', task_id: probe && typedId(probe.task_id, 'task') ? probe.task_id : null,
      reason: HORIZON_REFUSALS.includes(reason) ? reason : 'linked-task-time-invalid' };
  }
}
// Closed, bounded block consumed by the surfaces (status, personal summary, messages).
function summarizeLinkedStatus(status) {
  if (status === null || status === undefined) return null;
  const n = intOrNull, task = status?.task_horizon, m = status?.milestone_horizon, c = status?.chain;
  const states = lifecycle().LIFECYCLE_STATES, mstates = admission().TIME_STATES;
  if (!object(status) || status.status === 'invalid' || !object(task)) return { task_id: typedId(status?.task_id, 'task') ? status.task_id : null, lifecycle: 'invalid', task: null, milestone: null, chain: null, decision_pending: false, unknown: true };
  return { task_id: typedId(status.task_id, 'task') ? status.task_id : null, milestone_id: typedId(status.milestone, 'milestone') ? status.milestone : null,
    lifecycle: states.includes(status.predecessor?.lifecycle) ? status.predecessor.lifecycle : 'invalid',
    task: { state: TASK_STATES.includes(task.state) ? task.state : 'unknown', ceiling_ms: n(task.ceiling_ms), consumed_ms: n(task.consumed_ms), unknown_ms: n(task.unknown_ms),
      remaining_ms: n(task.remaining_ms), extensions: n(task.extensions), governs: 'task-operations' },
    milestone: { state: mstates.includes(m?.state) ? m.state : null, ceiling_ms: n(m?.ceiling_ms), consumed_ms: n(m?.consumed_ms), frozen: m?.frozen === true,
      endpoint_proven: m?.endpoint?.proven === true, governs: 'milestone-operations' },
    chain: { cap_ms: n(c?.cap_ms), consumed_ms: n(c?.consumed_ms), forecast_low_ms: n(c?.forecast?.low_ms), forecast_high_ms: n(c?.forecast?.high_ms),
      cap_basis: 'derived-sum', governs: false, completed: c?.completed === true },
    decision_pending: status.decision_pending === true, unknown: Array.isArray(status.unknowns) && status.unknowns.length > 0 };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const OWNER_ACTIONS = Object.freeze(['--status', '--admit', '--presence', '--wait-start', '--wait-end', '--inspect-drain', '--checkpoint']);
const LIVE_ACTIONS = Object.freeze(['--extend']);
const VALUED_ACTIONS = Object.freeze(['--presence', '--wait-start', '--wait-end']);
function publicTask(value) { return typedId(value, 'task') && time().isPublicData(value) ? value : null; }
function message(action, view) {
  if (view === null) return 'Task sem vínculo: nenhum estado de tempo foi lido.';
  const reason = view.reason || view.reason_code, text = MESSAGES[reason];
  if (view.allowed === false || ['refused', 'partial', 'invalid', 'not-drained'].includes(view.status)) {
    return (view.status === 'partial' ? 'Operação parcial do horizonte da task: ' : 'Operação recusada: ') + reason + (text ? ' (' + text + ')' : '') + '.';
  }
  if (action === '--admit') return view.decision === 'unlinked' ? 'Task sem vínculo: admissão inalterada.' : 'Entrada admitida no horizonte da task ligada.';
  if (action === '--status') return 'Task ligada ' + view.task_id + ': horizonte ' + view.task_horizon?.state + '.';
  if (action === '--inspect-drain') return 'Drain da task: ' + view.state + '.';
  return 'Horizonte da task ligada: ' + view.status + '.';
}
function exitOf(action, view) {
  if (view === null) return 0;
  if (action === '--admit') return view.allowed ? 0 : 3;
  if (action === '--status') return view.status === 'invalid' ? 3 : 0;
  if (action === '--inspect-drain') return view.state === 'incomplete-unknown' && view.reason !== undefined && HORIZON_REFUSALS.includes(view.reason) ? 3 : 0;
  return ['appended', 'checkpointed', 'unchanged', 'extended'].includes(view.status) ? 0 : 3;
}
// --status, --admit, journal actions, --inspect-drain and --checkpoint are owner actions; --extend
// works only in the embedded main(argv, io, liveAdapter) and, standalone, refuses before any read.
function main(argv = process.argv.slice(2), io = process, liveAdapter) {
  const json = argv.includes('--json'), options = {};
  let action = null;
  try {
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i], value = argv[i + 1], has = typeof value === 'string' && value !== '' && !value.startsWith('--');
      if (flag === '--json') continue;
      if ([...OWNER_ACTIONS, ...LIVE_ACTIONS].includes(flag)) {
        if (action) fail('linked-task-usage'); action = flag;
        if (VALUED_ACTIONS.includes(flag)) { if (!has) fail('linked-task-usage'); options.value = argv[++i]; }
        continue;
      }
      if (['--cwd', '--task', '--milestone', '--unit', '--ceiling-ms', '--session', '--class', '--source-kind', '--source-ref', '--claim-generation'].includes(flag) && has) {
        const key = flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (options[key] !== undefined) fail('linked-task-usage'); options[key] = argv[++i]; continue;
      }
      fail('linked-task-usage');
    }
    if (!action || !options.cwd || (action === '--status' ? !options.task === !options.milestone : !options.task) || (action === '--admit') !== (options.unit !== undefined)
        || (action === '--extend') !== (options.ceilingMs !== undefined) || (action === '--extend' && !/^[1-9][0-9]{0,15}$/.test(options.ceilingMs))) fail('linked-task-usage');
    let result;
    if (LIVE_ACTIONS.includes(action) && typeof liveAdapter?.getDecisionHandle !== 'function') {
      // Refused before any read or write: the standalone CLI never carries live authority.
      result = { status: 'refused', task_id: options.task, reason: 'linked-task-authorization-required' };
    } else if (action === '--status') result = readLinkedStatus({ cwd: options.cwd, ...(options.task ? { task: options.task } : { milestone: options.milestone }) });
    else if (action === '--admit') result = decideLinkedTaskEntry({ cwd: options.cwd, taskId: options.task, unit: options.unit, ...(options.claimGeneration ? { claimGeneration: options.claimGeneration } : {}) });
    else if (action === '--inspect-drain') result = inspectTaskDrain({ cwd: options.cwd, task: options.task, liveAdapter });
    else if (action === '--checkpoint') result = checkpointTaskIfDrained({ cwd: options.cwd, task: options.task, liveAdapter });
    else if (action === '--extend') result = extendTaskHorizon({ cwd: options.cwd, task: options.task, ceilingMs: Number(options.ceilingMs), liveAdapter });
    else {
      const at = isoOf(Date.now());
      const record = action === '--presence' ? { type: 'presence', session_sha256: options.session ? digest(options.session) : null, boundary: options.value, at }
        : { type: action.slice(2), wait_id: options.value, class: options.class, source: { kind: options.sourceKind, ref: options.sourceRef }, at };
      result = appendTaskJournal({ cwd: options.cwd, task: options.task, record });
    }
    // Public JSON only: typed IDs, relative references and typed reasons, never an absolute path.
    let view = result;
    if (view !== null && Object.hasOwn(view, 'task_id')) view = { ...view, task_id: publicTask(view.task_id) };
    if (view !== null && Object.hasOwn(view?.details || {}, 'task_id')) view = { ...view, details: { ...view.details, task_id: publicTask(view.details.task_id) } };
    if (view !== null && !time().isPublicData(view)) {
      const reason = view.reason ?? view.reason_code;
      view = { status: typeof view.status === 'string' && /^[a-z-]{1,40}$/.test(view.status) ? view.status : 'refused', task_id: publicTask(view.task_id),
        reason: typeof reason === 'string' && /^[a-z][a-z0-9-]{0,100}$/.test(reason) ? reason : 'linked-task-output-not-public',
        ...(typeof view.allowed === 'boolean' ? { allowed: view.allowed } : {}) };
    }
    if (view !== null && !time().isPublicData(view)) fail('linked-task-output-not-public');
    io.stdout.write((json ? JSON.stringify(view) : message(action, view)) + '\n');
    return exitOf(action, view);
  } catch (e) {
    const reason = codeOf(e, 'linked-task-refused'), status = reason === 'linked-task-usage' ? 2 : 3;
    io.stdout.write(json ? JSON.stringify({ status: status === 2 ? 'usage' : 'refused', reason }) + '\n'
      : status === 2 ? 'Uso: --status|--admit --unit <tipo/id>|--presence <limite>|--wait-start <id>|--wait-end <id>|--inspect-drain|--checkpoint|--extend --ceiling-ms <ms> '
        + '--cwd <owner> --task <T> [--milestone <M>] [--class <classe> --source-kind <tipo> --source-ref <ref>] [--json]\n' : 'Operação recusada: ' + reason + '\n');
    return status;
  }
}

module.exports = { HORIZON_SCHEMA_VERSION, TASK_CLOCK_POLICY, LINKED_TASK_TRANSPORT_CODES, TASK_STATES, TASK_DRAIN_STATES, TASK_WRITER_CLASSES, TASK_CLAIM_STATES,
  HORIZON_REFUSALS, HORIZON_RECORD_FIELDS, TASK_UNIT_TYPES, readTaskClock, decideLinkedTaskEntry, assertLinkedTaskEntry, appendTaskJournal, inspectTaskDrain,
  checkpointTaskIfDrained, closureClock, extendTaskHorizon, prepareTaskExtension, answerTaskExtension, readLinkedStatus, summarizeLinkedStatus, validateCheckpointRecord: checkpointValid,
  validateExtensionRecord: extensionValid, main };
if (require.main === module) process.exitCode = main();
