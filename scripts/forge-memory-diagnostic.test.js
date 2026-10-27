'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const diagnostic = require('./forge-memory-diagnostic.js');
const { boundDiagnostic, unavailableDiagnostic, safeIdentity, safeNumber, safeCount,
  LIMITS, REASONS, PRIMARY_REASONS, MODIFIER_REASONS } = diagnostic;
let count = 0;
function test(name, fn) { fn(); count++; console.log(`ok ${count} - ${name}`); }
function strings(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]);
}
function candidate(rank = 0, identity = `T01/MEM${rank}`) {
  return { rank, identity, category: 'gotcha', reasons: ['included'], tie_break: 'identity',
    evidence_origin: 'recorded', hits_basis: 'legacy_ranking', components: {
      overlap_count: 2, overlap_points: 200, category_weight: 3, category_points: 30,
      quality: 0.9876, confidence: 0.9876, base_confidence: 0.9999, hits: 1, score: 230.9876,
    } };
}
function observed(candidates = []) {
  return { stages: Object.fromEntries(['source', 'projection', 'ranking', 'context'].map(name =>
    [name, { availability: 'observed' }])), candidates };
}
function bounded(value) {
  assert.equal(Buffer.byteLength(JSON.stringify(value), 'utf8'), value.emitted_bytes);
  assert(value.emitted_bytes <= LIMITS.max_bytes);
  assert.deepStrictEqual(boundDiagnostic(value), value);
  return value;
}
const document = fs.readFileSync(path.join(__dirname, '../shared/forge-memory-diagnostic.md'), 'utf8');
function table(name) {
  const row = document.split('\n').find(line => line.startsWith(`| ${name} |`));
  assert(row, `missing contract table row ${name}`);
  return row.split('|')[2].trim();
}

test('contract constants and closed enums match the Markdown tables', () => {
  assert.equal(diagnostic.DIAGNOSTIC_VERSION, 1);
  assert(document.includes('`version: 1`'));
  for (const [name, value] of Object.entries(LIMITS)) assert.equal(Number(table(name)), value);
  for (const name of ['AVAILABILITY', 'STAGE_REASONS', 'PRIMARY_REASONS', 'MODIFIER_REASONS', 'REASONS', 'CATEGORIES', 'ORIGINS']) {
    assert.deepStrictEqual(table(name).split(', '), diagnostic[name]);
    assert(Object.isFrozen(diagnostic[name]));
  }
  assert(Object.isFrozen(LIMITS));
  assert(!REASONS.includes('below-minimum-overlap'));
  assert.equal(1 + MODIFIER_REASONS.length, 3);
});

test('closed fields and numeric normalization discard untrusted fields at every level', () => {
  const raw = observed([candidate()]);
  raw.query = 'PRIVATE QUERY TEXT'; raw.limits = { secret: true };
  raw.stages.extra = { secret: true }; raw.stages.source.warning = 'RAW WARNING TEXT';
  raw.stages.ranking.examined = NaN; raw.stages.ranking.limit = '1.5';
  raw.candidates[0].secret = 'SECRET FACT TEXT';
  Object.assign(raw.candidates[0].components, { secret: 'PRIVATE QUERY TEXT', quality: Infinity, confidence: '1.5', score: 1.23456 });
  const d = bounded(boundDiagnostic(raw));
  assert.deepStrictEqual(Object.keys(d), ['version', 'status', 'reason', 'limits', 'stages', 'candidates', 'total_candidates', 'omitted_candidates', 'truncated', 'emitted_bytes']);
  assert.deepStrictEqual(Object.keys(d.stages), ['source', 'projection', 'ranking', 'context']);
  assert.deepStrictEqual(Object.keys(d.stages.source), ['availability', 'reason', 'provider', 'store', 'schema_partial']);
  assert.deepStrictEqual(Object.keys(d.stages.projection), ['availability', 'reason', 'evidence_model_version', 'pruned_excluded', 'superseded_excluded', 'orphans_shadowed', 'skipped_fragments']);
  assert.deepStrictEqual(Object.keys(d.stages.ranking), ['availability', 'reason', 'profile', 'minimum_overlap', 'query_term_count', 'examined', 'eligible', 'below_minimum_overlap', 'limit', 'max_tokens']);
  assert.deepStrictEqual(Object.keys(d.stages.context), ['availability', 'reason', 'limit', 'max_tokens', 'content_tokens', 'header_chars', 'received', 'filtered_no_terms', 'limit_cut', 'invalid_identity', 'budget_cut', 'text_truncated', 'included', 'unattributed_positions', 'markdown_bytes', 'truncated']);
  assert.deepStrictEqual(Object.keys(d.candidates[0]), ['rank', 'identity', 'category', 'decision', 'reasons', 'tie_break', 'evidence_origin', 'hits_basis', 'components']);
  assert.deepStrictEqual(Object.keys(d.candidates[0].components).sort(), Object.keys(candidate().components).sort());
  assert.equal(d.stages.ranking.examined, null); assert.equal(d.stages.ranking.limit, null);
  assert.equal(d.candidates[0].components.quality, null); assert.equal(d.candidates[0].components.confidence, null);
  assert.equal(d.candidates[0].components.score, 1.2346);
  assert(!strings(d).some(s => /PRIVATE QUERY TEXT|SECRET FACT TEXT|RAW WARNING TEXT/.test(s)));
  for (const input of [NaN, Infinity, -Infinity, '1.5', null, undefined]) assert.equal(safeNumber(input), null);
  for (const input of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', NaN]) assert.equal(safeCount(input), null);
  assert.equal(safeNumber(1.23456), 1.2346); assert.equal(safeCount(0), 0);
});

test('safeIdentity follows segment safety without a private-word denylist', () => {
  for (const value of ['a..b', 'PRIVATE_QUERY', 'M/T01/MEM001', 'a'.repeat(240)]) assert.equal(safeIdentity(value), value);
  for (const value of ['a/../b', '..', 'a b', 'C:\\x', '/abs', 'a'.repeat(241), '', null]) assert.equal(safeIdentity(value), null);
});

test('reason normalization preserves primary, deduplicates modifiers and does not truncate', () => {
  const raw = observed([{ ...candidate(), reasons: ['ranking-text-truncated', 'included', 'ranking-text-truncated', 'rank-limit', 'unknown reason text', 'context-text-truncated'] }]);
  const d = bounded(boundDiagnostic(raw));
  assert.deepStrictEqual(d.candidates[0].reasons, ['included', 'ranking-text-truncated', 'context-text-truncated']);
  assert.equal(d.candidates[0].decision, 'included'); assert.equal(d.truncated, false);
  const omitted = bounded(boundDiagnostic({ ...raw, total_candidates: 2 }));
  assert.equal(omitted.truncated, true); assert.equal(omitted.omitted_candidates, 1);
  for (const [input, expected] of [
    [['context-text-truncated', 'context-text-truncated'], ['reason-unknown', 'context-text-truncated']],
    [['unknown reason text'], ['reason-unknown']],
  ]) assert.deepStrictEqual(boundDiagnostic(observed([{ reasons: input }])).candidates[0].reasons, expected);
});

test('all reason sequences through length four have one primary and unique bounded modifiers', () => {
  const alphabet = [...REASONS, 'unknown reason text'];
  function check(sequence) {
    const c = boundDiagnostic(observed([{ reasons: sequence }])).candidates[0];
    assert(PRIMARY_REASONS.includes(c.reasons[0]));
    assert.equal(c.reasons[0], sequence.find(r => PRIMARY_REASONS.includes(r)) || 'reason-unknown');
    assert.deepStrictEqual(c.reasons.slice(1), [...new Set(sequence.filter(r => MODIFIER_REASONS.includes(r)))]);
    assert.equal(new Set(c.reasons).size, c.reasons.length);
    assert(c.reasons.length <= 3 && c.reasons.length <= LIMITS.max_reasons);
    if (sequence.length < 4) for (const reason of alphabet) check([...sequence, reason]);
  }
  check([]);
});

test('item and byte cuts have exact omissions and compact emitted_bytes fixed point', () => {
  const items = bounded(boundDiagnostic(observed(Array.from({ length: 200 }, (_, i) => ({ rank: i, identity: `M${i}` })))));
  assert.equal(items.candidates.length, 64); assert.equal(items.total_candidates, 200);
  assert.equal(items.omitted_candidates, 136); assert.equal(items.truncated, true);
  const raw = observed(Array.from({ length: 64 }, (_, i) => candidate(i, `M${i}`.padEnd(240, 'a'))));
  const bytes = bounded(boundDiagnostic(raw));
  assert(bytes.candidates.length < 64 && bytes.candidates.length > 0);
  assert.equal(bytes.omitted_candidates, 64 - bytes.candidates.length); assert(bytes.truncated);
  const uncut = { ...bytes, candidates: raw.candidates };
  assert(Buffer.byteLength(JSON.stringify(uncut), 'utf8') > LIMITS.max_bytes);
  for (const value of [undefined, null, {}, observed(), observed([candidate()])]) bounded(boundDiagnostic(value));
  bounded(unavailableDiagnostic('diagnostic-failed'));
});

test('pure deterministic idempotent normalization leaves inputs unchanged', () => {
  const raw = observed([candidate()]); raw.stages.context.included = 1;
  const before = JSON.stringify(raw);
  assert.deepStrictEqual(boundDiagnostic(raw), boundDiagnostic(raw));
  bounded(boundDiagnostic(raw)); assert.equal(JSON.stringify(raw), before);
  const frozen = Object.freeze({ candidates: Object.freeze([Object.freeze(candidate())]) });
  bounded(boundDiagnostic(frozen));
});

test('privacy recursively excludes raw sentinels and unsafe identities while valid IDs survive', () => {
  const sentinels = ['PRIVATE QUERY TEXT', 'SECRET FACT TEXT', 'RAW ERROR TEXT', 'RAW WARNING TEXT', 'FREE CATEGORY TEXT', 'MULTIBYTE PRIVATE \u00e9 TEXT'];
  const raw = observed([{ ...candidate(), identity: 'PRIVATE_QUERY', category: sentinels[4], evidence_origin: sentinels[1],
    query: sentinels[0], text: sentinels[1], matched_terms: sentinels, warning: sentinels[3], message: sentinels[2], reasons: sentinels }]);
  raw.extra = sentinels; raw.stages.source.message = sentinels[5];
  const d = bounded(boundDiagnostic(raw));
  for (const sentinel of sentinels) assert(!strings(d).some(s => s.includes(sentinel)));
  assert.equal(d.candidates[0].identity, 'PRIVATE_QUERY'); assert.equal(d.candidates[0].category, 'other');
  assert.equal(d.candidates[0].evidence_origin, null); assert.deepStrictEqual(d.candidates[0].reasons, ['reason-unknown']);
  for (const identity of ['C:\\private', '/private', 'a/../b']) assert.equal(boundDiagnostic(observed([{ identity }])).candidates[0].identity, null);
  assert.equal(bounded(unavailableDiagnostic('x y')).reason, 'reason-unknown');
});

test('availability is explicit and unavailableDiagnostic survives exported bounding failure', () => {
  const empty = bounded(boundDiagnostic({})); assert.equal(empty.status, 'unavailable'); assert.equal(empty.reason, 'not-reached');
  for (const stage of Object.values(empty.stages)) for (const [key, value] of Object.entries(stage)) {
    if (!['availability', 'reason'].includes(key)) assert.equal(value, null);
  }
  const partial = bounded(boundDiagnostic({ stages: { source: { availability: 'observed' }, projection: { availability: 'unavailable', reason: 'store-missing' } } }));
  assert.equal(partial.status, 'partial'); assert.equal(partial.reason, 'store-missing');
  assert.equal(bounded(boundDiagnostic(observed())).status, 'observed');
  assert.equal(boundDiagnostic({ stages: { source: { availability: 'wrong', reason: 'private text' } } }).reason, 'reason-unknown');
  const original = diagnostic.boundDiagnostic;
  try { diagnostic.boundDiagnostic = () => { throw new Error('RAW ERROR TEXT'); };
    const d = bounded(unavailableDiagnostic('diagnostic-failed')); assert.equal(d.status, 'unavailable');
    for (const stage of Object.values(d.stages)) assert.equal(stage.reason, 'diagnostic-failed');
  } finally { diagnostic.boundDiagnostic = original; }
});

test('contract documents stage semantics, reason precedence, privacy and evidence boundaries', () => {
  for (const phrase of ['ENOENT', 'source-failed', 'not-reached', 'diagnostic-failed', 'até 2 modificadores',
    'teto defensivo', 'não truncamento', 'subconjunto', 'pruned_excluded', 'posição original',
    'defensivas', 'nowMs fixo', 'não reconstroem o score exatamente', '1e-4', 'pretty-printed',
    'nunca entra em markdown, prompt', 'forge-memory-evidence.md', 'origin', 'hits_basis', 'ambiguidade legada',
    'S03 R1', 'seis itens S04', '#214', 'S06', 'S07', 'S09']) assert(document.includes(phrase), phrase);
  assert(document.indexOf('rank-limit precede ranking-budget') > 0);
});

test('declared artifacts and directed test-module and contract-evidence links are present', () => {
  const moduleText = fs.readFileSync(path.join(__dirname, 'forge-memory-diagnostic.js'), 'utf8');
  const testText = fs.readFileSync(__filename, 'utf8');
  assert(moduleText.split('\n').length >= 130);
  assert(testText.split('\n').length >= 140);
  assert(document.split('\n').length >= 100);
  assert(!/\brequire\s*\(|\bprocess\b|\bDate\b|\beval\s*\(|new RegExp/.test(moduleText));
  for (const name of ['boundDiagnostic', 'unavailableDiagnostic', 'safeIdentity', 'safeNumber', 'safeCount']) assert.equal(typeof diagnostic[name], 'function');
  assert(testText.includes("require('./forge-memory-diagnostic.js')"));
  assert(document.includes('[forge-memory-evidence.md](forge-memory-evidence.md)'));
  assert(fs.existsSync(path.join(__dirname, '../shared/forge-memory-evidence.md')));
});
console.log(`${count} tests passed`);
