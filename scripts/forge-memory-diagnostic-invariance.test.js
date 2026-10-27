#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const memory = require('./forge-memory.js');
const { renderPrompt } = require('./forge-prompt.js');
const { buildContextBundle, buildContextBundleResult } = require('./forge-context-bundle.js');
const { resolveMemoryQuery } = require('./forge-memory-query.js');
const diagnostic = require('./forge-memory-diagnostic.js');
const codeDir = path.resolve(__dirname, '..');
const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-invariance-'));
const now = Date.parse('2026-10-20T00:00:00Z');
const privateTerms = ['PRIVATE QUERY SENTINEL', 'PRIVATE FACT SENTINEL', 'PRIVATE CATEGORY SENTINEL'];
let count = 0;
function test(name, fn) { fn(); count++; console.log(`ok ${count} - ${name}`); }
function root(name) {
  const dir = path.join(parent, name);
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'empty-directory'));
  fs.writeFileSync(path.join(dir, 'empty-file'), '');
  return dir;
}
function strings(value) {
  if (typeof value === 'string') return [value];
  return value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]) : [];
}
function snapshot(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(dir, entry.name);
    const relative = path.relative(base, file);
    const size = fs.statSync(file).size;
    if (entry.isDirectory()) return [{ path: relative, type: 'directory', size }, ...snapshot(file, base)];
    const bytes = fs.readFileSync(file);
    return [{ path: relative, type: 'file', size, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }];
  });
}
function withClock(ms, fn) {
  const original = Date.now;
  try { Date.now = () => ms; return fn(); } finally { Date.now = original; }
}
function fact(mem_id, extra = {}) {
  return { mem_id, category: 'gotcha', text: 'ultraviolet cache constraint', confidence_base: 0.9,
    created_at: '2026-10-20T00:00:00Z', source_unit: 'execute-task/T01', ...extra };
}
function put(dir, facts) { memory.writeFragment(dir, { unit_id: 'T01', facts, stats: [] }); }
function strip(value) { const { diagnostic: ignored, ...rest } = value; return rest; }
function bounded(d, dir) {
  assert.equal(d.emitted_bytes, Buffer.byteLength(JSON.stringify(d), 'utf8'));
  assert(d.emitted_bytes <= 32768);
  assert(d.candidates.length <= 64);
  assert.equal(d.omitted_candidates, d.total_candidates - d.candidates.length);
  for (const c of d.candidates) {
    assert(diagnostic.PRIMARY_REASONS.includes(c.reasons[0]));
    assert(c.reasons.slice(1).every(reason => diagnostic.MODIFIER_REASONS.includes(reason)));
    assert.equal(c.reasons.length, new Set(c.reasons).size);
    assert(c.reasons.length <= diagnostic.LIMITS.max_reasons);
  }
  privacy(d, dir);
}
function privacy(value, dir) {
  for (const text of strings(value)) {
    for (const sentinel of [...privateTerms, dir]) assert(!text.includes(sentinel));
  }
}
function prompt(dir, opts, on) {
  const seen = [];
  const result = withClock(now, () => renderPrompt({ cwd: dir, codeDir, isolationMode: 'worktree', branch: 'fixture',
    unitType: opts.unitType || 'execute-task', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01',
    dispatchId: 'invariance', autoCommit: false, ledger: '(none)', standardsMaxTokens: 0,
    memoryQuery: opts.query, memoryLimit: opts.limit ?? 10, memoryMaxTokens: opts.maxTokens ?? 2000,
    memoryDiagnostic: on, onMemorySelection: s => seen.push(s), ...opts.prompt }));
  assert.equal(seen.length, 1);
  return { result, selection: seen[0] };
}
function parity(dir, opts = {}) {
  const before = snapshot(dir);
  const options = { cwd: dir, unitType: opts.unitType || 'execute-task', query: opts.query ?? 'ultraviolet cache',
    limit: opts.limit ?? 10, maxTokens: opts.maxTokens ?? 2000 };
  const off = withClock(now, () => buildContextBundleResult(options));
  const on = withClock(now, () => buildContextBundleResult({ ...options, diagnostic: true }));
  const again = withClock(now, () => buildContextBundleResult({ ...options, diagnostic: false }));
  assert.deepStrictEqual(strip(on.selection), off.selection);
  assert.deepStrictEqual(again, off);
  assert.equal(on.markdown, off.markdown);
  assert.equal(withClock(now, () => buildContextBundle({ ...options, diagnostic: true })), off.markdown);
  const p0 = prompt(dir, options, false), p1 = prompt(dir, options, true), p2 = prompt(dir, options, false);
  assert.deepStrictEqual(p0.result, p1.result);
  assert.deepStrictEqual(p0, p2);
  assert.deepStrictEqual(strip(p1.selection), p0.selection);
  assert.deepStrictEqual(p1.selection.selected, on.selection.selected);
  assert.deepStrictEqual(p0.selection.selected, off.selection.selected);
  assert(!p1.result.prompt.includes('"candidates"'));
  assert(!p1.result.prompt.includes('"diagnostic"'));
  const excluded = on.selection.diagnostic.candidates.filter(c => c.decision === 'excluded');
  for (const c of excluded) if (c.identity) assert(!p1.result.prompt.includes(`[${c.identity}]`));
  bounded(on.selection.diagnostic, dir);
  bounded(p1.selection.diagnostic, dir);
  assert.deepStrictEqual(snapshot(dir), before);
  if (fs.statSync(path.join(dir, '.gsd')).isDirectory() && fs.existsSync(path.join(dir, '.gsd/memory/T01.md'))) {
    assert(!memory.readFragment(dir, 'T01').stats.some(s => ['exposure', 'hit'].includes(s.event || s.type)));
  }
  return on;
}
function cli(dir, name, flag, query = 'ultraviolet cache') {
  const out = path.join(parent, `${name}.md`), report = path.join(parent, `${name}.json`);
  const queryFile = path.join(parent, `${name}-query.txt`);
  fs.writeFileSync(queryFile, query);
  const run = spawnSync(process.execPath, [path.join(__dirname, 'forge-context-bundle.js'), '--cwd', dir,
    '--out', out, '--selection-report', report, '--query-file', queryFile, '--unit-type', 'execute-task',
    '--limit', '10', '--max-tokens', '2000', '--memory-diagnostic', flag], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const selection = JSON.parse(fs.readFileSync(report, 'utf8'));
  privacy(selection, dir); privacy(run.stderr, dir);
  return { out: fs.readFileSync(out), selection, stderr: run.stderr };
}
try {
  const direct = root('direct');
  put(direct, [fact('MEM002'), fact('MEM001'), fact('MEM003', { text: 'unrelated furniture' })]);
  test('T04 truth 0: strict bundle API and CLI flags precede store and output writes; metadata never changes bundle string', () => {
    for (const value of [null, 0, 'on', {}, []]) assert.throws(() => buildContextBundleResult({ diagnostic: value,
      get cwd() { throw new Error('store read before validation'); } }), /Invalid memory diagnostic/);
    parity(direct);
    for (const [name, args] of [['missing-report', ['on']], ['invalid', ['maybe']], ['invalid-with-report', ['maybe', '--selection-report', path.join(parent, 'invalid-report')]]]) {
      const out = path.join(parent, name, 'not-created', 'out.md');
      const run = spawnSync(process.execPath, [path.join(__dirname, 'forge-context-bundle.js'), '--cwd', direct,
        '--out', out, '--memory-diagnostic', ...args], { encoding: 'utf8' });
      assert.equal(run.status, 2); assert.equal(run.stderr, 'forge-context-bundle: invalid arguments\n');
      assert(!fs.existsSync(path.dirname(out))); assert(!fs.existsSync(path.join(parent, 'invalid-report')));
    }
  });
  test('T04 truth 1: prompt validation, canonical callback once, unchanged provider arguments and legacy diagnostics', () => {
    for (const memoryDiagnostic of [null, 'on', 0, {}]) assert.throws(() => prompt(direct,
      { query: 'ultraviolet cache', prompt: { memoryDiagnostic, memoryProvider() { throw new Error('provider called'); } } }, false), /Invalid memory diagnostic option/);
    parity(direct);
    for (const directMemories of [false, true]) {
      const calls = [];
      const provider = q => { calls.push(q); return ['ultraviolet cache']; };
      const override = directMemories ? { memories: ['ultraviolet cache'], memoryProvider: provider } : { memoryProvider: provider };
      const a = prompt(direct, { query: 'ultraviolet cache', prompt: override }, false);
      const b = prompt(direct, { query: 'ultraviolet cache', prompt: override }, true);
      const c = prompt(direct, { query: 'ultraviolet cache', prompt: override }, false);
      assert.deepStrictEqual(a.result, b.result); assert.deepStrictEqual(a, c);
      assert.deepStrictEqual(strip(b.selection), a.selection);
      assert.equal(calls.length, directMemories ? 0 : 3);
      if (calls.length) { assert.deepStrictEqual(calls[0], calls[1]); assert.deepStrictEqual(calls[0], calls[2]); assert(!Object.hasOwn(calls[0], 'diagnostic')); }
      for (const stage of Object.values(b.selection.diagnostic.stages)) assert.equal(stage.reason, directMemories ? 'direct-memories' : 'override-provider');
    }
    // cliOptions spreads stdin-json without a dedicated memoryDiagnostic CLI flag.
    const child = spawnSync(process.execPath, [path.join(__dirname, 'forge-prompt.js'), '--stdin-json'], {
      input: JSON.stringify({ cwd: direct, unitType: 'execute-task', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01', memoryDiagnostic: 'on' }), encoding: 'utf8' });
    assert.notEqual(child.status, 0); assert(child.stderr.includes('Invalid memory diagnostic option'));
  });
  test('T04 truth 2: fixed-clock on/off/off package parity, lexical edge cases, invalid sources and complete persistence snapshot', () => {
    for (const query of ['ultraviolet cache', 'violet storage policy', 'ultraviolet alien', 'missingterm', 'the and para']) {
      for (const unitType of ['execute-task', 'plan-slice']) {
        const r = parity(direct, { query, unitType });
        if (query === 'ultraviolet alien') {
          assert.equal(r.selection.diagnostic.stages.ranking.minimum_overlap, unitType === 'execute-task' ? 2 : 1);
          assert.equal(r.selection.selected.length, unitType === 'execute-task' ? 0 : 2);
        }
        if (query === 'violet storage policy') assert(r.selection.diagnostic.stages.ranking.below_minimum_overlap > 0);
      }
    }
    const tie = parity(direct).selection.diagnostic.candidates;
    assert.deepStrictEqual(tie.map(c => c.identity), ['T01/MEM001', 'T01/MEM002']); assert.equal(tie[1].tie_break, 'identity');
    for (const maxTokens of [0, 2, 10, 16, 32]) parity(direct, { maxTokens });
    parity(direct, { limit: 0 });
    for (const setting of [{ limit: 0 }, { maxTokens: 0 }]) {
      let calls = 0;
      for (const on of [false, true, false]) {
        const result = prompt(direct, { ...setting, query: 'ultraviolet cache', prompt: { memoryProvider() { calls++; return []; } } }, on);
        assert.equal(result.selection.status, 'disabled');
        assert.equal(buildContextBundleResult({ cwd: direct, query: 'ultraviolet cache', ...setting, diagnostic: on,
          memoryProvider() { calls++; return { entries: [], markdown: '' }; } }).selection.status, 'disabled');
      }
      assert.equal(calls, 0);
    }
    const invalid = root('invalid-source'); fs.writeFileSync(path.join(invalid, '.gsd/memory'), 'not a directory');
    const failed = parity(invalid); assert.equal(failed.selection.status, 'optional-error');
    assert.equal(failed.selection.diagnostic.stages.ranking.reason, 'source-failed');
    const unavailable = resolveMemoryQuery({ cwd: direct, unitType: 'execute-task', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01' });
    assert.equal(unavailable.status, 'unavailable');
    assert.equal(parity(direct, { query: unavailable.query_file ? fs.readFileSync(unavailable.query_file, 'utf8') : '' }).selection.diagnostic.stages.context.reason, 'no-query');
    assert(!memory.readFragment(direct, 'T01').stats.some(s => ['exposure', 'hit'].includes(s.event || s.type)));
  });
  test('T04 truth 3: child CLI compares selected identities/order, output bytes and stderr; API-equivalent diagnostic structure and compact bound', () => {
    const before = snapshot(direct), a = cli(direct, 'off', 'off'), b = cli(direct, 'on', 'on'), c = cli(direct, 'off-again', 'off');
    assert.deepStrictEqual(a.out, b.out); assert.deepStrictEqual(a.out, c.out);
    assert.deepStrictEqual(a.selection.selected, b.selection.selected); assert.deepStrictEqual(a.selection.selected, c.selection.selected);
    assert.equal(a.stderr, b.stderr); assert.equal(a.stderr, c.stderr); bounded(b.selection.diagnostic, direct);
    // Different processes use different clocks: compare the complete schema, not time-sensitive numeric values.
    function shape(v) { return Array.isArray(v) ? v.map(shape) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : v === null ? null : typeof v; }
    const api = buildContextBundleResult({ cwd: direct, query: 'ultraviolet cache', unitType: 'execute-task', limit: 10, maxTokens: 2000, diagnostic: true });
    assert.deepStrictEqual(shape(b.selection.diagnostic), shape(api.selection.diagnostic));
    assert.deepStrictEqual(snapshot(direct), before);
  });
  test('T04 truth 4: 500KiB query, 300 facts, separately measured item/byte cuts, private text exclusion and identical oversized-query errors', () => {
    const query = 'ultraviolet cache ' + privateTerms[0] + ' ' + 'x'.repeat(500 * 1024 - 100);
    assert(Buffer.byteLength(query) < 524288);
    for (const long of [false, true]) {
      const dir = root(long ? 'large-long' : 'large-short');
      put(dir, Array.from({ length: 300 }, (_, i) => fact(`MEM${String(i).padStart(3, '0')}${long ? 'a'.repeat(225) : ''}`,
        { text: `ultraviolet cache ${privateTerms[1]}`, category: privateTerms[2] })));
      const r = parity(dir, { query, limit: 50, maxTokens: 16000 });
      const d = r.selection.diagnostic; assert.equal(d.total_candidates, 300); assert(d.omitted_candidates > 0); assert(d.truncated);
      if (long) assert(d.candidates.length < 64); else assert.equal(d.candidates.length, 64);
      console.log(`measured ${long ? 'byte' : 'item'} cut: ${d.emitted_bytes} bytes, ${d.candidates.length}/300 candidates`);
      const before = snapshot(dir);
      const child = cli(dir, long ? 'large-long' : 'large-short', 'on', query); bounded(child.selection.diagnostic, dir);
      const off = cli(dir, long ? 'large-long-off' : 'large-short-off', 'off', query);
      const again = cli(dir, long ? 'large-long-off-again' : 'large-short-off-again', 'off', query);
      assert.deepStrictEqual(child.out, off.out); assert.deepStrictEqual(off.out, again.out);
      assert.deepStrictEqual(child.selection.selected, off.selection.selected); assert.deepStrictEqual(off.selection.selected, again.selection.selected);
      assert.equal(child.stderr, off.stderr); assert.equal(off.stderr, again.stderr);
      assert.deepStrictEqual(snapshot(dir), before);
      for (const on of [false, true]) {
        assert.throws(() => buildContextBundleResult({ cwd: dir, query: 'x'.repeat(524289), diagnostic: on }), /^Error: Invalid memory query$/);
        assert.throws(() => prompt(dir, { query: 'x'.repeat(524289) }, on), /^Error: Invalid memory query$/);
      }
    }
  });
  test('T04 key link 0: bundle forwards opt-in to canonical context while keeping override arguments unchanged', () => {
    const calls = [], provider = q => { calls.push(q); return { entries: [{ identity: 'T01/MEM001', text: 'ultraviolet cache', matched_terms: ['ultraviolet'] }], markdown: '' }; };
    const a = buildContextBundleResult({ cwd: direct, query: 'ultraviolet cache', memoryProvider: provider });
    const b = buildContextBundleResult({ cwd: direct, query: 'ultraviolet cache', memoryProvider: provider, diagnostic: true });
    assert.deepStrictEqual(a.selection, strip(b.selection)); assert.equal(a.markdown, b.markdown);
    assert.equal(calls.length, 2); assert.deepStrictEqual(calls[0], calls[1]); assert(!Object.hasOwn(calls[0], 'diagnostic'));
    assert.equal(b.selection.diagnostic.stages.projection.reason, 'override-provider');
    assert.equal(b.selection.diagnostic.stages.ranking.reason, 'override-provider');
  });
  test('T04 key link 1: canonical prompt selection callback receives diagnostic once without altering final prompt', () => { parity(direct); });
  test('T04 key link 2: legacy prompt callback uses bounded unavailableDiagnostic direct-memories and override-provider', () => {
    for (const [override, reason] of [[{ memories: ['fact'] }, 'direct-memories'], [{ memoryProvider: () => ['fact'] }, 'override-provider']]) {
      const r = prompt(direct, { query: 'ultraviolet cache', prompt: override }, true);
      assert.deepStrictEqual(r.selection.diagnostic, diagnostic.unavailableDiagnostic(reason));
    }
  });
  test('T04 key link 3: invariance suite exercises renderPrompt on/off and the final provider prompt', () => { parity(direct, { maxTokens: 32 }); });
  test('T04 key link 4: invariance suite exercises bundle API and child CLI output/report opt-in', () => {
    parity(direct); const a = cli(direct, 'link-off', 'off'), b = cli(direct, 'link-on', 'on');
    assert.deepStrictEqual(a.out, b.out); assert(!Object.hasOwn(a.selection, 'diagnostic')); assert(b.selection.diagnostic);
  });
  test('T04 key link 5: unavailable resolveMemoryQuery supplies empty package query with explicit no-query diagnostic', () => {
    const r = resolveMemoryQuery({ cwd: direct, unitType: 'execute-task', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01' });
    assert.equal(r.status, 'unavailable'); assert.equal(r.query_file, null);
    const bundle = parity(direct, { query: '' }); assert.equal(bundle.selection.reason, 'no-query');
    assert.equal(bundle.selection.diagnostic.stages.context.reason, 'no-query');
  });
  console.log(`${count} final-package invariance tests passed (offline fixtures; no provider/network/UAT)`);
} finally {
  fs.rmSync(parent, { recursive: true, force: true });
}
