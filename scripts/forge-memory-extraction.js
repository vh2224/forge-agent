#!/usr/bin/env node
'use strict';

const fs = require('fs');
const memory = require('./forge-memory');

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

class MemoryExtractionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MemoryExtractionError';
    this.code = 'MEMORY_EXTRACTION_INVALID';
  }
}

class MemoryPublicationConflict extends Error {
  constructor(message) {
    super(message);
    this.name = 'MemoryPublicationConflict';
    this.code = 'MEMORY_PUBLICATION_CONFLICT';
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

function validateExtractionResult(result, context) {
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
  assertKeys(sourceContext, ['unitId', 'extractionId', 'extractedAt', 'source'], ['milestoneId'], 'sourceContext');
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

function publicationState(facts, stats) {
  const state = new Map();
  for (const fact of facts) {
    if (!fact.mem_id) continue;
    state.set(String(fact.mem_id), {
      fact,
      confidence: Number(fact.confidence_base || fact.confidence || 0.5),
      hits: 0,
      pruned: false,
      promoted: false,
    });
  }
  for (const stat of stats) {
    const id = String(stat.kind === 'supersede' ? (stat.old_id || stat.mem_id || '') : (stat.mem_id || ''));
    const entry = state.get(id);
    if (!entry) continue;
    if (stat.kind === 'seed') {
      entry.confidence = Number(stat.confidence_base || stat.confidence || entry.confidence);
      entry.hits = Number(stat.hits || 0);
    } else if (stat.kind === 'hit' || stat.kind === 'confirm') {
      entry.hits += 1;
    } else if (stat.kind === 'prune' || stat.kind === 'supersede') {
      entry.pruned = true;
    } else if (stat.kind === 'promote') {
      entry.promoted = true;
    }
  }
  return state;
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

  for (const candidate of extraction.facts) {
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

  const resolveReference = (event, location) => {
    const memId = event.existing_id || mappings[event.local_id];
    const entry = memId ? publicationState(facts, stats).get(memId) : null;
    if (!entry || entry.pruned) {
      throw new MemoryPublicationConflict(`${location} references missing canonical fact ${memId || '(unknown)'}`);
    }
    return memId;
  };
  const pruneRequests = [];
  const promotionRequests = [];
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
      const oldEntry = publicationState(facts, stats).get(oldId);
      if (!oldEntry || oldEntry.pruned) throw new MemoryPublicationConflict(`supersede references missing canonical fact ${oldId}`);
      if (!newId || oldId === newId) throw new MemoryPublicationConflict('supersede replacement must be a distinct candidate');
      addEvent(canonical);
      return;
    }
    const referencedId = event.existing_id || mappings[event.local_id];
    const canonical = event.kind === 'prune'
      ? { kind: 'prune', mem_id: referencedId, ts: context.extractedAt, reason: 'cap',
        event_id: `${context.extractionId}:cap:${referencedId}`, extraction_id: context.extractionId }
      : event.kind === 'promote'
        ? { kind: 'promote', mem_id: referencedId, ts: context.extractedAt, threshold_met: true,
          event_id: eventId, extraction_id: context.extractionId }
        : { kind: event.kind, mem_id: referencedId, ts: context.extractedAt,
          event_id: eventId, extraction_id: context.extractionId };
    if (existingByEventId.has(canonical.event_id)) {
      addEvent(canonical);
      return;
    }
    const memId = resolveReference(event, `event ${index}`);
    if (event.kind === 'prune') {
      pruneRequests.push(memId);
    } else if (event.kind === 'promote') {
      promotionRequests.push({ memId, eventId });
    } else {
      addEvent(canonical);
    }
  });

  let state = publicationState(facts, stats);
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
  for (const memId of selectedForPrune) {
    addEvent({
      kind: 'prune', mem_id: memId, ts: context.extractedAt, reason: 'cap',
      event_id: `${context.extractionId}:cap:${memId}`, extraction_id: context.extractionId,
    });
  }

  state = publicationState(facts, stats);
  for (const request of promotionRequests) {
    const entry = state.get(request.memId);
    if (entry && entry.promoted) continue;
    const text = String(entry && entry.fact.text || '').toLowerCase();
    const category = String(entry && entry.fact.category || '');
    const eligible = entry && !entry.pruned
      && entry.confidence >= 0.85
      && entry.hits >= 3
      && category !== 'preference'
      && category !== 'environment'
      && !/\b(fixed|patched|workaround)\b/.test(text);
    if (!eligible) throw new MemoryPublicationConflict(`promotion threshold is not met for ${request.memId}`);
    addEvent({
      kind: 'promote', mem_id: request.memId, ts: context.extractedAt, threshold_met: true,
      event_id: request.eventId, extraction_id: context.extractionId,
    });
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
  const extraction = validateExtractionResult(options.extraction);
  const sourceContext = validateSourceContext(options.sourceContext);

  if (extraction.status !== 'done') {
    return { status: 'noop', reason: `result-${extraction.status}`, mappings: {}, counts: { facts: 0, events: 0 } };
  }
  if (extraction.facts.length === 0 && extraction.events.length === 0) {
    return { status: 'noop', reason: 'empty', mappings: {}, counts: { facts: 0, events: 0 } };
  }

  try {
    const written = memory.transactFragment(
      cwd,
      { unit_id: sourceContext.unitId, ...(sourceContext.milestoneId ? { milestone_id: sourceContext.milestoneId } : {}) },
      {
        milestoneId: sourceContext.milestoneId,
        extractionId: sourceContext.extractionId,
        extractedAt: sourceContext.extractedAt,
      },
      current => buildPublication(current, extraction, sourceContext),
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
        ...transaction,
      };
    }
    const changed = transaction.counts.facts > 0 || transaction.counts.events > 0;
    return {
      status: changed ? 'written' : 'noop',
      reason: changed ? undefined : 'replay',
      path: written.path,
      ...transaction,
    };
  } catch (error) {
    if (['MEMORY_PUBLICATION_CONFLICT', 'MEMORY_FACT_CONFLICT', 'MEMORY_EVENT_CONFLICT', 'MEMORY_QUARANTINE_CONFLICT'].includes(error && error.code)) {
      return { status: 'conflict', reason: error.message, mappings: {}, counts: { facts: 0, events: 0 } };
    }
    throw error;
  }
}

module.exports = {
  LIMITS,
  validateExtractionResult,
  publishExtraction,
  MemoryExtractionError,
  MemoryPublicationConflict,
  _private: { buildPublication, publicationState, validateSourceContext },
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
    process.stdout.write(`${JSON.stringify(validateExtractionResult(readJsonInput(filename)))}\n`);
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
