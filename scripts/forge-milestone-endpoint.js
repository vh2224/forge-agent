#!/usr/bin/env node
'use strict';

// Owner endpoint of a contracted milestone (verified-integrated-delivery): a FRESH root
// verification of the integrated code, the immutable endpoint.json record published at
// the safe owner boundary, and its validated reader. The proof itself is computed by
// forge-milestone-time-clock.readEndpointProof; no caller object, flag, handle or
// imported status grants it. Import is inert: only core modules load here.
const fs = require('fs');
const path = require('path');
const ENDPOINT_SCHEMA_VERSION = 1;
const RECORD_PATH = 'endpoint.json', KIND = 'forge-milestone-endpoint', MAX_RECORD = 64 * 1024, MAX_GAPS = 64, MAX_SCOPE = 256;
// Exact key order of endpoint.json and its nested objects (shared/schemas/forge-milestone-endpoint.schema.json).
const ENDPOINT_RECORD_FIELDS = Object.freeze({
  record: Object.freeze(['schema_version', 'kind', 'milestone', 'policy', 'endpoint_at', 'contract', 'completion', 'delivery', 'selection',
    'roadmap', 'reviews', 'roots', 'questions', 'time_state', 'clock']),
  policy: Object.freeze(['id', 'version']),
  contract: Object.freeze(['version', 'sha256', 'base_sha256']),
  completion: Object.freeze(['unit', 'transaction_sha256', 'result_sha256', 'boundary_sha256', 'event_sha256', 'completed_at', 'committed_at']),
  delivery: Object.freeze(['reference', 'sha256', 'input_sha256', 'fingerprint', 'criteria', 'children']),
  child: Object.freeze(['unit', 'reference', 'sha256']),
  selection: Object.freeze(['status', 'sha256']),
  roadmap: Object.freeze(['sha256', 'structure_sha256']),
  review: Object.freeze(['slice', 'reference', 'sha256']),
  root: Object.freeze(['root_id', 'root_identity_sha256', 'revision', 'branch', 'envelope_sha256', 'checks', 'scope']),
  scope: Object.freeze(['path', 'hash']),
  questions: Object.freeze(['pending']),
  time_state: Object.freeze(['state', 'contract_version', 'ceiling_ms', 'consumed_ms', 'unknown_ms', 'remaining_ms', 'forecast', 'unknown', 'decision_pending']),
  clock: Object.freeze(['consumed_ms', 'unknown_ms', 'by_class', 'effort', 'waits', 'gaps', 'gap_count', 'gaps_truncated']),
  gap: Object.freeze(['start', 'end', 'reason']),
});
const SELECTION_STATUSES = Object.freeze(['decided', 'not-enrolled']);
// time_state of the record is the snapshot taken BEFORE the freeze (deriveSnapshot rejects an
// already-frozen clock): exactly the six pre-endpoint budget states (plus null), never the public
// endpoint-proven state that only exists after this record froze the clock.
const SNAPSHOT_TIME_STATES = Object.freeze(['active', 'warning', 'exhausted', 'draining', 'checkpointed', 'extended']);
const FORECASTS = Object.freeze(['fits', 'at-risk', 'exceeds', 'unknown']);
const GAP_REASONS = Object.freeze(['wait-end-missing', 'session-change', 'source-limit', 'no-source']);
const HASH = /^[a-f0-9]{64}$/, REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, ROOT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
// Storage refusals of the generic owner record API, renamed in this domain.
const STORAGE_REASONS = Object.freeze({ 'time-record-conflict': 'endpoint-record-conflict', 'time-path-link': 'endpoint-path-link',
  'time-record-invalid': 'endpoint-record-not-public', 'time-source-too-large': 'endpoint-record-too-large', 'time-record-path-invalid': 'endpoint-path-invalid',
  'time-work-id-invalid': 'endpoint-milestone-invalid', 'time-work-kind-unsupported': 'endpoint-milestone-invalid',
  'time-owner-invalid': 'endpoint-owner-invalid', 'time-owner-missing': 'endpoint-owner-invalid', 'time-contract-required': 'endpoint-contract-missing' });
function time() { return require('./forge-milestone-time'); }
function clock() { return require('./forge-milestone-time-clock'); }
function selection() { return require('./forge-milestone-time-selection'); }
function roots() { return require('./forge-code-roots'); }
function refusal(code, extra) { return Object.assign(new Error(code), { code, extra }); }
function reasonOf(e) { const code = e?.code; return typeof code === 'string' && /^endpoint-[a-z0-9-]{1,80}$/.test(code) ? code : STORAGE_REASONS[code] || 'endpoint-operation-refused'; }
// Only a supported public typed milestone ID is ever echoed back: an unsafe argument is never reflected.
function publicMilestone(v) {
  try {
    const ids = require('./forge-ids');
    return typeof v === 'string' && !/[\\/\0]/.test(v) && ids.isValid(v) && ids.entityKind(v) === 'milestone' && time().isPublicData(v) ? v : null;
  } catch { return null; }
}
function refused(milestone, e) { return { status: 'refused', milestone: publicMilestone(milestone), reason: reasonOf(e), ...(e?.extra || {}) }; }
function object(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function exact(v, keys) { return object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k)); }
function hash(v) { return typeof v === 'string' && HASH.test(v); }
function count(v) { return Number.isSafeInteger(v) && v >= 0; }
function nullable(v) { return v === null || Number.isSafeInteger(v); }
function instant(v) { return typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && new Date(Date.parse(v)).toISOString() === v; }
function nowOf(options) { const now = typeof options.now === 'function' ? options.now() : options.now ?? Date.now(); if (!Number.isSafeInteger(now)) throw refusal('endpoint-now-invalid'); return now; }
function milestoneOf(options) {
  const ids = require('./forge-ids'), milestone = options?.milestone;
  if (typeof milestone !== 'string' || /[\\/\0]/.test(milestone) || !ids.isValid(milestone) || ids.entityKind(milestone) !== 'milestone') throw refusal('endpoint-milestone-invalid');
  return milestone;
}
function ownerOf(options) { try { return selection().ownerRoot(options); } catch (e) { throw refusal(e.code === 'time-path-link' ? 'endpoint-path-link' : 'endpoint-owner-invalid'); } }
function noLinks(file) {
  for (let cursor = path.resolve(file); ; cursor = path.dirname(cursor)) {
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw refusal('endpoint-path-link'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (path.dirname(cursor) === cursor) return;
  }
}
// Append-only publication anchor of one endpoint.json: written only by time.publishAnchoredEndpoint
// inside the owner publication critical section, never by the generic owner-record API. It names the
// record digest, the contract chain it was proven against and the digests of its proof and snapshot
// sections, so a coherently reserialized or imported record carries no freeze authority.
const ANCHOR_KIND = 'forge-milestone-endpoint-anchor';
const PROOF_SECTIONS = Object.freeze(['milestone', 'policy', 'contract', 'completion', 'delivery', 'selection', 'roadmap', 'reviews', 'roots', 'questions']);
const SNAPSHOT_SECTIONS = Object.freeze(['endpoint_at', 'time_state', 'clock']);
function sectionDigest(record, keys) { return require('./forge-code-roots').digest(Object.fromEntries(keys.map(k => [k, record[k]]))); }
function anchorOf(record, completionKey) {
  return { schema_version: 1, kind: ANCHOR_KIND, milestone: record.milestone, record_sha256: require('./forge-code-roots').digest(record),
    contract: { version: record.contract.version, sha256: record.contract.sha256, base_sha256: record.contract.base_sha256 },
    completion_key: completionKey, proof_sha256: sectionDigest(record, PROOF_SECTIONS), snapshot_sha256: sectionDigest(record, SNAPSHOT_SECTIONS) };
}
// The only anchor issuer (called by time.publishAnchoredEndpoint inside the owner lock): the proof was
// recomputed from the canonical stores at endpoint_at, so a record is anchored only when every proof
// section equals it, and the snapshot was derived internally by deriveSnapshot at the same instant, so
// the snapshot sections must equal it too. No caller pair, digest, snapshot or anchor object is accepted.
function issueAnchor(record, proof, snapshot) {
  if (proof?.status !== 'proven') throw refusal(typeof proof?.reason === 'string' && /^endpoint-[a-z0-9-]{1,80}$/.test(proof.reason) ? proof.reason : 'endpoint-proof-unknown');
  const canonical = { milestone: record.milestone, policy: { id: proof.policy.id, version: proof.policy.version }, ...proof.proof };
  if (typeof proof.completion_key !== 'string' || sectionDigest(canonical, PROOF_SECTIONS) !== sectionDigest(record, PROOF_SECTIONS)) throw refusal('endpoint-proof-mismatch');
  if (!object(snapshot) || sectionDigest(snapshot, SNAPSHOT_SECTIONS) !== sectionDigest(record, SNAPSHOT_SECTIONS)) throw refusal('endpoint-snapshot-mismatch');
  return anchorOf(record, proof.completion_key);
}
// Publication evidence of the internally derived snapshot, written by the same trusted path below
// endpoint-snapshots/<record sha>.json: a third object, independent of endpoint.json and its anchor, that
// names the record digest and the digest of the snapshot the publisher itself derived from the stores.
const WITNESS_KIND = 'forge-milestone-endpoint-snapshot';
function witnessOf(record, anchor) {
  return { schema_version: 1, kind: WITNESS_KIND, milestone: record.milestone, record_sha256: anchor.record_sha256,
    endpoint_at: record.endpoint_at, snapshot_sha256: anchor.snapshot_sha256, completion_key: anchor.completion_key };
}
function issueSnapshotWitness(record, anchor) {
  if (!object(anchor) || anchor.kind !== ANCHOR_KIND || JSON.stringify(anchor) !== JSON.stringify(anchorOf(record, anchor.completion_key))) throw refusal('endpoint-anchor-mismatch');
  return witnessOf(record, anchor);
}
function envelopeReference(milestone, root) { return clock().ENDPOINT_PROOF_POLICY.envelope.replace(/\{milestone\}/g, milestone).replace('{root}', root); }

// Closed structural and coherence validation of one endpoint.json value (never throws).
function validateEndpointRecord(r) {
  const invalid = reason => ({ valid: false, reason });
  try {
    if (!object(r)) return invalid('endpoint-record-invalid');
    if (Buffer.byteLength(JSON.stringify(r) + '\n') > MAX_RECORD) return invalid('endpoint-record-too-large');
    if (!time().isPublicData(r)) return invalid('endpoint-record-not-public');
    const F = ENDPOINT_RECORD_FIELDS, policy = clock().ENDPOINT_PROOF_POLICY, classes = clock().CLOCK_POLICY.classes;
    const consumes = clock().CLOCK_POLICY.consumption, M = r.milestone, dir = `.gsd/milestones/${M}`;
    const shape = exact(r, F.record) && r.schema_version === ENDPOINT_SCHEMA_VERSION && r.kind === KIND && typeof M === 'string'
      && exact(r.policy, F.policy) && r.policy.id === policy.id && r.policy.version === policy.version && instant(r.endpoint_at)
      && exact(r.contract, F.contract) && Number.isSafeInteger(r.contract.version) && r.contract.version >= 1 && hash(r.contract.sha256) && hash(r.contract.base_sha256)
      && (r.contract.version > 1 || r.contract.sha256 === r.contract.base_sha256)
      && exact(r.completion, F.completion) && r.completion.unit === 'complete-milestone/' + M
      && ['transaction_sha256', 'result_sha256', 'boundary_sha256', 'event_sha256'].every(k => hash(r.completion[k]))
      && instant(r.completion.completed_at) && instant(r.completion.committed_at)
      && exact(r.delivery, F.delivery) && r.delivery.reference === `${dir}/${M}-DELIVERY.json` && hash(r.delivery.sha256) && hash(r.delivery.input_sha256)
      && hash(r.delivery.fingerprint) && count(r.delivery.criteria) && r.delivery.criteria > 0
      && Array.isArray(r.delivery.children) && r.delivery.children.length > 0 && r.delivery.children.length <= 256
      && r.delivery.children.every(c => exact(c, F.child) && new RegExp(`^${M}/slice/S\\d{2,}$`).test(c.unit) && hash(c.sha256)
        && c.reference === `${dir}/slices/${c.unit.split('/')[2]}/${c.unit.split('/')[2]}-DELIVERY.json`)
      && exact(r.selection, F.selection) && SELECTION_STATUSES.includes(r.selection.status) && (r.selection.status === 'decided' ? hash(r.selection.sha256) : r.selection.sha256 === null)
      && exact(r.roadmap, F.roadmap) && hash(r.roadmap.sha256) && (r.roadmap.structure_sha256 === null || hash(r.roadmap.structure_sha256))
      && Array.isArray(r.reviews) && r.reviews.length === r.delivery.children.length
      && r.reviews.every((v, i) => exact(v, F.review) && v.slice === r.delivery.children[i].unit.split('/')[2] && hash(v.sha256)
        && v.reference === `${dir}/slices/${v.slice}/${v.slice}-REVIEW.md`)
      && Array.isArray(r.roots) && r.roots.length > 0 && r.roots.length <= 14 && new Set(r.roots.map(v => v?.root_id)).size === r.roots.length
      && r.roots.every(v => exact(v, F.root) && ROOT_ID.test(v.root_id) && hash(v.root_identity_sha256) && REVISION.test(v.revision)
        && (v.branch === null || typeof v.branch === 'string' && v.branch.length > 0 && v.branch.length <= 255) && hash(v.envelope_sha256)
        && Number.isSafeInteger(v.checks) && v.checks > 0 && Array.isArray(v.scope) && v.scope.length <= MAX_SCOPE
        && new Set(v.scope.map(s => s?.path)).size === v.scope.length
        && v.scope.every(s => exact(s, F.scope) && typeof s.path === 'string' && s.path.length > 0 && s.path.length <= 1024 && REVISION.test(s.hash)))
      && r.roots.some(v => v.scope.length > 0)
      && exact(r.questions, F.questions) && r.questions.pending === 0
      && exact(r.time_state, F.time_state) && (r.time_state.state === null || SNAPSHOT_TIME_STATES.includes(r.time_state.state))
      && r.time_state.contract_version === r.contract.version && ['ceiling_ms', 'consumed_ms', 'unknown_ms', 'remaining_ms'].every(k => nullable(r.time_state[k]))
      && FORECASTS.includes(r.time_state.forecast) && typeof r.time_state.unknown === 'boolean' && typeof r.time_state.decision_pending === 'boolean'
      && exact(r.clock, F.clock) && exact(r.clock.by_class, classes) && classes.every(k => count(r.clock.by_class[k]))
      && exact(r.clock.waits, classes.filter(k => !consumes[k])) && object(r.clock.effort) && count(r.clock.effort.unit_interval_sum_ms)
      && Array.isArray(r.clock.gaps) && r.clock.gaps.length <= MAX_GAPS
      && r.clock.gaps.every(g => exact(g, F.gap) && Number.isSafeInteger(g.start) && Number.isSafeInteger(g.end) && g.start <= g.end && GAP_REASONS.includes(g.reason))
      && count(r.clock.gap_count) && r.clock.gap_count >= r.clock.gaps.length && r.clock.gaps_truncated === r.clock.gap_count > r.clock.gaps.length;
    if (!shape) return invalid('endpoint-record-invalid');
    const order = Date.parse(r.completion.completed_at) <= Date.parse(r.completion.committed_at) && Date.parse(r.completion.committed_at) < Date.parse(r.endpoint_at);
    const sums = r.clock.consumed_ms === classes.filter(k => consumes[k]).reduce((sum, k) => sum + r.clock.by_class[k], 0)
      && r.clock.unknown_ms === r.clock.by_class.unknown && classes.filter(k => !consumes[k]).every(k => r.clock.waits[k] === r.clock.by_class[k])
      && r.time_state.consumed_ms === r.clock.consumed_ms && r.time_state.unknown_ms === r.clock.unknown_ms;
    return order && sums ? { valid: true } : invalid('endpoint-record-incoherent');
  } catch { return invalid('endpoint-record-invalid'); }
}

// Bounded historical binding of a recorded endpoint to the canonical immutable stores: the committed
// complete-milestone transaction (found by the anchored key), its result, boundary and event, and the
// exact bytes of the delivery, input, child deliveries and slice reviews. Fixed paths only: it never
// reads the live event stream or compares today's child sources, so later growth keeps a frozen read.
function verifyEndpointBinding({ cwd, record, completionKey }) {
  const bad = reason => ({ status: 'mismatch', reason });
  try {
    const M = record.milestone, delivery = require('./forge-delivery'), controller = require('./forge-unit-controller'), unit = 'complete-milestone/' + M;
    const read = reference => {
      const file = path.resolve(cwd, ...reference.split('/'));
      noLinks(file);
      const bytes = require('./forge-autonomy-sources').readBoundedStableFile(file, 1024 * 1024, { expectedReal: fs.realpathSync.native(file) });
      return bytes.error ? null : bytes.buffer;
    };
    const sha = buffer => require('crypto').createHash('sha256').update(buffer).digest('hex');
    const matches = (reference, sha256) => { const buffer = read(reference); return buffer && sha(buffer) === sha256 ? buffer : null; };
    const stored = matches(record.delivery.reference, record.delivery.sha256);
    if (!stored || JSON.parse(stored.toString('utf8')).delivery_fingerprint !== record.delivery.fingerprint) return bad('delivery-mismatch');
    if (!matches(record.delivery.reference.replace(/-DELIVERY\.json$/, '-DELIVERY-INPUT.json'), record.delivery.input_sha256)) return bad('input-mismatch');
    for (const child of record.delivery.children) if (!matches(child.reference, child.sha256)) return bad('child-delivery-mismatch');
    for (const review of record.reviews) if (!matches(review.reference, review.sha256)) return bad('review-mismatch');
    const tx = controller.lookupRecord(cwd, 'transaction', completionKey), result = controller.lookupRecord(cwd, 'result', completionKey), boundary = tx?.boundary;
    if (!tx || tx.action !== 'complete' || tx.phase !== 'committed' || tx.milestone !== M || tx.unit?.key !== unit || result?.status !== 'succeeded'
        || boundary?.kind !== 'completed' || boundary.handoff_ready !== true || boundary.idempotency_key !== completionKey) return bad('completion-mismatch');
    const c = record.completion;
    if (delivery.fingerprint(tx) !== c.transaction_sha256 || delivery.fingerprint(result) !== c.result_sha256 || delivery.fingerprint(boundary) !== c.boundary_sha256
        || delivery.fingerprint(tx.event) !== c.event_sha256 || tx.event?.ts !== c.completed_at || boundary.committed_at !== c.committed_at) return bad('completion-mismatch');
    return { status: 'bound' };
  } catch { return bad('canonical-store-unreadable'); }
}

// Validated reader (never throws): schema, milestone, the contract version and base bound
// to a row of the CURRENT chain (later amendments keep it), and internal coherence.
function readEndpoint(options = {}) {
  try {
    const milestone = milestoneOf(options), t = time();
    const read = t.readOwnerRecord({ cwd: options.cwd, milestone, path: RECORD_PATH });
    if (read.status === 'absent') return { status: 'absent' };
    if (read.status !== 'valid') return { status: 'invalid', reason: 'endpoint-record-unreadable', detail: read.reason };
    const record = read.record, checked = validateEndpointRecord(record);
    if (!checked.valid) return { status: 'invalid', reason: checked.reason };
    if (record.milestone !== milestone) return { status: 'invalid', reason: 'endpoint-record-foreign' };
    const contract = t.readContract({ cwd: options.cwd, milestone });
    if (contract.status !== 'valid') return { status: 'invalid', reason: 'endpoint-contract-invalid', detail: contract.reason || contract.status };
    const row = contract.chain[record.contract.version - 1];
    if (!row || row.sha256 !== record.contract.sha256 || contract.chain[0].sha256 !== record.contract.base_sha256) return { status: 'invalid', reason: 'endpoint-contract-chain-mismatch' };
    // Independent binding: the immutable anchor of this exact record, never a self-digest.
    const anchor = t.readEndpointAnchor({ cwd: options.cwd, milestone, sha256: read.sha256 });
    if (anchor.status === 'absent') return { status: 'invalid', reason: 'endpoint-anchor-missing' };
    if (anchor.status !== 'valid') return { status: 'invalid', reason: 'endpoint-anchor-invalid', detail: anchor.reason };
    if (typeof anchor.anchor?.completion_key !== 'string' || JSON.stringify(anchor.anchor) !== JSON.stringify(anchorOf(record, anchor.anchor.completion_key))) return { status: 'invalid', reason: 'endpoint-anchor-mismatch' };
    // Independent bounded historical binding to the canonical completion, delivery and review stores
    // (never today's child sources or the live event stream).
    const bound = verifyEndpointBinding({ cwd: options.cwd, record, completionKey: anchor.anchor.completion_key });
    if (bound.status !== 'bound') return { status: 'invalid', reason: 'endpoint-canonical-mismatch', detail: bound.reason };
    // Independent snapshot evidence: the publication witness of the snapshot the trusted path derived,
    // a third object that neither endpoint.json nor its anchor can supply for a coherent forgery.
    const witness = t.readEndpointSnapshot({ cwd: options.cwd, milestone, sha256: read.sha256 });
    if (witness.status !== 'valid' || JSON.stringify(witness.witness) !== JSON.stringify(witnessOf(record, anchor.anchor))) return { status: 'invalid', reason: 'endpoint-snapshot-unbound' };
    return { status: 'valid', record, sha256: read.sha256 };
  } catch (e) { return { status: 'invalid', reason: reasonOf(e) === 'endpoint-operation-refused' ? 'endpoint-record-unreadable' : reasonOf(e) }; }
}

// Fresh integrated verification: runRootVerification on the measured root contract of the
// milestone delivery, with the explicit deduplicated union of the declared verify commands
// per root (never discovery or a caller list). Each root envelope is written atomically in
// the milestone folder at the safe boundary; a failed run is written too and never proves.
function writeEndpointVerification(options = {}) {
  let milestone = typeof options.milestone === 'string' ? options.milestone : null;
  try {
    milestone = milestoneOf(options);
    const owner = ownerOf(options), now = nowOf(options);
    if (readEndpoint({ cwd: owner, milestone }).status !== 'absent') throw refusal('endpoint-already-recorded');
    const proof = clock().readEndpointProof({ cwd: owner, milestone, now });
    const plan = proof.verification_plan;
    if (!plan) throw refusal(proof.status === 'unknown' ? 'endpoint-proof-unknown' : proof.reason, { proof_status: proof.status, detail: proof.detail ?? proof.reason });
    if (plan.roots.some(row => !row.commands.length)) throw refusal('endpoint-verification-unavailable');
    const inputFile = path.join(owner, '.gsd', 'milestones', milestone, `${milestone}-DELIVERY-INPUT.json`);
    noLinks(inputFile);
    const bytes = require('./forge-autonomy-sources').readBoundedStableFile(inputFile, 1024 * 1024, { expectedReal: fs.realpathSync.native(inputFile) });
    if (bytes.error) throw refusal('endpoint-verification-unavailable', { detail: 'delivery-input-unreadable' });
    let contract;
    try { contract = roots().validateContract(JSON.parse(bytes.buffer.toString('utf8')).execution_contract, { owner, revalidate: true }); }
    catch { throw refusal('endpoint-verification-foreign', { detail: 'execution-contract-invalid' }); }
    if (roots().digest(contract) !== plan.execution_contract_sha256) throw refusal('endpoint-verification-foreign', { detail: 'execution-contract-changed' });
    const timeout = options.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: options.commandTimeoutMs };
    // Owner operation without provider: its duration is milestone consumption up to the endpoint, never worker effort.
    const gate = require('./forge-verify').runRootVerification(contract, { unit: { type: 'milestone', id: milestone }, planFingerprint: plan.plan_fingerprint,
      commandsByRoot: Object.fromEntries(plan.roots.map(row => [row.root_id, [...row.commands]])), ...timeout });
    const written = [];
    const boundary = selection().ownerBoundary(owner, milestone, () => {
      if (readEndpoint({ cwd: owner, milestone }).status !== 'absent') throw refusal('endpoint-already-recorded');
      for (const envelope of gate.roots) {
        const reference = envelopeReference(milestone, envelope.root_id), file = path.join(owner, ...reference.split('/'));
        noLinks(file);
        require('./forge-unit-controller').writeAtomic(file, JSON.stringify(envelope) + '\n', true);
        written.push({ root_id: envelope.root_id, reference, passed: envelope.result.passed === true && !envelope.result.skipped, checks: envelope.result.checks.length });
      }
      return { status: 'written' };
    });
    if (boundary?.status === 'deferred') throw refusal('endpoint-boundary-deferred', { detail: boundary.reason });
    return { status: gate.passed ? 'verified' : 'failed', milestone, envelopes: written };
  } catch (e) { return refused(milestone, e); }
}

// Derives the snapshot sections (endpoint_at, time_state, clock) from the live canonical stores at
// the instant; the trusted publication path compares every record with this, never with a builder value.
function deriveSnapshot(owner, milestone, now) {
  const measured = clock().readClock({ cwd: owner, milestone, now });
  if (measured.status !== 'measured' || measured.frozen) throw refusal('endpoint-clock-unknown', { detail: measured.reason || 'clock-frozen' });
  const admission = require('./forge-milestone-time-admission');
  // The milestone-only canonical status: the snapshot records the milestone horizon alone, never a
  // composed linked task/chain projection.
  const status = admission.readMilestoneTimeStatus(owner, milestone, { now }), summary = admission.summarizeTimeStatus(status);
  if (status.contract !== 'valid' || summary.consumed_ms !== measured.consumption.consumed_ms
      || !SNAPSHOT_TIME_STATES.includes(summary.state)) throw refusal('endpoint-clock-unknown', { detail: 'time-status-unstable' });
  const gaps = measured.gaps.slice(0, MAX_GAPS).map(g => ({ start: g.start, end: g.end, reason: g.reason }));
  return { endpoint_at: new Date(now).toISOString(),
    time_state: { state: summary.state, contract_version: status.contract_version, ceiling_ms: summary.ceiling_ms, consumed_ms: summary.consumed_ms,
      unknown_ms: summary.unknown_ms, remaining_ms: summary.remaining_ms, forecast: summary.forecast, unknown: summary.unknown, decision_pending: summary.decision_pending },
    clock: { consumed_ms: measured.consumption.consumed_ms, unknown_ms: measured.consumption.unknown_ms, by_class: { ...measured.consumption.by_class },
      effort: structuredClone(measured.effort), waits: { ...measured.waits }, gaps, gap_count: measured.gaps.length, gaps_truncated: measured.gaps.length > gaps.length } };
}
// Recomputes the proof and the snapshot of that instant; only a proven result becomes a record.
function buildRecord(owner, milestone, now) {
  const proof = clock().readEndpointProof({ cwd: owner, milestone, now });
  if (proof.status !== 'proven') throw refusal(proof.status === 'unknown' ? 'endpoint-proof-unknown' : proof.reason,
    { proof_status: proof.status, ...(proof.detail ? { detail: proof.detail } : {}), ...(proof.slice ? { slice: proof.slice } : {}), ...(proof.root_id ? { root_id: proof.root_id } : {}) });
  const p = proof.proof, snapshot = deriveSnapshot(owner, milestone, now);
  return { schema_version: ENDPOINT_SCHEMA_VERSION, kind: KIND, milestone, policy: { id: proof.policy.id, version: proof.policy.version },
    endpoint_at: snapshot.endpoint_at, contract: p.contract, completion: p.completion, delivery: p.delivery, selection: p.selection,
    roadmap: p.roadmap, reviews: p.reviews, roots: p.roots, questions: p.questions, time_state: snapshot.time_state, clock: snapshot.clock };
}
// The owner records the endpoint inside ownerBoundary (controller transaction lock, then the
// single canonical owner publication lock of publishAnchoredEndpoint, never nested). The proof,
// question census, contract identity and clock snapshot are rebuilt INSIDE that critical section,
// so a concurrent question or contract change refuses instead of freezing a stale census. A repeat
// returns the existing record and never writes a second endpoint.
function recordEndpoint(options = {}) {
  let milestone = typeof options.milestone === 'string' ? options.milestone : null;
  try {
    milestone = milestoneOf(options);
    const owner = ownerOf(options), now = nowOf(options);
    const existing = readEndpoint({ cwd: owner, milestone });
    if (existing.status === 'valid') return { status: 'unchanged', milestone, sha256: existing.sha256, endpoint_at: existing.record.endpoint_at };
    if (existing.status !== 'absent') throw refusal('endpoint-record-invalid', { detail: existing.reason });
    const pre = clock().readEndpointProof({ cwd: owner, milestone, now });
    if (pre.status !== 'proven') throw refusal(pre.status === 'unknown' ? 'endpoint-proof-unknown' : pre.reason, { proof_status: pre.status, ...(pre.detail ? { detail: pre.detail } : {}) });
    let published = null;
    const boundary = selection().ownerBoundary(owner, milestone, () => {
      published = time().publishAnchoredEndpoint({ cwd: owner, milestone, build: current => {
        const record = buildRecord(owner, milestone, now), checked = validateEndpointRecord(record);
        if (!checked.valid) throw refusal(checked.reason);
        if (record.contract.sha256 !== current.contract_sha256 || record.contract.version !== current.contract_version) throw refusal('endpoint-contract-changed');
        return { record };
      } });
      return { status: 'published' };
    });
    if (boundary?.status === 'deferred') throw refusal('endpoint-boundary-deferred', { detail: boundary.reason });
    const read = readEndpoint({ cwd: owner, milestone });
    if (read.status !== 'valid') throw refusal('endpoint-record-invalid', { detail: read.reason });
    return { status: published?.status === 'published' ? 'recorded' : 'unchanged', milestone, sha256: read.sha256, endpoint_at: read.record.endpoint_at };
  } catch (e) { return refused(milestone, e); }
}

const ACTIONS = Object.freeze({ '--verify': ['verified'], '--prove': ['proven'], '--record': ['recorded', 'unchanged'], '--show': ['valid', 'absent'] });
function message(action, result) {
  if (result.status === 'refused') return 'Operação de endpoint recusada: ' + result.reason + '.';
  if (action === '--verify') return result.status === 'verified' ? 'Verificação nova do endpoint gravada: aprovada em todas as raízes.'
    : 'Verificação nova do endpoint gravada, mas falhou: o endpoint não está comprovado.';
  if (action === '--prove') return result.status === 'proven' ? 'Endpoint integrado comprovado.' : 'Endpoint não comprovado (' + result.status + '): ' + result.reason + '.';
  if (action === '--record') return result.status === 'recorded' ? 'Endpoint registrado de forma imutável em ' + result.endpoint_at + '.'
    : 'Endpoint já registrado em ' + result.endpoint_at + '; nada foi alterado.';
  return result.status === 'valid' ? 'Endpoint registrado em ' + result.record.endpoint_at + '.'
    : result.status === 'absent' ? 'Nenhum endpoint registrado.' : 'Registro de endpoint inválido: ' + result.reason + '.';
}
function main(argv = process.argv.slice(2), io = process) {
  let action = null, json = false;
  const options = {};
  try {
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (Object.hasOwn(ACTIONS, flag)) { if (action) throw refusal('endpoint-usage'); action = flag; }
      else if (flag === '--json') json = true;
      else if (['--cwd', '--milestone', '--timeout-ms'].includes(flag) && typeof argv[i + 1] === 'string' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
        const key = flag.slice(2).replace('-', '_'); if (Object.hasOwn(options, key)) throw refusal('endpoint-usage'); options[key] = argv[++i];
      } else throw refusal('endpoint-usage');
    }
    if (!action || !options.cwd || !options.milestone || options.timeout_ms !== undefined && (action !== '--verify' || !/^[1-9]\d{0,8}$/.test(options.timeout_ms))) throw refusal('endpoint-usage');
  } catch {
    io.stderr.write('Uso: node scripts/forge-milestone-endpoint.js --verify|--prove|--record|--show --cwd <owner> --milestone <M> [--timeout-ms <ms>] [--json]\n');
    return 2;
  }
  const input = { cwd: options.cwd, milestone: options.milestone, ...(options.timeout_ms ? { commandTimeoutMs: Number(options.timeout_ms) } : {}) };
  let result;
  if (action === '--verify') result = writeEndpointVerification(input);
  else if (action === '--record') result = recordEndpoint(input);
  else {
    let owner = null; try { owner = selection().ownerRoot(input); } catch { owner = null; }
    // An unsupported milestone argument is refused by name before any read, like --verify and --record.
    result = publicMilestone(input.milestone) === null ? { status: 'refused', milestone: null, reason: 'endpoint-milestone-invalid' } : !owner ? { status: 'refused', milestone: null, reason: 'endpoint-owner-invalid' }
      : action === '--prove' ? clock().readEndpointProof({ cwd: owner, milestone: input.milestone }) : readEndpoint({ cwd: owner, milestone: input.milestone });
  }
  // Public JSON only: relative references, digests and typed reasons, never an absolute path.
  // The milestone is normalized on every non-null projection and the final object must itself be public.
  const projected = Object.hasOwn(result, 'milestone') ? { ...result, milestone: publicMilestone(result.milestone) } : result;
  const view = time().isPublicData(projected) ? projected : { status: result.status, milestone: publicMilestone(result.milestone),
    reason: typeof result.reason === 'string' && /^[a-z][a-z0-9-]{0,100}$/.test(result.reason) ? result.reason : 'endpoint-output-not-public' };
  io.stdout.write((json ? JSON.stringify(view) : message(action, view)) + '\n');
  return ACTIONS[action].includes(view.status) ? 0 : 3;
}
module.exports = { issueAnchor, issueSnapshotWitness, deriveSnapshot, ENDPOINT_SCHEMA_VERSION, ENDPOINT_RECORD_FIELDS, SELECTION_STATUSES, SNAPSHOT_TIME_STATES, FORECASTS, GAP_REASONS, validateEndpointRecord,
  writeEndpointVerification, recordEndpoint, readEndpoint, main };
if (require.main === module) process.exitCode = main();
