#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const evidence = require('./forge-memory-evidence');
const extraction = require('./forge-memory-extraction');
const memory = require('./forge-memory');
const projection = require('./forge-projection');

const REPO = path.join(__dirname, '..');
const V1_PATH = path.join(REPO, 'shared', 'schemas', 'memory-extraction.schema.json');
const V2_PATH = path.join(REPO, 'shared', 'schemas', 'memory-extraction-v2.schema.json');
const DOC_PATH = path.join(REPO, 'shared', 'forge-memory-evidence.md');
const V1_SHA256 = '81ed10b9e2fab982af5b14f60614b578715899e3a2adf8986448460c7bd8b7a0';
const V1_SCHEMA = JSON.parse(fs.readFileSync(V1_PATH, 'utf8'));
const V2_SCHEMA = JSON.parse(fs.readFileSync(V2_PATH, 'utf8'));
const { REASONS } = evidence;

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

// ── Minimal JSON Schema evaluator for the keywords both memory schemas use ──
function schemaErrors(schema, value, root, at, errors) {
  const out = errors || [];
  const base = root || schema;
  const where = at || '$';
  const isObject = value && typeof value === 'object' && !Array.isArray(value);
  const passes = sub => schemaErrors(sub, value, base, where).length === 0;
  if (schema.$ref) schemaErrors(base.$defs[schema.$ref.replace('#/$defs/', '')], value, base, where, out);
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) out.push(`${where}: const`);
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) out.push(`${where}: enum`);
  const types = { object: isObject, array: Array.isArray(value), string: typeof value === 'string',
    number: typeof value === 'number' && Number.isFinite(value), boolean: typeof value === 'boolean' };
  if (schema.type && !types[schema.type]) out.push(`${where}: type ${schema.type}`);
  if (isObject) {
    for (const key of schema.required || []) if (!(key in value)) out.push(`${where}.${key}: required`);
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (key in value) schemaErrors(sub, value[key], base, `${where}.${key}`, out);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in (schema.properties || {}))) out.push(`${where}.${key}: additional`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${where}: maxItems`);
    if (schema.items) value.forEach((item, index) => schemaErrors(schema.items, item, base, `${where}[${index}]`, out));
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${where}: minLength`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${where}: maxLength`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) out.push(`${where}: pattern`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${where}: minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${where}: maximum`);
  }
  for (const sub of schema.allOf || []) schemaErrors(sub, value, base, where, out);
  if (schema.oneOf && schema.oneOf.filter(passes).length !== 1) out.push(`${where}: oneOf`);
  if (schema.not && passes(schema.not)) out.push(`${where}: not`);
  if (schema.if && passes(schema.if) && schema.then) schemaErrors(schema.then, value, base, where, out);
  return out;
}

// ── Fixtures ────────────────────────────────────────────────────────────────
function v2(overrides) {
  return {
    schema_version: 2, status: 'done', summary: 'evidence', questions: [],
    facts: [{ local_id: 'fresh', category: 'gotcha', text: 'New durable fact.', confidence_base: 0.9 }],
    events: [
      { kind: 'seed', local_event_id: 'e0', local_id: 'fresh' },
      { kind: 'exposure', local_event_id: 'e1', existing_id: 'MEM001', evidence_ref: 'ev1' },
      { kind: 'reobserve', local_event_id: 'e2', existing_id: 'MEM001', evidence_ref: 'ev2' },
      { kind: 'confirm', local_event_id: 'e3', existing_id: 'MEM001', evidence_ref: 'ev3' },
      { kind: 'utility', local_event_id: 'e4', existing_id: 'MEM001', evidence_ref: 'ev4', outcome_ref: 'out1' },
      { kind: 'promote', local_event_id: 'e5', existing_id: 'MEM001', threshold_met: true },
    ],
    ...(overrides || {}),
  };
}

function v1() {
  return { schema_version: 1, status: 'done', summary: 'legacy', questions: [], facts: [],
    events: [{ kind: 'hit', existing_id: 'MEM001' }] };
}

function owner(overrides) {
  const record = (ref, kind, extra) => ({ evidence_ref: ref, observation_id: `obs-${ref}`, source_unit: 'execute-task/T02',
    source_fingerprint: `sha256:${ref}`, observed_kind: kind, ...(extra || {}) });
  return {
    extractionId: 'extract-2', extractedAt: '2026-10-02T00:00:00.000Z', namespace: { milestoneId: 'M001', unitId: 'T01' },
    mappings: { fresh: 'MEM002' },
    evidence: [record('ev1', 'exposure'), record('ev2', 'reobserve'),
      record('ev3', 'confirm', { independent_ref: 'verify:T02:check-7' }), record('ev4', 'utility')],
    outcomes: [{ outcome_ref: 'out1', outcome_id: 'outcome-T02-pass', result_ref: 'result:T02:summary' }],
    ...(overrides || {}),
  };
}

function fact(memId, overrides) {
  return { mem_id: memId, category: 'gotcha', text: `Fact ${memId}.`, confidence_base: 0.8,
    created_at: '2026-10-01T00:00:00.000Z', extraction_id: 'extract-1', source_fingerprint: 'sha256:origin',
    ...(overrides || {}) };
}

function row(kind, localEventId, overrides) {
  const extractionId = (overrides && overrides.extraction_id) || 'extract-2';
  const base = { kind, evidence_version: 2, event_id: `${extractionId}:v2:${localEventId}`, extraction_id: extractionId,
    local_event_id: localEventId, ts: '2026-10-02T00:00:00.000Z', mem_id: 'MEM001' };
  const bound = { evidence_ref: 'ev', observation_id: `obs-${localEventId}`, source_unit: 'execute-task/T02',
    source_fingerprint: 'sha256:other', observed_kind: kind };
  const extra = kind === 'confirm' ? { independent_ref: 'verify:T02:check-7' }
    : kind === 'utility' ? { outcome_ref: 'out1', outcome_id: 'outcome-T02-pass', outcome_result_ref: 'result:T02:summary' } : {};
  return { ...base, ...(evidence.EVIDENCE_KINDS.includes(kind) ? { ...bound, ...extra } : {}), ...(overrides || {}) };
}

function fold(stats, facts, namespace) {
  const ns = namespace || { milestoneId: 'M001', unitId: 'T01' };
  return evidence.foldMemoryEvidence([{ ...ns, facts: facts || [fact('MEM001')], stats }]);
}

function only(result, identity) {
  const entry = result.entries.find(item => item.identity === (identity || 'M001/T01/MEM001'));
  assert(entry, `missing entry ${identity}`);
  return entry;
}

function throwsReason(fn, reason) {
  assert.throws(fn, error => error instanceof evidence.MemoryEvidenceError && error.reason === reason, `expected ${reason}`);
}

function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

// ── Schemas ─────────────────────────────────────────────────────────────────
test('v1 schema bytes are pinned and v1/v2 are closed, distinct contracts', () => {
  assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(V1_PATH)).digest('hex'), V1_SHA256);
  assert.strictEqual(V1_SCHEMA.properties.schema_version.const, 1);
  assert.strictEqual(V2_SCHEMA.properties.schema_version.const, 2);
  assert.notStrictEqual(V1_SCHEMA.$id, V2_SCHEMA.$id);
  assert.deepStrictEqual(schemaErrors(V2_SCHEMA, v2()), []);
  assert.deepStrictEqual(schemaErrors(V1_SCHEMA, v1()), []);
  assert.notDeepStrictEqual(schemaErrors(V1_SCHEMA, v2()), [], 'v1 schema must refuse v2 envelopes');
  assert.notDeepStrictEqual(schemaErrors(V2_SCHEMA, v1()), [], 'v2 schema must refuse v1 envelopes');
  const walk = (node, at) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object' && node.properties && node !== V2_SCHEMA.$defs.target.oneOf[0] && node !== V2_SCHEMA.$defs.target.oneOf[1]) {
      assert.strictEqual(node.additionalProperties, false, `${at} must be closed`);
    }
    Object.entries(node).forEach(([key, child]) => walk(child, `${at}.${key}`));
  };
  walk(V2_SCHEMA, '$');
  for (const key of ['summary', 'questions', 'facts', 'events']) {
    assert.deepStrictEqual(V2_SCHEMA.properties[key], V1_SCHEMA.properties[key], `${key} limits are shared`);
  }
  assert.deepStrictEqual(V2_SCHEMA.$defs.fact, V1_SCHEMA.$defs.fact);
  assert.strictEqual(V2_SCHEMA.properties.events.maxItems, extraction.LIMITS.events);
  const kinds = new Set();
  for (const option of V2_SCHEMA.$defs.event.oneOf) {
    const kind = option.properties.kind;
    (kind.enum || [kind.const]).forEach(item => kinds.add(item));
    assert(option.required.includes('local_event_id'), 'every v2 event carries local_event_id');
    for (const forbidden of ['mem_id', 'path', 'ts', 'source_unit', 'source_fingerprint', 'observation_id', 'extraction_id']) {
      assert(!(forbidden in option.properties), `worker cannot choose ${forbidden}`);
    }
  }
  assert.deepStrictEqual([...kinds].sort(), [...evidence.EVIDENCE_KINDS, ...evidence.CONTROL_KINDS].sort());
});

test('positive and negative v2 fixtures agree between schema and validator', () => {
  const normalized = evidence.validateExtraction(v2());
  assert.strictEqual(normalized.schema_version, 2);
  assert.strictEqual(normalized.events.length, 6);
  assert(Object.isFrozen(normalized.events[0]));
  assert.strictEqual(evidence.validateExtraction(v1()).schema_version, 1, 'v1 still routes to the v1 validator');
  const event = patch => v2({ events: [{ kind: 'exposure', local_event_id: 'e1', existing_id: 'MEM001', evidence_ref: 'ev1', ...patch }] });
  const negatives = [
    [v2({ schema_version: 3 }), REASONS.UNKNOWN_SCHEMA_VERSION],
    [v2({ schema_version: '2' }), REASONS.UNKNOWN_SCHEMA_VERSION],
    [{ ...v1(), events: [{ kind: 'exposure', existing_id: 'MEM001' }] }, REASONS.HYBRID_SHAPE],
    [{ ...v1(), events: [{ kind: 'hit', existing_id: 'MEM001', local_event_id: 'e1' }] }, REASONS.HYBRID_SHAPE],
    [v2({ events: [{ kind: 'hit', local_event_id: 'e1', existing_id: 'MEM001' }] }), REASONS.HYBRID_SHAPE],
    [v2({ events: [{ kind: 'confirm', existing_id: 'MEM001', evidence_ref: 'ev1' }] }), REASONS.HYBRID_SHAPE],
    [v2({ extra: true }), REASONS.INVALID_ENVELOPE],
    [event({ mem_id: 'MEM009' }), REASONS.INVALID_ENVELOPE],
    [event({ ts: '2026-10-02T00:00:00Z' }), REASONS.INVALID_ENVELOPE],
    [event({ evidence_ref: '../etc/passwd' }), REASONS.INVALID_ENVELOPE],
    [event({ existing_id: undefined, local_id: 'fresh' }), REASONS.INVALID_ENVELOPE],
    [event({ kind: 'utility' }), REASONS.INVALID_ENVELOPE],
    [event({ kind: 'rumor' }), REASONS.UNKNOWN_KIND],
    // JSON Schema cannot express local_event_id uniqueness: validator-only.
    [v2({ events: [...v2().events, { kind: 'seed', local_event_id: 'e0', local_id: 'fresh' }] }), REASONS.INVALID_ENVELOPE, false],
    [v2({ status: 'partial' }), REASONS.INVALID_ENVELOPE],
  ];
  negatives.forEach(([fixture, reason, schemaExpressible], index) => {
    const clean = JSON.parse(JSON.stringify(fixture));
    throwsReason(() => evidence.validateExtraction(clean), reason);
    if (schemaExpressible === false) return;
    const knownByVersion = clean.schema_version === 1 ? V1_SCHEMA : V2_SCHEMA;
    assert.notDeepStrictEqual(schemaErrors(knownByVersion, clean), [], `negative #${index} must also fail the schema`);
  });
  assert.throws(() => extraction.validateExtractionResult(v2()), /must equal 1/, 'the v1 validator itself is unchanged');
});

// ── Owner binding ──────────────────────────────────────────────────────────
test('owner binding produces closed v2 rows and refuses insufficient confirm/utility without conversion', () => {
  const validated = evidence.validateExtractionV2(v2());
  const bound = evidence.bindExtractionEvents(validated, owner());
  assert.deepStrictEqual(bound.rejected, []);
  assert.deepStrictEqual(bound.rows.map(item => item.kind), ['seed', 'exposure', 'reobserve', 'confirm', 'utility', 'promote']);
  const confirm = bound.rows.find(item => item.kind === 'confirm');
  assert.strictEqual(confirm.event_id, 'extract-2:v2:e3');
  assert.strictEqual(confirm.independent_ref, 'verify:T02:check-7');
  assert.strictEqual(bound.rows.find(item => item.kind === 'seed').mem_id, 'MEM002');
  assert.strictEqual(bound.rows.find(item => item.kind === 'utility').outcome_id, 'outcome-T02-pass');

  const weak = owner();
  delete weak.evidence[2].independent_ref;
  weak.evidence[0].observed_kind = 'confirm';
  delete weak.evidence[1].observation_id;
  const refused = evidence.bindExtractionEvents(validated, { ...weak, outcomes: [] });
  assert.deepStrictEqual(refused.rejected.map(item => [item.kind, item.reason]), [
    ['exposure', REASONS.BINDING_KIND_MISMATCH],
    ['reobserve', REASONS.OBSERVATION_MISSING],
    ['confirm', REASONS.CONFIRM_BINDING_MISSING],
    ['utility', REASONS.UTILITY_OUTCOME_MISSING],
  ]);
  assert.deepStrictEqual(refused.rows.map(item => item.kind), ['seed', 'promote'], 'no rejected event becomes reobserve');
  const missing = evidence.bindExtractionEvents(validated, owner({ evidence: [] }));
  assert(missing.rejected.every(item => item.reason === REASONS.BINDING_MISSING));
});

test('stored v2 rows are closed: unknown version, hybrids, extra fields and unbounded IDs are refused', () => {
  const cases = [
    [row('confirm', 'a', { evidence_version: 3 }), REASONS.UNKNOWN_EVIDENCE_VERSION],
    [row('hit', 'a'), REASONS.HYBRID_SHAPE],
    [{ kind: 'utility', mem_id: 'MEM001', ts: '2026-10-02T00:00:00.000Z' }, REASONS.HYBRID_SHAPE],
    [row('exposure', 'a', { path: '/etc/passwd' }), REASONS.UNEXPECTED_PROPERTY],
    [row('exposure', 'a', { observation_id: '$(rm -rf /)' }), REASONS.INVALID_IDENTIFIER],
    [row('exposure', 'a', { event_id: 'extract-2:v2:other' }), REASONS.IDENTITY_MISMATCH],
    [row('exposure', 'a', { ts: 'yesterday' }), REASONS.INVALID_TIMESTAMP],
    [row('seed', 'a', { confidence_base: 0.5, hits: 3 }), REASONS.V2_SEED_HITS_FORBIDDEN],
    [row('mystery', 'a'), REASONS.UNKNOWN_KIND],
  ];
  for (const [input, reason] of cases) {
    const normalized = evidence.normalizeEvidenceEvent(input, { namespace: { unitId: 'T01' }, index: 0 });
    assert.strictEqual(normalized.origin, 'invalid', reason);
    assert.strictEqual(normalized.reason, reason);
  }
  const result = fold(cases.map(([input]) => input));
  assert.strictEqual(result.rejected.length, cases.length);
  assert.deepStrictEqual(only(result).legacyProjection.hits, 0, 'refused rows never reinforce');
});

test('legacy invocation-only exposure is closed, bounded, replay-safe and never creates observation or reinforcement', () => {
  const invocation = (id, extra) => ({ kind: 'exposure', evidence_version: 2,
    event_id: `invocation-${id}:v2:exposure`, extraction_id: `invocation-${id}`,
    local_event_id: 'exposure', ts: '2026-10-02T00:00:00.000Z', mem_id: 'MEM001',
    provenance: 'legacy-invocation-only', invocation_id: id, ...(extra || {}) });
  const first = invocation('call-1');
  const normalized = evidence.normalizeEvidenceEvent(first);
  assert.strictEqual(normalized.origin, 'v2');
  assert.strictEqual(normalized.label, 'legacy-invocation-only');
  assert.strictEqual(normalized.observation_id, null);
  assert.strictEqual(normalized.binding, null);
  const result = fold([first, { ...first }, invocation('call-2'), row('exposure', 'x1')]);
  const entry = only(result);
  assert.strictEqual(entry.counters.exposure.count, 3, 'local invocations do not share a null observation key');
  assert.strictEqual(result.replayed.length, 1);
  assert.deepStrictEqual(result.duplicates, []);
  assert.strictEqual(entry.legacyProjection.hits, 0);
  assert.strictEqual(entry.legacyProjection.confidence, 0.8);
  assert.strictEqual(entry.v2.independent_confirmation_count, 0);
  assert.strictEqual(entry.counters.utility.count, 0);
  assert.strictEqual(evidence.normalizeEvidenceEvent(invocation('call-1', { invocation_id: 'x'.repeat(128) })).origin, 'v2');
  const namespaces = evidence.foldMemoryEvidence(['T01', 'T02'].map(unitId => ({
    milestoneId: 'M001', unitId, facts: [fact('MEM001')], stats: [first, { ...first }],
  })));
  assert.deepStrictEqual(namespaces.entries.map(item => item.counters.exposure.count), [1, 1]);
  assert.strictEqual(namespaces.replayed.length, 2, 'event identity deduplicates within each namespace');
  throwsReason(() => fold([first, { ...first, invocation_id: 'other' }]), REASONS.EVENT_ID_CONFLICT);
  for (const extra of [
    { observation_id: 'obs-1' }, { independent_ref: 'verify-1' }, { outcome_id: 'out-1' },
    { outcome_ref: 'out' }, { outcome_result_ref: 'pass' }, { evidence_ref: 'contextDelivery' },
    { source_unit: 'confirmed-delivery' }, { source_fingerprint: 'sha256:fake' },
    { observed_kind: 'exposure' }, { delivery_id: 'dispatch-1' },
    { provenance: 'confirmed-delivery' }, { kind: 'confirm' }, { kind: 'utility' }, { kind: 'reobserve' },
    { invocation_id: '' }, { invocation_id: 'x'.repeat(129) }, { invocation_id: '$(whoami)' },
    { invocation_id: ['call-1'] },
  ]) {
    assert.strictEqual(evidence.normalizeEvidenceEvent(invocation('call-1', extra)).origin, 'invalid', JSON.stringify(extra));
  }
  for (const kind of ['exposure', 'reobserve', 'confirm', 'utility']) {
    assert.strictEqual(evidence.normalizeEvidenceEvent(row(kind, 'missing', { observation_id: undefined })).reason,
      REASONS.OBSERVATION_MISSING, `${kind} still needs its ordinary observation binding`);
  }
});

// ── Four semantics ────────────────────────────────────────────────────────
test('exposure, reobserve, independent confirmation and utility keep separate identities and counters', () => {
  const result = fold([row('exposure', 'x1'), row('reobserve', 'r1'), row('utility', 'u1'), row('confirm', 'c1')]);
  const entry = only(result);
  assert.deepStrictEqual(entry.counters.exposure, { count: 1, last_ts: '2026-10-02T00:00:00.000Z' });
  assert.strictEqual(entry.counters.reobserve.count, 1);
  assert.deepStrictEqual(entry.counters.utility.outcome_ids, ['outcome-T02-pass']);
  assert.strictEqual(entry.counters.independent_confirmation.count, 1);
  assert.strictEqual(entry.v2.independent_confirmation_count, 1);
  assert.strictEqual(entry.legacyProjection.hits, 1, 'only the confirmation reinforces');
  assert.strictEqual(entry.legacyProjection.confidence, 0.8 + 0.02);
  assert.strictEqual(entry.v2.confidence, 0.8 + 0.02);
  assert.strictEqual(entry.legacyPublication.hits, 1);

  const noConfirm = only(fold([row('exposure', 'x1'), row('reobserve', 'r1'), row('utility', 'u1')]));
  assert.strictEqual(noConfirm.legacyProjection.hits, 0);
  assert.strictEqual(noConfirm.legacyProjection.confidence, 0.8);
  assert.strictEqual(noConfirm.legacyProjection.lastAccessTs, '2026-10-01T00:00:00.000Z', 'no reinforcement last access');
  assert.strictEqual(noConfirm.v2.independent_confirmation_count, 0);

  const utilityMissing = fold([row('utility', 'u2', { outcome_id: undefined })]);
  assert.strictEqual(utilityMissing.rejected[0].reason, REASONS.UTILITY_OUTCOME_MISSING);
  assert.strictEqual(only(utilityMissing).counters.utility.count, 0);
});

test('confirmation from the same origin, extraction or a pruned target is not independent', () => {
  const sameSource = fold([row('confirm', 'c1', { source_fingerprint: 'sha256:origin' })]);
  const sameExtraction = fold([row('confirm', 'c1', { extraction_id: 'extract-1', event_id: 'extract-1:v2:c1' })]);
  const pruned = fold([{ kind: 'prune', mem_id: 'MEM001', ts: '2026-10-01T12:00:00.000Z', reason: 'cap' }, row('confirm', 'c1')]);
  assert.strictEqual(sameSource.rejected[0].reason, REASONS.CONFIRM_NOT_INDEPENDENT);
  assert.strictEqual(sameExtraction.rejected[0].reason, REASONS.CONFIRM_NOT_INDEPENDENT);
  assert.strictEqual(pruned.rejected[0].reason, REASONS.TARGET_PRUNED);
  for (const result of [sameSource, sameExtraction, pruned]) assert.strictEqual(only(result).v2.independent_confirmation_count, 0);
  assert.strictEqual(only(pruned).pruned, true, 'pruned targets remain in the full state');
});

// ── Replay and collisions ─────────────────────────────────────────────────
test('identical event_id redelivery is a no-op and a conflicting event_id is an error', () => {
  const confirm = row('confirm', 'c1');
  const replayed = fold([confirm, { ...confirm, evidence_version: '2' }]);
  assert.strictEqual(only(replayed).legacyProjection.hits, 1);
  assert.deepStrictEqual(replayed.replayed, [{ namespace: 'M001/T01', event_id: 'extract-2:v2:c1', reason: REASONS.REPLAYED_DELIVERY }]);
  assert.throws(() => fold([confirm, { ...confirm, independent_ref: 'verify:other' }]),
    error => error.code === 'MEMORY_EVIDENCE_CONFLICT' && error.reason === REASONS.EVENT_ID_CONFLICT);
});

test('the same observation delivered in distinct extractions produces no new reinforcement', () => {
  const first = row('confirm', 'c1', { observation_id: 'obs-shared' });
  const repackaged = row('confirm', 'c9', { extraction_id: 'extract-3', observation_id: 'obs-shared',
    event_id: 'extract-3:v2:c9', evidence_ref: 'other', ts: '2026-10-03T00:00:00.000Z' });
  const result = fold([first, repackaged]);
  assert.strictEqual(only(result).v2.independent_confirmation_count, 1);
  assert.strictEqual(only(result).legacyProjection.hits, 1);
  assert.strictEqual(result.duplicates[0].reason, REASONS.DUPLICATE_OBSERVATION);
  assert.strictEqual(result.duplicates[0].first_event_id, 'extract-2:v2:c1');
  throwsReason(() => fold([first, { ...repackaged, source_fingerprint: 'sha256:elsewhere' }]), REASONS.OBSERVATION_CONFLICT);
  throwsReason(() => fold([first, row('reobserve', 'c9', { extraction_id: 'extract-3', event_id: 'extract-3:v2:c9',
    observation_id: 'obs-shared' })]), REASONS.OBSERVATION_CONFLICT);
});

test('the same MEM in different units or milestones never mixes', () => {
  const shared = row('confirm', 'c1', { observation_id: 'obs-shared' });
  const result = evidence.foldMemoryEvidence([
    { milestoneId: 'M001', unitId: 'T01', facts: [fact('MEM001')], stats: [shared] },
    { milestoneId: 'M001', unitId: 'T02', facts: [fact('MEM001')], stats: [shared] },
    { milestoneId: 'M002', unitId: 'T01', facts: [fact('MEM001')], stats: [] },
    { unitId: 'T01', facts: [fact('MEM001')], stats: [{ kind: 'hit', mem_id: 'MEM001', ts: '2026-10-02T00:00:00.000Z' }] },
  ]);
  assert.deepStrictEqual(result.entries.map(item => item.identity), ['M001/T01/MEM001', 'M001/T02/MEM001', 'M002/T01/MEM001', 'T01/MEM001']);
  assert.deepStrictEqual(result.entries.map(item => item.v2.independent_confirmation_count), [1, 1, 0, 0]);
  assert.deepStrictEqual(result.entries.map(item => item.legacyProjection.hits), [1, 1, 0, 1]);
  assert.deepStrictEqual(result.duplicates, []);
});

// ── Legacy ────────────────────────────────────────────────────────────────
test('historical hit/confirm, seed.hits and promotions stay legacy_ambiguous with their numeric projection', () => {
  const stats = [
    { kind: 'seed', mem_id: 'MEM001', ts: '2026-10-01T00:00:00.000Z', confidence_base: 0.9, hits: 4 },
    { kind: 'hit', mem_id: 'MEM001', ts: '2026-10-01T01:00:00.000Z' },
    { kind: 'confirm', mem_id: 'MEM001', ts: '2026-10-01T02:00:00.000Z' },
    { kind: 'promote', mem_id: 'MEM001', ts: '2026-10-01T03:00:00.000Z', threshold_met: true },
  ];
  const entry = only(fold(stats, [fact('MEM001', { extraction_id: undefined, source_fingerprint: undefined })]));
  assert.strictEqual(entry.origin, 'legacy_unknown', 'absent origin stays unknown, not invented');
  assert.deepStrictEqual(entry.legacy_ambiguous, { label: 'legacy_ambiguous', seed_hits: 4, hit: 1, confirm: 1, promote: 1 });
  assert.strictEqual(entry.legacyProjection.hits, 6);
  assert(Math.abs(entry.legacyProjection.confidence - 0.99) < 1e-12, '0.9 + 0.02 + 0.02 + 0.05 capped at 0.99');
  assert.strictEqual(entry.legacyPublication.hits, 6);
  assert.strictEqual(entry.legacyPublication.promoted, true);
  assert.strictEqual(entry.v2.independent_confirmation_count, 0, 'legacy evidence is never reclassified');
  assert.strictEqual(entry.counters.utility.count, 0);
  assert.strictEqual(entry.v2.promoted, false);
  assert.deepStrictEqual(entry.promotions, [{ ts: '2026-10-01T03:00:00.000Z', origin: 'legacy', basis: 'legacy_ambiguous' }]);
  const unknown = fold([{ kind: 'boost', mem_id: 'MEM001', ts: '2026-10-01T00:00:00.000Z' }]);
  assert.strictEqual(unknown.ignored[0].reason, REASONS.UNKNOWN_LEGACY_KIND);
});

test('legacy views reproduce projectMemoryEntries and publicationState on a temporary root', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-evidence-'));
  try {
    const facts = [fact('MEM001'), fact('MEM002', { confidence_base: 0.6 }), fact('MEM003')];
    const stats = [
      { kind: 'seed', mem_id: 'MEM001', ts: '2026-10-01T00:00:00.000Z', confidence_base: 0.9, hits: 3 },
      { kind: 'hit', mem_id: 'MEM001', ts: '2026-10-01T01:00:00.000Z' },
      { kind: 'confirm', mem_id: 'MEM002', ts: '2026-10-01T01:00:00.000Z' },
      { kind: 'decay', mem_id: 'MEM002', ts: '2026-10-01T02:00:00.000Z', new_confidence: 0.4 },
      { kind: 'hit', mem_id: 'MEM002', ts: '2026-10-01T03:00:00.000Z' },
      { kind: 'promote', mem_id: 'MEM001', ts: '2026-10-01T04:00:00.000Z', threshold_met: true },
      { kind: 'prune', mem_id: 'MEM003', ts: '2026-10-01T05:00:00.000Z', reason: 'cap' },
      row('exposure', 'x1', { mem_id: 'MEM002' }),
      row('confirm', 'c1', { mem_id: 'MEM002' }),
    ];
    memory.writeFragment(cwd, { unit_id: 'T01', milestone_id: 'M001', facts, stats });
    const stored = memory.listFragments(cwd).map(entry => ({
      milestoneId: entry.milestoneId, unitId: entry.unitId,
      ...memory.parseFragment(memory.readFragmentText(cwd, entry)),
    }));
    const folded = evidence.foldMemoryEvidence(stored);
    const projected = projection.projectMemoryEntries(cwd, { nowMs: 0 });
    assert.deepStrictEqual(
      projected.map(item => [item.identity, item.hits, item.confidence, item.promoted, item.promotedAt, item.lastAccessTs]).sort(),
      folded.entries.filter(item => !item.pruned).map(item => [item.identity, item.legacyProjection.hits,
        item.legacyProjection.confidence, item.legacyProjection.promoted, item.legacyProjection.promotedAt,
        item.legacyProjection.lastAccessTs]).sort(),
    );
    const publication = extraction._private.publicationState(stored[0].facts, stored[0].stats);
    for (const entry of folded.entries) {
      const legacy = publication.get(entry.mem_id);
      assert.deepStrictEqual(
        [legacy.hits, legacy.confidence, legacy.pruned, legacy.promoted],
        [entry.legacyPublication.hits, entry.legacyPublication.confidence, entry.legacyPublication.pruned, entry.legacyPublication.promoted],
        entry.identity,
      );
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Order and determinism ─────────────────────────────────────────────────
test('legacy order and multiplicity are preserved and explicit decay is order sensitive', () => {
  const hit = { kind: 'hit', mem_id: 'MEM001', ts: '2026-10-01T01:00:00.000Z' };
  const duplicated = only(fold([hit, { ...hit }]));
  assert.strictEqual(duplicated.legacyProjection.hits, 2, 'stored legacy duplicates stay counted');
  const decay = { kind: 'decay', mem_id: 'MEM001', ts: '2026-10-01T01:00:00.000Z', new_confidence: 0.5 };
  assert.strictEqual(only(fold([hit, decay])).legacyProjection.confidence, 0.5);
  assert.strictEqual(only(fold([decay, hit])).legacyProjection.confidence, 0.5 + 0.02);
  const sameTsConfirm = row('confirm', 'c1', { ts: '2026-10-01T01:00:00.000Z' });
  assert.strictEqual(only(fold([decay, sameTsConfirm])).legacyProjection.confidence, 0.5,
    'a same-ts v2 confirm (precedence 1) is merged before a legacy decay (precedence 2)');
  const sameTsPromote = row('promote', 'p1', { ts: '2026-10-01T01:00:00.000Z', threshold_met: true });
  assert.strictEqual(only(fold([decay, sameTsPromote])).legacyProjection.confidence, 0.5 + 0.05,
    'on equal ts and precedence the legacy row keeps its place first');
  const seed = row('seed', 's1', { ts: '2026-10-01T01:00:00.000Z', confidence_base: 0.7, hits: 0 });
  assert.strictEqual(only(fold([hit, seed])).legacyProjection.hits, 1, 'seed precedence places it before the same-ts hit');
});

test('fold is deterministic for the same legacy sequence and v2 set, and never mutates history', () => {
  const legacy = [
    { kind: 'seed', mem_id: 'MEM001', ts: '2026-10-01T00:00:00.000Z', confidence_base: 0.85, hits: 2 },
    { kind: 'hit', mem_id: 'MEM001', ts: '2026-10-02T00:00:00.000Z' },
  ];
  const v2Rows = [row('confirm', 'c1'), row('exposure', 'x1'), row('utility', 'u1'), row('confirm', 'c2', { observation_id: 'obs-c1' }),
    row('reobserve', 'r1', { ts: '2026-10-01T12:00:00.000Z' })];
  const input = deepFreeze([{ milestoneId: 'M001', unitId: 'T01', facts: [fact('MEM001')], stats: [...legacy, ...v2Rows] }]);
  const before = JSON.stringify(input);
  const first = evidence.foldMemoryEvidence(input);
  const permuted = evidence.foldMemoryEvidence([{ ...input[0], stats: [v2Rows[3], legacy[0], v2Rows[1], v2Rows[4], legacy[1], v2Rows[2], v2Rows[0], v2Rows[0]] }]);
  assert.strictEqual(JSON.stringify(input), before);
  assert.deepStrictEqual(permuted.entries, first.entries);
  assert.deepStrictEqual(permuted.duplicates, first.duplicates);
  assert.strictEqual(first.duplicates.length, 1);
  assert.strictEqual(only(first).v2.independent_confirmation_count, 1);
  assert.strictEqual(only(first).legacyProjection.hits, 4);
});

// ── Purity, CLI and contract document ─────────────────────────────────────
test('the reducer has no I/O, global clock, process execution or ranking', () => {
  const source = fs.readFileSync(path.join(__dirname, 'forge-memory-evidence.js'), 'utf8');
  const library = source.slice(0, source.indexOf('function cliMain('));
  assert(!/require\(['"](?:fs|child_process|path|os)['"]\)/.test(library), 'library must not load I/O modules');
  assert(!/Date\.now|new Date\(|Math\.random|process\.env/.test(library), 'library must not read clocks or ambient state');
  assert(!/\.sort\(\(a, b\) => \{\s*const score/.test(source) && !/max\(1,/.test(library), 'no new ranking');
});

test('CLI detects versions and folds JSON from stdin', () => {
  const script = path.join(__dirname, 'forge-memory-evidence.js');
  const detected = spawnSync(process.execPath, [script, '--detect'], { input: JSON.stringify(v2()), encoding: 'utf8' });
  assert.strictEqual(detected.status, 0, detected.stderr);
  assert.deepStrictEqual(JSON.parse(detected.stdout), { schema_version: 2 });
  const refused = spawnSync(process.execPath, [script, '--detect'], { input: JSON.stringify({ schema_version: 9 }), encoding: 'utf8' });
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr, /unknown-schema-version/);
  const folded = spawnSync(process.execPath, [script, '--fold'], {
    input: JSON.stringify([{ unitId: 'T01', facts: [fact('MEM001')], stats: [row('confirm', 'c1')] }]), encoding: 'utf8' });
  assert.strictEqual(folded.status, 0, folded.stderr);
  assert.strictEqual(JSON.parse(folded.stdout).entries[0].v2.independent_confirmation_count, 1);
  assert.strictEqual(spawnSync(process.execPath, [script, '--bogus'], { encoding: 'utf8' }).status, 2);
});

test('the contract document pins v1 bytes, both schemas, every reason and the inventory', () => {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  assert(doc.includes(V1_SHA256), 'compatibility matrix pins the v1 bytes');
  for (const needle of ['memory-extraction.schema.json', 'memory-extraction-v2.schema.json', 'legacy_ambiguous',
    'evidence_version', 'model_version', 'projectMemoryEntries', 'publicationState', 'forge-unit-sidecar.js',
    'forge-worker-result-contract.js', 'confidence * max(1, hits)']) {
    assert(doc.includes(needle), `document mentions ${needle}`);
  }
  for (const reason of Object.values(REASONS)) assert(doc.includes(`\`${reason}\``), `document lists reason ${reason}`);
  for (const limit of ['256 KiB', 'summary 2000', '8 questions', '50 facts', '200 events']) assert(doc.includes(limit), limit);
});

async function run() {
  console.log('\nforge-memory-evidence tests\n');
  for (const entry of tests) {
    try {
      await entry.fn();
      passed += 1;
      console.log(`  ✓ ${entry.name}`);
    } catch (error) {
      failed += 1;
      console.error(`  ✗ ${entry.name}`);
      console.error(error.stack || error.message);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
