#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFragment } = require('./forge-memory.js');
const { renderMemory, queryMemoryEntries } = require('./forge-projection.js');
const { selectMemoryContext, MEMORY_HEADER } = require('./forge-memory-context.js');
const diagnostic = require('./forge-memory-diagnostic.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-context-'));
const nowMs = Date.parse('2026-10-20T00:00:00Z');
let count = 0;
function test(name, fn) { fn(); count++; console.log(`ok ${count} - ${name}`); }
function select(opts = {}) { return selectMemoryContext({ cwd: root, nowMs, query: 'ultraviolet', ...opts }); }
function strings(value) {
  if (typeof value === 'string') return [value];
  return value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
}
function parity(opts = {}) {
  const off = select({ ...opts, diagnostic: false });
  const on = select({ ...opts, diagnostic: true });
  const { diagnostic: trace, ...base } = on;
  assert.deepStrictEqual(base, off);
  assert(!Object.hasOwn(off, 'diagnostic'));
  assert.deepStrictEqual(select(opts), off);
  assert.equal(trace.emitted_bytes, Buffer.byteLength(JSON.stringify(trace), 'utf8'));
  assert(trace.emitted_bytes <= diagnostic.LIMITS.max_bytes);
  assert(trace.candidates.length <= diagnostic.LIMITS.max_candidates);
  for (const candidate of trace.candidates) {
    assert(diagnostic.PRIMARY_REASONS.includes(candidate.reasons[0]));
    assert(candidate.reasons.slice(1).every(reason => diagnostic.MODIFIER_REASONS.includes(reason)));
    assert.equal(new Set(candidate.reasons).size, candidate.reasons.length);
    assert(candidate.reasons.length <= diagnostic.LIMITS.max_reasons);
  }
  for (const stage of Object.values(trace.stages)) {
    assert(diagnostic.AVAILABILITY.includes(stage.availability));
    if (stage.availability === 'unavailable') assert(diagnostic.STAGE_REASONS.includes(stage.reason));
  }
  return on;
}
function entry(identity, text = 'ultraviolet fact', matched_terms = ['ultraviolet']) {
  return { identity, text, matched_terms };
}
function provider(entries, extras = {}) {
  return () => ({ entries, markdown: 'unused private provider markdown', ...extras });
}
try {
  test('missing store has independent absence evidence', () => {
    const r = select(); assert.equal(r.reason, 'store-missing'); assert.equal(r.source.availability, 'missing');
  });
  test('diagnostic missing store observes ENOENT and leaves downstream unavailable', () => {
    const r = parity();
    assert.equal(r.reason, 'store-missing');
    assert.equal(r.diagnostic.stages.source.availability, 'observed');
    assert.equal(r.diagnostic.stages.source.store, 'missing');
    for (const name of ['projection', 'ranking', 'context']) assert.equal(r.diagnostic.stages[name].reason, 'store-missing');
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
  test('T03 truth 0: on/off deep parity covers all existing selector branches', () => {
    const cases = [
      { query: '' }, { limit: 0 }, { maxTokens: 0 }, { maxTokens: 1 }, { maxTokens: 10 }, {},
      { query: 'unknownterm', unitType: 'execute-task' }, { query: 'the and para' },
      { memoryProvider: provider([entry('T03/MEM001')], { schema_partial: true }) },
      { memoryProvider: () => { throw new Error('private provider error text'); } },
    ];
    for (const opts of cases) parity(opts);
    const base = select();
    assert(!Object.hasOwn(base, 'diagnostic'));
    assert.equal(parity().status, 'selected');
    assert.equal(parity({ memoryProvider: provider([entry('T03/MEM001')], { schema_partial: true }) }).status, 'partial');
    assert.equal(parity({ query: 'unknownterm', unitType: 'execute-task' }).status, 'empty');
  });
  test('T03 truth 1: context counts and original ranks preserve selection and attribute bounded trace positions', () => {
    const r = parity();
    const c = r.diagnostic.stages.context;
    assert.equal(c.availability, 'observed');
    assert.equal(c.limit, 8); assert.equal(c.max_tokens, 2000);
    assert.equal(c.header_chars, 36); assert.equal(MEMORY_HEADER.length, 36);
    assert.equal(c.content_tokens, 1991);
    assert.equal(c.received, 8); assert.equal(c.filtered_no_terms, 7);
    assert.equal(c.included, 1); assert.equal(c.limit_cut, 0); assert.equal(c.invalid_identity, 0);
    assert.equal(c.budget_cut, 0); assert.equal(c.text_truncated, 0); assert.equal(c.unattributed_positions, 0);
    assert.equal(c.markdown_bytes, r.emitted_bytes); assert.equal(c.truncated, r.truncated);
    assert.deepStrictEqual(r.diagnostic.candidates.slice(0, 8).map(candidate => candidate.reasons[0]),
      ['included', ...Array(7).fill('context-no-matched-terms')]);
    assert(r.diagnostic.candidates.slice(8).every(candidate => candidate.reasons[0] === 'rank-limit'));
    assert.equal(r.diagnostic.stages.source.store, 'present');
    const bound = diagnostic.boundDiagnostic;
    let calls = 0;
    try {
      // Drop an original position and erase identities: attribution must still use rank.
      diagnostic.boundDiagnostic = raw => {
        const out = bound(raw);
        if (++calls === 1) out.candidates = out.candidates.slice(1).map(candidate => ({ ...candidate, identity: null }));
        return out;
      };
      const dropped = select({ diagnostic: true });
      assert.equal(dropped.diagnostic.stages.context.unattributed_positions, 1);
      assert.deepStrictEqual(dropped.diagnostic.candidates.slice(0, 7).map(candidate => candidate.rank), [1, 2, 3, 4, 5, 6, 7]);
      assert(dropped.diagnostic.candidates.slice(0, 7).every(candidate => candidate.reasons[0] === 'context-no-matched-terms'));
      assert.equal(dropped.diagnostic.total_candidates, r.diagnostic.total_candidates);
    } finally { diagnostic.boundDiagnostic = bound; }
    const many = parity({ memoryProvider: provider(Array.from({ length: 70 }, (_, i) => entry(`T03/M${i}`))) });
    assert.equal(many.diagnostic.total_candidates, 70);
    assert.equal(many.diagnostic.stages.context.unattributed_positions, 70 - many.diagnostic.candidates.length);
    assert.equal(many.diagnostic.candidates.length, 64);
    assert.equal(many.diagnostic.omitted_candidates, 6);
    const longTrace = parity({ memoryProvider: provider(Array.from({ length: 70 }, (_, i) => entry(`T03/${String(i).padStart(3, '0')}${'x'.repeat(230)}`))) });
    assert.equal(longTrace.diagnostic.stages.context.unattributed_positions, 70 - longTrace.diagnostic.candidates.length);
    try {
      // Simulate a final bound retaining fewer positions than the ranking bound.
      diagnostic.boundDiagnostic = raw => bound(raw.stages.context.availability === 'observed'
        ? { ...raw, candidates: raw.candidates.slice(0, 2) } : raw);
      const finalCut = select({ diagnostic: true });
      assert.equal(finalCut.diagnostic.candidates.length, 2);
      assert.equal(finalCut.diagnostic.stages.context.unattributed_positions, 6);
    } finally { diagnostic.boundDiagnostic = bound; }
  });
  test('T03 truth 2: canonical stopwords and override context reasons preserve markdown and selection', () => {
    const stopwords = parity({ query: 'the and para' }).diagnostic;
    assert.equal(stopwords.stages.ranking.eligible, stopwords.stages.ranking.examined);
    assert.equal(stopwords.stages.context.filtered_no_terms, stopwords.stages.context.received);
    assert(stopwords.stages.context.filtered_no_terms > 0);
    assert(stopwords.candidates.filter(candidate => candidate.rank < stopwords.stages.context.received)
      .every(candidate => candidate.reasons[0] === 'context-no-matched-terms'));
    const cut = parity({ limit: 1, memoryProvider: provider([
      entry('T03/FILTERED', 'no terms', []), entry('T03/MEM001'), entry('T03/MEM002'),
    ]) }).diagnostic;
    assert.deepStrictEqual(cut.candidates.map(candidate => candidate.reasons[0]), ['context-no-matched-terms', 'included', 'context-limit']);
    assert.equal(cut.stages.context.limit_cut, 1);
    const invalid = parity({ memoryProvider: provider([
      entry('../x'), entry('T03/NONTEXT', null), entry('T03/MEM001'), entry('T03/dots..ok'),
    ]) }).diagnostic;
    assert.equal(invalid.candidates[0].identity, null); assert.equal(invalid.candidates[0].rank, 0);
    assert.equal(invalid.candidates[0].reasons[0], 'context-invalid-identity');
    assert.equal(invalid.candidates[1].reasons[0], 'context-invalid-identity');
    assert.equal(invalid.candidates[2].reasons[0], 'included');
    assert.equal(invalid.candidates[3].identity, 'T03/dots..ok');
    assert.equal(invalid.stages.context.invalid_identity, 2);
    for (const maxTokens of [16, 32]) {
      const small = parity({ maxTokens, memoryProvider: provider([
        entry('T03/LONG', 'private long fact '.repeat(80)), entry('T03/NEXT'), entry('T03/LAST'),
      ]) }).diagnostic;
      assert.deepStrictEqual(small.candidates.map(candidate => candidate.reasons),
        [['included', 'context-text-truncated'], ['context-budget'], ['context-budget']]);
      assert.equal(small.stages.context.text_truncated, 1); assert.equal(small.stages.context.budget_cut, 2);
      assert.equal(small.stages.context.included, 1); assert.equal(small.stages.context.content_tokens, maxTokens - 9);
      assert(small.candidates.every(candidate => candidate.components === null));
      assert.deepStrictEqual(small.candidates.map(candidate => candidate.rank), [0, 1, 2]);
    }
  });
  test('T03 truth 3: unavailable source states validation and diagnostic failure remain independent', () => {
    for (const [opts, reason] of [
      [{ limit: 0 }, 'disabled'], [{ maxTokens: 0 }, 'disabled'], [{ query: '' }, 'no-query'],
      [{ maxTokens: 1 }, 'insufficient-budget'], [{ maxTokens: 10 }, 'insufficient-budget'],
    ]) {
      let calls = 0;
      const r = parity({ ...opts, memoryProvider: () => { calls++; throw new Error('must not call'); } });
      assert.equal(calls, 0);
      for (const stage of Object.values(r.diagnostic.stages)) {
        assert.equal(stage.availability, 'unavailable'); assert.equal(stage.reason, reason);
      }
      assert.equal(r.diagnostic.stages.context.header_chars, 36);
    }
    let calls = 0;
    for (const value of [1, null, 'true', {}, []]) assert.throws(() => select({
      diagnostic: value, memoryProvider: () => { calls++; },
    }), /^Error: Invalid memory diagnostic$/);
    assert.equal(calls, 0);
    const failed = parity({ memoryProvider: () => { throw new Error('private source failure'); } });
    assert.equal(failed.diagnostic.stages.source.store, 'unknown');
    for (const stage of Object.values(failed.diagnostic.stages)) assert.equal(stage.reason, 'source-failed');
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-context-diagnostic-broken-'));
    try {
      fs.mkdirSync(path.join(broken, '.gsd'));
      fs.writeFileSync(path.join(broken, '.gsd/memory'), 'not a directory');
      const r = parity({ cwd: broken });
      assert.equal(r.status, 'optional-error'); assert.equal(r.diagnostic.stages.source.store, 'present');
      for (const stage of Object.values(r.diagnostic.stages)) assert.equal(stage.reason, 'source-failed');
    } finally { fs.rmSync(broken, { recursive: true, force: true }); }
    const bound = diagnostic.boundDiagnostic;
    const off = select();
    try {
      diagnostic.boundDiagnostic = () => { throw new Error('private diagnostic failure'); };
      const { diagnostic: trace, ...base } = select({ diagnostic: true });
      assert.deepStrictEqual(base, off);
      assert.equal(trace.reason, 'diagnostic-failed');
      assert(Object.values(trace.stages).every(stage => stage.reason === 'diagnostic-failed'));
    } finally { diagnostic.boundDiagnostic = bound; }
    const direct = queryMemoryEntries(root, { query: 'ultraviolet', nowMs, diagnostic: true });
    assert.equal(direct.diagnostic.stages.context.reason, 'not-reached');
  });
  test('T03 truth 4 and key link 2: override arguments call count privacy and on/off metadata remain isolated', () => {
    const privateValues = ['private query sentinel', 'private fact sentinel', 'private warning sentinel', 'private error sentinel', root];
    const calls = [];
    const memoryProvider = args => {
      calls.push(args);
      return { entries: [entry('T03/MEM001', privateValues[1])], markdown: privateValues[1],
        schema_partial: true, schema_warning: privateValues[2], diagnostic: { secret: privateValues.join(' ') } };
    };
    const off = select({ query: privateValues[0], memoryProvider });
    const on = select({ query: privateValues[0], memoryProvider, diagnostic: true });
    assert.equal(calls.length, 2); assert.deepStrictEqual(calls[0], calls[1]);
    assert(!Object.hasOwn(calls[1], 'diagnostic'));
    const { diagnostic: trace, ...base } = on;
    assert.deepStrictEqual(base, off);
    assert.equal(trace.stages.source.provider, 'override'); assert.equal(trace.stages.source.store, 'unknown');
    for (const name of ['projection', 'ranking']) {
      assert.equal(trace.stages[name].availability, 'unavailable');
      assert.equal(trace.stages[name].reason, 'override-provider');
    }
    assert.equal(trace.candidates[0].components, null); assert.equal(trace.candidates[0].evidence_origin, null);
    const branches = [on, ...[
      { query: privateValues[0] }, { query: '' }, { limit: 0 }, { maxTokens: 0 }, { maxTokens: 1 }, { maxTokens: 10 },
      { query: 'the and para' }, { memoryProvider: () => { throw new Error(privateValues[3]); } },
      { memoryProvider: provider([entry('../x', privateValues[1])]) },
      { maxTokens: 16, memoryProvider: provider([entry('T03/MEM001', privateValues[1].repeat(100))]) },
      { memoryProvider: provider([], { schema_partial: true, schema_warning: privateValues[2] }) },
    ].map(opts => parity(opts))];
    for (const r of branches) {
      for (const value of strings(r.diagnostic)) for (const secret of privateValues) assert(!value.includes(secret));
      assert.equal(r.diagnostic.emitted_bytes, Buffer.byteLength(JSON.stringify(r.diagnostic)));
      assert(r.diagnostic.emitted_bytes <= 32768);
    }
  });
  test('T03 key link 0: canonical queryRelevant diagnostic copy preserves ranking trace and base API', () => {
    const on = parity({ unitType: 'execute-task' });
    const direct = queryMemoryEntries(root, { query: 'ultraviolet', nowMs, unitType: 'execute-task',
      limit: on.limit, maxTokens: on.max_tokens - 9, diagnostic: true });
    assert.deepStrictEqual(on.diagnostic.stages.ranking, direct.diagnostic.stages.ranking);
    assert.deepStrictEqual(on.diagnostic.candidates.map(candidate => candidate.components), direct.diagnostic.candidates.map(candidate => candidate.components));
    assert.equal(on.diagnostic.stages.context.included, on.selected.length);
    assert.equal(on.diagnostic.stages.projection.availability, 'observed');
  });
  test('T03 key link 1: namespace boundDiagnostic and unavailableDiagnostic isolate injected failures', () => {
    const bound = diagnostic.boundDiagnostic;
    const unavailable = diagnostic.unavailableDiagnostic;
    let boundCalls = 0; let fallbackCalls = 0;
    try {
      diagnostic.boundDiagnostic = () => { boundCalls++; throw new Error('private diagnostic error'); };
      diagnostic.unavailableDiagnostic = reason => { fallbackCalls++; return unavailable(reason); };
      const opts = { memoryProvider: provider([entry('T03/MEM001')]) };
      const off = select(opts);
      const { diagnostic: trace, ...base } = select({ ...opts, diagnostic: true });
      assert.deepStrictEqual(base, off);
      assert.equal(boundCalls, 1); assert.equal(fallbackCalls, 1); assert.equal(trace.reason, 'diagnostic-failed');
    } finally { diagnostic.boundDiagnostic = bound; diagnostic.unavailableDiagnostic = unavailable; }
  });
  console.log(`${count} memory-context contract tests passed`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
