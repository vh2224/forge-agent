'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const popularity = require('./forge-memory-popularity.js');
const { SHADOW_VERSION, PARAMETERS, normalizeHits, normalizeConfidence, popularityFactor,
  shadowQuality, shadowScore, orderFingerprint, compareShadow, unavailableShadow } = popularity;
const diagnostic = require('./forge-memory-diagnostic.js');
const { PROMOTION } = require('./forge-memory-extraction.js');
let count = 0;
function test(name, fn) { fn(); count++; console.log(`ok ${count} - ${name}`); }
function row(identity, values = {}) {
  return { identity, overlap_count: 1, category_weight: 1, confidence: 0.5, hits: 1, baseline_quality: 0.5, ...values };
}
function rows(count, identityLength = 12) {
  return Array.from({ length: count }, (_, i) => row(`T${String(i).padStart(4, '0')}/`.padEnd(identityLength, 'a')));
}
function activeScore(value) {
  return (value.overlap_count * 100) + (value.category_weight * 10) + value.confidence * Math.max(1, value.hits);
}
function activeOrder(values) {
  return values.slice().sort((a, b) => activeScore(b) !== activeScore(a) ? activeScore(b) - activeScore(a) : a.identity.localeCompare(b.identity));
}
function bounded(value, budget = diagnostic.LIMITS.max_bytes) {
  assert.equal(value.emitted_bytes, Buffer.byteLength(JSON.stringify(value), 'utf8'));
  assert(value.emitted_bytes <= budget);
  assert(value.candidates.length <= diagnostic.LIMITS.max_candidates);
  assert.equal(value.omitted_candidates, value.total_candidates - value.candidates.length);
  assert.equal(value.truncated, value.omitted_candidates > 0);
  return value;
}
function keys(value, expected) { assert.deepStrictEqual(Object.keys(value), expected.split(' ')); }
function closed(value) {
  keys(value, 'version status reason limits parameters window_basis budget_stage context_stage baseline candidate comparison measures candidates total_candidates omitted_candidates truncated emitted_bytes');
  keys(value.limits, 'max_bytes max_candidates max_identity_chars');
  keys(value.parameters, 'formula baseline_formula floor_hits cap_hits category_step overlap_step max_category_weight');
  keys(value.baseline, 'formula rank_basis fingerprint window_fingerprint');
  keys(value.candidate, 'formula fingerprint window_fingerprint');
  keys(value.comparison, 'order_equal window_equal');
  keys(value.measures, 'eligible rank_changes max_abs_rank_delta window_limit window_overlap entered left saturated_hits invalid_hits clamped_confidence invalid_confidence baseline_quality_over_category_step baseline_quality_nonfinite rows_outside_equivalence');
  for (const candidate of value.candidates) {
    keys(candidate, 'identity baseline_rank shadow_rank rank_delta hits hits_status confidence_status baseline_quality shadow_quality');
  }
}
function finiteNumbers(value) {
  if (typeof value === 'number') assert(Number.isFinite(value));
  else if (value && typeof value === 'object') Object.values(value).forEach(finiteNumbers);
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function measure(out) {
  out.emitted_bytes = 0;
  for (let i = 0; i < 4; i++) {
    const bytes = Buffer.byteLength(JSON.stringify(out), 'utf8');
    if (bytes === out.emitted_bytes) break;
    out.emitted_bytes = bytes;
  }
  return out.emitted_bytes;
}

const hitCases = [
  ['reachable zero', 0, 1, 'valid'], ['reachable negative zero', -0, 1, 'valid'],
  ['reachable one', 1, 1, 'valid'], ['reachable two', 2, 2, 'valid'], ['reachable cap', 3, 3, 'valid'],
  ['reachable four', 4, 3, 'saturated'], ['reachable MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER, 3, 'saturated'],
  ['reachable unsafe integer', Number.MAX_SAFE_INTEGER + 2, 3, 'saturated'],
  ['reachable decimal digits 1e308', 1e308, 3, 'saturated'], ['reachable MAX_VALUE', Number.MAX_VALUE, 3, 'saturated'],
  ['reachable negative', -1, 1, 'invalid'], ['unit-only fractional', 1.5, 1, 'invalid'],
  ['unit-only NaN', NaN, 1, 'invalid'], ['unit-only Infinity', Infinity, 1, 'invalid'],
  ['unit-only negative Infinity', -Infinity, 1, 'invalid'], ['unit-only string', '5', 1, 'invalid'],
  ['unit-only bigint', 5n, 1, 'invalid'], ['unit-only null', null, 1, 'invalid'],
  ['unit-only undefined', undefined, 1, 'invalid'], ['unit-only boolean', true, 1, 'invalid'],
  ['unit-only object', {}, 1, 'invalid'], ['unit-only false', false, 1, 'invalid'],
];
for (const [name, hits, expected, status] of hitCases) {
  test(`hits domain ${name}`, () => {
    assert.equal(popularityFactor(hits), expected);
    assert.equal(normalizeHits(hits).status, status);
    assert.equal(normalizeHits(hits).hits, status === 'invalid' ? 0 : hits);
  });
}
test('normalizers classify extremes and normalize negative zero without coercion', () => {
  assert(Object.is(normalizeHits(-0).hits, 0));
  assert(Object.is(normalizeConfidence(-0).confidence, 0));
  for (const value of [-1, 1.5, 7]) {
    assert.deepStrictEqual(normalizeConfidence(value), { confidence: value < 0 ? 0 : 1, status: 'clamped' });
  }
  for (const value of [NaN, Infinity, -Infinity, '0.9', 1n, true, null, undefined, {}, { valueOf() { throw Error('sentinel'); } }]) {
    assert.deepStrictEqual(normalizeConfidence(value), { confidence: 0, status: 'invalid' });
    assert.equal(popularityFactor(value), 1);
  }
  for (const value of [0, 0.5, 1]) assert.deepStrictEqual(normalizeConfidence(value), { confidence: value, status: 'valid' });
});
test('quality Cartesian extreme grid is finite in [0,3] and hits factor is monotonic', () => {
  for (const [, hits] of hitCases) {
    for (const confidence of [-1, -0, 0, 0.5, 1, 1.5, 7, NaN, Infinity, -Infinity, '0.9', null]) {
      const quality = shadowQuality(confidence, hits);
      assert(Number.isFinite(quality) && quality >= 0 && quality <= 3);
    }
  }
  const validHits = [0, 1, 2, 3, 4, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 2, 1e308, Number.MAX_VALUE];
  for (let i = 1; i < validHits.length; i++) assert(popularityFactor(validHits[i]) >= popularityFactor(validHits[i - 1]));
});
test('shadow score preserves active floating addition association bit for bit in equivalent domain', () => {
  for (const hits of [0, 1, 2, 3]) for (const confidence of [-0, 0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
    for (const overlap_count of [0, 1, 50000]) for (const category_weight of [0, 1, 2, 3]) {
      const value = row('A', { hits, confidence, overlap_count, category_weight });
      assert(Object.is(shadowScore(value), activeScore(value)));
    }
  }
  for (const invalid of [-1, 0.5, NaN, Infinity, '1', null]) {
    assert.equal(shadowScore(row('A', { overlap_count: invalid, category_weight: invalid })), 0.5);
  }
});
test('contract parameter table, PROMOTION tripwire and bucket invariants match PARAMETERS', () => {
  assert.equal(SHADOW_VERSION, 1);
  assert(Object.isFrozen(PARAMETERS));
  assert(PARAMETERS.cap_hits < PARAMETERS.category_step);
  assert(PARAMETERS.max_category_weight * PARAMETERS.category_step + PARAMETERS.cap_hits < PARAMETERS.overlap_step);
  assert.equal(PARAMETERS.cap_hits, PROMOTION.legacyHits);
  const document = fs.readFileSync(path.join(__dirname, '../shared/forge-memory-popularity-shadow.md'), 'utf8');
  for (const [name, key] of Object.entries({ FLOOR: 'floor_hits', CAP: 'cap_hits', CATEGORY_STEP: 'category_step', OVERLAP_STEP: 'overlap_step', MAX_CATEGORY_WEIGHT: 'max_category_weight' })) {
    const line = document.split('\n').find(line => line.startsWith(`| ${name} |`));
    assert(line, name);
    assert.equal(Number(line.split('|')[2].trim()), PARAMETERS[key]);
  }
  for (let overlap = 0; overlap < 3; overlap++) for (let category = 0; category < 3; category++) {
    const low = row('low', { overlap_count: overlap, category_weight: category, hits: Number.MAX_VALUE, confidence: 1 });
    assert(shadowScore(row('high', { overlap_count: overlap, category_weight: category + 1, hits: 0, confidence: 0 })) > shadowScore(low));
    assert(shadowScore(row('high', { overlap_count: overlap + 1, category_weight: 0, hits: 0, confidence: 0 })) >
      shadowScore({ ...low, category_weight: 3 }));
  }
});
test('fingerprints use exact domain/formula/scope and separate equality from formula identity', () => {
  const order = ['A', 'B'];
  const expected = crypto.createHash('sha256').update(JSON.stringify({ domain: 'forge-memory-popularity-shadow/order', shadow_version: 1,
    formula: PARAMETERS.formula, scope: 'full', order })).digest('hex');
  assert.equal(orderFingerprint(PARAMETERS.formula, 'full', order), expected);
  const values = activeOrder([row('B', { hits: 2, confidence: 0.9 }), row('A', { confidence: 0.1 })]);
  const out = bounded(compareShadow(values, { limit: 2 }));
  assert.equal(out.measures.rows_outside_equivalence, 0);
  assert.equal(out.comparison.order_equal, true);
  assert.equal(out.comparison.window_equal, true);
  assert.equal(out.measures.rank_changes, 0);
  assert.equal(new Set([out.baseline.fingerprint, out.baseline.window_fingerprint, out.candidate.fingerprint, out.candidate.window_fingerprint]).size, 4);
  // Distinct q below the sum's ulp tie by identity, exactly as the active comparator.
  const ties = activeOrder([row('B', { confidence: 0.5, overlap_count: 50000 }), row('A', { confidence: 0.5 + Number.EPSILON, overlap_count: 50000 })]);
  assert.equal(compareShadow(ties, { limit: 1 }).comparison.order_equal, true);
});
test('confidence counterexample changes order without saturated hits; saturation is a separate case', () => {
  const out = bounded(compareShadow([row('A', { confidence: 2, baseline_quality: 2 }), row('B', { confidence: 0.9, hits: 2, baseline_quality: 1.8 })], { limit: 1 }));
  assert.equal(out.measures.saturated_hits, 0);
  assert.equal(out.measures.clamped_confidence, 1);
  assert.equal(out.measures.rows_outside_equivalence, 1);
  assert.equal(out.comparison.order_equal, false);
  assert.equal(out.comparison.window_equal, false);
  assert.equal(out.measures.rank_changes, 2);
  assert.equal(out.measures.entered, 1);
  assert.equal(out.measures.left, 1);
  assert.deepStrictEqual(out.candidates.map(value => value.rank_delta), [1, -1]);
  const saturated = compareShadow([row('B', { hits: 4, confidence: 1 }), row('A', { hits: 3, confidence: 1 })], { limit: 2 });
  assert.equal(saturated.measures.saturated_hits, 1);
  assert.equal(saturated.comparison.order_equal, false);
});
test('all 300 ranks precede candidate cap and byte cut; frozen input is deterministic and unchanged', () => {
  const input = freeze(rows(300).map((value, index) => ({ ...value, overlap_count: index })));
  const before = JSON.stringify(input);
  const out = bounded(compareShadow(input, { limit: 10 }));
  assert.deepStrictEqual(compareShadow(input, { limit: 10 }), out);
  assert.equal(JSON.stringify(input), before);
  assert.equal(out.total_candidates, 300);
  assert.equal(out.candidates.length, 64);
  assert.equal(out.omitted_candidates, 236);
  assert.equal(out.measures.rank_changes, 300);
  assert.equal(out.measures.max_abs_rank_delta, 299);
  assert.equal(out.measures.window_overlap, 0);
  assert.equal(out.candidates[0].shadow_rank, 299);
  assert.equal(out.candidates[63].shadow_rank, 236);
});
test('invalid limit and maxBytes throw sanitized RangeError before hostile Proxy or getter access', () => {
  const sentinel = new Error('ROWS MUST NOT BE READ');
  let accesses = 0;
  const hostile = new Proxy([], { get() { accesses++; throw sentinel; } });
  const getter = { get map() { accesses++; throw sentinel; } };
  const rejected = fn => assert.throws(fn, error => error instanceof RangeError && error !== sentinel && error.message === 'Invalid memory popularity shadow budget');
  for (const input of [hostile, getter]) {
    for (const limit of [0, -1, 1.5, NaN, '3', null, undefined, Infinity]) rejected(() => compareShadow(input, { limit }));
    for (const maxBytes of [1024, 2047, 32769, 2048.5, NaN, '4096', null]) rejected(() => compareShadow(input, { limit: 1, maxBytes }));
  }
  assert.equal(accesses, 0);
});
test('2048 floor retains every closed field and four 64-hex fingerprints; default equals maximum', () => {
  const input = rows(300);
  const out = bounded(compareShadow(input, { limit: 10, maxBytes: 2048 }), 2048);
  closed(out);
  for (const side of [out.baseline, out.candidate]) for (const key of ['fingerprint', 'window_fingerprint']) assert(/^[0-9a-f]{64}$/.test(side[key]));
  assert.equal(out.limits.max_bytes, 32768);
  assert.deepStrictEqual(compareShadow(input, { limit: 10 }), compareShadow(input, { limit: 10, maxBytes: 32768 }));
});
test('defensive envelope guard has no reachable permitted fixture; MAX_SAFE_INTEGER envelope probe fits 2048, not universal proof', () => {
  // No permitted input triggering the defensive guard was found. This finite
  // counter-width probe supports the floor; it does not prove every schema state.
  const probe = compareShadow(rows(300), { limit: 10, maxBytes: 2048 });
  probe.candidates = [];
  for (const key of Object.keys(probe.measures)) probe.measures[key] = Number.MAX_SAFE_INTEGER;
  probe.total_candidates = Number.MAX_SAFE_INTEGER;
  probe.omitted_candidates = Number.MAX_SAFE_INTEGER;
  probe.status = 'unavailable'; probe.reason = 'shadow-failed'; probe.truncated = false;
  probe.comparison.order_equal = false; probe.comparison.window_equal = false;
  assert(measure(probe) <= 2048);
  assert.equal(probe.emitted_bytes, Buffer.byteLength(JSON.stringify(probe), 'utf8'));
});
test('measured full 64-row output drives supported byte truncation budget and long identities remain bounded', () => {
  const input = rows(64, 80);
  const full = bounded(compareShadow(input, { limit: 10 }));
  assert.equal(full.candidates.length, 64);
  assert.equal(full.truncated, false);
  assert(full.emitted_bytes > 2048);
  const budget = Math.floor((2048 + full.emitted_bytes) / 2);
  assert(budget >= 2048 && budget < full.emitted_bytes);
  const cut = bounded(compareShadow(input, { limit: 10, maxBytes: budget }), budget);
  assert(cut.candidates.length < 64);
  assert.equal(cut.truncated, true);
  bounded(compareShadow(rows(64, 240), { limit: 10 }));
});
test('nonfinite baseline qualities become null and counts exclude them from finite threshold', () => {
  const input = [NaN, Infinity, -Infinity, 10, 11, 9].map((baseline_quality, i) => row(`A${i}`, { baseline_quality }));
  const out = bounded(compareShadow(input, { limit: 3 }));
  assert.equal(out.measures.baseline_quality_nonfinite, 3);
  assert.equal(out.measures.baseline_quality_over_category_step, 2);
  assert.deepStrictEqual(out.candidates.slice(0, 3).map(value => value.baseline_quality), [null, null, null]);
  finiteNumbers(out);
});
test('privacy allowlist reuses diagnostic sanitizers and discards free text and invalid identities', () => {
  const privateText = 'PRIVATE QUERY FACT CATEGORY PATH ERROR';
  const input = [row(privateText, { query: privateText, text: privateText, category: privateText, path: privateText, error: privateText, hits: Number.MAX_VALUE }), row('../invalid', { hits: -1 })];
  const out = bounded(compareShadow(input, { limit: 2 }));
  closed(out);
  assert(!JSON.stringify(out).includes(privateText));
  assert(out.candidates.every(value => value.identity === null));
  assert(out.candidates.every(value => value.hits === null));
  assert.equal(out.candidates[0].hits_status, 'saturated');
  assert.equal(out.candidates[1].hits_status, 'invalid');
  assert.equal(out.candidates[0].shadow_quality, diagnostic.safeNumber(shadowQuality(0.5, Number.MAX_VALUE)));
  assert.equal(diagnostic.safeIdentity(privateText), null);
  assert.equal(diagnostic.safeCount(Number.MAX_VALUE), null);
  const source = fs.readFileSync(path.join(__dirname, 'forge-memory-popularity.js'), 'utf8');
  assert(source.includes("const { LIMITS, safeIdentity, safeNumber, safeCount } = require('./forge-memory-diagnostic.js')"));
});
test('unavailableShadow is constant sanitized independent of caller input and preserves closed shape', () => {
  const unavailable = unavailableShadow('shadow-failed');
  closed(unavailable);
  assert.deepStrictEqual(unavailableShadow({ toString() { throw Error('private'); } }), unavailable);
  assert.deepStrictEqual(unavailableShadow('PRIVATE QUERY ERROR'), unavailable);
  assert.equal(unavailable.emitted_bytes, Buffer.byteLength(JSON.stringify(unavailable), 'utf8'));
  assert(unavailable.emitted_bytes <= 2048);
  assert.equal(unavailableShadow('no-candidates').reason, 'no-candidates');
  assert(Object.values(unavailable.measures).every(value => value === null));
  assert.deepStrictEqual(unavailable.comparison, { order_equal: null, window_equal: null });
  unavailable.parameters.cap_hits = 999;
  assert.equal(unavailableShadow().parameters.cap_hits, 3);
  const empty = bounded(compareShadow([], { limit: 1, maxBytes: 2048 }), 2048);
  closed(empty);
  assert.equal(empty.status, 'unavailable');
  assert.equal(empty.reason, 'no-candidates');
  assert.equal(empty.measures.eligible, 0);
});
console.log(`Passed ${count} popularity shadow tests`);
