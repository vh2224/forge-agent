'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const memory = require('./forge-memory');
const projection = require('./forge-projection');
const evidence = require('./forge-memory-evidence');
const ts = '2026-10-25T00:00:00.000Z';
const opts = { query: 'cache', nowMs: Date.parse(ts), limit: 50, maxTokens: 20000 };

function fixture(t, rows) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-finite-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  memory.writeFragment(cwd, { unit_id: 'T01',
    facts: rows.map(([mem_id, hits, confidence_base]) => ({ mem_id, category: 'pattern', text: 'synthetic cache', confidence_base, created_at: ts })),
    stats: rows.map(([mem_id, hits, confidence_base]) => ({ kind: 'seed', mem_id, hits, confidence_base, ts })),
  });
  return cwd;
}

function assertFinite(value) {
  if (typeof value === 'number') assert(Number.isFinite(value), `nonfinite number: ${value}`);
  else if (value && typeof value === 'object') Object.values(value).forEach(assertFinite);
}

test('legacy overflowing seed hits stay finite through write, project, query and JSON', t => {
  const cwd = fixture(t, [['MEM002', '9'.repeat(400), 0.5], ['MEM001', '9'.repeat(400), 0], ['MEM004', '4tail', 0.5], ['MEM003', '9'.repeat(400), 0.5]]);
  const state = projection.projectMemoryState(cwd, opts);
  assertFinite(state);
  assert.deepEqual(state.entries.map(x => [x.fact.mem_id, x.hits]), [['MEM004', 4], ['MEM002', 0], ['MEM003', 0], ['MEM001', 0]]);
  const result = projection.queryMemoryEntries(cwd, { ...opts, diagnostic: true });
  assertFinite(result);
  assert.deepEqual(result.entries.map(x => [x.mem_id, x.score]), [['MEM004', 102], ['MEM002', 100.5], ['MEM003', 100.5], ['MEM001', 100]]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)).entries, result.entries);
  assert.deepEqual(projection.queryMemoryEntries(cwd, opts).entries, result.entries);
});

test('finite legacy boundaries and parsing conventions remain compatible', t => {
  const finiteDigits = '9'.repeat(308);
  const cwd = fixture(t, [['MEM001', finiteDigits, 1], ['MEM002', Number.MAX_SAFE_INTEGER, 0.5], ['MEM003', -3, 0.5], ['MEM004', 2.5, 0.5], ['MEM005', '2.5', 0.5]]);
  const result = projection.queryMemoryEntries(cwd, opts);
  assertFinite(result);
  const byId = Object.fromEntries(result.entries.map(x => [x.mem_id, x]));
  assert.equal(byId.MEM001.hits, Number(finiteDigits));
  assert.equal(byId.MEM001.score, Number(finiteDigits));
  assert.equal(byId.MEM002.hits, Number.MAX_SAFE_INTEGER);
  assert.equal(byId.MEM003.hits, -3);
  // Fragment text reads numeric values through the historical parseInt path.
  assert.equal(byId.MEM004.hits, 2);
  assert.equal(byId.MEM005.hits, 2);
  const folded = evidence.foldMemoryEvidence({ unitId: 'T01', facts: [{ mem_id: 'MEM001' }], stats: [{ kind: 'seed', mem_id: 'MEM001', hits: '4tail' }] });
  assert.equal(folded.entries[0].legacyProjection.hits, 4);
  assert.equal(folded.entries[0].legacyPublication.hits, 0);
  for (const hits of [Number.MAX_VALUE, Number.MAX_SAFE_INTEGER, 2.5, -3]) {
    const numeric = evidence.foldMemoryEvidence({ unitId: 'T01', facts: [{ mem_id: 'MEM001' }], stats: [{ kind: 'seed', mem_id: 'MEM001', hits }] });
    assert.equal(numeric.entries[0].legacyProjection.hits, hits);
    assert.equal(numeric.entries[0].legacyPublication.hits, hits);
  }
});

test('orphan inputs and finite arithmetic overflow cannot escape as nonfinite scores', t => {
  const cwd = fixture(t, []);
  fs.writeFileSync(path.join(cwd, '.gsd', 'memory', 'legacy-orphan.md'), [
    '## [MEM001] pattern', '- text: synthetic cache', '- confidence: 2', `- hits: ${'9'.repeat(308)}`,
    '## [MEM002] pattern', '- text: synthetic cache', '- confidence: Infinity', `- hits: ${'9'.repeat(400)}`,
    '## [MEM003] pattern', '- text: synthetic cache', '- confidence: -2', `- hits: ${'9'.repeat(308)}`,
  ].join('\n'));
  const result = projection.queryMemoryEntries(cwd, { ...opts, diagnostic: true });
  assertFinite(result);
  assert.deepEqual(result.entries.map(x => [x.mem_id, x.score]), [['MEM001', Number.MAX_VALUE], ['MEM002', 100.5], ['MEM003', -Number.MAX_VALUE]]);
});
