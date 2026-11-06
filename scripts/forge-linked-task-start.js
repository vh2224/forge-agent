#!/usr/bin/env node
'use strict';

// Linked task lifecycle (S03/T03) over the T01 link records and the T02 endpoint:
// predecessor proof, the owner handoff produced at the milestone closure, the start
// with live reattested authority and a proven code base, the handoff consumed into the
// BRIEF, read-only continuation after a restart, explicit chain closure and the task
// closure by its verified canonical delivery.
//
// Authority is never data: only a NEW live opaque handle from the trusted host,
// verified by forge-milestone-time.verifyDecision against an explicit persisted owner
// answer, authorizes the start, the continuation and the chain closure. JSON, flags,
// the handoff itself, a serialized handle or a standalone CLI never do. Every refusal
// happens before the first write. Records are immutable owner records published by the
// generic T01 API inside one ownerBoundary; Git is read-only. The handoff carries
// SUMMARY text only as bounded, sanitized single-line evidence framed by T01.
// Import is inert: only core modules load here; local modules are required late.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HANDOFF_SCHEMA_VERSION = 1;
const LIFECYCLE_STATES = Object.freeze(['blocked', 'handoff-ready', 'open', 'started', 'closed', 'chain-closed', 'invalid']);
const BASE_KINDS = Object.freeze(['milestone-branch', 'integrated']);
const PREDECESSOR_REASONS = Object.freeze(['endpoint-unproven', 'milestone-budget-exhausted', 'milestone-budget-draining', 'milestone-budget-checkpointed', 'creation-pending']);
const START_REFUSALS = Object.freeze(['linked-task-not-linked', 'linked-task-state-invalid', 'predecessor-incomplete', 'linked-task-chain-closed',
  'linked-task-already-started', 'linked-task-not-started', 'linked-task-closed', 'linked-task-authorization-required', 'linked-task-authorization-revoked',
  'linked-task-start-request-required', 'linked-task-question-census-unknown', 'linked-task-handoff-missing', 'linked-task-handoff-tampered',
  'linked-task-handoff-stale', 'linked-task-handoff-foreign', 'linked-task-base-unproven', 'linked-task-base-drift', 'linked-task-isolation-invalid',
  'linked-task-personal-conflict', 'linked-task-start-conflict', 'linked-task-boundary-deferred', 'linked-task-failpoint', 'linked-task-start-failed', 'linked-task-decision-pending']);
const LIFECYCLE_REFUSALS = Object.freeze([...START_REFUSALS, 'linked-task-summary-missing', 'linked-task-handoff-conflict', 'linked-task-handoff-too-large',
  'linked-task-close-chain-request-required', 'linked-task-delivery-unproven', 'linked-task-closure-conflict', 'linked-task-decision-invalid', 'linked-task-operation-failed']);
const LINKED_DECISION_ACTIONS = Object.freeze(['start', 'close-chain']);
const HANDOFF_MARKERS = Object.freeze({ start: '<!-- forge:linked-handoff:start -->', end: '<!-- forge:linked-handoff:end -->' });
// Exact key order of every lifecycle record (shared/schemas/forge-linked-task-handoff.schema.json).
const HANDOFF_RECORD_FIELDS = Object.freeze({
  handoff: Object.freeze(['schema_version', 'kind', 'milestone', 'task_id', 'link_sha256', 'endpoint_sha256', 'produced_at', 'authorization', 'summary',
    'delivery', 'roadmap', 'forward_intelligence', 'decisions', 'moved_scope', 'criteria', 'gates', 'clocks', 'task_horizon', 'base_candidate']),
  authorization: Object.freeze(['scope', 'reference', 'question', 'answer', 'request_sha256']),
  summary: Object.freeze(['reference', 'sha256', 'fingerprint']),
  delivery: Object.freeze(['reference', 'sha256', 'fingerprint']),
  roadmap: Object.freeze(['reference', 'sha256', 'structure_sha256']),
  gates: Object.freeze(['plan_gate', 'security_gate', 'claims', 'verification', 'independent_review', 'slice_reviews']),
  clock: Object.freeze(['frozen', 'endpoint_at', 'consumed_ms', 'unknown_ms', 'endpoint_state', 'endpoint_ceiling_ms', 'endpoint_contract_version',
    'current_state', 'current_ceiling_ms', 'current_contract_version']),
  start_witness: Object.freeze(['schema_version', 'kind', 'milestone', 'task_id', 'link_sha256', 'start_sha256', 'start']),
  start: Object.freeze(['schema_version', 'kind', 'milestone', 'task_id', 'link_sha256', 'handoff_sha256', 'endpoint_sha256', 'brief_sha256', 'block_sha256',
    'authority', 'base', 'isolation', 'started_at']),
  authority: Object.freeze(['mode', 'reference', 'question', 'answer', 'request_sha256']),
  base_root: Object.freeze(['root_id', 'head', 'branch', 'endpoint_revision', 'target', 'ancestry', 'scope_sha256']),
  isolation: Object.freeze(['mode', 'branch', 'attached_to', 'worktree_count']),
  chain_closure: Object.freeze(['schema_version', 'kind', 'milestone', 'task_id', 'link_sha256', 'decision', 'closed_at']),
  closure: Object.freeze(['schema_version', 'kind', 'milestone', 'task_id', 'link_sha256', 'start_sha256', 'summary', 'delivery', 'closed_at', 'fingerprint']),
  closure_delivery: Object.freeze(['reference', 'sha256', 'input_sha256', 'fingerprint', 'criteria']),
  // Optional verified task clock projection retained at the genuine closure (R45): the last key of a closure record.
  closure_clock: Object.freeze(['policy', 'consumption', 'waits', 'overlap_ms', 'gaps', 'gap_count', 'journal_records', 'unknowns']),
});
const KINDS = Object.freeze({ handoff: 'forge-linked-task-handoff', start: 'forge-linked-task-start', 'start-witness': 'forge-linked-task-start-witness', 'chain-closure': 'forge-linked-task-chain-closure', closure: 'forge-linked-task-closure' });
const RECORDS = Object.freeze(['handoff', 'start', 'chain-closure', 'closure']);
const LINKED_SET = 'milestone-time-linked-task', CHAINED = 'create-and-start-after-proven-completion', EXPLICIT = 'create-without-auto-start';
// A declined decision (defer / keep-chain) stays as history; the next explicit request opens the next generation.
const MAX_GENERATIONS = 8;
const MAX_HANDOFF_BYTES = 16 * 1024, MAX_SUMMARY = 1024 * 1024, MAX_SOURCE = 1024 * 1024, MAX_BRIEF = 128 * 1024, MAX_ITEMS = 16, ITEM_TEXT = 300;
const HASH = /^[a-f0-9]{64}$/, REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, ROOT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ALTERNATIVES = Object.freeze([
  Object.freeze({ id: 'extend-milestone', text: 'Estender a milestone por decisão explícita e atestada do operador (nunca automática).' }),
  Object.freeze({ id: 'close-chain', text: 'Encerrar a cadeia por decisão explícita linked-task:close-chain; a task ligada não será iniciada.' })]);
const DECISION_TEXT = Object.freeze({
  start: { header: 'Início da task ligada', question: 'O endpoint da milestone foi comprovado e o handoff está pronto. Iniciar agora a task ligada?',
    options: [{ label: 'Iniciar a task ligada', description: 'Pedido explícito de início; a base de código e a autoridade ainda são comprovadas no início.', answer: 'linked-task:start' },
      { label: 'Não iniciar agora', description: 'Mantém a task ligada bloqueada; nada é iniciado.', answer: 'linked-task:defer' }] },
  'close-chain': { header: 'Encerrar a cadeia', question: 'Encerrar a cadeia milestone → task ligada? A task ligada não será iniciada nem continuada.',
    options: [{ label: 'Encerrar a cadeia', description: 'Decisão explícita; registra o encerramento e impede início e continuação.', answer: 'linked-task:close-chain' },
      { label: 'Manter a cadeia', description: 'Nada muda; a cadeia continua aguardando.', answer: 'linked-task:keep-chain' }] },
});
const MESSAGES = Object.freeze({
  'linked-task-not-linked': 'a task não tem vínculo com uma milestone', 'predecessor-incomplete': 'a milestone predecessora não está comprovada',
  'linked-task-authorization-required': 'falta uma reatestação viva e nova da autorização', 'linked-task-authorization-revoked': 'a autorização foi revogada ou diverge da resposta persistida',
  'linked-task-start-request-required': 'falta o pedido explícito de início do operador', 'linked-task-chain-closed': 'a cadeia foi encerrada por decisão explícita',
  'linked-task-already-started': 'a task ligada já foi iniciada', 'linked-task-not-started': 'a task ligada ainda não foi iniciada',
  'linked-task-handoff-missing': 'o handoff do fechamento não existe', 'linked-task-handoff-tampered': 'o handoff foi adulterado',
  'linked-task-handoff-stale': 'as fontes do handoff mudaram', 'linked-task-handoff-foreign': 'o handoff pertence a outra milestone ou task',
  'linked-task-base-unproven': 'a base de código não foi comprovada', 'linked-task-base-drift': 'o escopo do endpoint mudou na base informada',
  'linked-task-delivery-unproven': 'a entrega canônica da task não está comprovada',
  'linked-task-decision-pending': 'há uma decisão obrigatória pendente sobre a cadeia',
});

function fail(code, detail, extra) { throw Object.assign(new Error(code), { code, ...(detail ? { detail } : {}), ...(extra || {}) }); }
function object(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function exact(v, keys) { return object(v) && Object.keys(v).length === keys.length && keys.every((k, i) => Object.keys(v)[i] === k); }
function hash(v) { return typeof v === 'string' && HASH.test(v); }
function count(v) { return Number.isSafeInteger(v) && v >= 0; }
function nullableMs(v) { return v === null || Number.isSafeInteger(v); }
function instant(v) { return typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v; }
function codeOf(e, fallback) { return typeof e?.code === 'string' && /^[a-z][a-z0-9-]{0,100}$/.test(e.code) ? e.code : fallback; }
function time() { return require('./forge-milestone-time'); }
function selection() { return require('./forge-milestone-time-selection'); }
function linkedTask() { return require('./forge-linked-task'); }
function endpoints() { return require('./forge-milestone-endpoint'); }
function clocks() { return require('./forge-milestone-time-clock'); }
function admission() { return require('./forge-milestone-time-admission'); }
function horizonModule() { return require('./forge-linked-task-horizon'); }
function questions() { return require('./forge-pending-questions'); }
function runs() { return require('./forge-runs'); }
function personal() { return require('./forge-personal-context'); }
function typedId(value, kind) {
  const ids = require('./forge-ids');
  return typeof value === 'string' && !/[\\/\0]/.test(value) && ids.isValid(value) && ids.entityKind(value) === kind;
}
function digest(v) { return require('./forge-code-roots').digest(v); }
function canonical(v) { return Array.isArray(v) ? v.map(canonical) : object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v; }
function same(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
function samePath(a, b) { return process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b; }
function nowOf(input) { const now = input.now ?? Date.now(); if (!Number.isSafeInteger(now)) fail('linked-task-state-invalid', 'now-invalid'); return now; }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function noLinks(file) {
  for (let cursor = path.resolve(file); ; cursor = path.dirname(cursor)) {
    let stat = null;
    try { stat = fs.lstatSync(cursor); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (stat && stat.isSymbolicLink()) fail('linked-task-state-invalid', 'path-link');
    if (path.dirname(cursor) === cursor) return;
  }
}
// Bounded, link-free read of one owner-relative file; null only when it is absent.
function ownerBytes(owner, relative, max) {
  const file = path.join(owner, ...relative.split('/'));
  noLinks(file);
  let stat; try { stat = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (!stat.isFile() || stat.size > max) fail('linked-task-state-invalid', 'source-unreadable');
  const read = require('./forge-autonomy-sources').readBoundedStableFile(file, max, { expectedReal: fs.realpathSync.native(file) });
  if (read.error) fail('linked-task-state-invalid', 'source-unstable');
  return read.buffer;
}
function ownerOf(input) { try { return selection().ownerRoot(input); } catch { fail('linked-task-state-invalid', 'owner-invalid'); } }
function point(input, name) { if (typeof input.failpoint === 'function' && input.failpoint(name)) fail('linked-task-failpoint', name); }
function recordPath(name) { return 'linked-task/' + name + '.json'; }
function recordSource(owner, milestone, name) { return path.join(owner, '.gsd', 'forge', 'time', milestone, 'linked-task', name + '.json'); }
function briefFile(owner, task) { return path.join(owner, '.gsd', 'tasks', task, task + '-BRIEF.md'); }
function personalOptions(owner, input) { return { project: owner, userHome: input.userHome, env: input.env }; }

// ---------------------------------------------------------------------------
// Link probe and lifecycle records
// ---------------------------------------------------------------------------
function probeTask(owner, task) {
  const probe = linkedTask().linkedTaskFor(owner, task);
  if (probe === null) fail('linked-task-not-linked');
  if (probe.status !== 'linked') fail('linked-task-state-invalid', probe.reason);
  return probe;
}
function probeMilestone(owner, milestone) {
  const read = time().readOwnerRecord({ cwd: owner, milestone, path: 'linked-task/link.json' });
  if (read.status === 'absent') fail('linked-task-not-linked');
  if (read.status !== 'valid' || typeof read.record?.task_id !== 'string') fail('linked-task-state-invalid', 'link-invalid');
  const probe = probeTask(owner, read.record.task_id);
  if (probe.milestone !== milestone || probe.link_sha256 !== read.sha256) fail('linked-task-state-invalid', 'link-invalid');
  return probe;
}
function probeOf(owner, input) {
  if (typeof input.task === 'string' || typeof input.taskId === 'string') return probeTask(owner, input.task ?? input.taskId);
  if (typeof input.milestone === 'string') return probeMilestone(owner, input.milestone);
  fail('linked-task-not-linked');
}
function decisionValid(v) {
  return exact(v, ['reference', 'question', 'answer', 'request_sha256']) && (v.reference === null || typeof v.reference === 'string' && v.reference.length <= 120)
    && exact(v.question, ['identity_sha256', 'id']) && hash(v.question.identity_sha256) && typeof v.question.id === 'string' && typeof v.answer === 'string' && hash(v.request_sha256);
}
function texts(v, max = MAX_ITEMS) { return Array.isArray(v) && v.length <= max && v.every(t => typeof t === 'string' && t.length <= 1000); }
const ENDPOINT_STATES = Object.freeze(['active', 'warning', 'exhausted', 'draining', 'checkpointed', 'extended']);
const CURRENT_STATES = Object.freeze(['active', 'warning', 'extended']);
function handoffValid(v) {
  const F = HANDOFF_RECORD_FIELDS;
  return exact(v, F.handoff) && v.schema_version === HANDOFF_SCHEMA_VERSION && v.kind === KINDS.handoff && typedId(v.milestone, 'milestone') && typedId(v.task_id, 'task')
    && hash(v.link_sha256) && hash(v.endpoint_sha256) && instant(v.produced_at)
    && exact(v.authorization, F.authorization) && [CHAINED, EXPLICIT].includes(v.authorization.scope) && decisionValid({ reference: v.authorization.reference,
      question: v.authorization.question, answer: v.authorization.answer, request_sha256: v.authorization.request_sha256 })
    && exact(v.summary, F.summary) && typeof v.summary.reference === 'string' && hash(v.summary.sha256) && hash(v.summary.fingerprint)
    && exact(v.delivery, F.delivery) && typeof v.delivery.reference === 'string' && hash(v.delivery.sha256) && hash(v.delivery.fingerprint)
    && exact(v.roadmap, F.roadmap) && typeof v.roadmap.reference === 'string' && hash(v.roadmap.sha256) && (v.roadmap.structure_sha256 === null || hash(v.roadmap.structure_sha256))
    && texts(v.forward_intelligence) && texts(v.decisions)
    && Array.isArray(v.moved_scope) && v.moved_scope.length > 0 && v.moved_scope.length <= 64 && v.moved_scope.every(r => exact(r, ['id', 'title']) && typeof r.id === 'string' && (r.title === null || typeof r.title === 'string'))
    && exact(v.criteria, ['milestone', 'task']) && texts(v.criteria.milestone, 64) && texts(v.criteria.task, 64)
    && exact(v.gates, F.gates) && ['plan_gate', 'security_gate', 'claims', 'verification', 'independent_review'].every(k => v.gates[k] === 'required')
    && Array.isArray(v.gates.slice_reviews) && v.gates.slice_reviews.length > 0 && v.gates.slice_reviews.every(r => exact(r, ['slice', 'reference', 'sha256']) && hash(r.sha256))
    && exact(v.clocks, ['milestone']) && exact(v.clocks.milestone, F.clock) && v.clocks.milestone.frozen === true && instant(v.clocks.milestone.endpoint_at)
    && count(v.clocks.milestone.consumed_ms) && count(v.clocks.milestone.unknown_ms) && nullableMs(v.clocks.milestone.endpoint_ceiling_ms) && nullableMs(v.clocks.milestone.current_ceiling_ms)
    && [...ENDPOINT_STATES, null].includes(v.clocks.milestone.endpoint_state) && CURRENT_STATES.includes(v.clocks.milestone.current_state)
    && Number.isSafeInteger(v.clocks.milestone.endpoint_contract_version) && v.clocks.milestone.endpoint_contract_version >= 1
    && Number.isSafeInteger(v.clocks.milestone.current_contract_version) && v.clocks.milestone.current_contract_version >= 1
    && exact(v.task_horizon, ['low_ms', 'high_ms', 'ceiling_ms']) && ['low_ms', 'high_ms', 'ceiling_ms'].every(k => Number.isSafeInteger(v.task_horizon[k]) && v.task_horizon[k] > 0)
    && exact(v.base_candidate, ['roots']) && Array.isArray(v.base_candidate.roots) && v.base_candidate.roots.length > 0
    && v.base_candidate.roots.every(r => exact(r, ['root_id', 'revision', 'branch', 'scope_sha256']) && ROOT_ID.test(r.root_id) && REVISION.test(r.revision)
      && (r.branch === null || typeof r.branch === 'string') && hash(r.scope_sha256))
    && Buffer.byteLength(JSON.stringify(v) + '\n') <= MAX_HANDOFF_BYTES && time().isPublicData(v);
}
function startValid(v) {
  const F = HANDOFF_RECORD_FIELDS;
  return exact(v, F.start) && v.schema_version === HANDOFF_SCHEMA_VERSION && v.kind === KINDS.start && typedId(v.milestone, 'milestone') && typedId(v.task_id, 'task')
    && ['link_sha256', 'handoff_sha256', 'endpoint_sha256', 'brief_sha256', 'block_sha256'].every(k => hash(v[k]))
    && exact(v.authority, F.authority) && ['chained', 'explicit'].includes(v.authority.mode)
    && decisionValid({ reference: v.authority.reference, question: v.authority.question, answer: v.authority.answer, request_sha256: v.authority.request_sha256 })
    && exact(v.base, ['kind', 'roots']) && BASE_KINDS.includes(v.base.kind) && Array.isArray(v.base.roots) && v.base.roots.length > 0
    && v.base.roots.every(r => exact(r, F.base_root) && ROOT_ID.test(r.root_id) && REVISION.test(r.head) && REVISION.test(r.endpoint_revision)
      && (r.target === null || REVISION.test(r.target)) && ['ancestor', 'not-ancestor', 'unknown'].includes(r.ancestry) && hash(r.scope_sha256))
    && exact(v.isolation, F.isolation) && ['shared', 'branch', 'worktree'].includes(v.isolation.mode) && count(v.isolation.worktree_count)
    && instant(v.started_at) && time().isPublicData(v);
}
// The independent witness of a start: a separate immutable owner record published BEFORE start.json
// that carries the complete start record and its canonical digest. A start edited alone, in any
// canonical field, no longer equals its witness.
function startWitnessValid(v) {
  return exact(v, HANDOFF_RECORD_FIELDS.start_witness) && v.schema_version === HANDOFF_SCHEMA_VERSION && v.kind === KINDS['start-witness'] && typedId(v.milestone, 'milestone')
    && typedId(v.task_id, 'task') && hash(v.link_sha256) && hash(v.start_sha256) && startValid(v.start) && digest(v.start) === v.start_sha256
    && v.start.milestone === v.milestone && v.start.task_id === v.task_id && v.start.link_sha256 === v.link_sha256 && time().isPublicData(v);
}
function chainClosureValid(v) {
  return exact(v, HANDOFF_RECORD_FIELDS.chain_closure) && v.schema_version === HANDOFF_SCHEMA_VERSION && v.kind === KINDS['chain-closure'] && hash(v.link_sha256)
    && typedId(v.milestone, 'milestone') && typedId(v.task_id, 'task')
    && decisionValid(v.decision) && v.decision.answer === 'linked-task:close-chain' && instant(v.closed_at) && time().isPublicData(v);
}
// The retained clock of a closed task: bounded integers and typed reasons only. Its coherence with the closure
// instants (partition of the horizon, consumption table) is checked by the horizon reader that consumes it.
function closureClockValid(c) {
  const F = HANDOFF_RECORD_FIELDS, ints = o => object(o) && Object.keys(o).length <= 16 && Object.entries(o).every(([k, n]) => /^[a-z][a-z-]{0,40}$/.test(k) && count(n));
  return exact(c, F.closure_clock) && exact(c.policy, ['id', 'version']) && typeof c.policy.id === 'string' && /^[a-z][a-z0-9-]{0,60}$/.test(c.policy.id) && Number.isSafeInteger(c.policy.version) && c.policy.version > 0
    && exact(c.consumption, ['consumed_ms', 'unknown_ms', 'by_class']) && count(c.consumption.consumed_ms) && count(c.consumption.unknown_ms) && ints(c.consumption.by_class)
    && ints(c.waits) && count(c.overlap_ms) && Array.isArray(c.gaps) && c.gaps.length <= 64 && count(c.gap_count) && c.gap_count >= c.gaps.length
    && c.gaps.every(g => exact(g, ['start', 'end', 'reason']) && count(g.start) && count(g.end) && g.end >= g.start && typeof g.reason === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(g.reason))
    && count(c.journal_records) && Array.isArray(c.unknowns) && c.unknowns.length <= 16 && c.unknowns.every(u => typeof u === 'string' && /^[a-z][a-z0-9-]{0,80}$/.test(u));
}
function closureValid(v) {
  return (exact(v, HANDOFF_RECORD_FIELDS.closure) || exact(v, [...HANDOFF_RECORD_FIELDS.closure, 'clock']) && closureClockValid(v.clock)) && v.schema_version === HANDOFF_SCHEMA_VERSION && v.kind === KINDS.closure && hash(v.link_sha256) && hash(v.start_sha256)
    && typedId(v.milestone, 'milestone') && typedId(v.task_id, 'task')
    && exact(v.summary, ['reference', 'sha256']) && hash(v.summary.sha256) && exact(v.delivery, HANDOFF_RECORD_FIELDS.closure_delivery)
    && hash(v.delivery.sha256) && hash(v.delivery.input_sha256) && hash(v.delivery.fingerprint) && Number.isSafeInteger(v.delivery.criteria) && v.delivery.criteria > 0
    && instant(v.closed_at) && v.fingerprint === v.delivery.fingerprint && time().isPublicData(v);
}
const VALIDATORS = Object.freeze({ handoff: handoffValid, start: startValid, 'chain-closure': chainClosureValid, closure: closureValid });
// Every lifecycle record of one link: absent, valid (and bound to this exact link) or invalid.
function lifecycleRecords(owner, probe) {
  const out = {};
  for (const name of RECORDS) {
    const read = time().readOwnerRecord({ cwd: owner, milestone: probe.milestone, path: recordPath(name) });
    if (read.status === 'absent') { out[name] = { status: 'absent' }; continue; }
    if (read.status !== 'valid' || !VALIDATORS[name](read.record)) { out[name] = { status: 'invalid', reason: 'tampered' }; continue; }
    const r = read.record;
    out[name] = r.milestone !== probe.milestone || r.task_id !== probe.task_id || r.link_sha256 !== probe.link_sha256
      ? { status: 'invalid', reason: 'foreign', record: r, sha256: read.sha256 } : { status: 'valid', record: r, sha256: read.sha256 };
  }
  return out;
}
function requireRecords(owner, probe) {
  const recs = lifecycleRecords(owner, probe);
  for (const name of ['chain-closure', 'closure', 'start']) if (recs[name].status === 'invalid') fail('linked-task-state-invalid', name + '-' + recs[name].reason);
  return recs;
}
function startWitnessIntact(owner, probe, start) {
  const witness = time().readOwnerRecord({ cwd: owner, milestone: probe.milestone, path: recordPath('start-witness') });
  return witness.status === 'valid' && startWitnessValid(witness.record) && witness.record.milestone === probe.milestone && witness.record.task_id === probe.task_id
    && witness.record.link_sha256 === probe.link_sha256 && witness.record.start_sha256 === start.sha256 && same(witness.record.start, start.record);
}
// linkedLifecycle(cwd, task): null for an unlinked task (no time state read); otherwise
// one of LIFECYCLE_STATES from the immutable records. Pure read, never throws.
function linkedLifecycle(cwd, task) {
  try {
    const owner = ownerOf(cwd), probe = linkedTask().linkedTaskFor(owner, task);
    if (probe === null) return null;
    if (probe.status !== 'linked') return { status: 'invalid', task_id: typeof task === 'string' ? task : null, reason: probe.reason };
    const recs = lifecycleRecords(owner, probe), base = { task_id: probe.task_id, milestone: probe.milestone, link_sha256: probe.link_sha256, authorization: probe.authorization };
    const bad = RECORDS.find(name => recs[name].status === 'invalid');
    if (bad) return { status: 'invalid', ...base, reason: 'linked-task-record-' + recs[bad].reason, record: bad };
    // A start (and so a started or closed lifecycle) is exposed only while it equals its independently
    // published witness: a canonical single-file edit is invalid for every reader (clock, status, summaries).
    if (recs.start.status === 'valid' && !startWitnessIntact(owner, probe, recs.start)) return { status: 'invalid', ...base, reason: 'linked-task-record-start-witness', record: 'start' };
    const shas = Object.fromEntries(RECORDS.filter(n => recs[n].status === 'valid').map(n => [n.replace('-', '_') + '_sha256', recs[n].sha256]));
    const status = recs.closure.status === 'valid' ? 'closed' : recs['chain-closure'].status === 'valid' ? 'chain-closed' : recs.start.status === 'valid' ? 'started'
      : recs.handoff.status === 'valid' ? (probe.authorization === CHAINED ? 'handoff-ready' : 'open') : 'blocked';
    return { status, ...base, ...shas, ...(status === 'blocked' ? { reason: 'handoff-pending' } : {}) };
  } catch { return { status: 'invalid', task_id: typeof task === 'string' ? task : null, reason: 'linked-task-state-invalid' }; }
}

// ---------------------------------------------------------------------------
// Predecessor proof
// ---------------------------------------------------------------------------
// The persisted counterpart of an attested extension, exactly as verifyDecision checks it at
// amendment time: an answered owner question of this milestone in milestone-time-extension
// whose answer names the extended ceiling. A forged or imported amendment row has none.
function extensionAttested(owner, milestone, row) {
  try {
    const q = questions(), cont = q.continuation({ cwd: owner, identity: row.decision.question.identity_sha256 });
    const listed = q.listPendingQuestions({ cwd: owner, filter: { type: 'milestone', id: milestone } });
    const identity = cont.identity, stored = cont.questions?.find(x => x.id === row.decision.question.id);
    const shown = listed.questions.find(x => x.id === row.decision.question.id && same(x.origin, identity));
    return cont.ok === true && identity?.origin === 'owner' && identity.milestone === milestone && identity.decision_set === 'milestone-time-extension'
      && stored?.status === 'resolved' && stored.answer === row.decision.answer && row.decision.answer === 'extend:' + row.patch?.ceiling_ms
      && shown?.last_round?.outcome === 'answered' && !listed.census.excess && !listed.census.invalid;
  } catch { return false; }
}
function incomplete(probe, reason, detail) {
  return { status: 'predecessor-incomplete', milestone: probe.milestone, task_id: probe.task_id, reason, ...(detail ? { detail } : {}), alternatives: ALTERNATIVES.map(a => ({ ...a })) };
}
// Shared proof: creation completeness (the T01 reader, only while no start progress exists),
// the T02 endpoint bound to the current chain, only canonical attested extensions after it,
// the clock frozen at this endpoint and the effective state derived by the canonical status
// reader from that frozen consumption and the current validated ceiling.
function predecessorOf(owner, probe, input, progress = false) {
  const M = probe.milestone, now = nowOf(input);
  const closure = time().readOwnerRecord({ cwd: owner, milestone: M, path: recordPath('chain-closure') });
  if (closure.status === 'valid') return { result: { status: 'chain-closed', milestone: M, task_id: probe.task_id, reason: 'linked-task-chain-closed' } };
  if (closure.status !== 'absent') return { result: { status: 'invalid', milestone: M, task_id: probe.task_id, reason: 'linked-task-state-invalid', detail: 'chain-closure-invalid' } };
  if (!progress) {
    const creation = linkedTask().readLinkedTask({ cwd: owner, task: probe.task_id, userHome: input.userHome, env: input.env });
    if (creation.status === 'creation-pending') return { result: incomplete(probe, 'creation-pending', (creation.missing || []).join(',') || null) };
    if (creation.status !== 'created') return { result: { status: 'invalid', milestone: M, task_id: probe.task_id, reason: 'linked-task-state-invalid', detail: creation.reason || creation.status } };
  }
  const read = endpoints().readEndpoint({ cwd: owner, milestone: M });
  if (read.status !== 'valid') return { result: incomplete(probe, 'endpoint-unproven', read.status === 'absent' ? 'endpoint-absent' : read.reason) };
  const contract = time().readContract({ cwd: owner, milestone: M });
  if (contract.status !== 'valid') return { result: incomplete(probe, 'endpoint-unproven', 'contract-invalid') };
  for (const row of contract.chain.slice(read.record.contract.version)) {
    if (row.kind !== 'extension' || !row.decision) return { result: incomplete(probe, 'endpoint-unproven', 'contract-changed-after-endpoint') };
    if (!extensionAttested(owner, M, row)) return { result: incomplete(probe, 'endpoint-unproven', 'extension-unattested') };
  }
  const frozen = clocks().readClock({ cwd: owner, milestone: M, now });
  if (frozen.status !== 'measured' || frozen.frozen !== true || frozen.endpoint?.sha256 !== read.sha256 || frozen.consumption?.consumed_ms !== read.record.clock.consumed_ms) {
    return { result: incomplete(probe, 'endpoint-unproven', 'clock-not-frozen') };
  }
  // Milestone-only canonical status (explicit seam): the predecessor needs the milestone horizon,
  // never the linked projection that itself consults this proof.
  const status = admission().readMilestoneTimeStatus(owner, M, { now });
  if (status.contract !== 'valid' || status.contract_version !== contract.version || status.clocks?.consumed_ms !== read.record.clock.consumed_ms) {
    return { result: incomplete(probe, 'endpoint-unproven', 'time-state-unknown') };
  }
  // The canonical status of this frozen endpoint is endpoint-proven with this exact proof; the
  // budget at the frozen consumption travels separately as budget_state and alone decides the
  // predecessor budget (endpoint-proven itself is never a budget allowance).
  if (status.state !== 'endpoint-proven' || status.horizon?.endpoint_proof?.sha256 !== read.sha256) {
    return { result: incomplete(probe, 'endpoint-unproven', 'time-state-unknown') };
  }
  const budget = status.budget_state;
  if (['exhausted', 'draining', 'checkpointed'].includes(budget)) return { result: incomplete(probe, 'milestone-budget-' + budget, null) };
  if (!['active', 'warning', 'extended'].includes(budget)) return { result: incomplete(probe, 'endpoint-unproven', 'time-state-unknown') };
  const historical = read.record.time_state;
  return { endpoint: read, contract, status, budget, result: { status: 'proven', milestone: M, task_id: probe.task_id, link_sha256: probe.link_sha256, endpoint_sha256: read.sha256,
    endpoint_at: read.record.endpoint_at, historical: { state: historical.state, ceiling_ms: historical.ceiling_ms, consumed_ms: historical.consumed_ms, contract_version: historical.contract_version },
    current: { state: budget, ceiling_ms: status.horizon.ceiling_ms, remaining_ms: status.remaining_ms, contract_version: status.contract_version } } };
}
// provePredecessor({cwd, task} | {cwd, milestone}, now): proven only from the actual records; never throws.
function provePredecessor(input = {}) {
  try {
    if (!object(input)) fail('linked-task-state-invalid');
    const owner = ownerOf(input), probe = probeOf(owner, input);
    return predecessorOf(owner, probe, input).result;
  } catch (e) { return { status: 'invalid', reason: codeOf(e, 'linked-task-state-invalid'), ...(e.detail ? { detail: e.detail } : {}) }; }
}

// ---------------------------------------------------------------------------
// Handoff (owner, at the milestone closure, after the endpoint)
// ---------------------------------------------------------------------------
// Bounded cut of two SUMMARY sections into sanitized single-line items; nothing else is parsed.
function summarySections(text) {
  const out = { forward: [], decisions: [] };
  let target = null;
  for (const raw of text.split(/\r?\n/)) {
    const heading = /^#{2,3}\s+(.+?)\s*#*\s*$/.exec(raw);
    if (heading) {
      const name = heading[1].toLowerCase();
      target = /^forward intelligence\b/.test(name) ? 'forward' : /^(?:key decisions|decis(?:ões|oes)(?:-chave| principais)?|decisions)\b/.test(name) ? 'decisions' : null;
      continue;
    }
    if (!target || out[target].length >= MAX_ITEMS) continue;
    const item = raw.replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, '').trim();
    if (!item) continue;
    const clean = linkedTask().sanitizeEvidenceText(item, ITEM_TEXT);
    if (clean) out[target].push(clean);
  }
  return out;
}
function handoffSources(owner, probe, endpoint) {
  const M = probe.milestone, e = endpoint.record, dir = '.gsd/milestones/' + M;
  const summaryRef = `${dir}/${M}-SUMMARY.md`, roadmapRef = `${dir}/${M}-ROADMAP.md`;
  const summary = ownerBytes(owner, summaryRef, MAX_SUMMARY);
  if (summary === null) fail('linked-task-summary-missing');
  const delivery = ownerBytes(owner, e.delivery.reference, MAX_SOURCE);
  if (delivery === null || sha256(delivery) !== e.delivery.sha256) fail('linked-task-handoff-stale', 'delivery-changed');
  const roadmap = ownerBytes(owner, roadmapRef, MAX_SOURCE);
  if (roadmap === null || sha256(roadmap) !== e.roadmap.sha256) fail('linked-task-handoff-stale', 'roadmap-changed');
  let identity; try { identity = time().roadmapIdentity(roadmap); } catch { fail('linked-task-handoff-stale', 'roadmap-invalid'); }
  if (e.roadmap.structure_sha256 !== null && identity.structure_sha256 !== e.roadmap.structure_sha256) fail('linked-task-handoff-stale', 'roadmap-changed');
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(summary); } catch { fail('linked-task-handoff-stale', 'summary-encoding'); }
  return { summaryRef, roadmapRef, summary, delivery, roadmap, identity, sections: summarySections(text) };
}
// Deterministic handoff of the current sources; produced_at and the current clock
// projection are the only fields that legitimately vary between two builds.
function buildHandoff(owner, probe, proof, now) {
  const link = probe.link, e = proof.endpoint.record, src = handoffSources(owner, probe, proof.endpoint);
  const sanitize = v => linkedTask().sanitizeEvidenceText(v, ITEM_TEXT);
  const offered = time().readOptions({ cwd: owner, milestone: probe.milestone, options_sha256: link.options_sha256 });
  const items = offered.status === 'valid' && Array.isArray(offered.record?.proposal?.scope_items) ? offered.record.proposal.scope_items : [];
  const record = { schema_version: HANDOFF_SCHEMA_VERSION, kind: KINDS.handoff, milestone: probe.milestone, task_id: probe.task_id, link_sha256: probe.link_sha256,
    endpoint_sha256: proof.endpoint.sha256, produced_at: new Date(now).toISOString(),
    authorization: { scope: link.authorization, reference: link.decision.reference, question: { identity_sha256: link.decision.question.identity_sha256, id: link.decision.question.id },
      answer: link.decision.answer, request_sha256: link.decision.request_sha256 },
    summary: { reference: src.summaryRef, sha256: sha256(src.summary), fingerprint: digest({ policy: 'forge-linked-task-summary-cut-v1', forward_intelligence: src.sections.forward, decisions: src.sections.decisions }) },
    delivery: { reference: e.delivery.reference, sha256: e.delivery.sha256, fingerprint: e.delivery.fingerprint },
    roadmap: { reference: src.roadmapRef, sha256: e.roadmap.sha256, structure_sha256: e.roadmap.structure_sha256 },
    forward_intelligence: src.sections.forward, decisions: src.sections.decisions,
    moved_scope: link.linked_task.moved_scope.map(id => { const row = items.find(r => r?.id === id); return { id, title: row ? sanitize(row.title) : null }; }),
    criteria: { milestone: link.linked_task.criteria.milestone.map(sanitize), task: link.linked_task.criteria.task.map(sanitize) },
    gates: { plan_gate: 'required', security_gate: 'required', claims: 'required', verification: 'required', independent_review: 'required',
      slice_reviews: e.reviews.map(r => ({ slice: r.slice, reference: r.reference, sha256: r.sha256 })) },
    clocks: { milestone: { frozen: true, endpoint_at: e.endpoint_at, consumed_ms: e.clock.consumed_ms, unknown_ms: e.clock.unknown_ms, endpoint_state: e.time_state.state,
      endpoint_ceiling_ms: e.time_state.ceiling_ms, endpoint_contract_version: e.contract.version, current_state: proof.budget,
      current_ceiling_ms: proof.status.horizon.ceiling_ms, current_contract_version: proof.status.contract_version } },
    task_horizon: { low_ms: link.linked_task.horizon.low_ms, high_ms: link.linked_task.horizon.high_ms, ceiling_ms: link.linked_task.horizon.ceiling_ms },
    base_candidate: { roots: e.roots.map(r => ({ root_id: r.root_id, revision: r.revision, branch: r.branch, scope_sha256: digest(r.scope) })) } };
  // Both the record and its framed BRIEF evidence stay within 16 KiB: trailing SUMMARY items
  // are dropped deterministically (never truncated mid-item) until both fit.
  const framed = r => { try { linkedTask().frameLinkedEvidence('handoff', r); return true; } catch { return false; } };
  const fits = r => Buffer.byteLength(JSON.stringify(r) + '\n') <= MAX_HANDOFF_BYTES && framed(r);
  while (!fits(record) && (record.forward_intelligence.length || record.decisions.length)) {
    (record.forward_intelligence.length >= record.decisions.length ? record.forward_intelligence : record.decisions).pop();
  }
  record.summary.fingerprint = digest({ policy: 'forge-linked-task-summary-cut-v1', forward_intelligence: record.forward_intelligence, decisions: record.decisions });
  if (!fits(record)) fail('linked-task-handoff-too-large');
  if (!time().isPublicData(record) || !handoffValid(record)) fail('linked-task-state-invalid', 'handoff-not-public');
  return record;
}
function stableHandoff(record) {
  const value = structuredClone(record); delete value.produced_at;
  for (const k of ['current_state', 'current_ceiling_ms', 'current_contract_version']) delete value.clocks.milestone[k];
  return value;
}
function deriveHandoffSnapshot(input) {
  const owner = ownerOf(input), probe = probeOf(owner, input), recs = requireRecords(owner, probe);
  if (recs['chain-closure'].status === 'valid') fail('linked-task-chain-closed');
  const proof = predecessorOf(owner, probe, input, recs.start.status === 'valid');
  if (proof.result.status !== 'proven') fail('predecessor-incomplete', proof.result.reason);
  return buildHandoff(owner, probe, proof, nowOf(input));
}
function handoffBindingMatches(binding, record) {
  return object(binding) && handoffValid(record) && binding.schema_version === 1 && binding.kind === 'forge-linked-task-handoff-binding'
    && binding.milestone === record.milestone && binding.task_id === record.task_id && binding.handoff_sha256 === digest(record) && same(binding.handoff, record);
}
function requireHandoffBinding(owner, milestone, record) {
  const bound = time().readHandoffBinding({ cwd: owner, milestone });
  if (bound.status !== 'valid' || !handoffBindingMatches(bound.binding, record)) fail('linked-task-handoff-tampered', 'content-changed');
}
// Pure: the exact framed section consumed into the BRIEF (and later into the prompts).
function renderHandoffBlock(handoff) {
  if (!handoffValid(handoff)) fail('linked-task-handoff-tampered');
  const sha = digest(handoff);
  return [HANDOFF_MARKERS.start, '## Handoff consumido da milestone', '',
    '- **Milestone:** `' + handoff.milestone + '`; **endpoint:** `' + handoff.endpoint_sha256 + '`; **handoff:** `' + sha + '`.',
    '- **Fonte:** `.gsd/forge/time/' + handoff.milestone + '/linked-task/handoff.json` (registro imutável do owner).',
    '- Os gates continuam obrigatórios (plan gate, security gate, claims, verificação e revisão independente); este bloco não concede autoridade.', '',
    linkedTask().frameLinkedEvidence('handoff', handoff), HANDOFF_MARKERS.end, ''].join('\n');
}
// Which bound source of a handoff changed since it was produced (null when all are current).
function handoffSourceChange(owner, h) {
  for (const [name, ref, max] of [['summary', h.summary.reference, MAX_SUMMARY], ['delivery', h.delivery.reference, MAX_SOURCE], ['roadmap', h.roadmap.reference, MAX_SOURCE]]) {
    if (typeof ref !== 'string' || !ref.startsWith('.gsd/milestones/' + h.milestone + '/') || ref.includes('..')) return name + '-changed';
    let bytes; try { bytes = ownerBytes(owner, ref, max); } catch { bytes = null; }
    if (bytes === null || sha256(bytes) !== h[name].sha256) return name + '-changed';
  }
  return null;
}
// Handoff validation against the link and the current sources, in a fixed order: absent,
// unreadable or non-canonical bytes, another milestone/task/link, changed sources, then a
// value edited in place (the deterministic rebuild from the same sources differs) or bytes
// that no longer match the owner's own capture of handoff.json.
function validateHandoff(owner, probe, read, proof, input) {
  if (!read || read.status === 'absent') fail('linked-task-handoff-missing');
  const stored = time().readOwnerRecord({ cwd: owner, milestone: probe.milestone, path: recordPath('handoff') });
  if (stored.status !== 'valid' || !handoffValid(stored.record)) fail('linked-task-handoff-tampered', stored.status === 'valid' ? 'schema-invalid' : 'bytes-invalid');
  const h = stored.record;
  if (h.milestone !== probe.milestone || h.task_id !== probe.task_id || h.link_sha256 !== probe.link_sha256) fail('linked-task-handoff-foreign');
  if (h.endpoint_sha256 !== proof.endpoint.sha256) fail('linked-task-handoff-stale', 'endpoint-changed');
  const changed = handoffSourceChange(owner, h);
  if (changed) fail('linked-task-handoff-stale', changed);
  let rebuilt; try { rebuilt = buildHandoff(owner, probe, proof, nowOf(input)); } catch (e) { if (e.code === 'linked-task-handoff-stale') throw e; fail('linked-task-handoff-tampered', 'rebuild-failed'); }
  if (!same(stableHandoff(rebuilt), stableHandoff(h))) fail('linked-task-handoff-tampered', 'content-changed');
  requireHandoffBinding(owner, probe.milestone, h);
  let work = null; try { work = personalWork(owner, probe.task_id, input); } catch { work = null; }
  const captured = Object.values(work?.checkpoint || {}).flat().filter(c => samePath(c.source, recordSource(owner, probe.milestone, 'handoff')));
  if (captured.some(c => c.validity !== 'current')) fail('linked-task-handoff-tampered', 'capture-mismatch');
  return { record: h, sha256: stored.sha256 };
}

// ---------------------------------------------------------------------------
// Personal checkpoint transitions (only the lifecycle's own captures are replaced)
// ---------------------------------------------------------------------------
function ownSource(owner, milestone, source) {
  return ['link', ...RECORDS].some(name => samePath(source, recordSource(owner, milestone, name)) || samePath(source, path.join(fs.realpathSync.native(owner), '.gsd', 'forge', 'time', milestone, 'linked-task', name + '.json')));
}
function personalWork(owner, task, input) {
  const snapshot = personal().readPersonalSnapshot({ ...personalOptions(owner, input), id: task });
  const work = snapshot.status === 'ok' ? snapshot.works.find(w => w.id === task) : null;
  if (!work) fail('linked-task-personal-conflict', snapshot.reason || 'binding-missing');
  return work;
}
// Refuses (before any write) when a field to be replaced holds an independent capture.
function personalPlan(owner, probe, input, entries) {
  const work = personalWork(owner, probe.task_id, input), fields = Object.keys(entries);
  for (const field of fields) {
    if ((work.checkpoint?.[field] || []).some(c => !ownSource(owner, probe.milestone, c.source))) fail('linked-task-personal-conflict', field);
  }
  const done = fields.every(field => {
    const current = work.checkpoint?.[field] || [];
    return current.length === entries[field].length && entries[field].every((e, i) => current[i].text === e.text && samePath(current[i].source, e.source)
      && current[i].resolved === e.resolved && current[i].validity === 'current');
  });
  const expectedCheckpoint = Object.fromEntries(fields.map(field => [field, (work.checkpoint?.[field] || []).map(({ text, source, hash, capturedAt, resolved }) =>
    ({ text, source, hash, capturedAt, resolved }))]));
  return { done, expectedCheckpoint };
}
function personalApply(owner, probe, input, entries, committed = () => {}) {
  const plan = personalPlan(owner, probe, input, entries);
  if (plan.done) return false;
  const saved = personal().saveCheckpoint({ ...personalOptions(owner, input), id: probe.task_id, intent: 'checkpoint', checkpoint: entries, expectedCheckpoint: plan.expectedCheckpoint });
  if (saved.status === 'partial' && saved.reason === 'checkpoint-saved') {
    committed();
    fail('linked-task-personal-conflict', 'checkpoint-cleanup-required', { committed: true,
      cleanup: (saved.cleanup || []).slice(0, 8).map(row => ({ reason: ['temporary-cleanup-failed', 'lock-release-failed'].includes(row.reason) ? row.reason : 'cleanup-failed' })),
      recovery: 'Inspect personal context lock ownership before retrying.' });
  }
  if (saved.status !== 'ok') fail('linked-task-personal-conflict', saved.reason);
  return true;
}
function linkPending(owner, probe) {
  return { text: 'Aguardando a conclusão comprovada da milestone ' + probe.milestone + ' (vínculo da task ligada).', source: recordSource(owner, probe.milestone, 'link') };
}
// The creation capture sourced from link.json always stays (resolved once the predecessor is
// proven); the lifecycle only adds or resolves its own captures.
function transitionEntries(owner, probe, stage) {
  const src = name => recordSource(owner, probe.milestone, name), pending = linkPending(owner, probe);
  if (stage === 'handoff' && probe.authorization === CHAINED) return {
    pending: [{ ...pending, resolved: true }, { text: 'Handoff pronto: o início encadeado da task ligada aguarda a reatestação viva da autorização original.', source: src('handoff'), resolved: false }],
    nextAction: [{ text: 'Iniciar a task ligada pelo início encadeado reatestado, com a base de código comprovada.', source: src('handoff'), resolved: false }] };
  if (stage === 'handoff') return { pending: [{ ...pending, resolved: true }],
    nextAction: [{ text: 'Pedir explicitamente o início da task ligada (linked-task:start); nada começa sozinho.', source: src('handoff'), resolved: false }] };
  if (stage === 'start') return { pending: [{ ...pending, resolved: true }, { text: 'Handoff da milestone ' + probe.milestone + ' consumido no BRIEF; pendência resolvida no início ligado.', source: src('handoff'), resolved: true }],
    nextAction: [{ text: 'Preparar o plano da task ligada pelo fluxo normal do forge-task.', source: src('handoff'), resolved: false }] };
  if (stage === 'chain-closure') return { pending: [{ ...pending, resolved: true }],
    nextAction: [{ text: 'Cadeia encerrada por decisão explícita; a task ligada não será iniciada.', source: src('chain-closure'), resolved: true }],
    lastResult: [{ text: 'Cadeia milestone ' + probe.milestone + ' → task ligada encerrada por decisão explícita do operador.', source: src('chain-closure'), resolved: true }] };
  return { pending: [{ ...pending, resolved: true }],
    nextAction: [{ text: 'Task ligada encerrada com a entrega canônica verificada.', source: src('closure'), resolved: true }],
    lastResult: [{ text: 'Task ligada encerrada: todos os critérios da entrega canônica verificados.', source: src('closure'), resolved: true }] };
}

// produceHandoff({cwd, milestone | task, now, userHome, env}): owner action at the closure.
function produceHandoff(input = {}) {
  let probe = null;
  const answer = (e, wrote) => ({ status: wrote || e.committed || e.published ? 'partial' : 'refused', ...personalCleanup(e), milestone: probe?.milestone ?? (typeof input?.milestone === 'string' ? input.milestone : null),
    task_id: probe?.task_id ?? null, reason: LIFECYCLE_REFUSALS.includes(codeOf(e)) ? codeOf(e) : 'linked-task-operation-failed',
    ...(e.detail ? { detail: e.detail } : !LIFECYCLE_REFUSALS.includes(codeOf(e)) ? { detail: codeOf(e, 'error') } : {}), ...(e.predecessor ? { predecessor: e.predecessor } : {}) });
  let wrote = false;
  try {
    if (!object(input)) fail('linked-task-state-invalid');
    const owner = ownerOf(input), now = nowOf(input);
    probe = probeOf(owner, input);
    const recs = requireRecords(owner, probe);
    if (recs['chain-closure'].status === 'valid') fail('linked-task-chain-closed');
    const proof = predecessorOf(owner, probe, input, recs.start.status === 'valid');
    if (proof.result.status === 'chain-closed') fail('linked-task-chain-closed');
    if (proof.result.status !== 'proven') fail(proof.result.status === 'predecessor-incomplete' ? 'predecessor-incomplete' : 'linked-task-state-invalid', proof.result.reason, { predecessor: proof.result });
    const candidate = buildHandoff(owner, probe, proof, now);
    if (recs.handoff.status === 'invalid') fail(recs.handoff.reason === 'foreign' ? 'linked-task-handoff-foreign' : 'linked-task-handoff-tampered');
    if (recs.handoff.status === 'valid' && !same(stableHandoff(recs.handoff.record), stableHandoff(candidate))) fail('linked-task-handoff-conflict');
    if (recs.handoff.status === 'valid') requireHandoffBinding(owner, probe.milestone, recs.handoff.record);
    const entries = transitionEntries(owner, probe, 'handoff');
    if (recs.start.status !== 'valid') personalPlan(owner, probe, input, entries);
    const result = selection().ownerBoundary(owner, probe.milestone, () => {
      // Recomputed inside the boundary: a concurrent change refuses instead of publishing stale evidence.
      const innerNow = nowOf(input);
      const again = predecessorOf(owner, probe, { ...input, now: innerNow }, recs.start.status === 'valid');
      if (again.result.status !== 'proven' || again.endpoint.sha256 !== proof.endpoint.sha256) fail('predecessor-incomplete', again.result.reason, { predecessor: again.result });
      const currentCandidate = buildHandoff(owner, probe, again, innerNow);
      if (!same(stableHandoff(candidate), stableHandoff(currentCandidate))) fail('linked-task-handoff-stale', 'sources-changed-during-handoff');
      const current = time().readOwnerRecord({ cwd: owner, milestone: probe.milestone, path: recordPath('handoff') });
      if (current.status !== 'absent' && (current.status !== 'valid' || !handoffValid(current.record) || !same(stableHandoff(current.record), stableHandoff(currentCandidate)))) fail('linked-task-handoff-conflict');
      const published = time().publishLinkedTaskHandoff({ ...input, cwd: owner, milestone: probe.milestone,
        expected_snapshot_sha256: digest(stableHandoff(currentCandidate)) });
      if (published.status === 'published') wrote = true;
      point(input, 'after-handoff');
      // The start already consumed it: the personal state belongs to the later transition.
      if (recs.start.status !== 'valid' && personalApply(owner, probe, input, entries)) wrote = true;
      return { status: published.status === 'published' ? 'produced' : 'unchanged', milestone: probe.milestone, task_id: probe.task_id, handoff_sha256: published.sha256,
        lifecycle: probe.authorization === CHAINED ? 'handoff-ready' : 'open' };
    });
    if (result.status === 'deferred') fail('linked-task-boundary-deferred', result.reason);
    return result;
  } catch (e) { return answer(e, wrote); }
}

// ---------------------------------------------------------------------------
// Canonical owner decisions of the lifecycle (IC2/IC3/IC4), opened outside every owner lock
// ---------------------------------------------------------------------------
// Identity binds milestone M, task T and workflow_id T in the milestone-time-linked-task set,
// so verifyDecision (milestone view) and the task clock (workflow view) see the same decision.
// Generation 1 keeps the original question id; a later explicit request after a declined answer
// opens generation n as a NEW question (new id, unit and identity) so no answered state is reused.
function decisionSpec(probe, action, generation = 1) {
  if (!LINKED_DECISION_ACTIONS.includes(action)) fail('linked-task-decision-invalid');
  const id = 'linked-task-' + action + '-' + probe.link_sha256.slice(0, 12) + (generation > 1 ? '-g' + generation : ''), unit = 'milestone-time/' + id;
  // Same field order as forge-pending-questions bindingIdentity for an owner question.
  const identity = digest({ schema_version: 1, origin: 'owner', unit, milestone: probe.milestone, slice: null, task: probe.task_id, workflow_id: probe.task_id,
    dispatch_id: null, request_fingerprint: null, receipt_phase: null, decision_set: LINKED_SET });
  return { action, id, unit, identity, generation, answer: 'linked-task:' + action, text: DECISION_TEXT[action] };
}
function decisionRequest(probe, action, handoffSha) {
  return action === 'start' ? { milestone: probe.milestone, task_id: probe.task_id, link_sha256: probe.link_sha256, handoff_sha256: handoffSha, action }
    : { milestone: probe.milestone, task_id: probe.task_id, link_sha256: probe.link_sha256, action };
}
// Unreadable, invalid or excess question state is an unknown census, never "no questions".
function requireCensus(owner, milestone) {
  let listed;
  try { listed = questions().listPendingQuestions({ cwd: owner, filter: { type: 'milestone', id: milestone } }); } catch { fail('linked-task-question-census-unknown'); }
  if (listed.census.invalid || listed.census.excess || !['no-questions', 'no-matching-questions', null].includes(listed.empty_reason)) fail('linked-task-question-census-unknown', listed.empty_reason || 'census-incomplete');
  return listed;
}
// A start or continuation is also blocked while the required close-chain decision of THIS link
// (milestone M, task T, workflow T, any generation) is still pending; the pending IDs are reported and kept.
function requireDecisionsClear(owner, probe) {
  const listed = requireCensus(owner, probe.milestone), prefix = 'linked-task-close-chain-' + probe.link_sha256.slice(0, 12);
  const pending = listed.questions.filter(q => q.status === 'pending' && q.origin?.origin === 'owner' && q.origin.decision_set === LINKED_SET && q.origin.milestone === probe.milestone
    && q.origin.task === probe.task_id && q.origin.workflow_id === probe.task_id && typeof q.id === 'string' && q.id.startsWith(prefix));
  if (pending.length) fail('linked-task-decision-pending', 'close-chain-pending', { pending_ids: pending.map(q => q.id) });
  return listed;
}
function persistedAnswer(owner, spec) {
  const file = path.join(owner, '.gsd', 'forge', 'questions', spec.identity + '.json');
  noLinks(file);
  if (!fs.existsSync(file)) return { status: 'absent', answer: null };
  let state; try { state = questions().continuation({ cwd: owner, identity: spec.identity }); } catch { fail('linked-task-question-census-unknown', 'decision-unreadable'); }
  if (!state.ok) return { status: 'pending', answer: null };
  const row = state.questions.find(q => q.id === spec.id);
  if (!row || state.identity?.decision_set !== LINKED_SET || state.identity.task !== spec.task) return { status: 'pending', answer: null };
  return { status: row.status === 'resolved' ? 'answered' : 'pending', answer: row.status === 'resolved' ? row.answer : null };
}
function specFor(probe, action, generation = 1) { return { ...decisionSpec(probe, action, generation), task: probe.task_id }; }
// Persisted generations in order, each entry with its stored state. The chain stops at the first
// generation that is absent, still pending or answered with the authorizing choice: declined
// generations (defer / keep-chain) are completed history and never rewritten.
function decisionHistory(owner, probe, action) {
  const history = [];
  for (let generation = 1; generation <= MAX_GENERATIONS; generation++) {
    const spec = specFor(probe, action, generation), persisted = persistedAnswer(owner, spec);
    if (persisted.status === 'absent') break;
    history.push({ generation, spec, ...persisted });
    if (persisted.status !== 'answered' || persisted.answer === spec.answer) break;
  }
  return history;
}
function declined(entry) { return entry.status === 'answered' && entry.answer !== entry.spec.answer; }
// The generation that currently carries the decision: the latest persisted one (null before the first request).
function currentDecision(owner, probe, action) { return decisionHistory(owner, probe, action).at(-1) || null; }
// prepareLinkedDecision({cwd, task, action}): opens (idempotently) the canonical owner question with
// the real forge-pending-questions API before any publication lock and returns the exact request,
// expected answer and question identity the host must present and attest. It never authorizes.
function prepareLinkedDecision(input = {}) {
  try {
    if (!object(input)) fail('linked-task-decision-invalid');
    const owner = ownerOf(input), probe = probeOf(owner, input), action = input.action;
    specFor(probe, action);
    const recs = requireRecords(owner, probe);
    if (recs['chain-closure'].status === 'valid') fail('linked-task-chain-closed');
    if (recs.closure.status === 'valid') fail('linked-task-closed');
    let handoffSha = null;
    if (action === 'start') {
      if (probe.authorization !== EXPLICIT) fail('linked-task-decision-invalid', 'chained-start-needs-no-question');
      if (recs.start.status === 'valid') fail('linked-task-already-started');
      if (recs.handoff.status !== 'valid') fail(recs.handoff.status === 'absent' ? 'linked-task-handoff-missing' : 'linked-task-handoff-tampered');
      handoffSha = recs.handoff.sha256;
    }
    requireCensus(owner, probe.milestone);
    // An unanswered generation stays stable; only a completed declined one is followed by a new explicit generation.
    const latest = currentDecision(owner, probe, action);
    if (latest && declined(latest) && latest.generation >= MAX_GENERATIONS) fail('linked-task-decision-invalid', 'generation-limit');
    const spec = latest && declined(latest) ? specFor(probe, action, latest.generation + 1) : latest ? latest.spec : specFor(probe, action);
    const opened = questions().openQuestions({ cwd: owner, milestone: probe.milestone, task: probe.task_id, workflow_id: probe.task_id, unit: spec.unit,
      decision_set: LINKED_SET, questions: [{ id: spec.id, question: spec.text.question }] });
    if (opened.identity_sha256 !== spec.identity) fail('linked-task-decision-invalid', 'identity-mismatch');
    const persisted = persistedAnswer(owner, spec), request = decisionRequest(probe, action, handoffSha);
    return { status: persisted.status === 'answered' ? 'answered' : 'open', action, generation: spec.generation, milestone: probe.milestone, task_id: probe.task_id, kind: 'linked-task',
      request, request_sha256: digest(request), expected: [spec.answer], question: { identity_sha256: spec.identity, id: spec.id }, answer: persisted.answer,
      decision: { id: spec.id, header: spec.text.header, question: spec.text.question, options: spec.text.options.map(o => ({ label: o.label, description: o.description })),
        identity_sha256: spec.identity, question_id: spec.id } };
  } catch (e) { return { status: 'refused', reason: LIFECYCLE_REFUSALS.includes(codeOf(e)) ? codeOf(e) : 'linked-task-decision-invalid', ...(e.detail ? { detail: e.detail } : {}) }; }
}
// answerLinkedDecision({cwd, task, action, response, source, channel}): records the operator's
// explicit answer (canonical label or value) through forge-pending-questions.answer. Persisting an
// answer never authorizes by itself: the start or closure still needs a live attested handle.
function answerLinkedDecision(input = {}) {
  try {
    if (!object(input) || !['user-text', 'tool-answer'].includes(input.source)) fail('linked-task-decision-invalid', 'source-invalid');
    const owner = ownerOf(input), probe = probeOf(owner, input), base = specFor(probe, input.action);
    const option = base.text.options.find(o => o.label === input.response || o.answer === input.response);
    if (!option) fail('linked-task-decision-invalid', 'answer-invalid');
    // Only the current generation can be answered; a completed one is history and never reopened.
    const latest = currentDecision(owner, probe, input.action);
    if (!latest) fail('linked-task-decision-invalid', 'question-not-open');
    if (latest.status === 'answered' && latest.answer !== option.answer) fail('linked-task-decision-invalid', 'decision-answered');
    const spec = latest.spec;
    questions().answer({ cwd: owner, identity: spec.identity, answers: [{ id: spec.id, answer: option.answer, source: input.source }], ...(input.channel ? { channel: input.channel } : {}) });
    return { status: 'answered', action: spec.action, generation: spec.generation, task_id: probe.task_id, answer: option.answer, question: { identity_sha256: spec.identity, id: spec.id } };
  } catch (e) { return { status: 'refused', reason: LIFECYCLE_REFUSALS.includes(codeOf(e)) ? codeOf(e) : 'linked-task-decision-invalid', ...(e.detail ? { detail: e.detail } : {}) }; }
}
// recordLinkedDecisionRound({cwd, task, action, channel, outcome}): presentation history only.
function recordLinkedDecisionRound(input = {}) {
  try {
    const owner = ownerOf(input), probe = probeOf(owner, input), spec = (currentDecision(owner, probe, input.action) || { spec: specFor(probe, input.action) }).spec;
    const rounds = questions().recordRound({ cwd: owner, identity: spec.identity, ids: [spec.id], channel: input.channel, outcome: input.outcome });
    return { status: 'recorded', action: spec.action, task_id: probe.task_id, rounds: rounds.rounds.length };
  } catch (e) { return { status: 'refused', reason: 'linked-task-decision-invalid', detail: codeOf(e, 'round-invalid') }; }
}

// ---------------------------------------------------------------------------
// Live authority
// ---------------------------------------------------------------------------
// The chained start reuses the ORIGINAL persisted linked-task decision of the link (no new
// question); the explicit start needs the operator's linked-task:start bound to link and handoff.
function authorityPlan(owner, probe, handoffSha) {
  const link = probe.link;
  // A persisted, answered close-chain decision revokes every start authority of this link.
  requireClosingNotDecided(owner, probe);
  if (probe.authorization === CHAINED) {
    return { mode: 'chained', request: { milestone: probe.milestone, options_sha256: link.options_sha256, option_id: link.option_id, position_id: link.position_id, authorization: link.authorization },
      expected: ['linked-task:' + link.authorization], question: { ...link.decision.question }, request_sha256: link.decision.request_sha256 };
  }
  // Authority binds the CURRENT generation: a declined earlier generation never authorizes.
  const current = currentDecision(owner, probe, 'start'), request = decisionRequest(probe, 'start', handoffSha);
  if (!current || current.status !== 'answered' || current.answer !== current.spec.answer) {
    fail('linked-task-start-request-required', !current ? 'absent' : current.status === 'answered' ? 'start-not-requested' : current.status);
  }
  const spec = current.spec;
  return { mode: 'explicit', request, expected: [spec.answer], question: { identity_sha256: spec.identity, id: spec.id }, request_sha256: digest(request) };
}
// A persisted, answered close-chain decision (current generation) revokes every start authority of this link.
function requireClosingNotDecided(owner, probe) {
  const closing = currentDecision(owner, probe, 'close-chain');
  if (closing && closing.status === 'answered' && closing.answer === closing.spec.answer) fail('linked-task-authorization-revoked', 'chain-closure-decided');
}
function closePlan(owner, probe) {
  const current = currentDecision(owner, probe, 'close-chain'), request = decisionRequest(probe, 'close-chain');
  if (!current || current.status !== 'answered' || current.answer !== current.spec.answer) {
    fail('linked-task-close-chain-request-required', !current ? 'absent' : current.status === 'answered' ? 'close-not-requested' : current.status);
  }
  const spec = current.spec;
  return { mode: 'close-chain', request, expected: [spec.answer], question: { identity_sha256: spec.identity, id: spec.id }, request_sha256: digest(request) };
}
function verifyAuthority(owner, probe, handle, plan, now) {
  let decision;
  try { decision = time().verifyDecision({ cwd: owner, milestone: probe.milestone, now, handle, kind: 'linked-task', request: plan.request, expected: plan.expected }); }
  catch (e) { fail(e.code === 'time-decision-answer-mismatch' ? 'linked-task-authorization-revoked' : 'linked-task-authorization-required', codeOf(e, null)); }
  if (!same(decision.question, plan.question) || decision.request_sha256 !== plan.request_sha256 || decision.request_sha256 !== digest(plan.request)) fail('linked-task-authorization-required', 'scope-mismatch');
  return decision;
}
// The handle comes only from the live adapter, outside every boundary, and is verified at once.
function liveHandle(owner, probe, adapter, plan, now) {
  let handle;
  try {
    handle = adapter.getDecisionHandle({ cwd: owner, milestone: probe.milestone, task: probe.task_id, kind: 'linked-task', request: structuredClone(plan.request),
      request_sha256: digest(plan.request), question: { ...plan.question }, expected: [...plan.expected] });
  } catch { fail('linked-task-authorization-required', 'adapter-failed'); }
  return { handle, decision: verifyAuthority(owner, probe, handle, plan, now) };
}
function authorityRecord(plan, decision) {
  return { mode: plan.mode, reference: typeof decision.reference === 'string' && decision.reference.length <= 120 && time().isPublicData(decision.reference) ? decision.reference : null,
    question: { identity_sha256: decision.question.identity_sha256, id: decision.question.id }, answer: decision.answer, request_sha256: decision.request_sha256 };
}

// ---------------------------------------------------------------------------
// Proven code base (read-only Git per explicit physical root)
// ---------------------------------------------------------------------------
function gitRead(dir, args) {
  return require('./forge-git-process').git(dir, args, { maxBuffer: 4 * 1024 * 1024, env: { GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' } }).trim();
}
function rootKey(dir) { return require('./forge-code-roots').key(fs.realpathSync.native(dir)); }
function baseRefusal(reason, detail, rootId) { return Object.assign(new Error(reason), { code: reason, detail, root_id: rootId }); }
function explicitMap(value, ids, label) {
  if (typeof value === 'string') {
    if (ids.length !== 1) throw baseRefusal('linked-task-base-unproven', label + '-map-required', null);
    return { [ids[0]]: value };
  }
  if (!object(value)) throw baseRefusal('linked-task-base-unproven', label + '-missing', null);
  const extra = Object.keys(value).find(k => !ids.includes(k));
  if (extra) throw baseRefusal('linked-task-base-unproven', 'root-extra', ROOT_ID.test(extra) ? extra : null);
  const missing = ids.find(k => typeof value[k] !== 'string' || !value[k]);
  if (missing) throw baseRefusal('linked-task-base-unproven', 'root-missing', missing);
  return value;
}
function milestoneRootPaths(owner, milestone) {
  try {
    const bytes = ownerBytes(owner, `.gsd/milestones/${milestone}/${milestone}-DELIVERY-INPUT.json`, MAX_SOURCE);
    const contract = JSON.parse(bytes.toString('utf8')).execution_contract;
    return Object.fromEntries((contract?.code_roots || []).filter(r => ROOT_ID.test(r?.id) && typeof r.path === 'string').map(r => [r.id, r.path]));
  } catch { return {}; }
}
function commitOf(dir, ref) {
  if (typeof ref !== 'string' || !ref) return null;
  try {
    if (REVISION.test(ref)) return gitRead(dir, ['rev-parse', '--verify', '--quiet', ref + '^{commit}']);
    require('./forge-git-process').validateBranch(dir, ref);
    return gitRead(dir, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + ref + '^{commit}']);
  } catch { return null; }
}
function proveRoot(root, dir, kind, targetRef, recorded) {
  const id = root.root_id;
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw baseRefusal('linked-task-base-unproven', 'root-directory-invalid', id);
  let real; try { real = fs.realpathSync.native(dir); if (!fs.statSync(real).isDirectory()) throw new Error('dir'); } catch { throw baseRefusal('linked-task-base-unproven', 'root-directory-missing', id); }
  let top, head, branch = null;
  try { top = gitRead(real, ['rev-parse', '--show-toplevel']); head = gitRead(real, ['rev-parse', '--verify', 'HEAD']); }
  catch { throw baseRefusal('linked-task-base-unproven', 'root-not-checkout', id); }
  if (rootKey(top) !== rootKey(real)) throw baseRefusal('linked-task-base-unproven', 'root-not-checkout', id);
  try { branch = gitRead(real, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || null; } catch { branch = null; }
  // Same repository as the measured milestone root (a worktree of it is fine); without that root,
  // the endpoint revision itself must exist in this history.
  const common = d => rootKey(path.resolve(d, gitRead(d, ['rev-parse', '--git-common-dir'])));
  if (recorded && fs.existsSync(recorded)) {
    let same; try { same = common(recorded) === common(real); } catch { same = false; }
    if (!same) throw baseRefusal('linked-task-base-unproven', 'root-repository-mismatch', id);
  } else {
    try { gitRead(real, ['cat-file', '-e', root.revision + '^{commit}']); } catch { throw baseRefusal('linked-task-base-unproven', 'root-repository-unknown', id); }
  }
  const content = () => {
    for (const entry of root.scope) {
      let blob; try { blob = gitRead(real, ['rev-parse', '--verify', '--quiet', 'HEAD:' + entry.path]); } catch { blob = null; }
      if (!blob) throw baseRefusal('linked-task-base-drift', 'scope-missing', id);
      if (blob !== entry.hash) throw baseRefusal('linked-task-base-drift', 'scope-changed', id);
    }
  };
  let target = null;
  if (kind === 'milestone-branch') {
    if (!root.branch || branch !== root.branch) throw baseRefusal('linked-task-base-unproven', 'branch-mismatch', id);
    if (head !== root.revision) { content(); throw baseRefusal('linked-task-base-unproven', 'revision-mismatch', id); }
  } else {
    target = commitOf(real, targetRef);
    if (!target) throw baseRefusal('linked-task-base-unproven', 'target-unknown', id);
    if (head !== target) throw baseRefusal('linked-task-base-unproven', 'head-not-target', id);
  }
  content();
  if (root.scope.length) {
    let dirty;
    try { dirty = gitRead(real, ['status', '--porcelain=v1', '--untracked-files=all', '--', ...root.scope.map(s => ':(literal)' + s.path)]); }
    catch { throw baseRefusal('linked-task-base-unproven', 'status-unreadable', id); }
    if (dirty) throw baseRefusal('linked-task-base-drift', 'scope-dirty', id);
  }
  // Ancestry is recorded, never required: a squash integration is not a descendant.
  let ancestry = 'unknown';
  try { gitRead(real, ['merge-base', '--is-ancestor', root.revision, 'HEAD']); ancestry = 'ancestor'; }
  catch (e) { ancestry = e.status === 1 ? 'not-ancestor' : 'unknown'; }
  return { row: { root_id: id, head, branch, endpoint_revision: root.revision, target, ancestry, scope_sha256: digest(root.scope) }, directory: real };
}
function proveBase(owner, milestone, endpointRecord, codeDir, base) {
  if (!object(base) || !BASE_KINDS.includes(base.kind)) throw baseRefusal('linked-task-base-unproven', 'base-kind-invalid', null);
  const roots = endpointRecord.roots, ids = roots.map(r => r.root_id);
  const dirs = explicitMap(codeDir, ids, 'code-dir'), targets = base.kind === 'integrated' ? explicitMap(base.target, ids, 'target') : {};
  if (base.kind === 'milestone-branch' && base.target !== undefined && base.target !== null) throw baseRefusal('linked-task-base-unproven', 'target-unexpected', null);
  const seen = new Map();
  for (const id of ids) {
    let key; try { key = rootKey(dirs[id]); } catch { continue; }
    if (seen.has(key)) throw baseRefusal('linked-task-base-unproven', 'root-ambiguous', id);
    seen.set(key, id);
  }
  const recorded = milestoneRootPaths(owner, milestone), proven = roots.map(root => proveRoot(root, dirs[root.root_id], base.kind, targets[root.root_id], recorded[root.root_id]));
  return { kind: base.kind, roots: proven.map(p => p.row), directories: Object.fromEntries(proven.map(p => [p.row.root_id, p.directory])) };
}
// validateLinkedBase({cwd, task | milestone, codeDir, base: {kind, target}}): never throws, never writes.
function validateLinkedBase(input = {}) {
  try {
    if (!object(input)) fail('linked-task-state-invalid');
    const owner = ownerOf(input), probe = probeOf(owner, input);
    const read = endpoints().readEndpoint({ cwd: owner, milestone: probe.milestone });
    if (read.status !== 'valid') return { status: 'refused', reason: 'linked-task-base-unproven', detail: 'endpoint-unproven' };
    const proven = proveBase(owner, probe.milestone, read.record, input.codeDir, input.base);
    return { status: 'proven', kind: proven.kind, milestone: probe.milestone, endpoint_sha256: read.sha256, roots: proven.roots };
  } catch (e) {
    return { status: 'refused', reason: ['linked-task-base-unproven', 'linked-task-base-drift'].includes(e.code) ? e.code : codeOf(e, 'linked-task-base-unproven'),
      ...(e.detail ? { detail: e.detail } : {}), ...(e.root_id ? { root_id: e.root_id } : {}) };
  }
}

// ---------------------------------------------------------------------------
// Isolation (real data only; never a fake borrower)
// ---------------------------------------------------------------------------
// Bounded census of every worktree the canonical run registry registers. An unreadable, malformed or
// oversized registry is UNKNOWN ownership and refuses; it is never treated as an empty (safe) registry.
const MAX_OWNERSHIP_RUNS = 512, MAX_OWNERSHIP_ENTRIES = 2048;
function ownershipCensus(owner) {
  let listed;
  try { listed = runs().listAllDetailed(owner, { maxRuns: MAX_OWNERSHIP_RUNS, maxBytes: 64 * 1024 }); } catch { fail('linked-task-isolation-invalid', 'ownership-unknown'); }
  if (!object(listed) || !Array.isArray(listed.parsed) || !Array.isArray(listed.unparseable) || listed.unparseable.length || listed.parsed.length > MAX_OWNERSHIP_RUNS) {
    fail('linked-task-isolation-invalid', 'ownership-unknown');
  }
  const entries = [];
  for (const run of listed.parsed) {
    if (!object(run) || typeof run.id !== 'string' || !run.id) fail('linked-task-isolation-invalid', 'ownership-unknown');
    if (run.worktrees === undefined || run.worktrees === null) continue;
    if (!Array.isArray(run.worktrees)) fail('linked-task-isolation-invalid', 'ownership-unknown');
    for (const w of run.worktrees) {
      if (!object(w) || typeof w.path !== 'string' || !w.path) fail('linked-task-isolation-invalid', 'ownership-unknown');
      let key;
      try { key = rootKey(w.path); } catch { if (!fs.existsSync(w.path)) continue; fail('linked-task-isolation-invalid', 'ownership-unknown'); }
      entries.push({ run: run.id, key });
      if (entries.length > MAX_OWNERSHIP_ENTRIES) fail('linked-task-isolation-invalid', 'ownership-unknown');
    }
  }
  return entries;
}
// Every supplied physical directory is reconciled with the census: a worktree registered by a run other than the
// parent milestone (the only supported lender) or registered by several runs is refused before any mutation.
function requireOwnership(owner, probe, directories) {
  const census = ownershipCensus(owner);
  for (const [rootId, dir] of Object.entries(directories)) {
    let key; try { key = rootKey(dir); } catch { fail('linked-task-isolation-invalid', 'ownership-unknown', { root_id: rootId }); }
    const owners = [...new Set(census.filter(e => e.key === key && e.run !== probe.task_id).map(e => e.run))];
    if (owners.length > 1) fail('linked-task-isolation-invalid', 'worktree-owner-ambiguous', { root_id: rootId });
    if (owners.length === 1 && owners[0] !== probe.milestone) fail('linked-task-isolation-invalid', 'worktree-owner-foreign', { root_id: rootId });
  }
}
function isolationOf(owner, probe, isolation, directories) {
  const isolationApi = require('./forge-isolation');
  if (!object(isolation) || !['shared', 'branch', 'worktree'].includes(isolation.mode)) fail('linked-task-isolation-invalid', 'mode-invalid');
  requireOwnership(owner, probe, directories);
  const dirs = Object.values(directories).map(rootKey), primary = Object.values(directories)[0];
  const branchOf = dir => { try { return gitRead(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || null; } catch { return null; } };
  // Any explicit physical root that is a worktree registered by the milestone's run (the lender) can only be
  // used by a genuine canonical borrowing; every other mode would hide it from the lender-side cleanup guard.
  const lendsAny = () => {
    let lender = null; try { lender = runs().get(owner, probe.milestone); } catch { lender = null; }
    const paths = []; for (const w of lender?.worktrees || []) { try { paths.push(rootKey(w.path)); } catch { /* an unreadable entry lends nothing */ } }
    return dirs.some(d => paths.includes(d));
  };
  if (isolation.attached_to !== undefined && isolation.attached_to !== null) {
    // Borrowing is real only when the lender (the milestone run) still validates its registered worktree.
    if (isolation.mode !== 'worktree' || isolation.attached_to !== probe.milestone) fail('linked-task-isolation-invalid', 'lender-invalid');
    const attached = isolationApi.attachForRun(owner, probe.task_id, isolation.attached_to);
    if (!attached.ok) fail('linked-task-isolation-invalid', attached.reason);
    const lender = runs().get(owner, isolation.attached_to);
    const paths = (lender?.worktrees || []).map(w => rootKey(w.path));
    if (!dirs.every(d => paths.includes(d))) fail('linked-task-isolation-invalid', 'code-dir-not-attached');
    // Publish exactly the proven roots: no unchecked extra or duplicate lender entry.
    if (paths.length !== dirs.length || new Set(paths).size !== paths.length) fail('linked-task-isolation-invalid', 'worktrees-unexpected');
    return { mode: 'worktree', branch: lender.branch, attached_to: isolation.attached_to, worktrees: structuredClone(lender.worktrees) };
  }
  if (isolation.mode === 'worktree') {
    if (!Array.isArray(isolation.worktrees) || !isolation.worktrees.length || typeof isolation.branch !== 'string') fail('linked-task-isolation-invalid', 'worktrees-missing');
    const worktrees = isolation.worktrees.map(w => {
      if (!object(w) || typeof w.repo !== 'string' || typeof w.path !== 'string' || !path.isAbsolute(w.repo) || !path.isAbsolute(w.path)) fail('linked-task-isolation-invalid', 'worktree-invalid');
      const identity = isolationApi.validateWorktreeIdentity(w.repo, w.path, isolation.branch);
      if (!identity.ok) fail('linked-task-isolation-invalid', identity.reason);
      return { repo: fs.realpathSync.native(w.repo), path: fs.realpathSync.native(w.path) };
    });
    if (!dirs.every(d => worktrees.some(w => rootKey(w.path) === d))) fail('linked-task-isolation-invalid', 'code-dir-not-registered');
    // Every published entry must be one of the roots already reconciled with ownership.
    if (worktrees.length !== dirs.length || new Set(worktrees.map(w => rootKey(w.path))).size !== worktrees.length) fail('linked-task-isolation-invalid', 'worktrees-unexpected');
    if (lendsAny()) fail('linked-task-isolation-invalid', 'lender-worktree-requires-attachment');
    return { mode: 'worktree', branch: isolation.branch, attached_to: null, worktrees };
  }
  if (isolation.worktrees !== undefined && (!Array.isArray(isolation.worktrees) || isolation.worktrees.length)) fail('linked-task-isolation-invalid', 'worktrees-unexpected');
  const branch = branchOf(primary);
  if (isolation.mode === 'branch' && (!branch || isolation.branch !== branch)) fail('linked-task-isolation-invalid', 'branch-mismatch');
  if (lendsAny()) fail('linked-task-isolation-invalid', 'lender-worktree-requires-attachment');
  return { mode: isolation.mode, branch, attached_to: null, worktrees: [] };
}
function runIdentity(owner, probe, run) {
  return !!run && run.id === probe.task_id && run.kind === 'task' && run.session_id === 'linked-task-' + probe.link.creation_key.slice(0, 32)
    && typeof run.project === 'string' && samePath(run.project, owner) && typeof run.cwd === 'string' && samePath(run.cwd, owner);
}
function runStarted(run, iso) {
  return run.active === true && run.isolation_mode === iso.mode && run.branch === iso.branch && run.attached_to === iso.attached_to && same(run.worktrees || [], iso.worktrees);
}
function runPlan(owner, probe, iso) {
  const file = runs().runFile(owner, probe.task_id);
  noLinks(file);
  const run = fs.existsSync(file) ? runs().get(owner, probe.task_id) : null;
  if (!runIdentity(owner, probe, run)) fail('linked-task-start-conflict', 'run');
  if (runStarted(run, iso)) return { done: true };
  if (run.active !== false || (Array.isArray(run.worktrees) && run.worktrees.length) || run.attached_to) fail('linked-task-start-conflict', 'run');
  return { done: false };
}

// ---------------------------------------------------------------------------
// BRIEF consumption
// ---------------------------------------------------------------------------
// One bounded, regular-file, stable BRIEF read: null when absent, false when oversized, nonregular or unstable.
// Type and size are checked on the path (lstat) BEFORE any open, so a FIFO or a huge file is never opened or read.
function briefBytes(file) {
  let stat; try { stat = fs.lstatSync(file); } catch (e) { return e.code === 'ENOENT' ? null : false; }
  if (!stat.isFile() || stat.size > MAX_BRIEF) return false;
  try {
    const read = require('./forge-autonomy-sources').readBoundedStableFile(file, MAX_BRIEF, { expectedReal: fs.realpathSync.native(file) });
    return read.error ? false : read.buffer;
  } catch { return false; }
}
function briefPlan(owner, probe, handoff) {
  const offered = time().readOptions({ cwd: owner, milestone: probe.milestone, options_sha256: probe.link.options_sha256 });
  if (offered.status !== 'valid') fail('linked-task-state-invalid', 'options-invalid');
  const base = linkedTask().renderLinkedBrief(probe.link, offered.record), block = renderHandoffBlock(handoff), consumed = base + '\n' + block;
  const file = briefFile(owner, probe.task_id);
  noLinks(file);
  const current = briefBytes(file);
  if (!Buffer.isBuffer(current)) fail('linked-task-start-conflict', 'brief');
  if (current.equals(Buffer.from(consumed, 'utf8'))) return { done: true, block, consumed, file };
  if (!current.equals(Buffer.from(base, 'utf8'))) fail('linked-task-start-conflict', 'brief');
  return { done: false, block, consumed, file };
}
function writeAtomicText(file, content) {
  noLinks(file);
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp');
  let created = false;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o644); created = true;
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    noLinks(file); fs.renameSync(temporary, file); created = false;
  } finally { if (created) { try { fs.unlinkSync(temporary); } catch { /* best effort */ } } }
}
function startRecord(probe, handoffSha, endpointSha, brief, plan, decision, proven, iso, now) {
  return { schema_version: HANDOFF_SCHEMA_VERSION, kind: KINDS.start, milestone: probe.milestone, task_id: probe.task_id, link_sha256: probe.link_sha256,
    handoff_sha256: handoffSha, endpoint_sha256: endpointSha, brief_sha256: sha256(Buffer.from(brief.consumed, 'utf8')), block_sha256: sha256(Buffer.from(brief.block, 'utf8')),
    authority: authorityRecord(plan, decision), base: { kind: proven.kind, roots: proven.roots.map(r => ({ ...r })) },
    isolation: { mode: iso.mode, branch: iso.branch, attached_to: iso.attached_to, worktree_count: iso.worktrees.length }, started_at: new Date(now).toISOString() };
}
// An interrupted start may already have published its witness: the replay adopts the witnessed record
// (same started_at and live reference) when every other canonical field is identical, else refuses.
function witnessedStart(owner, probe, candidate) {
  if (!startValid(candidate)) fail('linked-task-start-failed', 'start-record-invalid');
  const read = time().readOwnerRecord({ cwd: owner, milestone: probe.milestone, path: recordPath('start-witness') });
  if (read.status === 'absent') return candidate;
  const w = read.record;
  if (read.status !== 'valid' || !startWitnessValid(w) || w.milestone !== probe.milestone || w.task_id !== probe.task_id || w.link_sha256 !== probe.link_sha256) fail('linked-task-start-conflict', 'witness');
  const volatile = r => ({ ...r, started_at: null, authority: { ...r.authority, reference: null } });
  if (!same(volatile(w.start), volatile(candidate))) fail('linked-task-start-conflict', 'witness');
  return w.start;
}
// Everything the start validates before its first write, in the fixed refusal order.
function startPreflight(owner, probe, input, now, progressAllowed) {
  const recs = requireRecords(owner, probe);
  if (recs['chain-closure'].status === 'valid') fail('linked-task-chain-closed');
  if (recs.start.status === 'valid') fail('linked-task-already-started');
  const proof = predecessorOf(owner, probe, input, progressAllowed);
  if (proof.result.status === 'chain-closed') fail('linked-task-chain-closed');
  // A handoff exists only after a proven endpoint: when its bound DELIVERY, SUMMARY or roadmap
  // changed since, that change (which also unbinds the endpoint) is reported as a stale handoff.
  if (proof.result.status === 'predecessor-incomplete' && proof.result.reason === 'endpoint-unproven' && recs.handoff.status === 'valid') {
    const changed = handoffSourceChange(owner, recs.handoff.record);
    if (changed) fail('linked-task-handoff-stale', changed);
  }
  if (proof.result.status !== 'proven') fail(proof.result.status === 'predecessor-incomplete' ? 'predecessor-incomplete' : 'linked-task-state-invalid', proof.result.reason, { predecessor: proof.result });
  const handoff = validateHandoff(owner, probe, recs.handoff, proof, input);
  requireDecisionsClear(owner, probe);
  const plan = authorityPlan(owner, probe, handoff.sha256);
  return { recs, proof, handoff, plan };
}
function startProgress(owner, probe) {
  // A previous interrupted start of this link: the consumed block is in the BRIEF or the run is active.
  const file = briefFile(owner, probe.task_id);
  noLinks(file);
  const bytes = briefBytes(file);
  if (bytes === false) fail('linked-task-start-conflict', 'brief');
  try {
    const run = runs().get(owner, probe.task_id);
    return (bytes !== null && bytes.toString('utf8').includes(HANDOFF_MARKERS.start)) || run?.active === true;
  } catch { return false; }
}
// startLinkedTask({cwd, taskId, liveAdapter, codeDir, base: {kind, target}, isolation, now, userHome, env}).
// Order: BRIEF section -> personal resolution -> run activation -> start.json (last).
function startLinkedTask(input = {}) {
  let probe = null;
  const progress = [];
  const answer = e => {
    const busy = ['EOWNERSHIPBUSY', 'LOCK_BUSY'].includes(e.code);
    const code = busy ? 'linked-task-isolation-invalid' : codeOf(e, 'linked-task-start-failed'), known = START_REFUSALS.includes(code);
    return { status: progress.length || e.committed ? 'partial' : 'refused', ...personalCleanup(e), task_id: probe?.task_id ?? (typeof input?.taskId === 'string' ? input.taskId : null), reason: known ? code : 'linked-task-start-failed',
      ...(typeof e.detail === 'string' ? { detail: e.detail } : busy ? { detail: 'ownership-busy' } : !known ? { detail: code } : {}), ...(e.root_id ? { root_id: e.root_id } : {}),
      ...(e.predecessor ? { predecessor: e.predecessor } : {}), ...(Array.isArray(e.pending_ids) ? { pending_ids: [...e.pending_ids] } : {}), steps_written: [...progress] };
  };
  try {
    // A standalone call, a flag, persisted JSON or the handoff never carries live authority.
    if (!object(input) || typeof input.liveAdapter?.getDecisionHandle !== 'function') fail('linked-task-authorization-required');
    const owner = ownerOf(input), now = nowOf(input);
    probe = probeTask(owner, input.taskId ?? input.task);
    const resumed = startProgress(owner, probe);
    const pre = startPreflight(owner, probe, input, now, resumed);
    const live = liveHandle(owner, probe, input.liveAdapter, pre.plan, now);
    let proven;
    try { proven = proveBase(owner, probe.milestone, pre.proof.endpoint.record, input.codeDir, input.base); }
    catch (e) { fail(['linked-task-base-unproven', 'linked-task-base-drift'].includes(e.code) ? e.code : 'linked-task-base-unproven', e.detail, { root_id: e.root_id }); }
    const iso = isolationOf(owner, probe, input.isolation, proven.directories);
    const entries = transitionEntries(owner, probe, 'start');
    personalPlan(owner, probe, input, entries);
    runPlan(owner, probe, iso);
    briefPlan(owner, probe, pre.handoff.record);
    const result = selection().ownerBoundary(owner, probe.milestone, () => runs().withRegistryFence(owner, guard => {
      // The host callback ran outside: state, handoff, base and authority are verified again before writing.
      const again = startPreflight(owner, probe, input, now, startProgress(owner, probe));
      if (again.handoff.sha256 !== pre.handoff.sha256 || again.proof.endpoint.sha256 !== pre.proof.endpoint.sha256) fail('linked-task-handoff-stale', 'changed-during-start');
      const decision = verifyAuthority(owner, probe, live.handle, again.plan, now);
      const base = proveBase(owner, probe.milestone, again.proof.endpoint.record, input.codeDir, input.base);
      if (!same(base.roots, proven.roots)) fail('linked-task-base-drift', 'changed-during-start');
      // Worktree ownership is reconciled again after the host callback, before the first write.
      if (!same(isolationOf(owner, probe, input.isolation, base.directories), iso)) fail('linked-task-isolation-invalid', 'changed-during-start');
      // A late canonical registration (worktrees / attachment) on the still-inactive run refuses before any write.
      runPlan(owner, probe, iso);
      const brief = briefPlan(owner, probe, again.handoff.record);
      // The complete record (and its witness, when an interrupted start already published one) is
      // fixed before the first write; the isolation was validated against every physical root above.
      const record = witnessedStart(owner, probe, startRecord(probe, again.handoff.sha256, again.proof.endpoint.sha256, brief, again.plan, decision, base, iso, now));
      if (!brief.done) { writeAtomicText(brief.file, brief.consumed); progress.push('brief'); }
      point(input, 'after-brief');
      if (personalApply(owner, probe, input, entries, () => progress.push('personal'))) progress.push('personal');
      point(input, 'after-personal');
      if (!same(isolationOf(owner, probe, input.isolation, base.directories), iso)) fail('linked-task-isolation-invalid', 'changed-during-start');
      const updated = runs().updateWith(owner, probe.task_id, current => {
        if (!runIdentity(owner, probe, current)) fail('linked-task-start-conflict', 'run');
        if (runStarted(current, iso)) return null;
        if (current.active !== false || (Array.isArray(current.worktrees) && current.worktrees.length) || current.attached_to) fail('linked-task-start-conflict', 'run');
        return { active: true, isolation_mode: iso.mode, branch: iso.branch, worktrees: structuredClone(iso.worktrees), attached_to: iso.attached_to };
      }, guard);
      if (updated.updated) progress.push('run');
      point(input, 'after-run');
      if (!same(isolationOf(owner, probe, input.isolation, base.directories), iso)) fail('linked-task-isolation-invalid', 'changed-during-start');
      // The witness is published first, start.json stays the last record.
      const witnessed = time().publishOwnerRecord({ cwd: owner, milestone: probe.milestone, path: recordPath('start-witness'), record: { schema_version: HANDOFF_SCHEMA_VERSION,
        kind: KINDS['start-witness'], milestone: probe.milestone, task_id: probe.task_id, link_sha256: probe.link_sha256, start_sha256: digest(record), start: record } });
      if (witnessed.status === 'published') progress.push('witness');
      point(input, 'after-witness');
      if (!same(isolationOf(owner, probe, input.isolation, base.directories), iso)) fail('linked-task-isolation-invalid', 'changed-during-start');
      const published = time().publishOwnerRecord({ cwd: owner, milestone: probe.milestone, path: recordPath('start'), record });
      progress.push('start');
      point(input, 'after-start');
      return { status: 'started', task_id: probe.task_id, milestone: probe.milestone, start_sha256: published.sha256, handoff_sha256: again.handoff.sha256,
        brief_sha256: record.brief_sha256, block_sha256: record.block_sha256, base: record.base, authority_mode: again.plan.mode, steps_written: [...progress] };
    }));
    if (result.status === 'deferred') fail('linked-task-boundary-deferred', result.reason);
    return result;
  } catch (e) { return answer(e); }
}

// ---------------------------------------------------------------------------
// Consumed evidence, continuation and closures
// ---------------------------------------------------------------------------
// The started task's immutable consumed evidence: start.json, handoff.json and the exact BRIEF block.
function consumedEvidence(owner, probe) {
  const recs = requireRecords(owner, probe);
  if (recs['chain-closure'].status === 'valid') fail('linked-task-chain-closed');
  if (recs.start.status !== 'valid') fail('linked-task-not-started');
  const start = recs.start.record;
  if (recs.handoff.status !== 'valid' || recs.handoff.sha256 !== start.handoff_sha256) fail('linked-task-handoff-tampered', 'handoff-changed');
  requireHandoffBinding(owner, probe.milestone, recs.handoff.record);
  const endpoint = endpoints().readEndpoint({ cwd: owner, milestone: probe.milestone });
  if (endpoint.status !== 'valid' || endpoint.sha256 !== start.endpoint_sha256) fail('linked-task-handoff-stale', 'endpoint-changed');
  const block = renderHandoffBlock(recs.handoff.record);
  const file = briefFile(owner, probe.task_id);
  noLinks(file);
  const content = briefBytes(file);
  if (content === null) fail('linked-task-handoff-tampered', 'brief-missing');
  if (content === false) fail('linked-task-handoff-tampered', 'brief-changed');
  const text = content.toString('utf8');
  if (sha256(content) !== start.brief_sha256 || sha256(Buffer.from(block, 'utf8')) !== start.block_sha256
      || text.split(HANDOFF_MARKERS.start).length !== 2 || text.split(HANDOFF_MARKERS.end).length !== 2 || !text.endsWith('\n' + block)) fail('linked-task-handoff-tampered', 'brief-changed');
  // The complete start.json must still equal its independently published witness (any canonical edit refuses).
  const witness = time().readOwnerRecord({ cwd: owner, milestone: probe.milestone, path: recordPath('start-witness') });
  if (witness.status !== 'valid' || !startWitnessValid(witness.record) || witness.record.milestone !== probe.milestone || witness.record.task_id !== probe.task_id
      || witness.record.link_sha256 !== probe.link_sha256 || witness.record.start_sha256 !== recs.start.sha256 || !same(witness.record.start, start)) fail('linked-task-handoff-tampered', 'start-witness');
  return { recs, start, startSha: recs.start.sha256, handoff: recs.handoff, block };
}
// consumedHandoffBlock(cwd | request, taskId): null for an unlinked task (no time state read),
// the exact consumed block for a started linked task, a named refusal (thrown) otherwise.
function consumedHandoffBlock(cwd, task) {
  const owner = ownerOf(cwd);
  const probe = linkedTask().linkedTaskFor(owner, task);
  if (probe === null) return null;
  if (probe.status !== 'linked') fail('linked-task-state-invalid', probe.reason);
  return consumedEvidence(owner, probe).block;
}
// requireEntryDecisionsClear(cwd, task): bounded read-only gate for an actual provider entry of a started
// linked task. A required close-chain decision of this link that is still pending, or already answered to close
// the chain (closure not yet published), blocks the entry; an unreadable/excess census fails closed. It never
// writes and returns null for an unlinked task (no time state is read). Throws the same named refusals as
// continueLinkedTask: linked-task-decision-pending (with pending_ids), linked-task-authorization-revoked
// (chain-closure-decided) or linked-task-question-census-unknown.
function requireEntryDecisionsClear(cwd, task) {
  const owner = ownerOf(cwd), probe = linkedTask().linkedTaskFor(owner, task);
  if (probe === null) return null;
  if (probe.status !== 'linked') fail('linked-task-state-invalid', probe.reason);
  requireClosingNotDecided(owner, probe);
  requireDecisionsClear(owner, probe);
  return { task_id: probe.task_id, milestone: probe.milestone };
}
function startAuthorityPlan(probe, start) {
  if (start.authority.mode === 'chained') {
    const link = probe.link;
    return { mode: 'chained', request: { milestone: probe.milestone, options_sha256: link.options_sha256, option_id: link.option_id, position_id: link.position_id, authorization: link.authorization },
      expected: ['linked-task:' + link.authorization], question: { ...start.authority.question }, request_sha256: start.authority.request_sha256 };
  }
  return { mode: 'explicit', request: decisionRequest(probe, 'start', start.handoff_sha256), expected: ['linked-task:start'], question: { ...start.authority.question }, request_sha256: start.authority.request_sha256 };
}
// continueLinkedTask({cwd, taskId, liveAdapter, now}): read-only reattestation after a restart.
function continueLinkedTask(input = {}) {
  let probe = null;
  try {
    if (!object(input) || typeof input.liveAdapter?.getDecisionHandle !== 'function') fail('linked-task-authorization-required');
    const owner = ownerOf(input), now = nowOf(input);
    probe = probeTask(owner, input.taskId ?? input.task);
    const evidence = consumedEvidence(owner, probe);
    if (evidence.recs.closure.status === 'valid') fail('linked-task-closed');
    requireClosingNotDecided(owner, probe);
    requireDecisionsClear(owner, probe);
    const plan = startAuthorityPlan(probe, evidence.start);
    const live = liveHandle(owner, probe, input.liveAdapter, plan, now);
    if (live.decision.answer !== evidence.start.authority.answer) fail('linked-task-authorization-revoked');
    // The host callback ran outside every lock: the required decisions are checked again before the result.
    requireClosingNotDecided(owner, probe);
    requireDecisionsClear(owner, probe);
    // The consumed evidence is read again after the host callback: it must still be identical.
    const again = consumedEvidence(owner, probe);
    if (again.recs.closure.status === 'valid') fail('linked-task-closed');
    if (again.startSha !== evidence.startSha || again.block !== evidence.block) fail('linked-task-handoff-tampered', 'changed-during-continuation');
    return { status: 'continued', task_id: probe.task_id, milestone: probe.milestone, start_sha256: evidence.startSha, handoff_sha256: evidence.start.handoff_sha256,
      block_sha256: evidence.start.block_sha256, authority_mode: evidence.start.authority.mode };
  } catch (e) {
    const code = codeOf(e, 'linked-task-start-failed');
    return { status: 'refused', task_id: probe?.task_id ?? null, reason: START_REFUSALS.includes(code) ? code : 'linked-task-start-failed', ...(e.detail ? { detail: e.detail } : {}),
      ...(Array.isArray(e.pending_ids) ? { pending_ids: [...e.pending_ids] } : {}) };
  }
}
function lifecycleAnswer(probe, e, wrote, fallback) {
  const code = codeOf(e, fallback), known = LIFECYCLE_REFUSALS.includes(code);
  return { status: wrote || e.committed ? 'partial' : 'refused', ...personalCleanup(e), task_id: probe?.task_id ?? null, reason: known ? code : fallback, ...(typeof e.detail === 'string' ? { detail: e.detail } : !known ? { detail: code } : {}) };
}
function personalCleanup(error) {
  return error.committed ? { personal_committed: true, cleanup: error.cleanup, recovery: error.recovery } : {};
}
// closeChain({cwd, taskId, liveAdapter, now, userHome, env}): explicit attested revocation of the chain.
function closeChain(input = {}) {
  let probe = null, wrote = false;
  try {
    if (!object(input) || typeof input.liveAdapter?.getDecisionHandle !== 'function') fail('linked-task-authorization-required');
    const owner = ownerOf(input), now = nowOf(input);
    probe = probeTask(owner, input.taskId ?? input.task);
    const recs = requireRecords(owner, probe);
    if (recs.closure.status === 'valid') fail('linked-task-closed');
    requireCensus(owner, probe.milestone);
    const plan = closePlan(owner, probe), live = liveHandle(owner, probe, input.liveAdapter, plan, now);
    const entries = transitionEntries(owner, probe, 'chain-closure');
    personalPlan(owner, probe, input, entries);
    const result = selection().ownerBoundary(owner, probe.milestone, () => {
      const decision = verifyAuthority(owner, probe, live.handle, closePlan(owner, probe), now);
      const again = requireRecords(owner, probe);
      if (again.closure.status === 'valid') fail('linked-task-closed');
      const record = { schema_version: HANDOFF_SCHEMA_VERSION, kind: KINDS['chain-closure'], milestone: probe.milestone, task_id: probe.task_id, link_sha256: probe.link_sha256,
        decision: { reference: authorityRecord(plan, decision).reference, question: { identity_sha256: decision.question.identity_sha256, id: decision.question.id },
          answer: decision.answer, request_sha256: decision.request_sha256 },
        closed_at: new Date(now).toISOString() };
      const current = time().readOwnerRecord({ cwd: owner, milestone: probe.milestone, path: recordPath('chain-closure') });
      let published;
      if (current.status === 'valid' && chainClosureValid(current.record) && same({ ...current.record, closed_at: null, decision: { ...current.record.decision, reference: null } },
        { ...record, closed_at: null, decision: { ...record.decision, reference: null } })) published = { status: 'unchanged', sha256: current.sha256 };
      else if (current.status === 'absent') { published = time().publishOwnerRecord({ cwd: owner, milestone: probe.milestone, path: recordPath('chain-closure'), record }); wrote = true; }
      else fail('linked-task-closure-conflict', 'chain-closure');
      point(input, 'after-chain-closure');
      if (personalApply(owner, probe, input, entries)) wrote = true;
      return { status: published.status === 'published' ? 'chain-closed' : 'unchanged', task_id: probe.task_id, milestone: probe.milestone, chain_closure_sha256: published.sha256 };
    });
    if (result.status === 'deferred') fail('linked-task-boundary-deferred', result.reason);
    return result;
  } catch (e) { return lifecycleAnswer(probe, e, wrote, 'linked-task-operation-failed'); }
}
// The canonical standalone delivery of the task, rebuilt from its INPUT by forge-delivery.
function taskDeliveryProof(owner, task, codeDir) {
  const prefix = `.gsd/tasks/${task}/${task}`, refs = { summary: prefix + '-SUMMARY.md', input: prefix + '-DELIVERY-INPUT.json', output: prefix + '-DELIVERY.json', plan: prefix + '-PLAN.md' };
  const summary = ownerBytes(owner, refs.summary, MAX_SOURCE);
  if (summary === null) fail('linked-task-delivery-unproven', 'summary-missing');
  const inputBytes = ownerBytes(owner, refs.input, MAX_SOURCE), outputBytes = ownerBytes(owner, refs.output, 8 * MAX_SOURCE);
  if (inputBytes === null || outputBytes === null) fail('linked-task-delivery-unproven', 'delivery-missing');
  let input, stored;
  try { input = JSON.parse(inputBytes.toString('utf8')); stored = JSON.parse(outputBytes.toString('utf8')); } catch { fail('linked-task-delivery-unproven', 'delivery-json-invalid'); }
  if (!same(input?.unit, { type: 'task', id: task }) || input.plan !== refs.plan) fail('linked-task-delivery-unproven', 'delivery-foreign');
  const primary = input.schema_version === 2 ? input.execution_contract?.code_roots?.find(r => r?.id === input.execution_contract.primary_root_id)?.path : null;
  const dir = typeof codeDir === 'string' ? codeDir : primary || owner;
  let rebuilt; try { rebuilt = require('./forge-delivery').buildDelivery(input, { ownerRoot: owner, codeDir: dir }); } catch { fail('linked-task-delivery-unproven', 'delivery-rebuild-failed'); }
  if (!same(rebuilt, stored)) fail('linked-task-delivery-unproven', 'delivery-stale');
  // Canonical standalone delivery: this task's unit, zero diagnostics (a missing, malformed or foreign
  // expected child reports one and omits its criteria) and every expected child present in the lineage.
  const delivered = require('./forge-delivery'), own = delivered.unitKey({ type: 'task', id: task });
  if (rebuilt.generated_by !== 'forge-delivery' || !same(rebuilt.unit, { type: 'task', id: task }) || !Array.isArray(rebuilt.diagnostics) || !Array.isArray(rebuilt.lineage)) fail('linked-task-delivery-unproven', 'delivery-foreign');
  if (rebuilt.diagnostics.length) fail('linked-task-delivery-unproven', 'delivery-diagnostics');
  const expected = input.expected_children === undefined ? [] : input.expected_children;
  if (!Array.isArray(expected) || !expected.every(c => object(c) && delivered.unitKey(c.unit) && rebuilt.lineage.includes(delivered.unitKey(c.unit)))) fail('linked-task-delivery-unproven', 'delivery-incomplete');
  if (!rebuilt.plan?.structured || !rebuilt.lineage.includes(own) || !Array.isArray(rebuilt.criteria) || rebuilt.criteria.some(c => !object(c) || !rebuilt.lineage.includes(delivered.unitKey(c.unit)))) fail('linked-task-delivery-unproven', 'delivery-incomplete');
  if (!Array.isArray(rebuilt.criteria) || !rebuilt.criteria.length || rebuilt.criteria.some(c => c.status !== 'verificado' || (c.pending || []).length)) fail('linked-task-delivery-unproven', 'criteria-unverified');
  if (!hash(rebuilt.delivery_fingerprint)) fail('linked-task-delivery-unproven', 'fingerprint-missing');
  return { summary: { reference: refs.summary, sha256: sha256(summary) },
    delivery: { reference: refs.output, sha256: sha256(outputBytes), input_sha256: sha256(inputBytes), fingerprint: rebuilt.delivery_fingerprint, criteria: rebuilt.criteria.length } };
}
// closeLinkedTask({cwd, taskId, codeDir, now, userHome, env}): owner action after the verified delivery.
function closeLinkedTask(input = {}) {
  let probe = null, wrote = false;
  try {
    if (!object(input)) fail('linked-task-state-invalid');
    const owner = ownerOf(input), now = nowOf(input);
    probe = probeTask(owner, input.taskId ?? input.task);
    const evidence = consumedEvidence(owner, probe);
    const entries = transitionEntries(owner, probe, 'closure');
    // An existing immutable closure is history: a repeat never re-proves a later source state.
    if (evidence.recs.closure.status === 'valid' && evidence.recs.closure.record.start_sha256 === evidence.startSha) {
      personalPlan(owner, probe, input, entries);
      const result = selection().ownerBoundary(owner, probe.milestone, () => {
        // The consumed evidence is revalidated inside the boundary (BRIEF included) before any personal write;
        // only the historical closure/delivery record is retained, later delivery sources are not rebuilt.
        const again = consumedEvidence(owner, probe), closure = again.recs.closure;
        if (again.startSha !== evidence.startSha || again.block !== evidence.block || closure.status !== 'valid'
            || closure.sha256 !== evidence.recs.closure.sha256 || closure.record.start_sha256 !== again.startSha) fail('linked-task-handoff-tampered', 'changed-during-closure');
        if (personalApply(owner, probe, input, entries)) wrote = true;
        return { status: 'unchanged', task_id: probe.task_id, milestone: probe.milestone, closure_sha256: closure.sha256, fingerprint: closure.record.fingerprint, criteria: closure.record.delivery.criteria };
      });
      if (result.status === 'deferred') fail('linked-task-boundary-deferred', result.reason);
      return result;
    }
    const proof = taskDeliveryProof(owner, probe.task_id, input.codeDir);
    personalPlan(owner, probe, input, entries);
    const result = selection().ownerBoundary(owner, probe.milestone, () => {
      const again = consumedEvidence(owner, probe), delivered = taskDeliveryProof(owner, probe.task_id, input.codeDir);
      if (again.startSha !== evidence.startSha || !same(delivered, proof)) fail('linked-task-delivery-unproven', 'changed-during-closure');
      // The verified task clock at the instant of closure is retained in the immutable record, so a later census growth
      // of unrelated question states can never reclassify the closed horizon. It is omitted only when it cannot be
      // measured; the reader then keeps its conservative live computation.
      const clock = horizonModule().closureClock({ cwd: owner, task: probe.task_id, now });
      const record = { schema_version: HANDOFF_SCHEMA_VERSION, kind: KINDS.closure, milestone: probe.milestone, task_id: probe.task_id, link_sha256: probe.link_sha256,
        start_sha256: again.startSha, summary: delivered.summary, delivery: delivered.delivery, closed_at: new Date(now).toISOString(), fingerprint: delivered.delivery.fingerprint,
        ...(clock ? { clock } : {}) };
      const current = time().readOwnerRecord({ cwd: owner, milestone: probe.milestone, path: recordPath('closure') });
      let published;
      if (current.status === 'valid' && closureValid(current.record) && same({ ...current.record, closed_at: null, clock: null }, { ...record, closed_at: null, clock: null })) published = { status: 'unchanged', sha256: current.sha256 };
      else if (current.status === 'absent') { published = time().publishOwnerRecord({ cwd: owner, milestone: probe.milestone, path: recordPath('closure'), record }); wrote = true; }
      else fail('linked-task-closure-conflict', 'closure');
      point(input, 'after-closure');
      if (personalApply(owner, probe, input, entries)) wrote = true;
      return { status: published.status === 'published' ? 'closed' : 'unchanged', task_id: probe.task_id, milestone: probe.milestone, closure_sha256: published.sha256,
        fingerprint: record.fingerprint, criteria: record.delivery.criteria };
    });
    if (result.status === 'deferred') fail('linked-task-boundary-deferred', result.reason);
    return result;
  } catch (e) { return lifecycleAnswer(probe, e, wrote, 'linked-task-operation-failed'); }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const OWNER_ACTIONS = Object.freeze(['--status', '--handoff', '--close']), LIVE_ACTIONS = Object.freeze(['--start', '--continue', '--close-chain']);
const OK = Object.freeze({ '--status': null, '--handoff': ['produced', 'unchanged'], '--close': ['closed', 'unchanged'], '--start': ['started'], '--continue': ['continued'], '--close-chain': ['chain-closed', 'unchanged'] });
function message(action, result) {
  if (result === null) return 'Task sem vínculo: nenhum estado de tempo foi lido.';
  const reason = result.reason, text = MESSAGES[reason];
  if (['refused', 'partial', 'invalid'].includes(result.status)) return (result.status === 'partial' ? 'Operação parcial da task ligada: ' : 'Operação recusada: ') + reason + (text ? ' (' + text + ')' : '') + '.';
  if (action === '--status') return 'Task ligada ' + result.task_id + ': estado ' + result.status + '.';
  return 'Task ligada ' + result.task_id + ': ' + result.status + '.';
}
// --status, --handoff and --close are owner actions; --start, --continue and --close-chain need the
// embedded main(argv, io, liveAdapter) of the trusted host and, standalone, refuse before any read.
function main(argv = process.argv.slice(2), io = process, liveAdapter) {
  const json = argv.includes('--json'), options = {}, roots = {}, targets = {};
  let action = null;
  try {
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i], value = argv[i + 1], has = typeof value === 'string' && value && !value.startsWith('--');
      if (flag === '--json') continue;
      if ([...OWNER_ACTIONS, ...LIVE_ACTIONS].includes(flag)) { if (action) fail('linked-task-usage'); action = flag; continue; }
      if (['--cwd', '--task', '--milestone', '--code-dir', '--base-kind', '--base-target', '--isolation-mode', '--attached-to'].includes(flag) && has) {
        const key = flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (options[key] !== undefined) fail('linked-task-usage'); options[key] = argv[++i]; continue;
      }
      if (['--root', '--target'].includes(flag) && has && /^[A-Za-z][A-Za-z0-9_-]{0,63}=./.test(value)) {
        const [id, ...rest] = value.split('='), map = flag === '--root' ? roots : targets;
        if (map[id] !== undefined) fail('linked-task-usage'); map[id] = rest.join('='); i++; continue;
      }
      fail('linked-task-usage');
    }
    if (!action || !options.cwd || (action === '--handoff' ? !options.task && !options.milestone : !options.task)) fail('linked-task-usage');
    let result;
    if (LIVE_ACTIONS.includes(action) && typeof liveAdapter?.getDecisionHandle !== 'function') {
      // Refused before any read or write: the standalone CLI never carries live authority.
      result = { status: 'refused', task_id: options.task, reason: 'linked-task-authorization-required', steps_written: [] };
    } else if (action === '--status') result = linkedLifecycle(options.cwd, options.task);
    else if (action === '--handoff') result = produceHandoff({ cwd: options.cwd, ...(options.task ? { task: options.task } : { milestone: options.milestone }) });
    else if (action === '--close') result = closeLinkedTask({ cwd: options.cwd, taskId: options.task, ...(options.codeDir ? { codeDir: options.codeDir } : {}) });
    else if (action === '--continue') result = continueLinkedTask({ cwd: options.cwd, taskId: options.task, liveAdapter });
    else if (action === '--close-chain') result = closeChain({ cwd: options.cwd, taskId: options.task, liveAdapter });
    else {
      const codeDir = Object.keys(roots).length ? roots : options.codeDir, target = Object.keys(targets).length ? targets : options.baseTarget;
      result = startLinkedTask({ cwd: options.cwd, taskId: options.task, liveAdapter, codeDir, base: { kind: options.baseKind, ...(target !== undefined ? { target } : {}) },
        isolation: { mode: options.isolationMode || 'shared', ...(options.attachedTo ? { attached_to: options.attachedTo } : {}) } });
    }
    // Public JSON only: relative references, digests and typed reasons, never an absolute path.
    if (result !== null && Object.hasOwn(result, 'task_id')) result = { ...result, task_id: typedId(result.task_id, 'task') && time().isPublicData(result.task_id) ? result.task_id : null };
    const view = result === null || time().isPublicData(result) ? result : { status: result.status, task_id: typedId(result.task_id, 'task') && time().isPublicData(result.task_id) ? result.task_id : null,
      reason: typeof result.reason === 'string' && /^[a-z][a-z0-9-]{0,100}$/.test(result.reason) ? result.reason : 'linked-task-output-not-public' };
    if (view !== null && !time().isPublicData(view)) fail('linked-task-output-not-public');
    io.stdout.write((json ? JSON.stringify(view) : message(action, view)) + '\n');
    if (view === null) return 0;
    if (action === '--status') return view.status === 'invalid' ? 3 : 0;
    return OK[action].includes(view.status) ? 0 : 3;
  } catch (e) {
    const reason = codeOf(e, 'linked-task-refused'), status = reason === 'linked-task-usage' ? 2 : 3;
    io.stdout.write(json ? JSON.stringify({ status: status === 2 ? 'usage' : 'refused', reason }) + '\n'
      : status === 2 ? 'Uso: --status|--handoff|--close|--start|--continue|--close-chain --cwd <owner> --task <T> [--milestone <M>] [--code-dir <dir> | --root <id>=<dir>] '
        + '[--base-kind milestone-branch|integrated] [--base-target <ref> | --target <id>=<ref>] [--json]\n' : 'Operação recusada: ' + reason + '\n');
    return status;
  }
}

module.exports = { HANDOFF_SCHEMA_VERSION, LIFECYCLE_STATES, START_REFUSALS, BASE_KINDS, PREDECESSOR_REASONS, LIFECYCLE_REFUSALS, LINKED_DECISION_ACTIONS,
  HANDOFF_MARKERS, HANDOFF_RECORD_FIELDS, linkedLifecycle, provePredecessor, produceHandoff, renderHandoffBlock, validateLinkedBase, startLinkedTask,
  continueLinkedTask, consumedHandoffBlock, requireEntryDecisionsClear, closeChain, closeLinkedTask, prepareLinkedDecision, answerLinkedDecision, recordLinkedDecisionRound,
  deriveHandoffSnapshot, handoffSourceProjection: stableHandoff, handoffBindingMatches, main };
if (require.main === module) process.exitCode = main();
