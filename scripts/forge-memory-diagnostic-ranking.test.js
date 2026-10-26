#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const memory = require('./forge-memory.js');
const projection = require('./forge-projection.js');
const diagnostic = require('./forge-memory-diagnostic.js');
const fixture = require('./fixtures/memory-evidence/v1.json');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-diagnostic-ranking-'));
const nowMs = Date.parse(fixture.now);
let count = 0;
function test(name, fn) { fn(); count++; console.log(`ok ${count} - ${name}`); }
function strings(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]);
}
function snapshot(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(dir, entry.name);
    const relative = path.relative(root, file);
    if (entry.isDirectory()) return [{ path: relative, type: 'directory' }, ...snapshot(file)];
    const bytes = fs.readFileSync(file);
    return [{ path: relative, type: 'file', size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex') }];
  });
}
function fact(id, extra = {}) {
  return { mem_id: id, category: 'gotcha', text: 'ultraviolet cache reusable constraint',
    confidence_base: 0.9, created_at: fixture.now, source_unit: 'execute-task/T20', ...extra };
}
function query(opts = {}) {
  return projection.queryMemoryEntries(root, { query: 'ultraviolet cache', unitType: 'execute-task', nowMs, ...opts });
}
function base(result) { const { diagnostic: ignored, ...rest } = result; return rest; }
function bounded(result) {
  const d = result.diagnostic;
  assert(d.candidates.length <= diagnostic.LIMITS.max_candidates);
  assert.equal(d.emitted_bytes, Buffer.byteLength(JSON.stringify(d), 'utf8'));
  assert(d.emitted_bytes <= diagnostic.LIMITS.max_bytes);
  assert.equal(d.omitted_candidates, d.total_candidates - d.candidates.length);
  return d;
}
try {
  memory.writeFragment(root, { unit_id: 'T20', facts: Array.from({ length: 5 }, (_, i) => fact(`MEM00${i}`)), stats: [] });
  fs.mkdirSync(path.join(root, 'empty-directory'));
  fs.writeFileSync(path.join(root, 'empty-file'), '');
  test('truth 1: disabled query/projection/render/public seam preserve shape and deep equality', () => {
    assert.deepStrictEqual(query(), query({ diagnostic: false }));
    assert(!Object.hasOwn(query(), 'diagnostic'));
    const state = projection.projectMemoryState(root, { nowMs });
    assert.deepStrictEqual(state, projection.projectMemoryState(root, { nowMs, diagnostic: false }));
    assert(!Object.hasOwn(state.diagnostics, 'selection_trace'));
    const traced = projection.projectMemoryState(root, { nowMs, diagnostic: true });
    const { selection_trace: trace, ...diagnostics } = traced.diagnostics;
    assert.deepStrictEqual({ ...traced, diagnostics }, state);
    assert.deepStrictEqual(trace, { pruned_excluded: 0, superseded_excluded: 0, orphans_shadowed: 0 });
    const originalNow = Date.now;
    try {
      Date.now = () => nowMs;
      assert.equal(projection.renderMemory(root), projection.renderMemory(root));
    } finally { Date.now = originalNow; }
    const original = projection.queryMemoryEntries;
    const received = [];
    try {
      projection.queryMemoryEntries = (cwd, opts) => { received.push(opts); return original(cwd, opts); };
      const q = { cwd: root, query: 'ultraviolet cache', unitType: 'execute-task', nowMs };
      assert.deepStrictEqual(memory.queryRelevant(q), query());
      assert.deepStrictEqual(Object.keys(received[0]), ['unitType', 'query', 'limit', 'maxTokens', 'nowMs']);
      memory.queryRelevant({ ...q, diagnostic: false });
      assert.strictEqual(received.at(-1).diagnostic, false);
    } finally { projection.queryMemoryEntries = original; }
  });
  test('public seam rejects invalid diagnostic flags before schema reads or warnings', () => {
    const future = path.join(root, 'future-schema');
    fs.mkdirSync(path.join(future, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(future, '.gsd/SCHEMA-VERSION'), 'fragment-store@999.0.0\n');
    const guard = require('./forge-schema-guard.js');
    const originalRead = fs.readFileSync;
    const originalWrite = process.stderr.write;
    let schemaReads = 0;
    const warnings = [];
    try {
      fs.readFileSync = function (file, ...args) {
        if (path.basename(String(file)) === 'SCHEMA-VERSION') schemaReads++;
        return originalRead.call(this, file, ...args);
      };
      process.stderr.write = chunk => { warnings.push(String(chunk)); return true; };
      for (const cwd of [root, future]) {
        guard._resetSchemaWarnings();
        for (const value of ['yes', 1, 0, '', null, {}, [], NaN]) {
          assert.throws(() => memory.queryRelevant({ cwd, diagnostic: value }),
            /^Error: Invalid memory diagnostic$/);
          assert.equal(schemaReads, 0);
          assert.equal(warnings.length, 0);
        }
      }
      const results = [];
      for (const flag of [{}, { diagnostic: false }, { diagnostic: true }]) {
        guard._resetSchemaWarnings();
        schemaReads = 0;
        warnings.length = 0;
        results.push(memory.queryRelevant({ cwd: future, nowMs, ...flag }));
        assert(schemaReads > 0);
        assert.equal(warnings.length, 1);
        assert(warnings[0].includes('999.0.0'));
      }
      assert.deepStrictEqual(results[0], results[1]);
      assert(!Object.hasOwn(results[0], 'diagnostic'));
      assert.deepStrictEqual(base(results[2]), results[0]);
      assert.equal(results[2].diagnostic.stages.source.schema_partial, true);
    } finally {
      fs.readFileSync = originalRead;
      process.stderr.write = originalWrite;
      guard._resetSchemaWarnings();
    }
  });
  test('truth 2: fixed-clock base equality and bounded trace use the same reads/sorts and namespace', () => {
    const originalList = memory.listFragments;
    const originalRead = memory.readFragmentText;
    const originalSort = Array.prototype.sort;
    const originalBound = diagnostic.boundDiagnostic;
    let lists = 0, reads = 0, sorts = 0, calls = 0, raw;
    try {
      memory.listFragments = (...args) => { lists++; return originalList(...args); };
      memory.readFragmentText = (...args) => { reads++; return originalRead(...args); };
      Array.prototype.sort = function (...args) { sorts++; return originalSort.apply(this, args); };
      diagnostic.boundDiagnostic = value => { calls++; raw = value; return originalBound(value); };
      const off = query();
      const before = [lists, reads, sorts];
      lists = reads = sorts = 0;
      const on = query({ diagnostic: true });
      assert.deepStrictEqual(base(on), off);
      assert.deepStrictEqual([lists, reads, sorts], before);
      assert.equal(calls, 1);
      assert(raw.candidates.length <= 64);
      assert.deepStrictEqual(on.diagnostic, originalBound(raw));
      bounded(on);
    } finally {
      memory.listFragments = originalList; memory.readFragmentText = originalRead;
      Array.prototype.sort = originalSort; diagnostic.boundDiagnostic = originalBound;
    }
  });
  test('truth 3: components, primary reasons, raw ties, evidence and canonical prefix agree', () => {
    const result = query({ diagnostic: true, limit: 2 });
    const d = bounded(result);
    assert.deepStrictEqual(d.candidates.slice(0, 2).map(c => c.identity), result.entries.map(e => e.identity));
    d.candidates.forEach((c, i) => {
      assert.equal(c.rank, i);
      assert.equal(c.category, 'gotcha');
      assert.equal(c.reasons[0], i < 2 ? 'included' : 'rank-limit');
      assert.equal(c.tie_break, i === 0 ? null : 'identity');
      assert.equal(c.evidence_origin, 'legacy_unknown');
      assert.equal(c.hits_basis, 'legacy_ranking');
      assert.equal(c.identity, `T20/MEM00${i}`);
      const v = c.components;
      assert(Math.abs(v.overlap_points + v.category_points + v.quality - v.score) <= 1e-4);
      if (i < 2) assert.equal(v.score, result.entries[i].score);
      assert.equal(new Set(c.reasons).size, c.reasons.length);
      assert(c.reasons.length <= diagnostic.LIMITS.max_reasons);
    });
    const tiny = query({ diagnostic: true, maxTokens: 2 });
    assert.equal(tiny.entries.length, 0);
    assert(tiny.diagnostic.candidates.every(c => c.reasons[0] === 'ranking-budget'));
    const cut = query({ diagnostic: true, maxTokens: 12 });
    assert.equal(cut.entries.length, 1);
    assert(cut.diagnostic.candidates[0].reasons.includes('ranking-text-truncated'));
    assert(cut.entries[0].text.endsWith('…'));
    assert.equal(cut.diagnostic.candidates[1].reasons[0], 'ranking-budget');
    assert.deepStrictEqual(base(cut), query({ maxTokens: 12 }));
  });
  test('truth 4: stages count overlap, exclusions and shadowed orphans without reintroducing IDs', () => {
    const partial = query({ diagnostic: true, query: 'ultraviolet nonexistent' }).diagnostic;
    assert.equal(partial.stages.ranking.below_minimum_overlap, 5);
    assert.equal(partial.candidates.length, 0);
    assert.equal(query({ diagnostic: true, query: 'unknownterm' }).diagnostic.stages.ranking.eligible, 0);
    const stop = query({ diagnostic: true, query: 'the and para' }).diagnostic;
    assert.equal(stop.stages.ranking.eligible, stop.stages.ranking.examined);
    assert(stop.candidates.every(c => c.components.overlap_count === 0));
    memory.writeFragment(root, fixture.fragment);
    fs.writeFileSync(path.join(root, '.gsd/memory/legacy-orphan.md'),
      '## [MEM001] gotcha\n- text: ultraviolet cache orphan\n- confidence: 0.8\n- hits: 1\n');
    const r = query({ diagnostic: true, query: 'the and para' });
    const d = bounded(r);
    assert(d.stages.projection.pruned_excluded >= 2);
    assert(d.stages.projection.superseded_excluded >= 1);
    assert(d.stages.projection.superseded_excluded <= d.stages.projection.pruned_excluded);
    assert(d.stages.projection.orphans_shadowed >= 1);
    for (const id of ['M001/T01/MEM002', 'M001/T01/MEM003']) {
      assert(!d.candidates.some(c => c.identity === id));
      assert(!r.entries.some(e => e.identity === id));
    }
    assert(d.candidates.every(c => !Object.hasOwn(c, 'superseded')));
    assert.equal(d.stages.projection.evidence_model_version, r.evidence_model_version);
    assert.equal(d.stages.projection.skipped_fragments, 0);
    assert.deepStrictEqual(d.stages.source, { availability: 'observed', reason: null,
      provider: 'canonical', store: 'unknown', schema_partial: false });
    assert.equal(d.stages.context.reason, 'not-reached');
    assert.equal(d.stages.context.availability, 'unavailable');
    const ranking = d.stages.ranking;
    assert.equal(ranking.profile, 'execution'); assert.equal(ranking.minimum_overlap, 0);
    assert.equal(ranking.query_term_count, 0); assert.equal(ranking.examined, 6);
    assert.equal(ranking.eligible, r.considered); assert.equal(ranking.limit, 8);
    assert.equal(ranking.max_tokens, 2000);
    const planning = query({ diagnostic: true, unitType: 'plan-slice' }).diagnostic.stages.ranking;
    assert.equal(planning.profile, 'planning'); assert.equal(planning.minimum_overlap, 1);
    const neutral = query({ diagnostic: true, unitType: 'other' }).diagnostic.stages.ranking;
    assert.equal(neutral.profile, 'neutral'); assert.equal(neutral.minimum_overlap, 0);
  });
  test('truth 5: early flag validation, isolated diagnostic failure, privacy and persistence', () => {
    const before = snapshot(root);
    const originalRead = fs.readFileSync;
    try {
      fs.readFileSync = () => { throw new Error('store must not be read'); };
      assert.throws(() => query({ diagnostic: 'yes' }), /^Error: Invalid memory diagnostic$/);
    } finally { fs.readFileSync = originalRead; }
    const originalBound = diagnostic.boundDiagnostic;
    try {
      diagnostic.boundDiagnostic = () => { throw new Error('PRIVATE FAILURE TEXT'); };
      const failed = query({ diagnostic: true });
      assert.equal(failed.diagnostic.reason, 'diagnostic-failed');
      assert.equal(failed.diagnostic.status, 'unavailable');
      assert.deepStrictEqual(base(failed), query());
    } finally { diagnostic.boundDiagnostic = originalBound; }
    query(); query({ diagnostic: false }); query({ diagnostic: true });
    assert.deepStrictEqual(snapshot(root), before);
    memory.writeFragment(root, { unit_id: 'T21', facts: [fact('MEM999', {
      text: 'ultraviolet cache SECRET FACT TEXT', category: 'PRIVATE CATEGORY TEXT',
    })], stats: [] });
    const r = query({ diagnostic: true, query: 'ultraviolet cache PRIVATE QUERY TEXT' });
    const all = strings(r.diagnostic).join('\n');
    for (const secret of [root, 'PRIVATE QUERY TEXT', 'SECRET FACT TEXT', 'PRIVATE CATEGORY TEXT']) assert(!all.includes(secret));
    assert.equal(r.diagnostic.candidates.find(c => c.identity === 'T21/MEM999').category, 'other');
  });
  test('bounded ranking counts 300 candidates exactly while retaining only the first 64 positions', () => {
    memory.writeFragment(root, { unit_id: 'T30', facts: Array.from({ length: 300 }, (_, i) => fact(`MEM${i}`, { text: 'largefixture' })), stats: [] });
    const r = query({ query: 'largefixture', diagnostic: true });
    const d = bounded(r);
    assert.equal(d.total_candidates, 300); assert.equal(r.considered, 300);
    assert.equal(d.stages.ranking.eligible, 300); assert.equal(d.candidates.length, 64);
    assert.equal(d.omitted_candidates, 236); assert.equal(d.truncated, true);
    assert.deepStrictEqual(d.candidates.map(c => c.rank), Array.from({ length: 64 }, (_, i) => i));
    assert.deepStrictEqual(base(r), query({ query: 'largefixture' }));
  });
  test('key links: public seam delegates diagnostic only when defined to the canonical projection', () => {
    const q = { cwd: root, query: 'ultraviolet cache', nowMs };
    assert(!Object.hasOwn(memory.queryRelevant(q), 'diagnostic'));
    assert.deepStrictEqual(memory.queryRelevant({ ...q, diagnostic: true }),
      projection.queryMemoryEntries(root, { query: q.query, nowMs, diagnostic: true }));
    assert(Object.hasOwn(memory.queryRelevant({ ...q, diagnostic: true }), 'diagnostic'));
  });
  test('invalid fragments, legacy orphans and partial schema retain base output and persistent bytes', () => {
    fs.writeFileSync(path.join(root, '.gsd/memory/T99.md'), 'invalid fragment PRIVATE INVALID TEXT');
    fs.appendFileSync(path.join(root, '.gsd/memory/legacy-orphan.md'),
      '\n## [MEM098] pattern\n- text: ultraviolet cache legacy survivor\n- confidence: 0.5\n- hits: 1\n');
    fs.writeFileSync(path.join(root, '.gsd/SCHEMA-VERSION'), 'fragment-store@999.0.0\n');
    const before = snapshot(root);
    const off = query();
    const on = query({ diagnostic: true });
    assert.deepStrictEqual(base(on), off);
    assert.equal(on.diagnostic.stages.source.schema_partial, true);
    assert(on.diagnostic.candidates.some(c => c.evidence_origin === 'legacy_orphan'));
    assert(!strings(on.diagnostic).join('\n').includes('PRIVATE INVALID TEXT'));
    assert.deepStrictEqual(snapshot(root), before);
  });
  console.log(`${count} diagnostic-ranking contract tests passed`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
