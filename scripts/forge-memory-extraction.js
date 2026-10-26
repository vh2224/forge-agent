#!/usr/bin/env node
'use strict';

// Owner-side decoder and publisher for memory extractions.
//
//   validateExtractionResult(result, ctx)  v1 by default; ctx.schemaVersions
//                                          selects v1 and/or v2 explicitly
//   normalizeEvidenceRegistry(raw, source) owner evidence/outcome snapshot + digest
//   publishExtraction({ cwd, extraction, sourceContext })
//
// Every publication decision reads forge-memory-evidence::foldMemoryEvidence,
// the same reducer forge-projection uses. v1 keeps its historical identities
// (seed / event:index / cap) and promotion rule; v2 rows use
// extractionId:v2:local_event_id and new promotions require owner-bound
// independent confirmations. Evidence IDs are bounded data, never paths.

const crypto = require('crypto');
const fs = require('fs');
const memory = require('./forge-memory');
const evidence = require('./forge-memory-evidence');

const LIMITS = Object.freeze({
  envelopeBytes: 256 * 1024,
  summaryChars: 2000,
  questions: 8,
  questionChars: 500,
  facts: 50,
  events: 200,
  localIdChars: 64,
  factTextChars: 4000,
  ownerScalarChars: 256,
});

const CATEGORIES = new Set([
  'gotcha',
  'convention',
  'architecture',
  'pattern',
  'environment',
  'preference',
]);
const STATUSES = new Set(['done', 'partial', 'blocked', 'error']);
const EVENT_KINDS = new Set(['seed', 'hit', 'confirm', 'supersede', 'prune', 'promote']);
const LOCAL_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MEMORY_ID_RE = /^MEM\d{3,}$/;
const EXTRACTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SCHEMA_VERSIONS = Object.freeze([1, 2]);
const EVIDENCE_CONTRACT_VERSION = 2;
const REGISTRY_LIMITS = Object.freeze({ records: 64, outcomes: 32 });
const PROMOTION = Object.freeze({ confidence: 0.85, legacyHits: 3, independentConfirmations: 3 });

class MemoryExtractionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MemoryExtractionError';
    this.code = 'MEMORY_EXTRACTION_INVALID';
  }
}

class MemoryPublicationConflict extends Error {
  constructor(message, reasonCode) {
    super(message);
    this.name = 'MemoryPublicationConflict';
    this.code = 'MEMORY_PUBLICATION_CONFLICT';
    this.reasonCode = reasonCode || 'publication-conflict';
  }
}

class MemoryEvidenceRegistryError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'MemoryEvidenceRegistryError';
    this.code = 'MEMORY_EVIDENCE_REGISTRY_INVALID';
    this.reason = reason;
  }
}

function invalid(location, message) {
  throw new MemoryExtractionError(`${location}: ${message}`);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value, location) {
  if (!isPlainObject(value)) invalid(location, 'must be an object');
}

function assertKeys(value, required, optional, location) {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${location}.${key}`, 'unexpected property');
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      invalid(`${location}.${key}`, 'required property is missing');
    }
  }
}

function assertString(value, location, options) {
  const opts = options || {};
  if (typeof value !== 'string') invalid(location, 'must be a string');
  if (opts.min !== undefined && value.length < opts.min) invalid(location, `must have at least ${opts.min} characters`);
  if (opts.max !== undefined && value.length > opts.max) invalid(location, `must have at most ${opts.max} characters`);
  if (opts.pattern && !opts.pattern.test(value)) invalid(location, `does not match ${opts.pattern}`);
  return value;
}

function assertFiniteNumber(value, location, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(location, 'must be a finite number');
  if (value < min || value > max) invalid(location, `must be between ${min} and ${max}`);
  return value;
}

function normalizeRef(event, location) {
  const hasExisting = Object.prototype.hasOwnProperty.call(event, 'existing_id');
  const hasLocal = Object.prototype.hasOwnProperty.call(event, 'local_id');
  if (hasExisting === hasLocal) invalid(location, 'must contain exactly one of existing_id or local_id');
  if (hasExisting) {
    return { existing_id: assertString(event.existing_id, `${location}.existing_id`, { pattern: MEMORY_ID_RE }) };
  }
  return { local_id: assertString(event.local_id, `${location}.local_id`, { pattern: LOCAL_ID_RE }) };
}

function normalizeEvent(event, index, localIds) {
  const location = `result.events[${index}]`;
  assertObject(event, location);
  assertString(event.kind, `${location}.kind`, { min: 1, max: 32 });
  if (!EVENT_KINDS.has(event.kind)) invalid(`${location}.kind`, `unknown event kind ${JSON.stringify(event.kind)}`);

  if (event.kind === 'seed') {
    assertKeys(event, ['kind', 'local_id'], [], location);
    const localId = assertString(event.local_id, `${location}.local_id`, { pattern: LOCAL_ID_RE });
    if (!localIds.has(localId)) invalid(`${location}.local_id`, 'dangling candidate reference');
    return { kind: 'seed', local_id: localId };
  }

  if (event.kind === 'supersede') {
    assertKeys(event, ['kind', 'existing_id', 'replacement_local_id'], [], location);
    const existingId = assertString(event.existing_id, `${location}.existing_id`, { pattern: MEMORY_ID_RE });
    const replacement = assertString(event.replacement_local_id, `${location}.replacement_local_id`, { pattern: LOCAL_ID_RE });
    if (!localIds.has(replacement)) invalid(`${location}.replacement_local_id`, 'dangling candidate reference');
    return { kind: 'supersede', existing_id: existingId, replacement_local_id: replacement };
  }

  const optional = event.kind === 'prune'
    ? ['existing_id', 'local_id', 'reason']
    : event.kind === 'promote'
      ? ['existing_id', 'local_id', 'threshold_met']
      : ['existing_id', 'local_id'];
  assertKeys(event, ['kind'], optional, location);
  const ref = normalizeRef(event, location);
  if (ref.local_id && !localIds.has(ref.local_id)) invalid(`${location}.local_id`, 'dangling candidate reference');
  if (event.kind === 'prune' && event.reason !== 'cap') invalid(`${location}.reason`, 'must equal "cap"');
  if (event.kind === 'promote' && event.threshold_met !== true) invalid(`${location}.threshold_met`, 'must equal true');
  return {
    kind: event.kind,
    ...ref,
    ...(event.kind === 'prune' ? { reason: 'cap' } : {}),
    ...(event.kind === 'promote' ? { threshold_met: true } : {}),
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateExtractionV1(result, context) {
  void context;
  assertObject(result, 'result');
  let serialized;
  try {
    serialized = JSON.stringify(result);
  } catch (error) {
    invalid('result', `must be JSON serializable (${error.message})`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > LIMITS.envelopeBytes) {
    invalid('result', `exceeds ${LIMITS.envelopeBytes} UTF-8 bytes`);
  }
  assertKeys(result, ['schema_version', 'status', 'summary', 'questions', 'facts', 'events'], [], 'result');
  if (result.schema_version !== 1) invalid('result.schema_version', 'must equal 1');
  if (!STATUSES.has(result.status)) invalid('result.status', `unsupported status ${JSON.stringify(result.status)}`);
  const summary = assertString(result.summary, 'result.summary', { max: LIMITS.summaryChars });

  if (!Array.isArray(result.questions)) invalid('result.questions', 'must be an array');
  if (result.questions.length > LIMITS.questions) invalid('result.questions', `must contain at most ${LIMITS.questions} items`);
  const questions = result.questions.map((question, index) => assertString(
    question,
    `result.questions[${index}]`,
    { min: 1, max: LIMITS.questionChars },
  ));

  if (!Array.isArray(result.facts)) invalid('result.facts', 'must be an array');
  if (result.facts.length > LIMITS.facts) invalid('result.facts', `must contain at most ${LIMITS.facts} items`);
  const localIds = new Set();
  const facts = result.facts.map((fact, index) => {
    const location = `result.facts[${index}]`;
    assertObject(fact, location);
    assertKeys(fact, ['local_id', 'category', 'text', 'confidence_base'], [], location);
    const localId = assertString(fact.local_id, `${location}.local_id`, { pattern: LOCAL_ID_RE });
    if (localIds.has(localId)) invalid(`${location}.local_id`, 'duplicate local_id');
    localIds.add(localId);
    if (!CATEGORIES.has(fact.category)) invalid(`${location}.category`, `unsupported category ${JSON.stringify(fact.category)}`);
    return {
      local_id: localId,
      category: fact.category,
      text: assertString(fact.text, `${location}.text`, { min: 1, max: LIMITS.factTextChars }),
      confidence_base: assertFiniteNumber(fact.confidence_base, `${location}.confidence_base`, 0, 1),
    };
  });

  if (!Array.isArray(result.events)) invalid('result.events', 'must be an array');
  if (result.events.length > LIMITS.events) invalid('result.events', `must contain at most ${LIMITS.events} items`);
  const events = result.events.map((event, index) => normalizeEvent(event, index, localIds));
  const eventSet = new Set();
  for (let index = 0; index < events.length; index += 1) {
    const identity = JSON.stringify(events[index]);
    if (eventSet.has(identity)) invalid(`result.events[${index}]`, 'duplicate event');
    eventSet.add(identity);
  }

  if (result.status !== 'done' && (facts.length > 0 || events.length > 0)) {
    invalid('result', `${result.status} results cannot carry publishable facts or events`);
  }
  if (result.status === 'done' && questions.length > 0) {
    invalid('result.questions', 'done results cannot carry unresolved questions');
  }
  return deepFreeze({ schema_version: 1, status: result.status, summary, questions, facts, events });
}

// Without an explicit selection the historical v1 contract applies unchanged
// (a v2 envelope is refused with "must equal 1"). Callers that decode v2 name
// the accepted versions; anything else is refused, never guessed.
function selectedSchemaVersions(context) {
  const ctx = isPlainObject(context) ? context : {};
  const explicit = ctx.schemaVersions !== undefined ? ctx.schemaVersions
    : ctx.schemaVersion !== undefined ? [ctx.schemaVersion] : null;
  if (explicit === null) return [1];
  if (!Array.isArray(explicit) || explicit.length === 0 || explicit.some(version => !SCHEMA_VERSIONS.includes(version))) {
    throw new TypeError(`schemaVersions must select from ${SCHEMA_VERSIONS.join(', ')}`);
  }
  return Array.from(new Set(explicit));
}

function rethrowEvidence(error) {
  if (error instanceof evidence.MemoryEvidenceError) {
    const wrapped = new MemoryExtractionError(error.message);
    wrapped.reason = error.reason;
    throw wrapped;
  }
  throw error;
}

function assertRegistryShape(registry) {
  if (!isPlainObject(registry) || !Array.isArray(registry.records) || !Array.isArray(registry.outcomes)) {
    throw new TypeError('evidence registry must be a normalized { records, outcomes } snapshot');
  }
}

// Publisher guards the closed v2 schema cannot express: one seed per
// candidate, and (when the owner registry is known) references only into it.
function assertV2References(extraction, registry) {
  const seeded = new Set();
  extraction.events.forEach((event, index) => {
    if (event.kind !== 'seed') return;
    if (seeded.has(event.local_id)) invalid(`result.events[${index}].local_id`, 'duplicate seed for candidate');
    seeded.add(event.local_id);
  });
  if (registry === undefined || registry === null) return;
  assertRegistryShape(registry);
  const records = new Map(registry.records.map(record => [record.evidence_ref, record]));
  const outcomes = new Set(registry.outcomes.map(outcome => outcome.outcome_ref));
  extraction.events.forEach((event, index) => {
    if (!evidence.EVIDENCE_KINDS.includes(event.kind)) return;
    const record = records.get(event.evidence_ref);
    if (!record) invalid(`result.events[${index}].evidence_ref`, 'is not an owner-supplied evidence reference');
    if (record.observed_kind !== event.kind) {
      invalid(`result.events[${index}].evidence_ref`, `owner observed ${record.observed_kind}, not ${event.kind}`);
    }
    if (event.kind === 'utility' && !outcomes.has(event.outcome_ref)) {
      invalid(`result.events[${index}].outcome_ref`, 'is not an owner-supplied outcome reference');
    }
  });
}

function validateExtractionResult(result, context) {
  const versions = selectedSchemaVersions(context);
  if (versions.length === 1 && versions[0] === 1) return validateExtractionV1(result, context);
  assertObject(result, 'result');
  let version;
  try {
    version = evidence.detectExtractionVersion(result);
  } catch (error) {
    rethrowEvidence(error);
  }
  if (!versions.includes(version)) {
    invalid('result.schema_version', `schema_version ${version} is not selected (${versions.join(', ')})`);
  }
  if (version === 1) return validateExtractionV1(result, context);
  let validated;
  try {
    validated = evidence.validateExtractionV2(result);
  } catch (error) {
    rethrowEvidence(error);
  }
  assertV2References(validated, context.evidence);
  return validated;
}

// ── Owner evidence registry ───────────────────────────────────────────────────
// Built by the owner from structured sources only (never from narrative text or
// worker output). Every record is bound to the request source; the worker can
// only name its evidence_ref/outcome_ref. The digest binds the snapshot that a
// receipt persists and replays.

function evidenceSourceFingerprint(value) {
  const text = String(value === undefined || value === null ? '' : value);
  return EXTRACTION_ID_RE.test(text) ? text : `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

function registryInvalid(reason, location, message) {
  throw new MemoryEvidenceRegistryError(reason, `${location}: ${message}`);
}

function registryId(value, pattern, location) {
  if (typeof value !== 'string' || !pattern.test(value)) registryInvalid('invalid-identifier', location, 'is not a bounded identifier');
  return value;
}

function registryKeys(value, required, optional, location) {
  if (!isPlainObject(value)) registryInvalid('invalid-registry', location, 'must be an object');
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some(key => !allowed.has(key))) registryInvalid('unexpected-property', location, 'has an unexpected property');
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) registryInvalid('binding-missing', `${location}.${key}`, 'is required');
  }
}

function byKey(key) {
  return (left, right) => (left[key] < right[key] ? -1 : left[key] > right[key] ? 1 : 0);
}

function normalizeEvidenceRegistry(registry, source) {
  if (!isPlainObject(source)) throw new TypeError('evidence source must be an object');
  const sourceUnit = ownerScalar(source.sourceUnit, 'evidence source unit', true);
  const sourceFingerprint = evidenceSourceFingerprint(ownerScalar(source.sourceFingerprint, 'evidence source fingerprint', true));
  registryKeys(registry, ['records', 'outcomes'], ['contract_version', 'digest'], 'evidence');
  if (registry.contract_version !== undefined && registry.contract_version !== EVIDENCE_CONTRACT_VERSION) {
    registryInvalid('unknown-contract-version', 'evidence.contract_version', 'is not supported');
  }
  if (!Array.isArray(registry.records) || registry.records.length > REGISTRY_LIMITS.records) {
    registryInvalid('limit', 'evidence.records', `must be an array of at most ${REGISTRY_LIMITS.records} items`);
  }
  if (!Array.isArray(registry.outcomes) || registry.outcomes.length > REGISTRY_LIMITS.outcomes) {
    registryInvalid('limit', 'evidence.outcomes', `must be an array of at most ${REGISTRY_LIMITS.outcomes} items`);
  }
  const refs = new Set();
  const observations = new Set();
  const records = registry.records.map((record, index) => {
    const at = `evidence.records[${index}]`;
    const confirm = isPlainObject(record) && record.observed_kind === 'confirm';
    registryKeys(record, ['evidence_ref', 'observation_id', 'source_unit', 'source_fingerprint', 'observed_kind'],
      confirm ? ['independent_ref'] : [], at);
    if (!evidence.EVIDENCE_KINDS.includes(record.observed_kind)) registryInvalid('unknown-kind', `${at}.observed_kind`, 'is not an evidence kind');
    const ref = registryId(record.evidence_ref, LOCAL_ID_RE, `${at}.evidence_ref`);
    if (refs.has(ref)) registryInvalid('duplicate-reference', `${at}.evidence_ref`, 'is duplicated');
    refs.add(ref);
    const observation = registryId(record.observation_id, EXTRACTION_ID_RE, `${at}.observation_id`);
    if (observations.has(observation)) registryInvalid('duplicate-observation', `${at}.observation_id`, 'is duplicated');
    observations.add(observation);
    if (record.source_unit !== sourceUnit || record.source_fingerprint !== sourceFingerprint) {
      registryInvalid('evidence-source-mismatch', at, 'is not bound to the request source');
    }
    const normalized = { evidence_ref: ref, observation_id: observation, source_unit: sourceUnit,
      source_fingerprint: sourceFingerprint, observed_kind: record.observed_kind };
    if (confirm) {
      // Independence is never inferred: an unverified confirmation is not offered.
      if (!Object.prototype.hasOwnProperty.call(record, 'independent_ref')) {
        registryInvalid(evidence.REASONS.CONFIRM_BINDING_MISSING, `${at}.independent_ref`, 'is required for confirm');
      }
      normalized.independent_ref = registryId(record.independent_ref, EXTRACTION_ID_RE, `${at}.independent_ref`);
    }
    return normalized;
  });
  const outcomeRefs = new Set();
  const outcomes = registry.outcomes.map((outcome, index) => {
    const at = `evidence.outcomes[${index}]`;
    registryKeys(outcome, ['outcome_ref', 'outcome_id', 'result_ref'], [], at);
    const ref = registryId(outcome.outcome_ref, LOCAL_ID_RE, `${at}.outcome_ref`);
    if (outcomeRefs.has(ref)) registryInvalid('duplicate-reference', `${at}.outcome_ref`, 'is duplicated');
    outcomeRefs.add(ref);
    return { outcome_ref: ref, outcome_id: registryId(outcome.outcome_id, EXTRACTION_ID_RE, `${at}.outcome_id`),
      result_ref: registryId(outcome.result_ref, EXTRACTION_ID_RE, `${at}.result_ref`) };
  });
  records.sort(byKey('evidence_ref'));
  outcomes.sort(byKey('outcome_ref'));
  const body = { contract_version: EVIDENCE_CONTRACT_VERSION, records, outcomes };
  const digest = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  if (registry.digest !== undefined && registry.digest !== digest) {
    registryInvalid('evidence-digest-mismatch', 'evidence.digest', 'does not match the normalized registry');
  }
  return deepFreeze({ ...body, digest });
}

// Publication accepts only a digest-bound snapshot; any refusal is a conflict
// decided before the transaction, so nothing is written.
function verifyEvidenceRegistry(raw, source) {
  if (!isPlainObject(raw) || typeof raw.digest !== 'string') {
    throw new MemoryPublicationConflict('evidence registry digest is missing', 'evidence-registry-refused');
  }
  try {
    return normalizeEvidenceRegistry(raw, source);
  } catch (error) {
    if (error instanceof MemoryEvidenceRegistryError) {
      throw new MemoryPublicationConflict(`evidence registry refused (${error.reason})`, 'evidence-registry-refused');
    }
    throw error;
  }
}

function ownerScalar(value, location, required) {
  if ((value === undefined || value === null) && !required) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > LIMITS.ownerScalarChars) {
    throw new TypeError(`${location} must be a non-empty string of at most ${LIMITS.ownerScalarChars} characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`${location} must not contain control characters`);
  return value;
}

function validateSourceContext(sourceContext) {
  if (!isPlainObject(sourceContext)) throw new TypeError('sourceContext must be an object');
  assertKeys(sourceContext, ['unitId', 'extractionId', 'extractedAt', 'source'], ['milestoneId', 'evidence'], 'sourceContext');
  if (sourceContext.evidence !== undefined && !isPlainObject(sourceContext.evidence)) {
    throw new TypeError('sourceContext.evidence must be an owner evidence registry object');
  }
  if (!memory.validateUnitId(sourceContext.unitId)) throw new TypeError(`Invalid memory unit ID: ${sourceContext.unitId}`);
  if (sourceContext.milestoneId && !memory.validateMilestoneId(sourceContext.milestoneId)) {
    throw new TypeError(`Invalid memory milestone ID: ${sourceContext.milestoneId}`);
  }
  const extractionId = ownerScalar(sourceContext.extractionId, 'sourceContext.extractionId', true);
  if (!EXTRACTION_ID_RE.test(extractionId)) throw new TypeError('sourceContext.extractionId has an invalid format');
  const extractedAt = ownerScalar(sourceContext.extractedAt, 'sourceContext.extractedAt', true);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(extractedAt) || !Number.isFinite(Date.parse(extractedAt))) {
    throw new TypeError('sourceContext.extractedAt must be a valid UTC ISO-8601 timestamp');
  }
  assertObject(sourceContext.source, 'sourceContext.source');
  assertKeys(
    sourceContext.source,
    ['sourceFingerprint'],
    ['sourceUnit', 'dispatchId', 'model', 'effort'],
    'sourceContext.source',
  );
  return {
    unitId: sourceContext.unitId,
    milestoneId: sourceContext.milestoneId || null,
    extractionId,
    extractedAt,
    source: {
      sourceUnit: ownerScalar(sourceContext.source.sourceUnit, 'sourceContext.source.sourceUnit', false) || sourceContext.unitId,
      sourceFingerprint: ownerScalar(sourceContext.source.sourceFingerprint, 'sourceContext.source.sourceFingerprint', true),
      dispatchId: ownerScalar(sourceContext.source.dispatchId, 'sourceContext.source.dispatchId', false),
      model: ownerScalar(sourceContext.source.model, 'sourceContext.source.model', false),
      effort: ownerScalar(sourceContext.source.effort, 'sourceContext.source.effort', false),
    },
    evidence: sourceContext.evidence === undefined ? null : sourceContext.evidence,
  };
}

function canonicalIdNumbers(fragment) {
  const values = [];
  for (const fact of fragment.facts || []) values.push(fact.mem_id);
  for (const stat of fragment.stats || []) values.push(stat.mem_id, stat.old_id, stat.new_id);
  return values
    .map(value => /^MEM(\d+)$/.exec(String(value || '')))
    .filter(Boolean)
    .map(match => Number(match[1]));
}

function sameScalarFields(actual, expected, fields) {
  return fields.every(field => String(actual[field] === undefined || actual[field] === null ? '' : actual[field])
    === String(expected[field] === undefined || expected[field] === null ? '' : expected[field]));
}

// One fold over the fragment, shared with forge-projection. The cap boundary and
// the historical promotion rule read the legacyPublication view (so a v1
// continuation never picks a different cap victim); the v2 rule reads `v2`.
function foldPublication(facts, stats, namespace) {
  let folded;
  try {
    folded = evidence.foldMemoryEvidence([{ ...(namespace || {}), facts, stats }]);
  } catch (error) {
    if (error instanceof evidence.MemoryEvidenceError) {
      throw new MemoryPublicationConflict(`memory evidence conflict (${error.reason})`, 'evidence-reducer-conflict');
    }
    throw error;
  }
  const state = new Map();
  for (const entry of folded.entries) {
    const view = entry.legacyPublication;
    state.set(entry.mem_id, {
      fact: entry.fact,
      confidence: view.confidence,
      hits: view.hits,
      pruned: view.pruned,
      promoted: view.promoted,
      evidence: entry,
    });
  }
  return { folded, state };
}

function publicationState(facts, stats, namespace) {
  return foldPublication(facts, stats, namespace).state;
}

// Bounded, text-free semantic state of a fold: the same numbers
// projectMemoryState exposes before query-time decay.
function semanticState(folded) {
  return folded.entries.map(entry => ({
    mem_id: entry.mem_id,
    pruned: entry.pruned,
    superseded: entry.superseded,
    hits: entry.legacyProjection.hits,
    confidence: entry.legacyProjection.confidence,
    promoted: entry.legacyProjection.promoted,
    independent_confirmation_count: entry.v2.independent_confirmation_count,
    v2_confidence: entry.v2.confidence,
    v2_promoted: entry.v2.promoted,
    counters: {
      exposure: entry.counters.exposure.count,
      reobserve: entry.counters.reobserve.count,
      independent_confirmation: entry.counters.independent_confirmation.count,
      utility: entry.counters.utility.count,
    },
  }));
}

// Durable, non-fix knowledge in an eligible category, plus the policy's
// threshold. 'v1' is the historical rule kept for v1 continuations; 'v2'
// counts only deduplicated owner-bound independent confirmations, so legacy
// hit/confirm, exposure, reobserve and utility never satisfy it.
function promotionEligible(entry, policy) {
  if (!entry || entry.pruned) return false;
  const text = String(entry.fact.text || '').toLowerCase();
  const category = String(entry.fact.category || '');
  if (category === 'preference' || category === 'environment' || /\b(fixed|patched|workaround)\b/.test(text)) return false;
  if (policy === 'v1') return entry.confidence >= PROMOTION.confidence && entry.hits >= PROMOTION.legacyHits;
  const v2 = entry.evidence.v2;
  return v2.confidence >= PROMOTION.confidence && v2.independent_confirmation_count >= PROMOTION.independentConfirmations;
}

function bindV2Events(extraction, context, mappings, namespace) {
  const registry = context.evidence || { records: [], outcomes: [] };
  const bound = evidence.bindExtractionEvents(extraction, {
    extractionId: context.extractionId,
    extractedAt: context.extractedAt,
    namespace,
    mappings,
    evidence: registry.records,
    outcomes: registry.outcomes,
  });
  if (bound.rejected.length > 0) {
    const reasons = Array.from(new Set(bound.rejected.map(item => item.reason))).sort();
    throw new MemoryPublicationConflict(`evidence binding refused (${reasons.join(', ')})`, 'evidence-binding-refused');
  }
  return new Map(bound.rows.map(row => [row.local_event_id, row]));
}

function appendCanonicalEvent(existingById, stats, event) {
  const prior = existingById.get(event.event_id);
  if (prior) {
    const keys = Array.from(new Set([...Object.keys(prior), ...Object.keys(event)])).sort();
    if (!sameScalarFields(prior, event, keys)) {
      throw new MemoryPublicationConflict(`event identity ${event.event_id} has conflicting content`);
    }
    return false;
  }
  existingById.set(event.event_id, event);
  stats.push(event);
  return true;
}

function buildPublication(current, extraction, context) {
  const namespace = { milestoneId: context.milestoneId || null, unitId: context.unitId };
  const v2Envelope = extraction.schema_version === 2;
  const policy = context.policy || (v2Envelope ? 'v2' : 'v1');
  const facts = Array.isArray(current.facts) ? [...current.facts] : [];
  const stats = Array.isArray(current.stats) ? [...current.stats] : [];
  const canonicalIds = new Set(facts.map(fact => String(fact.mem_id || '')).filter(Boolean));
  const mappings = {};
  const provenance = new Map();
  for (const fact of facts) {
    if (String(fact.extraction_id || '') !== context.extractionId || !fact.candidate_id) continue;
    const candidateId = String(fact.candidate_id);
    if (provenance.has(candidateId) && provenance.get(candidateId).mem_id !== fact.mem_id) {
      throw new MemoryPublicationConflict(`candidate ${candidateId} maps to multiple canonical IDs`);
    }
    provenance.set(candidateId, fact);
  }

  let nextNumber = Math.max(0, ...canonicalIdNumbers(current)) + 1;
  let factsAdded = 0;
  for (const candidate of extraction.facts) {
    const expected = {
      category: candidate.category,
      text: candidate.text,
      confidence_base: candidate.confidence_base,
      source_unit: context.source.sourceUnit,
      extraction_id: context.extractionId,
      candidate_id: candidate.local_id,
      source_fingerprint: context.source.sourceFingerprint,
      dispatch_id: context.source.dispatchId || '',
      model: context.source.model || '',
      effort: context.source.effort || '',
    };
    const replayed = provenance.get(candidate.local_id);
    if (replayed) {
      if (!sameScalarFields(replayed, expected, Object.keys(expected))) {
        throw new MemoryPublicationConflict(`candidate ${candidate.local_id} changed during extraction replay`);
      }
      mappings[candidate.local_id] = replayed.mem_id;
      continue;
    }

    let memId;
    do {
      memId = `MEM${String(nextNumber).padStart(3, '0')}`;
      nextNumber += 1;
    } while (canonicalIds.has(memId));
    canonicalIds.add(memId);
    mappings[candidate.local_id] = memId;
    facts.push({
      mem_id: memId,
      ...expected,
      created_at: context.extractedAt,
    });
    factsAdded += 1;
  }

  const existingByEventId = new Map(
    stats.filter(stat => stat.event_id).map(stat => [String(stat.event_id), stat]),
  );
  let eventsAdded = 0;
  const addEvent = event => {
    const added = appendCanonicalEvent(existingByEventId, stats, event);
    if (added) eventsAdded += 1;
    return added;
  };

  // v2: the whole envelope is bound by the owner before anything is appended;
  // one refused binding refuses the publication (no partial rows).
  const bound = v2Envelope ? bindV2Events(extraction, context, mappings, namespace) : null;
  const explicitSeeds = new Set(v2Envelope
    ? extraction.events.filter(event => event.kind === 'seed').map(event => event.local_id) : []);
  for (const candidate of extraction.facts) {
    // A candidate without an explicit v2 seed keeps the owner seed identity.
    if (explicitSeeds.has(candidate.local_id)) continue;
    addEvent({
      kind: 'seed',
      mem_id: mappings[candidate.local_id],
      ts: context.extractedAt,
      confidence_base: candidate.confidence_base,
      hits: 0,
      event_id: `${context.extractionId}:seed:${candidate.local_id}`,
      extraction_id: context.extractionId,
      candidate_id: candidate.local_id,
    });
  }

  const resolveReference = (memId, location) => {
    const entry = memId ? publicationState(facts, stats, namespace).get(memId) : null;
    if (!entry || entry.pruned) {
      throw new MemoryPublicationConflict(`${location} references missing canonical fact ${memId || '(unknown)'}`);
    }
    return memId;
  };
  const capEvent = memId => ({
    kind: 'prune', mem_id: memId, ts: context.extractedAt, reason: 'cap',
    event_id: `${context.extractionId}:cap:${memId}`, extraction_id: context.extractionId,
  });
  const pruneRequests = [];
  const promotionRequests = [];
  const freshEvidence = [];
  if (v2Envelope) {
    // Identity is extractionId:v2:local_event_id, independent of attempt and
    // array position; cap prunes keep the owner cap identity.
    extraction.events.forEach((event, index) => {
      if (event.kind === 'prune') {
        const memId = event.existing_id || mappings[event.local_id];
        const canonical = capEvent(memId);
        if (existingByEventId.has(canonical.event_id)) {
          addEvent(canonical);
          return;
        }
        pruneRequests.push(resolveReference(memId, `event ${index}`));
        return;
      }
      const row = bound.get(event.local_event_id);
      if (event.kind === 'seed' || existingByEventId.has(row.event_id)) {
        addEvent(row);
        return;
      }
      if (event.kind === 'supersede') {
        const oldEntry = publicationState(facts, stats, namespace).get(row.old_id);
        if (!oldEntry || oldEntry.pruned) throw new MemoryPublicationConflict(`supersede references missing canonical fact ${row.old_id}`);
        if (!row.new_id || row.old_id === row.new_id) throw new MemoryPublicationConflict('supersede replacement must be a distinct candidate');
        addEvent(row);
        return;
      }
      const memId = resolveReference(row.mem_id, `event ${index}`);
      if (event.kind === 'promote') {
        if (!promotionRequests.some(request => request.memId === memId)) promotionRequests.push({ memId, row });
        return;
      }
      if (addEvent(row)) freshEvidence.push(row.event_id);
    });
  } else {
    extraction.events.forEach((event, index) => {
      const eventId = `${context.extractionId}:event:${String(index).padStart(3, '0')}`;
      if (event.kind === 'seed') return;
      if (event.kind === 'supersede') {
        const oldId = event.existing_id;
        const newId = mappings[event.replacement_local_id];
        const canonical = {
          kind: 'supersede', old_id: oldId, new_id: newId, ts: context.extractedAt,
          event_id: eventId, extraction_id: context.extractionId,
        };
        if (existingByEventId.has(eventId)) {
          addEvent(canonical);
          return;
        }
        const oldEntry = publicationState(facts, stats, namespace).get(oldId);
        if (!oldEntry || oldEntry.pruned) throw new MemoryPublicationConflict(`supersede references missing canonical fact ${oldId}`);
        if (!newId || oldId === newId) throw new MemoryPublicationConflict('supersede replacement must be a distinct candidate');
        addEvent(canonical);
        return;
      }
      const referencedId = event.existing_id || mappings[event.local_id];
      const canonical = event.kind === 'prune'
        ? capEvent(referencedId)
        : event.kind === 'promote'
          ? { kind: 'promote', mem_id: referencedId, ts: context.extractedAt, threshold_met: true,
            event_id: eventId, extraction_id: context.extractionId }
          : { kind: event.kind, mem_id: referencedId, ts: context.extractedAt,
            event_id: eventId, extraction_id: context.extractionId };
      if (existingByEventId.has(canonical.event_id)) {
        addEvent(canonical);
        return;
      }
      const memId = resolveReference(referencedId, `event ${index}`);
      if (event.kind === 'prune') {
        pruneRequests.push(memId);
      } else if (event.kind === 'promote') {
        promotionRequests.push({ memId, row: canonical });
      } else {
        addEvent(canonical);
      }
    });
  }

  // The reducer settles fresh v2 evidence: a refusal (e.g. confirmation from
  // the fact's own origin) is a conflict; an observation already recorded on
  // the same target adds no reinforcement but retains its delivery identity.
  if (freshEvidence.length > 0) {
    const fresh = new Set(freshEvidence);
    const { folded } = foldPublication(facts, stats, namespace);
    const refused = folded.rejected.filter(item => fresh.has(item.event_id));
    if (refused.length > 0) {
      const reasons = Array.from(new Set(refused.map(item => item.reason))).sort();
      throw new MemoryPublicationConflict(`evidence refused by the reducer (${reasons.join(', ')})`, 'evidence-reducer-refused');
    }
    // Keep distinct delivery IDs even when the reducer reports the same
    // observation. Reinforcement remains deduplicated; durable IDs prevent
    // later rebinding across publication attempts and process restarts.
  }

  let state = publicationState(facts, stats, namespace);
  const active = Array.from(state.entries()).filter(([, entry]) => !entry.pruned);
  const pruneCount = Math.max(0, active.length - 50);
  const selectedForPrune = active
    .sort((left, right) => (
      left[1].confidence - right[1].confidence
      || left[1].hits - right[1].hits
      || left[0].localeCompare(right[0])
    ))
    .slice(0, pruneCount)
    .map(([memId]) => memId);
  for (const requested of pruneRequests) {
    if (!selectedForPrune.includes(requested)) {
      throw new MemoryPublicationConflict(`prune target ${requested} is not eligible at the current cap boundary`);
    }
  }
  for (const memId of selectedForPrune) addEvent(capEvent(memId));

  // Historical promotions are never recomputed or undone: promoted is a no-op.
  state = publicationState(facts, stats, namespace);
  for (const request of promotionRequests) {
    const entry = state.get(request.memId);
    if (entry && entry.promoted) continue;
    if (!promotionEligible(entry, policy)) {
      throw new MemoryPublicationConflict(`promotion threshold is not met for ${request.memId}`, 'promotion-threshold-not-met');
    }
    addEvent(request.row);
  }

  return {
    fragment: {
      ...current,
      unit_id: context.unitId,
      ...(context.milestoneId ? { milestone_id: context.milestoneId } : {}),
      facts,
      stats,
    },
    result: { mappings, counts: { facts: factsAdded, events: eventsAdded } },
  };
}

function publishExtraction(options) {
  if (!isPlainObject(options)) throw new TypeError('publishExtraction options must be an object');
  assertKeys(options, ['cwd', 'extraction', 'sourceContext'], [], 'publishExtraction');
  if (typeof options.cwd !== 'string' || options.cwd.length === 0 || options.cwd.length > 32768 || /[\u0000]/.test(options.cwd)) {
    throw new TypeError('publishExtraction.cwd must be a valid owner path string');
  }
  const cwd = options.cwd;
  // The publisher decodes both versions; which one was sent is explicit in the
  // envelope and decides identities, never the caller's guess.
  const extraction = validateExtractionResult(options.extraction, { schemaVersions: SCHEMA_VERSIONS });
  const sourceContext = validateSourceContext(options.sourceContext);
  const version = extraction.schema_version;

  if (extraction.status !== 'done') {
    return { status: 'noop', reason: `result-${extraction.status}`, schema_version: version, mappings: {}, counts: { facts: 0, events: 0 } };
  }
  if (extraction.facts.length === 0 && extraction.events.length === 0) {
    return { status: 'noop', reason: 'empty', schema_version: version, mappings: {}, counts: { facts: 0, events: 0 } };
  }

  const namespace = { milestoneId: sourceContext.milestoneId, unitId: sourceContext.unitId };
  let policy = version === 2 ? 'v2' : 'v1';
  try {
    // A digest-bound owner registry marks the v2 evidence contract: its
    // promotion rule then applies whatever envelope version the worker sent.
    const registry = sourceContext.evidence === null ? null
      : verifyEvidenceRegistry(sourceContext.evidence, sourceContext.source);
    if (registry) policy = 'v2';
    const written = memory.transactFragment(
      cwd,
      { unit_id: sourceContext.unitId, ...(sourceContext.milestoneId ? { milestone_id: sourceContext.milestoneId } : {}) },
      {
        milestoneId: sourceContext.milestoneId,
        extractionId: sourceContext.extractionId,
        extractedAt: sourceContext.extractedAt,
      },
      current => buildPublication(current, extraction, { ...sourceContext, evidence: registry, policy }),
    );
    const transaction = written.transaction_result || { mappings: {}, counts: { facts: 0, events: 0 } };
    if (written.quarantined) {
      return {
        status: 'quarantined',
        reason: written.reason,
        path: written.path,
        container: written.container,
        remedy: written.remedy,
        replayed: written.replayed === true,
        schema_version: version,
        promotion_policy: policy,
        ...transaction,
      };
    }
    const changed = transaction.counts.facts > 0 || transaction.counts.events > 0;
    return {
      status: changed ? 'written' : 'noop',
      reason: changed ? undefined : 'replay',
      path: written.path,
      schema_version: version,
      promotion_policy: policy,
      ...transaction,
      state: publishedState(cwd, namespace),
    };
  } catch (error) {
    if (['MEMORY_PUBLICATION_CONFLICT', 'MEMORY_FACT_CONFLICT', 'MEMORY_EVENT_CONFLICT', 'MEMORY_EVENT_INVALID', 'MEMORY_QUARANTINE_CONFLICT'].includes(error && error.code)) {
      return { status: 'conflict', reason: error.message, reason_code: error.reasonCode || 'publication-conflict',
        schema_version: version, promotion_policy: policy, mappings: {}, counts: { facts: 0, events: 0 } };
    }
    throw error;
  }
}

// The persisted fragment folded by the same reducer the projection uses.
// Diagnostic only: a read failure after a committed write leaves it null.
function publishedState(cwd, namespace) {
  try {
    const fragment = memory.readFragment(cwd, namespace.unitId, namespace.milestoneId ? { milestoneId: namespace.milestoneId } : {});
    if (!fragment) return [];
    const facts = Array.isArray(fragment.facts) ? fragment.facts : [];
    const stats = Array.isArray(fragment.stats) ? fragment.stats : [];
    return semanticState(foldPublication(facts, stats, namespace).folded);
  } catch {
    return null;
  }
}

module.exports = {
  LIMITS,
  SCHEMA_VERSIONS,
  EVIDENCE_CONTRACT_VERSION,
  PROMOTION,
  validateExtractionResult,
  normalizeEvidenceRegistry,
  evidenceSourceFingerprint,
  publishExtraction,
  MemoryExtractionError,
  MemoryPublicationConflict,
  MemoryEvidenceRegistryError,
  _private: { buildPublication, publicationState, foldPublication, semanticState, validateSourceContext, selectedSchemaVersions },
};

function readJsonInput(filename) {
  const raw = filename ? fs.readFileSync(filename, 'utf8') : fs.readFileSync(0, 'utf8');
  return JSON.parse(raw);
}

function cliMain(argv) {
  const args = argv.slice(2);
  const mode = args[0];
  let filename = null;
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== '--input' && flag !== '--request') || !value) {
      throw Object.assign(new Error(`Unknown or incomplete option: ${flag || '(missing)'}`), { exitCode: 2 });
    }
    if (filename !== null) throw Object.assign(new Error('Only one input file may be supplied'), { exitCode: 2 });
    filename = value;
  }
  if (mode === '--validate') {
    if (args.includes('--request')) throw Object.assign(new Error('--validate accepts --input, not --request'), { exitCode: 2 });
    process.stdout.write(`${JSON.stringify(validateExtractionResult(readJsonInput(filename), { schemaVersions: SCHEMA_VERSIONS }))}\n`);
    return;
  }
  if (mode === '--publish') {
    if (!filename || !args.includes('--request')) {
      throw Object.assign(new Error('--publish requires --request <file>'), { exitCode: 2 });
    }
    process.stdout.write(`${JSON.stringify(publishExtraction(readJsonInput(filename)))}\n`);
    return;
  }
  throw Object.assign(new Error('Usage: forge-memory-extraction.js --validate [--input FILE] | --publish --request FILE'), { exitCode: 2 });
}

if (require.main === module) {
  try {
    cliMain(process.argv);
  } catch (error) {
    process.stderr.write(`${error.code || 'MEMORY_EXTRACTION_ERROR'}: ${error.message}\n`);
    process.exit(error.exitCode || 1);
  }
}
