'use strict';

const crypto = require('crypto');
const { LIMITS, safeIdentity, safeNumber, safeCount } = require('./forge-memory-diagnostic.js');

const SHADOW_VERSION = 1;
const PARAMETERS = Object.freeze({
  formula: 'bounded-popularity-v1',
  baseline_formula: 'active-v1',
  floor_hits: 1,
  cap_hits: 3,
  category_step: 10,
  overlap_step: 100,
  max_category_weight: 3,
});
const MIN_MAX_BYTES = 2048;
const BUDGET_ERROR = 'Invalid memory popularity shadow budget';
const MEASURES = Object.freeze(['eligible', 'rank_changes', 'max_abs_rank_delta', 'window_limit',
  'window_overlap', 'entered', 'left', 'saturated_hits', 'invalid_hits', 'clamped_confidence',
  'invalid_confidence', 'baseline_quality_over_category_step', 'baseline_quality_nonfinite',
  'rows_outside_equivalence']);

function normalizeHits(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return { hits: 0, status: 'invalid' };
  }
  return { hits: value === 0 ? 0 : value, status: value > PARAMETERS.cap_hits ? 'saturated' : 'valid' };
}
function normalizeConfidence(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return { confidence: 0, status: 'invalid' };
  const confidence = Math.min(1, Math.max(0, value));
  return { confidence, status: confidence === value ? 'valid' : 'clamped' };
}
function popularityFactor(hits) {
  return Math.min(PARAMETERS.cap_hits, Math.max(PARAMETERS.floor_hits, normalizeHits(hits).hits));
}
function shadowQuality(confidence, hits) {
  return normalizeConfidence(confidence).confidence * popularityFactor(hits);
}
function shadowScore({ overlap_count, category_weight, confidence, hits }) {
  const overlap = Number.isInteger(overlap_count) && overlap_count >= 0 ? overlap_count : 0;
  const category = Number.isInteger(category_weight) && category_weight >= 0 ? category_weight : 0;
  return (overlap * PARAMETERS.overlap_step) + (category * PARAMETERS.category_step) + shadowQuality(confidence, hits);
}
function orderFingerprint(formula, scope, identities) {
  return crypto.createHash('sha256').update(JSON.stringify({ domain: 'forge-memory-popularity-shadow/order',
    shadow_version: SHADOW_VERSION, formula, scope, order: identities })).digest('hex');
}
function measure(out) {
  // Minimal local copy of the internal forge-memory-diagnostic.js fixed point.
  out.emitted_bytes = 0;
  for (let i = 0; i < 4; i++) {
    const bytes = Buffer.byteLength(JSON.stringify(out), 'utf8');
    if (bytes === out.emitted_bytes) break;
    out.emitted_bytes = bytes;
  }
  return out.emitted_bytes;
}
function unavailableShadow(reason) {
  const out = {
    version: SHADOW_VERSION,
    status: 'unavailable',
    reason: reason === 'no-candidates' ? reason : 'shadow-failed',
    limits: { max_bytes: LIMITS.max_bytes, max_candidates: LIMITS.max_candidates, max_identity_chars: LIMITS.max_identity_chars },
    parameters: { ...PARAMETERS }, window_basis: 'rank-limit-pre-budget', budget_stage: 'unavailable', context_stage: 'unavailable',
    baseline: { formula: PARAMETERS.baseline_formula, rank_basis: 'observed-ranked-order', fingerprint: null, window_fingerprint: null },
    candidate: { formula: PARAMETERS.formula, fingerprint: null, window_fingerprint: null },
    comparison: { order_equal: null, window_equal: null },
    measures: Object.fromEntries(MEASURES.map(name => [name, null])),
    candidates: [],
    total_candidates: null,
    omitted_candidates: null,
    truncated: false,
    emitted_bytes: 0,
  };
  measure(out);
  return out;
}

function compareShadow(rows, { limit, maxBytes = LIMITS.max_bytes } = {}) {
  // Validate before touching rows, even when it is a hostile Proxy/getter.
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(maxBytes) ||
      maxBytes < MIN_MAX_BYTES || maxBytes > LIMITS.max_bytes) throw new RangeError(BUDGET_ERROR);
  const copies = rows.map((row, index) => ({ identity: row.identity, index, rawHits: row.hits === 0 ? 0 : row.hits,
    hits: normalizeHits(row.hits), confidence: normalizeConfidence(row.confidence),
    baseline_quality: row.baseline_quality, quality: shadowQuality(row.confidence, row.hits), s: shadowScore(row) }));
  const sorted = copies.slice().sort((a, b) => b.s !== a.s ? b.s - a.s : a.identity.localeCompare(b.identity));
  const ranks = new Map(sorted.map((row, index) => [row.index, index]));
  const baselineOrder = copies.map(row => row.identity);
  const candidateOrder = sorted.map(row => row.identity);
  const baselineWindow = baselineOrder.slice(0, limit);
  const candidateWindow = candidateOrder.slice(0, limit);
  const baselineIndices = new Set(copies.slice(0, limit).map(row => row.index));
  const windowOverlap = sorted.slice(0, limit).filter(row => baselineIndices.has(row.index)).length;
  const deltas = copies.map(row => ranks.get(row.index) - row.index);
  const out = unavailableShadow('no-candidates');
  out.status = copies.length ? 'observed' : 'unavailable';
  out.reason = copies.length ? null : 'no-candidates';
  out.baseline.fingerprint = orderFingerprint(PARAMETERS.baseline_formula, 'full', baselineOrder);
  out.baseline.window_fingerprint = orderFingerprint(PARAMETERS.baseline_formula, 'window', baselineWindow);
  out.candidate.fingerprint = orderFingerprint(PARAMETERS.formula, 'full', candidateOrder);
  out.candidate.window_fingerprint = orderFingerprint(PARAMETERS.formula, 'window', candidateWindow);
  out.comparison.order_equal = baselineOrder.every((identity, index) => identity === candidateOrder[index]);
  out.comparison.window_equal = baselineWindow.every((identity, index) => identity === candidateWindow[index]);
  out.measures = {
    eligible: safeCount(copies.length), rank_changes: safeCount(deltas.filter(delta => delta !== 0).length),
    max_abs_rank_delta: safeCount(deltas.reduce((max, delta) => Math.max(max, Math.abs(delta)), 0)),
    window_limit: safeCount(limit), window_overlap: safeCount(windowOverlap),
    entered: safeCount(candidateWindow.length - windowOverlap), left: safeCount(baselineWindow.length - windowOverlap),
    saturated_hits: safeCount(copies.filter(row => row.hits.status === 'saturated').length),
    invalid_hits: safeCount(copies.filter(row => row.hits.status === 'invalid').length),
    clamped_confidence: safeCount(copies.filter(row => row.confidence.status === 'clamped').length),
    invalid_confidence: safeCount(copies.filter(row => row.confidence.status === 'invalid').length),
    baseline_quality_over_category_step: safeCount(copies.filter(row => typeof row.baseline_quality === 'number' &&
      Number.isFinite(row.baseline_quality) && row.baseline_quality >= PARAMETERS.category_step).length),
    baseline_quality_nonfinite: safeCount(copies.filter(row => typeof row.baseline_quality !== 'number' || !Number.isFinite(row.baseline_quality)).length),
    rows_outside_equivalence: safeCount(copies.filter(row => row.hits.status !== 'valid' || row.confidence.status !== 'valid').length),
  };
  out.total_candidates = safeCount(copies.length);
  out.omitted_candidates = out.total_candidates;
  out.truncated = copies.length > 0;
  // Defensive guard: no permitted envelope exceeding 2048 was found; the
  // MAX_SAFE_INTEGER counter probe in the suite is evidence, not a universal proof.
  if (measure(out) > maxBytes) throw new RangeError(BUDGET_ERROR);
  out.candidates = copies.slice(0, LIMITS.max_candidates).map(row => ({
    identity: safeIdentity(row.identity), baseline_rank: safeCount(row.index), shadow_rank: safeCount(ranks.get(row.index)),
    rank_delta: safeNumber(ranks.get(row.index) - row.index), hits: safeCount(row.rawHits),
    hits_status: row.hits.status, confidence_status: row.confidence.status,
    baseline_quality: safeNumber(row.baseline_quality), shadow_quality: safeNumber(row.quality),
  }));
  for (;;) {
    out.omitted_candidates = out.total_candidates - out.candidates.length;
    out.truncated = out.omitted_candidates > 0;
    if (measure(out) <= maxBytes) return out;
    // The already-measured empty envelope fits; never pop an empty list.
    out.candidates.pop();
  }
}

module.exports = { SHADOW_VERSION, PARAMETERS, normalizeHits, normalizeConfidence, popularityFactor,
  shadowQuality, shadowScore, orderFingerprint, compareShadow, unavailableShadow };
