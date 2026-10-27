#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const memory = require('./forge-memory.js');
const projection = require('./forge-projection.js');
const popularity = require('./forge-memory-popularity.js');
const { selectMemoryContext } = require('./forge-memory-context.js');
const { renderPrompt } = require('./forge-prompt.js');
const fixture = require('./fixtures/memory-evidence/v1.json');
const mixed = require('./fixtures/memory-evidence/mixed.json');
const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-popularity-shadow-'));
const nowMs = Date.parse(fixture.now);
const secrets = ['PRIVATE QUERY SENTINEL', 'PRIVATE FACT SENTINEL', 'PRIVATE CATEGORY SENTINEL'];
let count = 0;
function test(name, fn) { fn(); count++; console.log(`ok ${count} - ${name}`); }
function root(name) {
  const dir = path.join(parent, name);
  fs.mkdirSync(path.join(dir, '.gsd/memory'), { recursive: true });
  return dir;
}
function fact(mem_id, extra = {}) {
  return { mem_id, category: 'gotcha', text: 'ultraviolet cache constraint',
    confidence_base: 0.9, created_at: fixture.now, source_unit: 'execute-task/T20', ...extra };
}
function put(dir, facts) { memory.writeFragment(dir, { unit_id: 'T20', facts, stats: [] }); }
function query(dir, opts = {}) {
  return projection.queryMemoryEntries(dir, { query: 'ultraviolet cache', unitType: 'execute-task', nowMs, ...opts });
}
function base(result) { const { popularity_shadow: ignored, ...rest } = result; return rest; }
// Local test-only patterns from diagnostic-invariance; those helpers are not exported.
function snapshot(dir, baseDir = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(dir, entry.name);
    const relative = path.relative(baseDir, file);
    if (entry.isDirectory()) return [{ path: relative, type: 'directory' }, ...snapshot(file, baseDir)];
    const bytes = fs.readFileSync(file);
    return [{ path: relative, type: 'file', size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex') }];
  });
}
function withClock(ms, fn) {
  const original = Date.now;
  try { Date.now = () => ms; return fn(); } finally { Date.now = original; }
}
function safeOutput(value, dir) {
  if (typeof value === 'number') assert(Number.isFinite(value));
  if (typeof value === 'string') {
    for (const sentinel of [...secrets, dir, 'PRIVATE FAILURE SENTINEL']) assert(!value.includes(sentinel));
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) { safeOutput(key, dir); safeOutput(child, dir); }
  }
}
function bounded(shadow, dir) {
  safeOutput(shadow, dir);
  assert.equal(shadow.emitted_bytes, Buffer.byteLength(JSON.stringify(shadow), 'utf8'));
  assert(shadow.emitted_bytes <= 32768);
  assert(shadow.candidates.length <= 64);
  assert.equal(shadow.omitted_candidates, shadow.total_candidates - shadow.candidates.length);
  assert.equal(shadow.truncated, shadow.omitted_candidates > 0);
  assert.equal(shadow.window_basis, 'rank-limit-pre-budget');
  assert.equal(shadow.budget_stage, 'unavailable');
  assert.equal(shadow.context_stage, 'unavailable');
}
function parity(dir, opts = {}) {
  const before = snapshot(path.join(dir, '.gsd'));
  const off = query(dir, opts);
  const on = query(dir, { ...opts, popularityShadow: true });
  const again = query(dir, { ...opts, popularityShadow: false });
  assert.equal('popularity_shadow' in off, false);
  assert.equal('popularity_shadow' in again, false);
  assert.deepStrictEqual(base(on), off);
  assert.deepStrictEqual(again, off);
  assert.deepStrictEqual(query(dir, { ...opts, popularityShadow: true }).popularity_shadow, on.popularity_shadow);
  assert.deepStrictEqual(snapshot(path.join(dir, '.gsd')), before);
  bounded(on.popularity_shadow, dir);
  return on;
}
function orphan(dir, rows, eol = '\n') {
  const text = rows.map(row => `## [${row.id}] ${row.category || 'gotcha'}\n- text: ${row.text || 'ultraviolet cache'}\n` +
    `- confidence: ${row.confidence ?? 0.5}\n- hits: ${row.hits ?? 1}\n` +
    (row.updated ? `- updated: ${row.updated}\n` : '')).join('\n');
  fs.writeFileSync(path.join(dir, '.gsd/memory/legacy-orphan.md'), text.replace(/\n/g, eol));
}
try {
  const direct = root('direct');
  put(direct, [fact('MEM002'), fact('MEM001'), fact('MEM003', { text: 'unrelated furniture' })]);
  test('T03 truth 0: strict booleans validate before schema/store; off has no key and deep equality', () => {
    const originalList = memory.listFragments;
    const originalRead = fs.readFileSync;
    let lists = 0;
    try {
      memory.listFragments = (...args) => { lists++; return originalList(...args); };
      fs.readFileSync = () => { throw new Error('store read before validation'); };
      for (const popularityShadow of ['true', 1, null, {}, [], 0, '']) {
        assert.throws(() => query(direct, { popularityShadow }), /^Error: Invalid memory popularity shadow$/);
        assert.equal(lists, 0);
      }
      fs.readFileSync = originalRead;
      const off = query(direct);
      assert.equal(lists, 1);
      assert.deepStrictEqual(query(direct, { popularityShadow: false }), off);
      assert.equal(lists, 2);
      const on = query(direct, { popularityShadow: true });
      assert.equal(lists, 3);
      assert.deepStrictEqual(base(on), off);
      assert.equal('popularity_shadow' in off, false);
    } finally { memory.listFragments = originalList; fs.readFileSync = originalRead; }
  });
  test('T03 truth 1: same single projection and observed ranked rows; unchanged active fields including diagnostic', () => {
    const originalList = memory.listFragments;
    const originalCompare = popularity.compareShadow;
    let lists = 0, comparisons = 0;
    try {
      memory.listFragments = (...args) => { lists++; return originalList(...args); };
      popularity.compareShadow = (rows, options) => {
        comparisons++;
        assert.deepStrictEqual(rows.map(row => row.identity), ['T20/MEM001', 'T20/MEM002']);
        for (const row of rows) {
          assert.equal(row.overlap_count, 2); assert.equal(row.category_weight, 3);
          assert.equal(row.baseline_quality, row.confidence * Math.max(1, row.hits));
          Object.freeze(row);
        }
        Object.freeze(rows);
        return originalCompare(rows, options);
      };
      for (const diagnostic of [false, true]) {
        lists = 0;
        const off = query(direct, { diagnostic });
        assert.equal(lists, 1);
        const on = query(direct, { diagnostic, popularityShadow: true });
        assert.equal(lists, 2);
        assert.deepStrictEqual(base(on), off);
        assert.deepStrictEqual(on.popularity_shadow.candidates.map(c => c.identity), ['T20/MEM001', 'T20/MEM002']);
      }
      assert.equal(comparisons, 2);
    } finally { memory.listFragments = originalList; popularity.compareShadow = originalCompare; }
    for (const opts of [{}, { query: 'missingterm' }, { query: '' }, { limit: 1 }, { maxTokens: 2 },
      { maxTokens: 16 }, { diagnostic: true }, { diagnostic: true, maxTokens: 16 }]) parity(direct, opts);
  });
  test('T03 truth 2: calculation and live weight failures isolated; queryRelevant/context/prompt ignore opt-in', () => {
    const originalCompare = popularity.compareShadow;
    const originalParameters = popularity.PARAMETERS;
    try {
      popularity.compareShadow = () => { throw new Error('PRIVATE FAILURE SENTINEL'); };
      const failed = query(direct, { popularityShadow: true, diagnostic: true });
      assert.deepStrictEqual(base(failed), query(direct, { diagnostic: true }));
      assert.equal(failed.popularity_shadow.status, 'unavailable');
      assert.equal(failed.popularity_shadow.reason, 'shadow-failed');
      safeOutput(failed.popularity_shadow, direct);
      let guardedComparisons = 0;
      popularity.compareShadow = () => { guardedComparisons++; throw new Error('weight guard did not run'); };
      popularity.PARAMETERS = { ...originalParameters, max_category_weight: 2 };
      const guarded = query(direct, { unitType: 'plan-slice', popularityShadow: true });
      assert.equal(guarded.popularity_shadow.status, 'unavailable');
      assert.equal(guarded.popularity_shadow.reason, 'shadow-failed');
      assert.equal(guardedComparisons, 0);
      assert.deepStrictEqual(base(guarded), query(direct, { unitType: 'plan-slice' }));
    } finally { popularity.compareShadow = originalCompare; popularity.PARAMETERS = originalParameters; }
    const q = { cwd: direct, query: 'ultraviolet cache', unitType: 'execute-task', nowMs };
    assert.deepStrictEqual(memory.queryRelevant({ ...q, popularityShadow: true }), memory.queryRelevant(q));
    assert.equal('popularity_shadow' in memory.queryRelevant({ ...q, popularityShadow: true }), false);
    assert.deepStrictEqual(selectMemoryContext({ ...q, popularityShadow: true }), selectMemoryContext(q));
    const prompt = { ...q, codeDir: path.resolve(__dirname, '..'), isolationMode: 'worktree', branch: 'fixture',
      milestoneId: 'M001', sliceId: 'S01', taskId: 'T01', autoCommit: false,
      ledger: '(none)', standardsMaxTokens: 0, memoryQuery: q.query };
    const off = withClock(nowMs, () => renderPrompt(prompt));
    const on = withClock(nowMs, () => renderPrompt({ ...prompt, popularityShadow: true }));
    assert.deepStrictEqual(on, off);
    assert(!on.prompt.includes('popularity_shadow'));
  });
  test('T03 truth 3: reachable decimal/orphan/v1/v2/mixed extremes finite; superseded and pruned excluded', () => {
    const hostile = root('hostile');
    const rows = [{ id: 'MEM101', hits: '1' + '0'.repeat(21) },
      { id: 'MEM102', hits: '9'.repeat(400) }, { id: 'MEM103', hits: '-5' },
      { id: 'MEM104', confidence: 7 }, { id: 'MEM105', confidence: -1 }];
    orphan(hostile, rows);
    const d = parity(hostile, { diagnostic: true }).popularity_shadow;
    const byId = id => d.candidates.find(c => c.identity === `legacy-orphan/${id}`);
    assert.equal(byId('MEM101').hits_status, 'saturated'); assert.equal(byId('MEM101').hits, null);
    // #228 normalizes overflowing legacy counters before the shadow receives them.
    assert.equal(byId('MEM102').hits_status, 'valid');
    assert.equal(byId('MEM102').hits, 0);
    assert.equal(byId('MEM103').hits_status, 'invalid');
    assert.equal(byId('MEM104').confidence_status, 'clamped');
    assert.equal(byId('MEM105').confidence_status, 'clamped');
    const crlf = root('hostile-crlf'); orphan(crlf, rows, '\r\n');
    assert.deepStrictEqual(parity(crlf).popularity_shadow, d);
    const legacy = root('legacy'); memory.writeFragment(legacy, fixture.fragment);
    const observed = parity(legacy, { query: '', diagnostic: true });
    const s = observed.popularity_shadow;
    assert.equal(s.candidates.find(c => c.identity === 'M001/T01/MEM001').hits_status, 'saturated');
    assert(s.candidates.find(c => c.identity === 'M001/T01/MEM001').hits > popularity.PARAMETERS.cap_hits);
    for (const id of ['M001/T01/MEM002', 'M001/T01/MEM003']) {
      assert(!s.candidates.some(c => c.identity === id));
      assert(!observed.diagnostic.candidates.some(c => c.identity === id));
    }
    assert(observed.diagnostic.stages.projection.superseded_excluded >= 1);
    assert(observed.diagnostic.stages.projection.pruned_excluded >= 2);
    const mixedDir = root('mixed');
    for (const fragment of mixed.fragments) memory.writeFragment(mixedDir, fragment);
    const m = parity(mixedDir, { query: '', diagnostic: true });
    assert(m.entries.some(e => e.evidence.legacy_ambiguous.seed_hits > 0 &&
      e.evidence.counters.exposure > 0));
    const v2 = root('v2');
    const fragment = mixed.fragments[0];
    memory.writeFragment(v2, { ...fragment, facts: [fragment.facts[0]],
      stats: fragment.stats.filter(row => row.evidence_version === 2) });
    assert(parity(v2, { query: '' }).entries.some(e => e.evidence.counters.exposure > 0 &&
      e.evidence.legacy_ambiguous.seed_hits === 0));
  });
  test('T03 truth 4: normalized overflow with real underflow keeps finite quality and observed baseline rank', () => {
    const dir = root('nan');
    orphan(dir, [{ id: 'MEM201', hits: '9'.repeat(400), updated: '1970-01-01T00:00:00Z' },
      { id: 'MEM202', hits: 1 }]);
    const r = parity(dir, { nowMs: 8640000000000000, diagnostic: true });
    const c = r.popularity_shadow.candidates.find(row => row.identity === 'legacy-orphan/MEM201');
    assert.equal(r.popularity_shadow.measures.baseline_quality_nonfinite, 0);
    assert.equal(c.shadow_quality, 0); assert.equal(c.hits_status, 'valid');
    assert.equal(c.hits, 0); assert.equal(c.baseline_quality, 0);
    const observed = r.diagnostic.candidates.find(row => row.identity === c.identity);
    assert.equal(c.baseline_rank, observed.rank);
    const entry = r.entries.find(row => row.identity === c.identity);
    assert.equal(entry.hits, 0); assert.equal(entry.confidence, 0);
    assert.equal(observed.components.quality, 0);
    assert(Number.isFinite(entry.score));
    assert.equal(entry.score, observed.components.overlap_points + observed.components.category_points);
    assert.equal(entry.score, observed.components.score);
  });
  test('T03 truth 5: observable A/C displacement, confidence counterexample, and valid-domain equality without quality claim', () => {
    const dir = root('displacement');
    orphan(dir, [{ id: 'MEM301', hits: '1' + '0'.repeat(21), confidence: 0.5, text: 'ultraviolet' },
      { id: 'MEM302', hits: 1, text: 'ultraviolet cache' }]);
    const s = parity(dir, { unitType: 'plan-slice', limit: 1 }).popularity_shadow;
    assert(s.measures.rank_changes >= 1);
    assert(s.measures.baseline_quality_over_category_step >= 1);
    assert.equal(s.candidates[0].identity, 'legacy-orphan/MEM301');
    assert.equal(s.candidates[0].shadow_rank, 1);
    const counter = root('counterexample');
    orphan(counter, [{ id: 'MEM401', hits: 1, confidence: 2 }, { id: 'MEM402', hits: 2, confidence: 0.9 }]);
    const c = parity(counter).popularity_shadow;
    assert.equal(c.measures.saturated_hits, 0);
    assert(c.measures.rows_outside_equivalence >= 1);
    assert.equal(c.comparison.order_equal, false);
    const equivalent = root('equivalent');
    put(equivalent, Array.from({ length: 4 }, (_, i) => fact(`MEM50${i}`, { confidence_base: i / 3 })));
    memory.writeFragment(equivalent, { unit_id: 'T20', facts: [], stats: Array.from({ length: 4 }, (_, i) =>
      ({ kind: 'seed', mem_id: `MEM50${i}`, hits: i, confidence_base: i / 3, ts: fixture.now })) });
    const e = parity(equivalent).popularity_shadow;
    assert.equal(e.total_candidates, 4);
    assert.equal(e.measures.rows_outside_equivalence, 0);
    assert.equal(e.comparison.order_equal, true);
  });
  test('T03 truth 6: recursive gsd sha256 off/on/off unchanged; repeat fixed-clock shadow deep-equal', () => {
    const before = snapshot(path.join(direct, '.gsd'));
    parity(direct, { diagnostic: true });
    assert.deepStrictEqual(snapshot(path.join(direct, '.gsd')), before);
    const large = root('large');
    put(large, Array.from({ length: 300 }, (_, i) => fact(`MEM${String(i).padStart(3, '0')}`,
      { text: `ultraviolet cache ${secrets[1]}`, category: secrets[2] })));
    const r = parity(large, { query: `ultraviolet cache ${secrets[0]}`, unitType: 'other', diagnostic: true, limit: 50 });
    assert.equal(r.popularity_shadow.total_candidates, 300);
    assert.equal(r.popularity_shadow.candidates.length, 64);
    assert.equal(r.popularity_shadow.omitted_candidates, 236);
    assert.deepStrictEqual(r.popularity_shadow.candidates.map(c => c.baseline_rank), Array.from({ length: 64 }, (_, i) => i));
  });
  test('T03 key link 0: projection invokes namespace compareShadow/unavailableShadow and live PARAMETERS', () => {
    const originalCompare = popularity.compareShadow, originalUnavailable = popularity.unavailableShadow;
    let calls = 0, unavailable = 0;
    try {
      popularity.compareShadow = (rows, opts) => { calls++; assert.equal(rows.length, 2);
        assert.deepStrictEqual(opts, { limit: 8 }); return originalCompare(rows, opts); };
      popularity.unavailableShadow = reason => { unavailable++; assert.equal(reason, 'shadow-failed'); return originalUnavailable(reason); };
      query(direct, { popularityShadow: true }); assert.equal(calls, 1);
      popularity.compareShadow = () => { throw new RangeError('PRIVATE FAILURE SENTINEL'); };
      const result = query(direct, { popularityShadow: true });
      assert.equal(unavailable, 1); assert.equal(result.popularity_shadow.reason, 'shadow-failed');
    } finally { popularity.compareShadow = originalCompare; popularity.unavailableShadow = originalUnavailable; }
  });
  test('T03 key link 1: temporary-root queryMemoryEntries exercises nowMs popularityShadow and diagnostic together', () => {
    const result = parity(direct, { nowMs, popularityShadow: false, diagnostic: true });
    assert.equal(result.diagnostic.stages.ranking.eligible, result.popularity_shadow.total_candidates);
    assert.deepStrictEqual(result.diagnostic.candidates.map(c => c.identity), result.popularity_shadow.candidates.map(c => c.identity));
  });
  test('T03 key link 2: writeFragment fixtures and listFragments spy use real store; queryRelevant never forwards opt-in', () => {
    const original = projection.queryMemoryEntries;
    let calls = 0;
    try {
      projection.queryMemoryEntries = (dir, opts) => { calls++; assert.equal(dir, direct);
        assert.equal('popularityShadow' in opts, false); return original(dir, opts); };
      const result = memory.queryRelevant({ cwd: direct, query: 'ultraviolet cache', nowMs, popularityShadow: true });
      assert.equal(calls, 1); assert.equal(result.entries.length, 3);
      assert.equal('popularity_shadow' in result, false);
    } finally { projection.queryMemoryEntries = original; }
  });
  console.log(`${count} popularity integration tests passed (synthetic offline observations; efficacy not evaluated)`);
} finally { fs.rmSync(parent, { recursive: true, force: true }); }
