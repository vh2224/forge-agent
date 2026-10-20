#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFragment } = require('./forge-memory.js');
const { renderMemory, queryMemoryEntries } = require('./forge-projection.js');
const { selectMemoryContext, MEMORY_HEADER } = require('./forge-memory-context.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-context-'));
const nowMs = Date.parse('2026-10-20T00:00:00Z');
let count = 0;
function test(name, fn) { fn(); count++; console.log(`ok ${count} - ${name}`); }
function select(opts = {}) { return selectMemoryContext({ cwd: root, nowMs, query: 'ultraviolet', ...opts }); }
try {
  test('missing store has independent absence evidence', () => {
    const r = select(); assert.equal(r.reason, 'store-missing'); assert.equal(r.source.availability, 'missing');
  });
  writeFragment(root, { unit_id: 'T01', facts: Array.from({ length: 12 }, (_, i) => ({
    mem_id: `MEM${String(i + 1).padStart(3, '0')}`, category: 'gotcha',
    text: i === 11 ? 'ultraviolet résumé cache sentinel' : `unrelated furniture ${i}`,
    source_unit: 'execute-task/T01', created_at: '2026-10-20T00:00:00Z', confidence_base: i === 11 ? 0.1 : 0.9,
  })), stats: [] });
  test('discriminating old first-ten baseline omits the relevant twelfth fact', () => {
    const old = renderMemory(root);
    const starts = [...old.matchAll(/^<!-- gsd-auto-memory /gm)].map(m => m.index);
    assert.equal(starts.length, 12);
    assert(!old.slice(0, starts[10]).includes('ultraviolet'));
    assert(select().markdown.includes('ultraviolet'));
    assert.deepEqual(select().selected.map(e => e.identity), ['T01/MEM012']);
  });
  test('canonical delegate and phase mapping preserve identity and request provenance', () => {
    const r = select({ phase: 'execute', taskId: 'T02', unitId: 'T02' });
    assert.equal(r.unit_type, 'execute-task'); assert.equal(r.unit.taskId, 'T02');
    assert.equal(r.selected[0].source_unit, 'execute-task/T01');
    assert.equal(r.selected[0].source, '.gsd/memory');
    assert.equal(r.selected[0].identity, queryMemoryEntries(root, {query:'ultraviolet', nowMs}).entries[0].identity);
  });
  test('empty or useless query and nonmatch never fall back to first facts', () => {
    assert.equal(select({ query: '' }).reason, 'no-query');
    assert.equal(select({ query: 'the and para' }).reason, 'no-match');
    assert.equal(select({ query: 'unknownterm' }).markdown, '');
    assert.equal(select({ query: 'unknownterm' }).source.availability, 'present');
  });
  test('zero and tiny budgets do not call provider or round up', () => {
    const memoryProvider = () => { throw new Error('must not call'); };
    for (const opts of [{ maxTokens: 0 }, { limit: 0 }, { maxTokens: 1 }]) {
      const r = select({ ...opts, memoryProvider }); assert.equal(r.markdown, ''); assert.notEqual(r.status, 'optional-error');
    }
  });
  test('full emitted section includes header in char budget and separately measures UTF8', () => {
    for (const maxTokens of [2, 10, 16, 32, 2000]) {
      const r = select({ maxTokens }); assert(r.markdown.length <= maxTokens * 4);
      assert(r.estimated_tokens <= maxTokens); assert.equal(r.emitted_bytes, Buffer.byteLength(r.markdown));
      if (r.markdown) assert(r.markdown.startsWith(MEMORY_HEADER));
    }
    const r = select(); assert(r.emitted_bytes > r.markdown.length);
  });
  test('fixed-clock tie and count cap keep canonical order', () => {
    const opts = { query: 'unrelated', limit: 2 };
    assert.deepEqual(select(opts), select(opts));
    assert.deepEqual(select(opts).selected.map(e => e.identity), queryMemoryEntries(root, { ...opts, nowMs }).entries.map(e => e.identity));
    assert.equal(select(opts).selected.length, 2);
  });
  test('configuration rejects invalid inputs even before optional source handling', () => {
    for (const opts of [{ limit: -1 }, { limit: 51 }, { maxTokens: null }, { maxTokens: '2x' }, { query: {} }, { query: 'a\0b' }, { phase: 'bogus' }, { nowMs: NaN }, { memoryProvider: true }]) {
      assert.throws(() => select(opts), /Invalid memory/);
    }
  });
  test('provider failures and malformed output are sanitized and availability stays unknown', () => {
    for (const memoryProvider of [() => { throw new Error(`${root} PRIVATE_QUERY`); }, () => ({ entries: null })]) {
      const r = select({ memoryProvider }); assert.equal(r.status, 'optional-error');
      assert.equal(r.source.availability, 'unknown'); assert(!JSON.stringify(r).includes(root)); assert(!JSON.stringify(r).includes('PRIVATE_QUERY'));
    }
  });
  test('schema partial warnings stay explicit without copying raw warning or fact', () => {
    const r = select({ memoryProvider: q => ({ ...queryMemoryEntries(root, q), schema_partial: true, schema_warning: root + ' SECRET' }) });
    assert.equal(r.status, 'partial'); assert.equal(r.warning, 'schema-partial');
    const { markdown, ...metadata } = r; assert(!JSON.stringify(metadata).includes('ultraviolet')); assert(!JSON.stringify(metadata).includes(root));
  });
  test('legacy orphan fragments are queried through the canonical store', () => {
    const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-legacy-'));
    try {
      fs.mkdirSync(path.join(legacy, '.gsd/memory'), { recursive: true });
      fs.writeFileSync(path.join(legacy, '.gsd/memory/legacy-orphan.md'), '## [MEM099] gotcha\n- text: ultraviolet legacy sentinel\n- confidence: 0.8\n- hits: 1\n');
      assert(selectMemoryContext({ cwd: legacy, query: 'ultraviolet', nowMs }).markdown.includes('legacy sentinel'));
    } finally { fs.rmSync(legacy, { recursive: true, force: true }); }
  });
  test('invalid projection source is optional failure, never a missing-store claim', () => {
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-broken-'));
    try {
      fs.mkdirSync(path.join(broken, '.gsd'));
      fs.writeFileSync(path.join(broken, '.gsd/memory'), 'not a directory');
      const r = selectMemoryContext({ cwd: broken, query: 'ultraviolet' });
      assert.equal(r.status, 'optional-error'); assert.notEqual(r.source.availability, 'missing');
    } finally { fs.rmSync(broken, { recursive: true, force: true }); }
  });
  test('real ahead schema reports partial, invalid stamp remains guarded fail-open', () => {
    const stamp = path.join(root, '.gsd/SCHEMA-VERSION');
    fs.writeFileSync(stamp, 'fragment-store@999.0.0\n');
    assert.equal(select().schema_partial, true);
    fs.writeFileSync(stamp, 'invalid schema');
    assert.equal(select().status, 'selected');
    fs.unlinkSync(stamp);
  });
  console.log(`${count} memory-context contract tests passed`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
