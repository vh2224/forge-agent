'use strict';

const DIAGNOSTIC_VERSION = 1;
const LIMITS = Object.freeze({ max_bytes: 32768, max_candidates: 64, max_reasons: 4, max_identity_chars: 240 });
const AVAILABILITY = Object.freeze(['observed', 'unavailable']);
const STAGE_REASONS = Object.freeze(['not-reached', 'override-provider', 'direct-memories', 'source-failed', 'store-missing', 'disabled', 'no-query', 'insufficient-budget', 'diagnostic-failed', 'reason-unknown']);
const PRIMARY_REASONS = Object.freeze(['included', 'rank-limit', 'ranking-budget', 'context-no-matched-terms', 'context-invalid-identity', 'context-limit', 'context-budget', 'reason-unknown']);
const MODIFIER_REASONS = Object.freeze(['ranking-text-truncated', 'context-text-truncated']);
const REASONS = Object.freeze([...PRIMARY_REASONS, ...MODIFIER_REASONS]);
const CATEGORIES = Object.freeze(['gotcha', 'convention', 'architecture', 'pattern', 'other']);
const ORIGINS = Object.freeze(['recorded', 'legacy_unknown', 'legacy_orphan']);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function enumValue(value, allowed, fallback = null) {
  return allowed.includes(value) ? value : fallback;
}
function safeIdentity(value) {
  // Same rule as forge-memory-context.js::memoryIdentifier, without importing I/O.
  return typeof value === 'string' && value.length <= LIMITS.max_identity_chars &&
    /^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(value) && !value.split('/').includes('..') ? value : null;
}
function safeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(4)) : null;
}
function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function safeBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

const STAGE_COUNTS = Object.freeze({
  projection: ['evidence_model_version', 'pruned_excluded', 'superseded_excluded', 'orphans_shadowed', 'skipped_fragments'],
  ranking: ['minimum_overlap', 'query_term_count', 'examined', 'eligible', 'below_minimum_overlap', 'limit', 'max_tokens'],
  context: ['limit', 'max_tokens', 'content_tokens', 'header_chars', 'received', 'filtered_no_terms', 'limit_cut', 'invalid_identity', 'budget_cut', 'text_truncated', 'included', 'unattributed_positions', 'markdown_bytes'],
});
const STAGES = Object.freeze(['source', 'projection', 'ranking', 'context']);
const COMPONENT_COUNTS = Object.freeze(['overlap_count', 'hits']);
const COMPONENT_NUMBERS = Object.freeze(['overlap_points', 'category_weight', 'category_points', 'quality', 'confidence', 'base_confidence', 'score']);

function normalizeStage(name, value) {
  const raw = object(value);
  const observed = raw.availability === 'observed';
  const out = {
    availability: observed ? 'observed' : 'unavailable',
    reason: observed ? null : enumValue(raw.reason, STAGE_REASONS, value === undefined ? 'not-reached' : 'reason-unknown'),
  };
  // An explicitly unavailable stage may still report observed source facts.
  // Absent stages have an empty raw object, so all their fact fields are null.
  const facts = raw;
  if (name === 'source') {
    out.provider = enumValue(facts.provider, ['canonical', 'override', 'direct']);
    out.store = enumValue(facts.store, ['present', 'missing', 'unknown'], observed ? 'unknown' : null);
    out.schema_partial = safeBoolean(facts.schema_partial);
  } else {
    if (name === 'ranking') out.profile = enumValue(facts.profile, ['execution', 'planning', 'neutral']);
    for (const key of STAGE_COUNTS[name]) out[key] = safeCount(facts[key]);
    if (name === 'context') out.truncated = safeBoolean(facts.truncated);
  }
  return out;
}

function normalizeCandidate(value) {
  const raw = object(value);
  const rawReasons = Array.isArray(raw.reasons) ? raw.reasons : [];
  const primary = rawReasons.find(reason => PRIMARY_REASONS.includes(reason)) || 'reason-unknown';
  const modifiers = [...new Set(rawReasons.filter(reason => MODIFIER_REASONS.includes(reason)))];
  const reasons = [primary, ...modifiers].slice(0, LIMITS.max_reasons);
  let components = null;
  if (raw.components !== null && typeof raw.components === 'object' && !Array.isArray(raw.components)) {
    components = {};
    for (const key of COMPONENT_COUNTS) components[key] = safeCount(raw.components[key]);
    for (const key of COMPONENT_NUMBERS) components[key] = safeNumber(raw.components[key]);
  }
  return {
    rank: safeCount(raw.rank),
    identity: safeIdentity(raw.identity),
    category: enumValue(raw.category, CATEGORIES, 'other'),
    decision: primary === 'included' ? 'included' : 'excluded',
    reasons,
    tie_break: enumValue(raw.tie_break, ['identity']),
    evidence_origin: enumValue(raw.evidence_origin, ORIGINS),
    hits_basis: enumValue(raw.hits_basis, ['legacy_ranking']),
    components,
  };
}

function measure(out) {
  // Only the width of emitted_bytes changes: four passes suffice for this bound.
  out.emitted_bytes = 0;
  for (let i = 0; i < 4; i++) {
    const bytes = Buffer.byteLength(JSON.stringify(out), 'utf8');
    if (bytes === out.emitted_bytes) break;
    out.emitted_bytes = bytes;
  }
  return out.emitted_bytes;
}

function normalizeDiagnostic(value) {
  const raw = object(value);
  const rawStages = object(raw.stages);
  const stages = {};
  for (const name of STAGES) stages[name] = normalizeStage(name, rawStages[name]);
  const unavailable = STAGES.filter(name => stages[name].availability === 'unavailable');
  const candidates = Array.isArray(raw.candidates) ? raw.candidates : [];
  const total = Math.max(safeCount(raw.total_candidates) || 0, candidates.length);
  const out = {
    version: DIAGNOSTIC_VERSION,
    status: unavailable.length === 0 ? 'observed' : unavailable.length === STAGES.length ? 'unavailable' : 'partial',
    reason: unavailable.length ? stages[unavailable[0]].reason : null,
    limits: { ...LIMITS },
    stages,
    candidates: candidates.slice(0, LIMITS.max_candidates).map(normalizeCandidate),
    total_candidates: total,
    omitted_candidates: 0,
    truncated: raw.truncated === true,
    emitted_bytes: 0,
  };
  do {
    out.omitted_candidates = total - out.candidates.length;
    out.truncated = out.omitted_candidates > 0 || raw.truncated === true;
    if (measure(out) <= LIMITS.max_bytes) return out;
  } while (out.candidates.length && out.candidates.pop());
  return null;
}

function unavailableDiagnostic(reason) {
  const stages = {};
  for (const name of STAGES) stages[name] = { availability: 'unavailable', reason: enumValue(reason, STAGE_REASONS, 'reason-unknown') };
  return normalizeDiagnostic({ stages });
}
function boundDiagnostic(raw) {
  return normalizeDiagnostic(raw) || unavailableDiagnostic('diagnostic-failed');
}

module.exports = {
  DIAGNOSTIC_VERSION, LIMITS, AVAILABILITY, STAGE_REASONS, PRIMARY_REASONS, MODIFIER_REASONS,
  REASONS, CATEGORIES, ORIGINS, boundDiagnostic, unavailableDiagnostic, safeIdentity, safeNumber, safeCount,
};
