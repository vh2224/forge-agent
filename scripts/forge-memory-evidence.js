#!/usr/bin/env node
'use strict';

// forge-memory-evidence — the single, pure interpretation of memory evidence.
//
// Contract: shared/forge-memory-evidence.md. Schemas: memory-extraction.schema.json
// (v1, frozen) and memory-extraction-v2.schema.json (v2).
//
//   detectExtractionVersion(result)        → 1 | 2 (throws on unknown/hybrid)
//   validateExtraction(result)             → normalized v1 or v2 envelope
//   validateExtractionV2(result)           → normalized v2 envelope
//   bindExtractionEvents(extraction, ctx)  → { rows, rejected } owner-bound stats
//   normalizeEvidenceEvent(row, options)   → legacy | v2 | invalid descriptor
//   foldMemoryEvidence(fragments)          → full state per milestone/unit/mem_id
//
// Library functions do no I/O (only cliMain reads stdin), read no clock and
// rank nothing: evidence IDs and fingerprints are bounded data, never paths
// to read or commands to run. Inputs are never mutated.

const EVIDENCE_MODEL_VERSION = 2;
const SCHEMA_VERSIONS = Object.freeze([1, 2]);
const EVIDENCE_KINDS = Object.freeze(['exposure', 'reobserve', 'confirm', 'utility']);
const CONTROL_KINDS = Object.freeze(['seed', 'supersede', 'prune', 'promote']);
const LEGACY_KINDS = Object.freeze(['seed', 'hit', 'confirm', 'supersede', 'prune', 'promote', 'decay']);
const V2_ONLY_KINDS = new Set(['exposure', 'reobserve', 'utility']);
const V2_KINDS = new Set([...EVIDENCE_KINDS, ...CONTROL_KINDS]);
const LEGACY_KIND_SET = new Set(LEGACY_KINDS);
const V2_EVENT_FIELDS = new Set(['local_event_id', 'evidence_ref', 'outcome_ref']);

// Same-ts precedence mirrors forge-memory.js::mergeStats (unknown kinds sort as 2).
const KIND_PRECEDENCE = Object.freeze({
  seed: 0, exposure: 1, reobserve: 1, hit: 1, confirm: 1, utility: 1,
  promote: 2, decay: 2, prune: 3, supersede: 3,
});
const UNKNOWN_PRECEDENCE = 2;

// Mirrors forge-memory-extraction.js (LOCAL_ID_RE, MEMORY_ID_RE, EXTRACTION_ID_RE).
const LOCAL_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MEMORY_ID_RE = /^MEM\d{3,}$/;
const BOUNDED_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const OWNER_SCALAR_CHARS = 256;

const REASONS = Object.freeze({
  UNKNOWN_SCHEMA_VERSION: 'unknown-schema-version',
  HYBRID_SHAPE: 'hybrid-shape',
  INVALID_ENVELOPE: 'invalid-envelope',
  UNKNOWN_EVIDENCE_VERSION: 'unknown-evidence-version',
  UNKNOWN_KIND: 'unknown-kind',
  UNEXPECTED_PROPERTY: 'unexpected-property',
  INVALID_IDENTIFIER: 'invalid-identifier',
  INVALID_TIMESTAMP: 'invalid-timestamp',
  IDENTITY_MISMATCH: 'identity-mismatch',
  BINDING_MISSING: 'binding-missing',
  BINDING_KIND_MISMATCH: 'binding-kind-mismatch',
  OBSERVATION_MISSING: 'observation-missing',
  CONFIRM_BINDING_MISSING: 'confirm-binding-missing',
  CONFIRM_NOT_INDEPENDENT: 'confirm-not-independent',
  UTILITY_OUTCOME_MISSING: 'utility-outcome-missing',
  V2_SEED_HITS_FORBIDDEN: 'v2-seed-hits-forbidden',
  UNKNOWN_TARGET: 'unknown-target',
  TARGET_PRUNED: 'target-pruned',
  UNKNOWN_LEGACY_KIND: 'unknown-legacy-kind',
  REPLAYED_DELIVERY: 'replayed-delivery',
  DUPLICATE_OBSERVATION: 'duplicate-observation',
  EVENT_ID_CONFLICT: 'event-id-conflict',
  OBSERVATION_CONFLICT: 'observation-conflict',
});

class MemoryEvidenceError extends Error {
  constructor(reason, message) {
    super(`${reason}: ${message}`);
    this.name = 'MemoryEvidenceError';
    this.code = reason === REASONS.EVENT_ID_CONFLICT || reason === REASONS.OBSERVATION_CONFLICT
      ? 'MEMORY_EVIDENCE_CONFLICT'
      : 'MEMORY_EVIDENCE_INVALID';
    this.reason = reason;
  }
}

function fail(reason, message) {
  throw new MemoryEvidenceError(reason, message);
}

// Lazy: forge-memory-extraction may later consume this module; resolving at
// call time keeps the dependency acyclic at load time.
function extractionModule() {
  return require('./forge-memory-extraction');
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function has(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function present(value) {
  return value !== undefined && value !== null && value !== '';
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function finiteNumber(value, fallback) {
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Scalar canonicalization matches forge-memory-extraction.js::sameScalarFields:
// fragments round-trip through YAML scalars, so 2 and "2" are the same value.
function canonicalScalars(value, keys) {
  return (keys || Object.keys(value).sort())
    .map(key => `${key}\x00${present(value[key]) ? String(value[key]) : ''}`)
    .join('\x01');
}

// ── Envelope version detection and v2 validation ────────────────────────────

function eventLooksV2(event) {
  return isPlainObject(event)
    && (V2_ONLY_KINDS.has(event.kind) || Object.keys(event).some(key => V2_EVENT_FIELDS.has(key)));
}

function detectExtractionVersion(result) {
  if (!isPlainObject(result)) fail(REASONS.INVALID_ENVELOPE, 'result must be an object');
  const version = result.schema_version;
  if (!SCHEMA_VERSIONS.includes(version)) {
    fail(REASONS.UNKNOWN_SCHEMA_VERSION, `unsupported schema_version ${JSON.stringify(version)}`);
  }
  const events = Array.isArray(result.events) ? result.events : [];
  events.forEach((event, index) => {
    if (version === 1 && eventLooksV2(event)) {
      fail(REASONS.HYBRID_SHAPE, `result.events[${index}] carries v2 evidence fields in a v1 envelope`);
    }
    if (version === 2 && isPlainObject(event) && (event.kind === 'hit' || !has(event, 'local_event_id'))) {
      fail(REASONS.HYBRID_SHAPE, `result.events[${index}] carries a v1 event shape in a v2 envelope`);
    }
  });
  return version;
}

function envelopeInvalid(location, message) {
  fail(REASONS.INVALID_ENVELOPE, `${location}: ${message}`);
}

function assertKeys(value, required, optional, location) {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) envelopeInvalid(`${location}.${key}`, 'unexpected property');
  }
  for (const key of required) {
    if (!has(value, key)) envelopeInvalid(`${location}.${key}`, 'required property is missing');
  }
}

function assertPattern(value, pattern, location) {
  if (typeof value !== 'string' || !pattern.test(value)) envelopeInvalid(location, `does not match ${pattern}`);
  return value;
}

function assertText(value, location, min, max) {
  if (typeof value !== 'string') envelopeInvalid(location, 'must be a string');
  if (value.length < min) envelopeInvalid(location, `must have at least ${min} characters`);
  if (value.length > max) envelopeInvalid(location, `must have at most ${max} characters`);
  return value;
}

function normalizeV2Event(event, index, localIds) {
  const location = `result.events[${index}]`;
  if (!isPlainObject(event)) envelopeInvalid(location, 'must be an object');
  if (!V2_KINDS.has(event.kind)) fail(REASONS.UNKNOWN_KIND, `${location}.kind ${JSON.stringify(event.kind)} is not a v2 kind`);
  const kind = event.kind;
  const localEventId = assertPattern(event.local_event_id, LOCAL_ID_RE, `${location}.local_event_id`);
  const localRef = (value, field) => {
    assertPattern(value, LOCAL_ID_RE, `${location}.${field}`);
    if (!localIds.has(value)) envelopeInvalid(`${location}.${field}`, 'dangling candidate reference');
    return value;
  };
  const target = () => {
    if (has(event, 'existing_id') === has(event, 'local_id')) {
      envelopeInvalid(location, 'must contain exactly one of existing_id or local_id');
    }
    return has(event, 'existing_id')
      ? { existing_id: assertPattern(event.existing_id, MEMORY_ID_RE, `${location}.existing_id`) }
      : { local_id: localRef(event.local_id, 'local_id') };
  };

  if (kind === 'seed') {
    assertKeys(event, ['kind', 'local_event_id', 'local_id'], [], location);
    return { kind, local_event_id: localEventId, local_id: localRef(event.local_id, 'local_id') };
  }
  if (kind === 'supersede') {
    assertKeys(event, ['kind', 'local_event_id', 'existing_id', 'replacement_local_id'], [], location);
    return {
      kind, local_event_id: localEventId,
      existing_id: assertPattern(event.existing_id, MEMORY_ID_RE, `${location}.existing_id`),
      replacement_local_id: localRef(event.replacement_local_id, 'replacement_local_id'),
    };
  }
  if (kind === 'prune') {
    assertKeys(event, ['kind', 'local_event_id', 'reason'], ['existing_id', 'local_id'], location);
    if (event.reason !== 'cap') envelopeInvalid(`${location}.reason`, 'must equal "cap"');
    return { kind, local_event_id: localEventId, ...target(), reason: 'cap' };
  }
  if (kind === 'promote') {
    assertKeys(event, ['kind', 'local_event_id', 'threshold_met'], ['existing_id', 'local_id'], location);
    if (event.threshold_met !== true) envelopeInvalid(`${location}.threshold_met`, 'must equal true');
    return { kind, local_event_id: localEventId, ...target(), threshold_met: true };
  }
  // Evidence kinds target existing canonical facts only: a candidate created by
  // the same extraction can never be exposed, re-observed or confirmed by it.
  const required = ['kind', 'local_event_id', 'existing_id', 'evidence_ref'];
  if (kind === 'utility') required.push('outcome_ref');
  assertKeys(event, required, [], location);
  return {
    kind,
    local_event_id: localEventId,
    existing_id: assertPattern(event.existing_id, MEMORY_ID_RE, `${location}.existing_id`),
    evidence_ref: assertPattern(event.evidence_ref, LOCAL_ID_RE, `${location}.evidence_ref`),
    ...(kind === 'utility' ? { outcome_ref: assertPattern(event.outcome_ref, LOCAL_ID_RE, `${location}.outcome_ref`) } : {}),
  };
}

function validateExtractionV2(result) {
  if (detectExtractionVersion(result) !== 2) fail(REASONS.UNKNOWN_SCHEMA_VERSION, 'expected schema_version 2');
  const limits = extractionModule().LIMITS;
  let serialized;
  try {
    serialized = JSON.stringify(result);
  } catch (error) {
    envelopeInvalid('result', `must be JSON serializable (${error.message})`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > limits.envelopeBytes) {
    envelopeInvalid('result', `exceeds ${limits.envelopeBytes} UTF-8 bytes`);
  }
  assertKeys(result, ['schema_version', 'status', 'summary', 'questions', 'facts', 'events'], [], 'result');
  if (!['done', 'partial', 'blocked', 'error'].includes(result.status)) {
    envelopeInvalid('result.status', `unsupported status ${JSON.stringify(result.status)}`);
  }
  const summary = assertText(result.summary, 'result.summary', 0, limits.summaryChars);
  if (!Array.isArray(result.questions) || result.questions.length > limits.questions) {
    envelopeInvalid('result.questions', `must be an array of at most ${limits.questions} items`);
  }
  const questions = result.questions.map((question, index) => assertText(
    question, `result.questions[${index}]`, 1, limits.questionChars,
  ));
  if (!Array.isArray(result.facts) || result.facts.length > limits.facts) {
    envelopeInvalid('result.facts', `must be an array of at most ${limits.facts} items`);
  }
  const localIds = new Set();
  const facts = result.facts.map((fact, index) => {
    const location = `result.facts[${index}]`;
    if (!isPlainObject(fact)) envelopeInvalid(location, 'must be an object');
    assertKeys(fact, ['local_id', 'category', 'text', 'confidence_base'], [], location);
    const localId = assertPattern(fact.local_id, LOCAL_ID_RE, `${location}.local_id`);
    if (localIds.has(localId)) envelopeInvalid(`${location}.local_id`, 'duplicate local_id');
    localIds.add(localId);
    if (!['gotcha', 'convention', 'architecture', 'pattern', 'environment', 'preference'].includes(fact.category)) {
      envelopeInvalid(`${location}.category`, `unsupported category ${JSON.stringify(fact.category)}`);
    }
    const confidence = fact.confidence_base;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      envelopeInvalid(`${location}.confidence_base`, 'must be a finite number between 0 and 1');
    }
    return {
      local_id: localId,
      category: fact.category,
      text: assertText(fact.text, `${location}.text`, 1, limits.factTextChars),
      confidence_base: confidence,
    };
  });
  if (!Array.isArray(result.events) || result.events.length > limits.events) {
    envelopeInvalid('result.events', `must be an array of at most ${limits.events} items`);
  }
  const events = result.events.map((event, index) => normalizeV2Event(event, index, localIds));
  const eventIds = new Set();
  events.forEach((event, index) => {
    if (eventIds.has(event.local_event_id)) envelopeInvalid(`result.events[${index}].local_event_id`, 'duplicate local_event_id');
    eventIds.add(event.local_event_id);
  });
  if (result.status !== 'done' && (facts.length > 0 || events.length > 0)) {
    envelopeInvalid('result', `${result.status} results cannot carry publishable facts or events`);
  }
  if (result.status === 'done' && questions.length > 0) {
    envelopeInvalid('result.questions', 'done results cannot carry unresolved questions');
  }
  return deepFreeze({ schema_version: 2, status: result.status, summary, questions, facts, events });
}

function validateExtraction(result, context) {
  const version = detectExtractionVersion(result);
  if (version === 1) return extractionModule().validateExtractionResult(result, context);
  return validateExtractionV2(result);
}

// ── Owner binding: v2 extraction event → canonical stored stat row ──────────

function ownerScalar(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= OWNER_SCALAR_CHARS
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function indexOwnerRecords(records, key) {
  const index = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (isPlainObject(record) && typeof record[key] === 'string') index.set(record[key], record);
  }
  return index;
}

// The owner supplies the evidence/outcome lists; the worker only names local
// refs into them. Insufficient bindings are rejected with a reason, never
// converted into another kind (the producer must propose reobserve instead).
function bindExtractionEvents(extraction, context) {
  const ctx = context || {};
  const rows = [];
  const rejected = [];
  const evidence = indexOwnerRecords(ctx.evidence, 'evidence_ref');
  const outcomes = indexOwnerRecords(ctx.outcomes, 'outcome_ref');
  const mappings = ctx.mappings || {};
  const confidenceByLocal = new Map((extraction.facts || []).map(fact => [fact.local_id, fact.confidence_base]));
  for (const event of extraction.events || []) {
    const base = {
      kind: event.kind,
      evidence_version: EVIDENCE_MODEL_VERSION,
      event_id: `${ctx.extractionId}:v2:${event.local_event_id}`,
      extraction_id: ctx.extractionId,
      local_event_id: event.local_event_id,
      ts: ctx.extractedAt,
    };
    const reject = (reason, detail) => rejected.push({ local_event_id: event.local_event_id, kind: event.kind, reason, detail });
    let row;
    if (event.kind === 'seed') {
      row = { ...base, mem_id: mappings[event.local_id], confidence_base: confidenceByLocal.get(event.local_id), hits: 0 };
    } else if (event.kind === 'supersede') {
      row = { ...base, old_id: event.existing_id, new_id: mappings[event.replacement_local_id] };
    } else if (event.kind === 'prune' || event.kind === 'promote') {
      row = {
        ...base,
        mem_id: event.existing_id || mappings[event.local_id],
        ...(event.kind === 'prune' ? { reason: 'cap' } : { threshold_met: true }),
      };
    } else {
      const record = evidence.get(event.evidence_ref);
      if (!record) {
        reject(REASONS.BINDING_MISSING, `evidence_ref ${event.evidence_ref} is not in the owner evidence list`);
        continue;
      }
      row = {
        ...base,
        mem_id: event.existing_id,
        evidence_ref: event.evidence_ref,
        observation_id: record.observation_id,
        source_unit: record.source_unit,
        source_fingerprint: record.source_fingerprint,
        observed_kind: record.observed_kind,
        ...(event.kind === 'confirm' ? { independent_ref: record.independent_ref } : {}),
      };
      if (event.kind === 'utility') {
        const outcome = outcomes.get(event.outcome_ref);
        if (!outcome) {
          reject(REASONS.UTILITY_OUTCOME_MISSING, `outcome_ref ${event.outcome_ref} is not in the owner outcome list`);
          continue;
        }
        row.outcome_ref = event.outcome_ref;
        row.outcome_id = outcome.outcome_id;
        row.outcome_result_ref = outcome.result_ref;
      }
    }
    const normalized = normalizeEvidenceEvent(row, { namespace: ctx.namespace, index: rows.length });
    if (normalized.origin === 'invalid') {
      reject(normalized.reason, normalized.detail);
      continue;
    }
    rows.push(row);
  }
  return { rows, rejected };
}

// ── Row normalization ────────────────────────────────────────────────────────

function namespaceOf(source) {
  const value = source || {};
  const milestoneId = value.milestoneId || value.milestone_id || null;
  const unitId = String(value.unitId || value.unit_id || '');
  return { milestoneId, unitId, key: milestoneId ? `${milestoneId}/${unitId}` : unitId };
}

const V2_ROW_FIELDS = Object.freeze({
  seed: ['mem_id', 'confidence_base', 'hits'],
  supersede: ['old_id', 'new_id'],
  prune: ['mem_id', 'reason'],
  promote: ['mem_id', 'threshold_met'],
  exposure: ['mem_id', 'evidence_ref', 'observation_id', 'source_unit', 'source_fingerprint', 'observed_kind'],
  reobserve: ['mem_id', 'evidence_ref', 'observation_id', 'source_unit', 'source_fingerprint', 'observed_kind'],
  confirm: ['mem_id', 'evidence_ref', 'observation_id', 'source_unit', 'source_fingerprint', 'observed_kind', 'independent_ref'],
  utility: ['mem_id', 'evidence_ref', 'observation_id', 'source_unit', 'source_fingerprint', 'observed_kind',
    'outcome_ref', 'outcome_id', 'outcome_result_ref'],
});
const V2_COMMON_FIELDS = ['kind', 'evidence_version', 'event_id', 'extraction_id', 'local_event_id', 'ts'];
const BINDING_FIELDS = ['kind', 'observation_id', 'source_unit', 'source_fingerprint', 'independent_ref',
  'outcome_id', 'outcome_result_ref'];

function invalidRow(kind, reason, detail) {
  return { origin: 'invalid', kind, reason, detail };
}

function normalizeEvidenceEvent(row, options) {
  const opts = options || {};
  const namespace = namespaceOf(opts.namespace);
  const index = Number.isInteger(opts.index) ? opts.index : 0;
  if (!isPlainObject(row)) return invalidRow('', REASONS.INVALID_ENVELOPE, 'stat row must be an object');
  const kind = typeof row.kind === 'string' ? row.kind : '';

  if (!present(row.evidence_version)) {
    if (V2_ONLY_KINDS.has(kind)) return invalidRow(kind, REASONS.HYBRID_SHAPE, `${kind} requires evidence_version 2`);
    const target = kind === 'supersede' ? (row.old_id || row.mem_id || '') : (row.mem_id || '');
    return {
      origin: 'legacy',
      kind,
      known: LEGACY_KIND_SET.has(kind),
      label: kind === 'hit' || kind === 'confirm' || kind === 'seed' || kind === 'promote' ? 'legacy_ambiguous' : 'legacy',
      mem_id: String(target),
      ts: present(row.ts) ? String(row.ts) : '',
      // Internal occurrence identity only: never persisted, never independence.
      occurrence_id: `${namespace.key}#${index}`,
      row,
    };
  }

  if (String(row.evidence_version) !== String(EVIDENCE_MODEL_VERSION)) {
    return invalidRow(kind, REASONS.UNKNOWN_EVIDENCE_VERSION, `evidence_version ${JSON.stringify(row.evidence_version)}`);
  }
  if (LEGACY_KIND_SET.has(kind) && !V2_KINDS.has(kind)) {
    return invalidRow(kind, REASONS.HYBRID_SHAPE, `${kind} is a legacy-only kind`);
  }
  if (!V2_KINDS.has(kind)) return invalidRow(kind, REASONS.UNKNOWN_KIND, `unknown v2 kind ${JSON.stringify(kind)}`);
  // Compatibility calls identify only a local invocation, never a delivered
  // context or an observed outcome. Keep this a closed, exposure-only shape.
  const legacyInvocation = kind === 'exposure' && row.provenance === 'legacy-invocation-only';
  const allowed = new Set([...V2_COMMON_FIELDS, ...(legacyInvocation
    ? ['mem_id', 'provenance', 'invocation_id'] : V2_ROW_FIELDS[kind])]);
  const extra = Object.keys(row).filter(key => !allowed.has(key));
  if (extra.length > 0) return invalidRow(kind, REASONS.UNEXPECTED_PROPERTY, `unexpected ${extra.sort().join(', ')}`);

  const ids = [['extraction_id', BOUNDED_ID_RE], ['local_event_id', LOCAL_ID_RE]];
  if (kind === 'supersede') ids.push(['old_id', MEMORY_ID_RE], ['new_id', MEMORY_ID_RE]);
  else ids.push(['mem_id', MEMORY_ID_RE]);
  if (legacyInvocation) ids.push(['invocation_id', BOUNDED_ID_RE]);
  else if (EVIDENCE_KINDS.includes(kind)) ids.push(['evidence_ref', LOCAL_ID_RE], ['source_fingerprint', BOUNDED_ID_RE]);
  for (const [field, pattern] of ids) {
    if (typeof row[field] !== 'string' || !pattern.test(row[field])) {
      return invalidRow(kind, REASONS.INVALID_IDENTIFIER, `${field} is missing or not a bounded identifier`);
    }
  }
  if (row.event_id !== `${row.extraction_id}:v2:${row.local_event_id}`) {
    return invalidRow(kind, REASONS.IDENTITY_MISMATCH, 'event_id must equal extraction_id:v2:local_event_id');
  }
  const ts = String(row.ts || '');
  if (!TS_RE.test(ts) || !Number.isFinite(Date.parse(ts))) {
    return invalidRow(kind, REASONS.INVALID_TIMESTAMP, 'ts must be an owner UTC ISO-8601 timestamp');
  }

  if (kind === 'seed') {
    if (present(row.hits) && Number(row.hits) !== 0) return invalidRow(kind, REASONS.V2_SEED_HITS_FORBIDDEN, 'v2 seeds carry hits: 0');
    const confidence = finiteNumber(row.confidence_base, NaN);
    if (!(confidence >= 0 && confidence <= 1)) return invalidRow(kind, REASONS.INVALID_ENVELOPE, 'confidence_base must be within [0, 1]');
  } else if (kind === 'prune' && row.reason !== 'cap') {
    return invalidRow(kind, REASONS.INVALID_ENVELOPE, 'prune reason must equal "cap"');
  } else if (kind === 'promote' && String(row.threshold_met) !== 'true') {
    return invalidRow(kind, REASONS.INVALID_ENVELOPE, 'promote threshold_met must equal true');
  } else if (EVIDENCE_KINDS.includes(kind) && !legacyInvocation) {
    if (!present(row.observation_id)) return invalidRow(kind, REASONS.OBSERVATION_MISSING, 'owner observation_id is required');
    if (!BOUNDED_ID_RE.test(String(row.observation_id))) {
      return invalidRow(kind, REASONS.INVALID_IDENTIFIER, 'observation_id is not a bounded identifier');
    }
    if (!ownerScalar(row.source_unit)) return invalidRow(kind, REASONS.BINDING_MISSING, 'owner source_unit is required');
    if (row.observed_kind !== kind) {
      return invalidRow(kind, REASONS.BINDING_KIND_MISMATCH, `owner observed ${JSON.stringify(row.observed_kind)}, not ${kind}`);
    }
    if (kind === 'confirm' && !(typeof row.independent_ref === 'string' && BOUNDED_ID_RE.test(row.independent_ref))) {
      return invalidRow(kind, REASONS.CONFIRM_BINDING_MISSING, 'confirm requires an owner-verified independent_ref');
    }
    if (kind === 'utility') {
      const bound = ['outcome_ref', 'outcome_id', 'outcome_result_ref'].every(field => (
        typeof row[field] === 'string' && (field === 'outcome_ref' ? LOCAL_ID_RE : BOUNDED_ID_RE).test(row[field])
      ));
      if (!bound) return invalidRow(kind, REASONS.UTILITY_OUTCOME_MISSING, 'utility requires outcome_id and outcome_result_ref');
    }
  }

  const memId = kind === 'supersede' ? row.old_id : row.mem_id;
  return {
    origin: 'v2',
    kind,
    label: legacyInvocation ? 'legacy-invocation-only' : kind === 'confirm' ? 'independent_confirmation' : kind,
    mem_id: memId,
    ts,
    event_id: row.event_id,
    extraction_id: row.extraction_id,
    observation_id: present(row.observation_id) ? String(row.observation_id) : null,
    payload: canonicalScalars(row),
    binding: EVIDENCE_KINDS.includes(kind) && !legacyInvocation ? canonicalScalars(row, BINDING_FIELDS) : null,
    row,
  };
}

// ── Canonical order ──────────────────────────────────────────────────────────

function precedence(kind) {
  return has(KIND_PRECEDENCE, kind) ? KIND_PRECEDENCE[kind] : UNKNOWN_PRECEDENCE;
}

function compareEvents(left, right) {
  const leftTime = Date.parse(left.ts), rightTime = Date.parse(right.ts);
  // Valid timestamps may use different precision. Keep malformed legacy
  // timestamps on their historical text ordering; never reorder legacy rows.
  const chronological = Number.isFinite(leftTime) && Number.isFinite(rightTime)
    ? leftTime - rightTime : compareText(left.ts, right.ts);
  return chronological || precedence(left.kind) - precedence(right.kind);
}

function compareV2(left, right) {
  return compareEvents(left, right) || compareText(left.event_id, right.event_id);
}

// The legacy subsequence keeps its received order and multiplicity; canonical
// v2 events are merged in front of the first legacy row that sorts after them.
function mergeOrdered(legacy, v2) {
  const merged = [];
  let l = 0;
  let v = 0;
  while (l < legacy.length || v < v2.length) {
    if (v >= v2.length || (l < legacy.length && compareEvents(v2[v], legacy[l]) >= 0)) merged.push(legacy[l++]);
    else merged.push(v2[v++]);
  }
  return merged;
}

// ── Fold ─────────────────────────────────────────────────────────────────────

function counter() {
  return { count: 0, last_ts: null };
}

function createEntry(namespace, memId, fact) {
  const projectionConfidence = finiteNumber(fact.confidence_base, finiteNumber(fact.confidence, 0.5));
  return {
    identity: `${namespace.key}/${memId}`,
    milestoneId: namespace.milestoneId,
    unitId: namespace.unitId,
    mem_id: memId,
    fact,
    origin: present(fact.extraction_id) || present(fact.source_fingerprint) ? 'recorded' : 'legacy_unknown',
    pruned: false,
    superseded: false,
    legacyProjection: {
      hits: 0, confidence: projectionConfidence, lastAccessTs: fact.created_at || null,
      pruned: false, promoted: false, promotedAt: null,
    },
    legacyPublication: {
      hits: 0, confidence: Number(fact.confidence_base ?? fact.confidence ?? 0.5), pruned: false, promoted: false,
    },
    v2: { confidence: projectionConfidence, independent_confirmation_count: 0, promoted: false },
    counters: {
      exposure: counter(),
      reobserve: counter(),
      independent_confirmation: counter(),
      utility: { ...counter(), outcome_ids: [] },
    },
    legacy_ambiguous: { label: 'legacy_ambiguous', seed_hits: 0, hit: 0, confirm: 0, promote: 0 },
    promotions: [],
  };
}

function applySeed(entry, row) {
  const projection = entry.legacyProjection;
  // Retain legacy number/parseInt semantics for every finite value. Overflow,
  // like an unparseable counter, has no usable baseline and falls back to zero.
  projection.hits = finiteNumber(typeof row.hits === 'number' ? row.hits : parseInt(row.hits, 10), 0);
  projection.confidence = finiteNumber(row.confidence_base, finiteNumber(row.confidence, projection.confidence));
  projection.lastAccessTs = row.ts || projection.lastAccessTs;
  const publication = entry.legacyPublication;
  publication.confidence = Number(row.confidence_base ?? row.confidence ?? publication.confidence);
  publication.hits = finiteNumber(Number(row.hits || 0), 0);
  entry.v2.confidence = projection.confidence;
}

function applyReinforcement(entry, ts) {
  const projection = entry.legacyProjection;
  projection.hits += 1;
  projection.lastAccessTs = ts || projection.lastAccessTs;
  projection.confidence = Math.min(0.99, projection.confidence + 0.02);
  entry.legacyPublication.hits += 1;
}

function applyRemoval(entry, kind) {
  entry.pruned = true;
  entry.legacyProjection.pruned = true;
  entry.legacyPublication.pruned = true;
  if (kind === 'supersede') entry.superseded = true;
}

function applyPromotion(entry, ts, origin) {
  const projection = entry.legacyProjection;
  projection.promoted = true;
  projection.promotedAt = ts || null;
  projection.confidence = Math.min(0.99, projection.confidence + 0.05);
  entry.legacyPublication.promoted = true;
  // History only: a legacy promotion is never declared proven by the v2 model.
  entry.promotions.push({ ts: ts || null, origin, basis: origin === 'legacy' ? 'legacy_ambiguous' : 'owner_control' });
  if (origin === 'v2') entry.v2.promoted = true;
}

function applyLegacy(entry, event, report) {
  const row = event.row;
  switch (event.kind) {
    case 'seed':
      applySeed(entry, row);
      entry.legacy_ambiguous.seed_hits = entry.legacyPublication.hits;
      break;
    case 'hit':
    case 'confirm':
      applyReinforcement(entry, row.ts);
      entry.legacy_ambiguous[event.kind] += 1;
      break;
    case 'prune':
    case 'supersede':
      applyRemoval(entry, event.kind);
      break;
    case 'promote':
      applyPromotion(entry, row.ts, 'legacy');
      entry.legacy_ambiguous.promote += 1;
      break;
    case 'decay':
      if (row.new_confidence !== undefined) {
        entry.legacyProjection.confidence = finiteNumber(row.new_confidence, entry.legacyProjection.confidence);
      }
      break;
    default:
      report.ignored.push({ identity: entry.identity, occurrence_id: event.occurrence_id, kind: event.kind, reason: REASONS.UNKNOWN_LEGACY_KIND });
  }
}

function confirmIsIndependent(entry, row) {
  const fact = entry.fact;
  if (present(fact.extraction_id) && String(fact.extraction_id) === row.extraction_id) return false;
  if (present(fact.source_fingerprint)) {
    const origin = String(fact.source_fingerprint);
    if (origin === row.source_fingerprint || origin === row.independent_ref) return false;
  }
  return true;
}

function applyV2(entry, event, state, report) {
  const row = event.row;
  const where = { identity: entry.identity, event_id: event.event_id, kind: event.kind };
  if (CONTROL_KINDS.includes(event.kind)) {
    if (event.kind === 'seed') applySeed(entry, row);
    else if (event.kind === 'promote') applyPromotion(entry, row.ts, 'v2');
    else applyRemoval(entry, event.kind);
    return;
  }
  if (entry.pruned) {
    report.rejected.push({ ...where, reason: REASONS.TARGET_PRUNED });
    return;
  }
  if (event.kind === 'confirm' && !confirmIsIndependent(entry, row)) {
    report.rejected.push({ ...where, reason: REASONS.CONFIRM_NOT_INDEPENDENT });
    return;
  }
  // Invocation-only exposures deduplicate by event identity, not a shared null
  // observation key. There is no observation binding to index here.
  if (event.observation_id !== null) {
    const observationKey = `${entry.identity}\x00${event.observation_id}`;
    const prior = state.observations.get(observationKey);
    if (prior) {
      if (prior.binding !== event.binding) {
        fail(REASONS.OBSERVATION_CONFLICT, `observation ${event.observation_id} on ${entry.identity} is bound inconsistently`);
      }
      report.duplicates.push({ ...where, observation_id: event.observation_id, first_event_id: prior.event_id, reason: REASONS.DUPLICATE_OBSERVATION });
      return;
    }
    state.observations.set(observationKey, event);
  }
  const counters = entry.counters;
  if (event.kind === 'confirm') {
    applyReinforcement(entry, row.ts);
    entry.v2.confidence = Math.min(0.99, entry.v2.confidence + 0.02);
    entry.v2.independent_confirmation_count += 1;
    counters.independent_confirmation.count += 1;
    counters.independent_confirmation.last_ts = row.ts;
    return;
  }
  // exposure / reobserve / utility: own counters and dates only — no hits,
  // confidence, last access or ranking input.
  counters[event.kind].count += 1;
  counters[event.kind].last_ts = row.ts;
  if (event.kind === 'utility' && !counters.utility.outcome_ids.includes(row.outcome_id)) {
    counters.utility.outcome_ids.push(row.outcome_id);
    counters.utility.outcome_ids.sort(compareText);
  }
}

function foldMemoryEvidence(input) {
  const fragments = Array.isArray(input)
    ? input
    : (input && Array.isArray(input.fragments) ? input.fragments : [input || {}]);
  const entries = new Map();
  const namespaces = new Map();
  const report = { rejected: [], ignored: [], replayed: [], duplicates: [] };

  for (const fragment of fragments) {
    const namespace = namespaceOf(fragment);
    if (!namespaces.has(namespace.key)) namespaces.set(namespace.key, { deliveries: new Map(), observations: new Map() });
    const state = namespaces.get(namespace.key);
    // Fragment-local keys, as in forge-projection.js::projectMemoryEntries.
    const local = new Map();
    for (const fact of Array.isArray(fragment.facts) ? fragment.facts : []) {
      const memId = String(fact && fact.mem_id || '');
      if (!memId) continue;
      const identity = `${namespace.key}/${memId}`;
      if (!entries.has(identity)) {
        entries.set(identity, createEntry(namespace, memId, fact));
      } else {
        // publicationState is last-fact-wins; the projection keeps the first.
        const publication = entries.get(identity).legacyPublication;
        publication.confidence = Number(fact.confidence_base ?? fact.confidence ?? 0.5);
      }
      local.set(memId, entries.get(identity));
    }

    const legacy = [];
    const v2 = [];
    (Array.isArray(fragment.stats) ? fragment.stats : []).forEach((row, index) => {
      const event = normalizeEvidenceEvent(row, { namespace, index });
      if (event.origin === 'invalid') {
        report.rejected.push({ namespace: namespace.key, index, kind: event.kind, reason: event.reason, detail: event.detail });
      } else if (event.origin === 'legacy') {
        legacy.push(event);
      } else {
        const prior = state.deliveries.get(event.event_id);
        if (prior) {
          if (prior.payload !== event.payload) fail(REASONS.EVENT_ID_CONFLICT, `event_id ${event.event_id} has conflicting content`);
          report.replayed.push({ namespace: namespace.key, event_id: event.event_id, reason: REASONS.REPLAYED_DELIVERY });
        } else {
          state.deliveries.set(event.event_id, event);
          v2.push(event);
        }
      }
    });
    v2.sort(compareV2);

    for (const event of mergeOrdered(legacy, v2)) {
      const entry = local.get(event.mem_id);
      if (!entry) {
        const item = { namespace: namespace.key, kind: event.kind, mem_id: event.mem_id, reason: REASONS.UNKNOWN_TARGET };
        if (event.origin === 'legacy') report.ignored.push({ ...item, occurrence_id: event.occurrence_id });
        else report.rejected.push({ ...item, event_id: event.event_id });
        continue;
      }
      if (event.origin === 'legacy') applyLegacy(entry, event, report);
      else applyV2(entry, event, state, report);
    }
  }

  // Replays depend only on the v2 set, not on where the copies were received.
  report.replayed.sort((left, right) => compareText(left.namespace, right.namespace)
    || compareText(left.event_id, right.event_id));
  return {
    model_version: EVIDENCE_MODEL_VERSION,
    entries: Array.from(entries.values()),
    ...report,
  };
}

module.exports = {
  EVIDENCE_MODEL_VERSION,
  SCHEMA_VERSIONS,
  EVIDENCE_KINDS,
  CONTROL_KINDS,
  LEGACY_KINDS,
  KIND_PRECEDENCE,
  REASONS,
  MemoryEvidenceError,
  detectExtractionVersion,
  validateExtraction,
  validateExtractionV2,
  bindExtractionEvents,
  normalizeEvidenceEvent,
  foldMemoryEvidence,
  _private: { mergeOrdered, compareV2, canonicalScalars, namespaceOf },
};

// ── CLI: JSON on stdin → JSON on stdout. The only I/O lives here. ───────────
function cliMain(argv) {
  const mode = argv[2];
  const modes = {
    '--detect': value => ({ schema_version: detectExtractionVersion(value) }),
    '--validate': value => validateExtraction(value),
    '--fold': value => foldMemoryEvidence(value),
  };
  if (!has(modes, mode) || argv.length > 3) {
    throw Object.assign(new Error('Usage: forge-memory-evidence.js --detect | --validate | --fold  (JSON on stdin)'), { exitCode: 2 });
  }
  const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  process.stdout.write(`${JSON.stringify(modes[mode](input))}\n`);
}

if (require.main === module) {
  try {
    cliMain(process.argv);
  } catch (error) {
    process.stderr.write(`${error.code || 'MEMORY_EVIDENCE_ERROR'}: ${error.message}\n`);
    process.exit(error.exitCode || 1);
  }
}
