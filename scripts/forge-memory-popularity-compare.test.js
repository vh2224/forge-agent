#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const projection = require('./forge-projection.js');
const { serializeFrontmatter } = require('./forge-memory.js');
const popularity = require('./forge-memory-popularity.js');
const mixed = require('./fixtures/memory-evidence/mixed.json');
const { MAX_QUERY_BYTES } = require('./forge-memory-query.js');
const { buildComparisonReport, parseArgs } = require('./forge-memory-popularity-compare.js');

const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-popularity-compare-'));
const script = path.join(__dirname, 'forge-memory-popularity-compare.js');
const nowMs = Date.parse('2026-10-24T12:00:00Z');
const querySentinel = 'PRIVATE QUERY SENTINEL';
const textSentinel = 'PRIVATE FACT SENTINEL';
const fragmentSentinel = 'private-fragment-sentinel';
const message = 'Entrada ou fonte inválida para comparação de memória.\n';
let count = 0;
function test(name, fn) { fn(); console.log(`ok ${++count} - ${name}`); }
function root(name) {
  const dir = path.join(parent, name);
  fs.mkdirSync(path.join(dir, '.gsd/memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'query.txt'), `ultraviolet cache ${querySentinel}`);
  return dir;
}
function opts(dir, changes = {}) {
  return { cwd: dir, queryFile: path.join(dir, 'query.txt'), unitType: 'execute-task',
    limit: 8, maxTokens: 2000, nowMs, ...changes };
}
function args(options) {
  const names = { cwd: '--cwd', queryFile: '--query-file', unitType: '--unit-type', limit: '--limit',
    maxTokens: '--max-tokens', nowMs: '--now-ms', commit: '--commit' };
  return Object.entries(options).flatMap(([key, value]) => [names[key], String(value)]);
}
function cli(options, extra = []) {
  const child = spawnSync(process.execPath, [script, ...args(options), ...extra], { encoding: 'utf8' });
  assert.ifError(child.error);
  return child;
}
function invalidCli(options, extra = []) {
  const child = cli(options, extra);
  assert.equal(child.status, 2);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, message);
}
function orphan(dir, rows) {
  const text = rows.map(row => `## [${row.id}] gotcha\n- text: ${row.text || `ultraviolet cache ${textSentinel}`}\n` +
    `- confidence: ${row.confidence ?? 0.5}\n- hits: ${row.hits ?? 1}\n`).join('\n');
  fs.writeFileSync(path.join(dir, '.gsd/memory/legacy-orphan.md'), text);
}
// Independent content snapshot, matching the diagnostic-invariance fixture pattern.
function snapshot(dir, relative = '') {
  return fs.readdirSync(path.join(dir, relative)).sort().flatMap(name => {
    const rel = path.join(relative, name);
    const file = path.join(dir, rel);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return [[rel, 'link', fs.readlinkSync(file)]];
    if (stat.isDirectory()) return [[rel, 'directory'], ...snapshot(dir, rel)];
    return [[rel, 'file', crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]];
  });
}
function privateOutput(text, dir) {
  for (const sentinel of [querySentinel, textSentinel, fragmentSentinel, dir, parent]) {
    assert(!text.includes(sentinel), 'output exposes private input');
  }
}
function distinct(shadow) { assert.notEqual(shadow.baseline.fingerprint, shadow.candidate.fingerprint); }
function junction(target, link) { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }

try {
  const frozen = root('frozen');
  orphan(frozen, [{ id: 'MEM001', hits: 1 }, { id: 'MEM002', hits: 2, confidence: 0.7 }]);
  const options = opts(frozen);

  test('T04 truth 0: strict CLI ranges, flags and UTF-8 files reject with exit 2 and no stdout', () => {
    const invalidChanges = [
      { nowMs: undefined }, { nowMs: 1.5 }, { nowMs: Number.MAX_SAFE_INTEGER + 1 },
      { limit: 0 }, { limit: 51 }, { limit: 1.2 }, { maxTokens: 1 }, { maxTokens: 16001 },
      { maxTokens: 2.5 }, { commit: 'xyz1234' }, { commit: 'a'.repeat(6) }, { commit: 'a'.repeat(65) },
      { unitType: 'Execute-task' }, { unitType: '../escape' }, { unitType: 'a'.repeat(81) },
    ];
    for (const change of invalidChanges) {
      const input = { ...options, ...change };
      if (input.nowMs === undefined) delete input.nowMs;
      invalidCli(input);
    }
    invalidCli(options, ['--unknown', 'value']);
    invalidCli(options, ['--limit', '8']);
    for (const tokens of [['--now-ms'], ['--now-ms', '1e3'], ['--now-ms', '0x10'], ['--now-ms', 'NaN']]) {
      const input = { ...options }; delete input.nowMs;
      invalidCli(input, tokens);
    }
    invalidCli({ ...options, queryFile: path.join(frozen, 'missing') });
    invalidCli({ ...options, queryFile: frozen });
    const file = path.join(frozen, 'invalid-query');
    for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from(''), Buffer.from('x\0y'), Buffer.from('  ')]) {
      fs.writeFileSync(file, bytes);
      invalidCli({ ...options, queryFile: file });
    }
    fs.writeFileSync(file, Buffer.alloc(MAX_QUERY_BYTES + 1, 97));
    invalidCli({ ...options, queryFile: file });
    assert.deepStrictEqual(parseArgs(args({ ...options, commit: 'AbC1234' })), { ...options, commit: 'AbC1234' });
  });

  test('T04 truth 0: invalid options perform zero projection, readdir and lstat calls', () => {
    const originalQuery = projection.queryMemoryEntries, originalReadDir = fs.readdirSync, originalStat = fs.lstatSync;
    let reads = 0;
    try {
      const spy = () => { reads++; throw new Error('premature store read'); };
      projection.queryMemoryEntries = spy; fs.readdirSync = spy; fs.lstatSync = spy;
      for (const input of [null, {}, { ...options, limit: 0 }, { ...options, nowMs: NaN },
        { ...options, nowMs: '123' }, { ...options, maxTokens: 16001 }, { ...options, commit: 'bad' },
        { ...options, queryFile: '' }, { ...options, extra: true }]) {
        assert.throws(() => buildComparisonReport(input), error => error.message === message.trim());
        assert.equal(reads, 0);
      }
    } finally { projection.queryMemoryEntries = originalQuery; fs.readdirSync = originalReadDir; fs.lstatSync = originalStat; }
  });

  test('T04 truth 1 / key_link 0: namespace off-on-off uses identical fixed options and deep active equality', () => {
    const original = projection.queryMemoryEntries;
    const calls = [];
    try {
      projection.queryMemoryEntries = (cwd, input) => { calls.push({ cwd, ...input }); return original(cwd, input); };
      const report = buildComparisonReport(options);
      assert.deepStrictEqual(calls.map(call => call.popularityShadow), [false, true, false]);
      const expected = { cwd: frozen, query: fs.readFileSync(options.queryFile, 'utf8'), unitType: options.unitType,
        nowMs, limit: options.limit, maxTokens: options.maxTokens };
      for (const { popularityShadow: ignored, ...call } of calls) assert.deepStrictEqual(call, expected);
      assert.equal(report.active_equal, true);
      assert.equal(report.source_equal, true);
      assert.equal(report.persisted_equal, true);
      assert.equal(report.persisted_reason, null);
      assert.equal(report.invariance, 'held');
      assert.equal(report.inputs.source_fingerprint_before, report.inputs.source_fingerprint_after);
    } finally { projection.queryMemoryEntries = original; }
  });

  test('T04 truth 1: schema bytes and absent state change source fingerprint; code-unit order ignores readdir order', () => {
    const dir = root('schema');
    const marker = path.join(dir, '.gsd/SCHEMA-VERSION');
    const absent = buildComparisonReport(opts(dir));
    assert.equal(absent.inputs.schema_marker, 'absent');
    fs.writeFileSync(marker, '4');
    const present = buildComparisonReport(opts(dir));
    assert.equal(present.inputs.schema_marker, 'present');
    assert.notEqual(absent.inputs.source_fingerprint_before, present.inputs.source_fingerprint_before);
    fs.writeFileSync(marker, '5');
    const changed = buildComparisonReport(opts(dir));
    assert.notEqual(present.inputs.source_fingerprint_before, changed.inputs.source_fingerprint_before);
    fs.writeFileSync(path.join(dir, '.gsd/memory/Z.txt'), 'Z');
    fs.writeFileSync(path.join(dir, '.gsd/memory/a.txt'), 'a');
    const first = buildComparisonReport(opts(dir));
    const original = fs.readdirSync;
    try {
      fs.readdirSync = (...input) => original(...input).reverse();
      const reversed = buildComparisonReport(opts(dir));
      assert.equal(first.inputs.source_fingerprint_before, reversed.inputs.source_fingerprint_before);
    } finally { fs.readdirSync = original; }
  });

  test('T04 truth 2: frozen copied corpus exits 0; injected on-write makes source/state false and violated', () => {
    const copied = root('copied');
    fs.copyFileSync(path.join(frozen, '.gsd/memory/legacy-orphan.md'), path.join(copied, '.gsd/memory/legacy-orphan.md'));
    const child = cli(opts(copied));
    assert.equal(child.status, 0); assert.equal(child.stderr, '');
    const held = JSON.parse(child.stdout);
    assert.equal(held.persisted_equal, true); assert.equal(held.source_equal, true);
    const original = projection.queryMemoryEntries;
    try {
      projection.queryMemoryEntries = (cwd, input) => {
        if (input.popularityShadow) fs.writeFileSync(path.join(cwd, '.gsd/memory/injected.txt'), 'changed');
        return original(cwd, input);
      };
      const changed = buildComparisonReport(opts(copied));
      assert.equal(changed.source_equal, false); assert.equal(changed.persisted_equal, false);
      assert.equal(changed.invariance, 'violated');
    } finally { projection.queryMemoryEntries = original; }
  });

  test('T04 truth 1: active mutation is deep-compared and CLI maps violated to exit 1', () => {
    const original = projection.queryMemoryEntries;
    try {
      projection.queryMemoryEntries = (cwd, input) => {
        const result = original(cwd, input);
        if (input.popularityShadow) result.considered++;
        return result;
      };
      const report = buildComparisonReport(options);
      assert.equal(report.active_equal, false); assert.equal(report.source_equal, true);
      assert.equal(report.persisted_equal, true); assert.equal(report.invariance, 'violated');
      // Exercise the real main guard in an isolated child, with an in-memory
      // projection seam installed before loading the unchanged CLI bytes.
      const bootstrap = `const p=require(${JSON.stringify(require.resolve('./forge-projection.js'))});` +
        `const q=p.queryMemoryEntries;p.queryMemoryEntries=(cwd,o)=>{const r=q(cwd,o);if(o.popularityShadow)r.considered++;return r};` +
        `process.argv=[process.execPath,${JSON.stringify(script)},...${JSON.stringify(args(options))}];` +
        `require('module')._load(${JSON.stringify(script)},null,true);`;
      const child = spawnSync(process.execPath, ['-e', bootstrap], { encoding: 'utf8' });
      assert.ifError(child.error); assert.equal(child.status, 1); assert.equal(child.stderr, '');
      assert.equal(JSON.parse(child.stdout).invariance, 'violated');
    } finally { projection.queryMemoryEntries = original; }
  });

  test('T04 truth 2: junction outside memory gives null/unknown exit 3; memory junction exits 2 without traversal', () => {
    const target = root('link-target'), outside = root('outside-link'), inside = root('inside-link');
    junction(target, path.join(outside, '.gsd/elsewhere'));
    const unknown = cli(opts(outside));
    assert.equal(unknown.status, 3); assert.equal(unknown.stderr, '');
    const report = JSON.parse(unknown.stdout);
    assert.equal(report.persisted_equal, null); assert.equal(report.persisted_reason, 'state-link');
    assert.equal(report.source_equal, true); assert.equal(report.invariance, 'unknown');
    junction(target, path.join(inside, '.gsd/memory/linked'));
    invalidCli(opts(inside));
    const original = fs.readdirSync;
    let traversed = false;
    try {
      fs.readdirSync = (file, ...rest) => {
        if (String(file).includes('linked')) traversed = true;
        return original(file, ...rest);
      };
      assert.throws(() => buildComparisonReport(opts(inside)));
      assert.equal(traversed, false);
    } finally { fs.readdirSync = original; }
  });

  test('T04 truth 0: unreadable and oversized source fail closed; state limits/unreadability stay unknown', () => {
    const dir = root('limits');
    orphan(dir, [{ id: 'MEM001' }]);
    const originalOpen = fs.openSync;
    try {
      fs.openSync = (file, ...rest) => {
        if (String(file).endsWith('legacy-orphan.md')) throw new Error(textSentinel);
        return originalOpen(file, ...rest);
      };
      assert.throws(() => buildComparisonReport(opts(dir)), error => error.message === message.trim());
    } finally { fs.openSync = originalOpen; }
    const source = path.join(dir, '.gsd/memory/huge');
    const fd = fs.openSync(source, 'w'); fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1); fs.closeSync(fd);
    invalidCli(opts(dir));
    fs.unlinkSync(source);
    const state = path.join(dir, '.gsd/huge');
    const stateFd = fs.openSync(state, 'w'); fs.ftruncateSync(stateFd, 64 * 1024 * 1024 + 1); fs.closeSync(stateFd);
    const limited = buildComparisonReport(opts(dir));
    assert.equal(limited.persisted_equal, null); assert.equal(limited.persisted_reason, 'state-limit-exceeded');
    assert.equal(limited.invariance, 'unknown');
    fs.unlinkSync(state); fs.writeFileSync(state, 'small');
    try {
      fs.openSync = (file, ...rest) => {
        if (file === state) throw new Error(textSentinel);
        return originalOpen(file, ...rest);
      };
      const unreadable = buildComparisonReport(opts(dir));
      assert.equal(unreadable.persisted_equal, null); assert.equal(unreadable.persisted_reason, 'state-unreadable');
      assert.equal(unreadable.invariance, 'unknown');
    } finally { fs.openSync = originalOpen; }
  });

  test('T04 truth 3 / key_link 1: closed observational fields use SHADOW_VERSION and PARAMETERS', () => {
    const report = buildComparisonReport({ ...options, commit: 'a'.repeat(40) });
    assert.equal(report.report_version, 1); assert.equal(report.shadow_version, popularity.SHADOW_VERSION);
    assert.deepStrictEqual(report.parameters, popularity.PARAMETERS);
    assert.equal(report.inputs.query_sha256, crypto.createHash('sha256').update(fs.readFileSync(options.queryFile)).digest('hex'));
    assert.equal(report.inputs.unit_type, options.unitType); assert.equal(report.inputs.limit, options.limit);
    assert.equal(report.inputs.max_tokens, options.maxTokens); assert.equal(report.inputs.now_ms, nowMs);
    assert.equal(report.inputs.commit, 'a'.repeat(40));
    assert.equal(buildComparisonReport(options).inputs.commit, 'unknown');
    assert.equal(report.apply_policy, false); assert.equal(report.efficacy, 'not-evaluated');
    assert.equal(report.corpus, 'unspecified'); assert.equal(report.family_count, 1);
    assert.deepStrictEqual(report.conditions, { node: process.version, locale: Intl.Collator().resolvedOptions().locale });
    assert.deepStrictEqual(report.limitations, ['controlled-frozen-copy-required', 'same-runtime-locale-only',
      'budget-stage-not-simulated', 'context-stage-not-simulated', 'comparator-not-reused', 'ranking-not-quality']);
  });

  test('T04 truth 0: source entry ceiling rejects before descent; state entry ceiling remains unknown', () => {
    const dir = root('entry-limits');
    const original = fs.readdirSync;
    try {
      fs.readdirSync = (file, ...rest) => file === path.join(dir, '.gsd/memory')
        ? Array.from({ length: 10001 }, (_, i) => String(i)) : original(file, ...rest);
      assert.throws(() => buildComparisonReport(opts(dir)), error => error.message === message.trim());
      fs.readdirSync = (file, ...rest) => file === path.join(dir, '.gsd')
        ? Array.from({ length: 10001 }, (_, i) => String(i)) : original(file, ...rest);
      const report = buildComparisonReport(opts(dir));
      assert.equal(report.persisted_equal, null); assert.equal(report.persisted_reason, 'state-limit-exceeded');
      assert.equal(report.invariance, 'unknown');
    } finally { fs.readdirSync = original; }
  });

  test('T04 truth 3: projection stderr is counted only and restored in finally on success and failure', () => {
    const original = projection.queryMemoryEntries, write = process.stderr.write;
    try {
      projection.queryMemoryEntries = (cwd, input) => { process.stderr.write(textSentinel); return original(cwd, input); };
      const report = buildComparisonReport(options);
      assert.equal(report.projection_warnings, 3);
      assert.strictEqual(process.stderr.write, write);
      privateOutput(JSON.stringify(report), frozen);
      projection.queryMemoryEntries = () => { process.stderr.write(textSentinel); throw new Error(querySentinel); };
      assert.throws(() => buildComparisonReport(options), error => error.message === message.trim());
      assert.strictEqual(process.stderr.write, write);
    } finally { projection.queryMemoryEntries = original; process.stderr.write = write; }
  });

  test('T04 truth 4: equivalent domain retains order; confidence counterexample and huge digit hits change ranks', () => {
    const equivalent = root('equivalent'), normalized = root('normalized'), huge = root('huge-hits');
    orphan(equivalent, [0, 1, 2, 3].map((hits, i) => ({ id: `MEM00${i}`, confidence: 0.9, hits })));
    const equal = buildComparisonReport(opts(equivalent)).popularity_shadow;
    distinct(equal); assert.equal(equal.comparison.order_equal, true); assert.equal(equal.measures.rank_changes, 0);
    assert.equal(equal.measures.rows_outside_equivalence, 0);
    orphan(normalized, [{ id: 'MEM001', confidence: 2, hits: 1 }, { id: 'MEM002', confidence: 0.9, hits: 2 }]);
    const changed = buildComparisonReport(opts(normalized)).popularity_shadow;
    distinct(changed); assert.equal(changed.measures.saturated_hits, 0);
    assert.equal(changed.comparison.order_equal, false); assert(changed.measures.rank_changes >= 1);
    orphan(huge, [{ id: 'MEM001', confidence: 0.5, hits: '1' + '0'.repeat(21), text: 'ultraviolet' },
      { id: 'MEM002', confidence: 0.5, hits: 1 }]);
    const hugeReport = buildComparisonReport(opts(huge, { unitType: 'plan-slice' })).popularity_shadow;
    distinct(hugeReport); assert(hugeReport.measures.rank_changes >= 1);
    assert.equal(hugeReport.measures.saturated_hits, 1);
    for (const shadow of [equal, changed, hugeReport]) assert.equal('efficacy' in shadow, false);
  });

  test('T04 truth 5 / key_link 3: two child CLIs are byte-identical, private in stdout/stderr, and write nothing', () => {
    const dir = root('private-frozen');
    orphan(dir, [{ id: 'MEM001' }]);
    const row = mixed.replay_rows[0];
    const invalid = { unit_id: 'T99', facts: [], stats: [row, { ...row, observation_id: 'conflicting-observation' }] };
    fs.writeFileSync(path.join(dir, `.gsd/memory/M-20261024120000-${fragmentSentinel}__T99.md`),
      `---\n${serializeFrontmatter(invalid)}\n---\n`);
    const before = snapshot(dir);
    const first = cli(opts(dir)), second = cli(opts(dir));
    assert.equal(first.status, 0); assert.equal(second.status, 0);
    assert.equal(first.stdout, second.stdout); assert.equal(first.stderr, ''); assert.equal(second.stderr, '');
    const report = JSON.parse(first.stdout);
    assert.equal(first.stdout, `${JSON.stringify(report)}\n`);
    assert(report.projection_warnings >= 1);
    privateOutput(first.stdout + first.stderr, dir);
    assert.deepStrictEqual(snapshot(dir), before);
    distinct(report.popularity_shadow);
  });

  test('T04 key_link 2: imported MAX_QUERY_BYTES accepts exact limit and refuses the next byte', () => {
    const dir = root('query-boundary');
    fs.writeFileSync(path.join(dir, 'query.txt'), Buffer.alloc(MAX_QUERY_BYTES, 97));
    assert.equal(cli(opts(dir)).status, 0);
    fs.appendFileSync(path.join(dir, 'query.txt'), 'a');
    invalidCli(opts(dir));
  });

  console.log(`${count} checks passed`);
} finally {
  // The only recursively removed path is the literal mkdtemp result created above.
  assert(path.resolve(parent).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(parent, { recursive: true, force: true });
}
