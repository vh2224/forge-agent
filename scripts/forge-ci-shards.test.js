'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  SHARD_PROFILE_SCHEMA, ALGORITHMS, PLATFORMS, LIMITS, SUITE_ID_RE, compareCodeUnits,
  validateShardProfile, loadShardProfile, planShards, verifyPartition,
  universeFingerprint, partitionFingerprint, formatShardPlanLine, parseShardPlanLine, buildShardProfile,
} = require('./forge-ci-shards.js');
const { discoverTests, suitesForShard } = require('./run-tests.js');

let passes = 0;
let failures = 0;
function test(name, check) {
  try { check(); passes += 1; console.log(`PASS ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}: ${error.stack}`); }
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function source(overrides = {}) {
  return {
    kind: 'run-tests-log', name: 'synthetic.log', sha256: 'a'.repeat(64), bytes: 32,
    platform: 'win32', job_name: 'Synthetic job', runner_image: 'synthetic-runner',
    runner_image_version: '20261025.1', node_version: 'v22.23.3',
    observed_from: '2026-10-25T00:00:00Z', observed_to: '2026-10-25T00:01:00Z',
    suites_declared: 2, suites_observed: 2, suites_failed: 0, unavailable: {}, ...overrides,
  };
}
function profile(weights = { 'a.test.js': 10, 'b.test.js': 2 }) {
  return {
    schema: SHARD_PROFILE_SCHEMA, algorithm: ALGORITHMS.weighted, sources: [source()],
    platforms: { win32: { status: 'observed', reason: null, default_weight_ms: 3,
      observations: 2, weights_ms: weights, excluded: [] } },
  };
}
function loaded(doc = profile()) { return { state: 'loaded', doc, sha256: 'b'.repeat(64) }; }
function plan(suites, count = 2, index = 0, prof = loaded(), platform = 'win32') {
  return planShards({ suites, count, index, platform, profile: prof });
}
function throwsCode(check, code) {
  assert.throws(check, error => error.code === code && error.message === code);
}
let seed = 0x4a19bc52;
function random(max) {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) % max;
}
function shuffled(values) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = random(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

test('public contracts and safe identifiers', () => {
  assert.equal(SHARD_PROFILE_SCHEMA, 'forge-shard-profile/v1');
  assert.deepEqual(PLATFORMS, ['win32', 'darwin', 'linux']);
  assert.equal(LIMITS.maxProfileBytes, 1048576);
  assert.deepEqual(['z', 'Z', '\u00e9'].sort(compareCodeUnits), ['Z', 'z', '\u00e9']);
  for (const id of ['.test.js', 'x.test.js', 'a'.repeat(192) + '.test.js', '\u00e9.test.js']) assert(SUITE_ID_RE.test(id));
  for (const id of ['x/y.test.js', 'x\\y.test.js', 'x:y.test.js', 'x*.test.js',
    'x?.test.js', 'x".test.js', "x'.test.js", 'x>.test.js', 'x<.test.js', 'x|.test.js',
    'x\n.test.js', 'x\x7f.test.js', 'x\x85.test.js', 'a'.repeat(193) + '.test.js']) assert(!SUITE_ID_RE.test(id), id);
});

test('positional oracle universes 0..60 and counts 1..7', () => {
  for (let size = 0; size <= 60; size += 1) {
    const suites = Array.from({ length: size }, (_, i) => `suite-${i}.test.js`);
    for (let count = 1; count <= 7; count += 1) for (let index = 0; index < count; index += 1) {
      const result = plan(suites, count, index, null);
      assert.deepEqual(result.selected, suitesForShard(suites, index, count));
      assert(verifyPartition(suites, result.shards).ok);
      assert.equal(result.fallback, null);
    }
  }
});

test('S04-T02 truth:0 partition-positional-permutation-properties', () => {
  for (let iteration = 0; iteration < 320; iteration += 1) {
    const suites = Array.from({ length: random(90) }, (_, i) => `suite-${i}.test.js`);
    const count = 1 + random(12);
    const weights = Object.fromEntries(suites.map(id => [id, 1 + random(10000)]));
    if (!suites.length) weights['stale.test.js'] = 1;
    const prof = loaded(profile(weights));
    const first = plan(suites, count, 0, prof);
    const permuted = plan(shuffled(suites), count, 0, prof);
    assert(verifyPartition(suites, first.shards).ok);
    assert.equal(first.universe_sha256, permuted.universe_sha256);
    assert.equal(first.partition_sha256, permuted.partition_sha256);
    if (suites.length >= count) assert(first.shards.every(row => row.length > 0));
    for (let index = 0; index < count; index += 1) {
      const other = plan(suites, count, index, prof);
      assert.deepEqual(first.shards, other.shards);
      assert.equal(first.partition_sha256, other.partition_sha256);
      assert.deepEqual(other.selected, first.shards[index]);
    }
  }
  assert.deepEqual(plan(['arbitrary / discovered name'], 1, 0, null).selected, ['arbitrary / discovered name']);
});

test('S04-T02 truth:1 integer-LPT-ties-default-and-stale', () => {
  const weights = { 'heavy.test.js': 100, 'stale.test.js': 999 };
  for (let i = 0; i < 20; i += 1) weights[`light-${i}.test.js`] = 5;
  const suites = Object.keys(weights).filter(id => id !== 'stale.test.js');
  const heavy = plan(suites, 2, 0, loaded(profile(weights)));
  assert.deepEqual(heavy.predicted_ms, [100, 100]);
  assert.deepEqual(heavy.stale, ['stale.test.js']);
  const tied = plan(['z.test.js', 'a.test.js', 'b.test.js', 'new.test.js'], 2, 0,
    loaded(profile({ 'z.test.js': 3, 'a.test.js': 3, 'b.test.js': 3, 'old.test.js': 99 })));
  assert.deepEqual(tied.shards, [['a.test.js', 'new.test.js'], ['z.test.js', 'b.test.js']]);
  assert.deepEqual(tied.predicted_ms, [6, 6]);
  assert.deepEqual(tied.unprofiled, ['new.test.js']);
  assert.deepEqual(tied.stale, ['old.test.js']);
  assert.deepEqual(plan(['z.test.js', 'a.test.js'], 2, 0,
    loaded(profile({ 'z.test.js': 1, 'a.test.js': 1 }))).shards, [['a.test.js'], ['z.test.js']]);
});

test('invalid shard arguments fail with named codes', () => {
  for (const args of [
    { suites: ['a', 'a'], count: 1, index: 0 }, { suites: [1], count: 1, index: 0 },
    { suites: [], count: 0, index: 0 }, { suites: [], count: 65, index: 0 },
    { suites: [], count: 1.5, index: 0 }, { suites: [], count: 1, index: 1 },
    { suites: [], count: 1, index: -1 }, { suites: null, count: 1, index: 0 },
    { suites: Array(1), count: 1, index: 0 },
    { suites: Array.from({ length: 5001 }, (_, i) => `${i}`), count: 1, index: 0 },
  ]) throwsCode(() => planShards(args), 'shard-input-invalid');
  throwsCode(() => plan([], 1, 0, { state: 'unknown' }), 'shard-input-invalid');
  throwsCode(() => plan([], 1, 0, loaded({})), 'shard-profile-invalid');
  throwsCode(() => plan([], 1, 0, { ...loaded(), sha256: 'bad' }), 'shard-input-invalid');
});

test('schema closes every object and validates fields, nullable reasons and limits', () => {
  const invalid = [
    doc => { doc.schema = 'other'; }, doc => { doc.algorithm = 'other'; },
    doc => { doc.extra = true; }, doc => { doc._annotation = 1; }, doc => { delete doc.sources; },
    doc => { doc.sources = []; }, doc => { doc.sources = Array(65).fill(source()); },
    doc => { doc.sources[0].extra = true; }, doc => { doc.sources[0].kind = 'other'; },
    doc => { doc.sources[0].name = '../private.log'; }, doc => { doc.sources[0].name = 'a'.repeat(121); },
    doc => { doc.sources[0].sha256 = 'bad'; }, doc => { doc.sources[0].bytes = -1; },
    doc => { doc.sources[0].job_name = null; }, doc => { doc.sources[0].platform = 'other'; },
    doc => { doc.sources[0].node_version = '22.0.0'; },
    doc => { doc.sources[0].observed_from = '2026-10-25'; },
    doc => { doc.sources[0].observed_from = '2026-02-30T00:00:00Z'; },
    doc => { doc.sources[0].observed_to = '2020-01-01T00:00:00Z'; },
    doc => { doc.sources[0].suites_declared = 5001; },
    doc => { doc.sources[0].suites_failed = 3; },
    doc => { doc.sources[0].unavailable.job_name = 'not null'; },
    doc => { doc.sources[0].unavailable.other = 'unknown'; },
    doc => { doc.platforms.other = {}; }, doc => { doc.platforms.win32.extra = 1; },
    doc => { doc.platforms.win32.status = 'other'; }, doc => { doc.platforms.win32.reason = 'bad'; },
    doc => { doc.platforms.win32.default_weight_ms = 0; },
    doc => { doc.platforms.win32.observations = -1; },
    doc => { doc.platforms.win32.weights_ms = []; },
    doc => { doc.platforms.win32.weights_ms['bad/path.test.js'] = 1; },
    doc => { doc.platforms.win32.weights_ms['a.test.js'] = 0; },
    doc => { doc.platforms.win32.weights_ms['a.test.js'] = 1.5; },
    doc => { doc.platforms.win32.weights_ms['a.test.js'] = 86400001; },
    doc => { doc.platforms.win32.weights_ms = {}; },
    doc => { doc.platforms.win32.excluded = [{ suite: 'a.test.js', reason: 'no-passing-observation' }]; },
    doc => { doc.platforms.win32.excluded = [{ suite: 'c.test.js', reason: 'bad' }]; },
    doc => { doc.platforms.win32.excluded = Array(5001).fill({ suite: 'c.test.js', reason: 'no-passing-observation' }); },
    doc => { doc.platforms.win32.weights_ms = Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`${i}.test.js`, 1])); },
    doc => { doc._large = 'a'.repeat(LIMITS.maxProfileBytes); },
    doc => { Object.setPrototypeOf(doc.platforms.win32.weights_ms, { injected: true }); },
    doc => { Object.setPrototypeOf(doc.sources, {}); },
    doc => { doc.sources = Array(1); },
    doc => { doc.sources.toJSON = () => { throw Error('must not execute'); }; },
    doc => { Object.defineProperty(doc, 'algorithm', { get() { throw Error('must not execute'); } }); },
    doc => { Object.defineProperty(doc, 'hidden', { value: 'unknown' }); },
  ];
  for (const mutate of invalid) {
    const doc = profile(); mutate(doc);
    const result = validateShardProfile(doc);
    assert.equal(result.ok, false);
    assert(result.errors.every(message => typeof message === 'string' && message.includes(':')));
  }
  assert.equal(validateShardProfile(Object.create(null)).ok, false);
  assert.equal(validateShardProfile(JSON.parse('{"__proto__":{}}')).ok, false);
  const nullable = profile(); nullable.sources[0].job_name = null;
  nullable.sources[0].unavailable.job_name = 'not recorded'; nullable._note = 'synthetic';
  assert(validateShardProfile(nullable).ok);
  const unavailable = profile(); unavailable.platforms.win32 = {
    status: 'unavailable', reason: 'no-observations', default_weight_ms: null,
    observations: 0, weights_ms: {}, excluded: [],
  };
  assert(validateShardProfile(unavailable).ok);
  unavailable.platforms.win32.default_weight_ms = 1;
  assert.equal(validateShardProfile(unavailable).ok, false);
});

test('S04-T02 truth:2 fallbacks-and-bounded-private-profile-errors', () => {
  const suites = ['a.test.js', 'b.test.js', 'c.test.js'];
  const absentPlatform = loaded(profile()); delete absentPlatform.doc.platforms.win32;
  const unavailable = loaded(profile()); unavailable.doc.platforms.win32 = {
    status: 'unavailable', reason: 'no-observations', default_weight_ms: null,
    observations: 0, weights_ms: {}, excluded: [],
  };
  for (const [prof, reason] of [[{ state: 'absent' }, 'profile-absent'],
    [absentPlatform, 'platform-missing'], [unavailable, 'platform-unavailable']]) {
    const result = plan(suites, 2, 1, prof);
    assert.equal(result.algorithm, ALGORITHMS.positional);
    assert.equal(result.fallback, reason);
    assert.deepEqual(result.selected, suitesForShard(suites, 1, 2));
    assert.equal(result.predicted_ms, null);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-shards-'));
  try {
    const file = path.join(root, 'profile.json');
    assert.deepEqual(loadShardProfile(file), { state: 'absent' });
    throwsCode(() => loadShardProfile(root), 'shard-profile-unreadable');
    fs.writeFileSync(file, JSON.stringify(profile()));
    const result = loadShardProfile(file);
    assert.equal(result.state, 'loaded');
    assert.equal(result.sha256, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    const link = path.join(root, 'link.json');
    try { fs.symlinkSync(file, link); throwsCode(() => loadShardProfile(link), 'shard-profile-unreadable'); }
    catch (error) {
      if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error;
      console.log('SKIP symlink creation denied by OS; injected symlink refusal still checked');
    }
    const stub = { lstatSync: () => ({ isSymbolicLink: () => true, isFile: () => true }) };
    throwsCode(() => loadShardProfile(file, stub), 'shard-profile-unreadable');
    throwsCode(() => loadShardProfile(file, { lstatSync() { throw Error('private'); } }), 'shard-profile-unreadable');
    throwsCode(() => loadShardProfile(file, { lstatSync: () => fs.lstatSync(file), readFileSync() { throw Error('private'); } }), 'shard-profile-unreadable');
    fs.writeFileSync(file, Buffer.alloc(LIMITS.maxProfileBytes + 1));
    throwsCode(() => loadShardProfile(file), 'shard-profile-too-large');
    for (const content of ['{SECRET_SENTINEL', JSON.stringify({ ...profile(), secret: 'SECRET_SENTINEL' }), Buffer.from([0xff])]) {
      fs.writeFileSync(file, content);
      assert.throws(() => loadShardProfile(file), error => error.code === 'shard-profile-invalid'
        && Array.isArray(error.errors) && !JSON.stringify({ message: error.message, errors: error.errors }).includes('SECRET_SENTINEL'));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('S04-T02 truth:3 partition-diagnostics-fingerprints-and-plan-line', () => {
  assert.deepEqual(verifyPartition(['a', 'b'], [['a', 'a', 'c']]), {
    ok: false, missing: ['b'], duplicated: ['a'], unknown: ['c'],
  });
  assert.equal(universeFingerprint(['b', 'a']), crypto.createHash('sha256').update('["a","b"]').digest('hex'));
  assert.equal(partitionFingerprint({ algorithm: 'x', count: 1, shards: [['b', 'a']] }),
    crypto.createHash('sha256').update('{"algorithm":"x","count":1,"shards":[["a","b"]]}').digest('hex'));
  for (const prof of [null, { state: 'absent' }, loaded()]) {
    const result = plan(['a.test.js', 'b.test.js'], 2, 1, prof);
    const line = formatShardPlanLine(result);
    assert(line.length < 400);
    const parsed = parseShardPlanLine(line);
    for (const key of ['algorithm', 'fallback', 'index', 'count', 'universe_size', 'universe_sha256', 'profile_sha256', 'partition_sha256']) {
      assert.deepEqual(parsed[key], result[key]);
    }
    assert.equal(parsed.selected, result.selected.length);
    assert.equal(parsed.unprofiled, result.unprofiled.length);
    assert.equal(parsed.stale, result.stale.length);
    assert.equal(parsed.predicted_ms, result.predicted_ms === null ? null : result.predicted_ms[1]);
    for (const bad of [` ${line}`, `${line} `, `${line}\n`, `2026-10-25 ${line}`,
      line.replace('shard=2/2', 'shard=0/2'), line.replace('shard=2/2', 'shard=3/2'),
      line.replace('selected=1', 'selected=01'), line.replace('algorithm=', 'unknown='),
      line.replace('universe=2', 'universe=0'), line.replace(/partition_sha256=.*/, 'partition_sha256=xyz')]) {
      assert.equal(parseShardPlanLine(bad), null);
    }
  }
});

test('S04-T02 truth:4 passing-lower-median-exclusions-determinism-and-limits', () => {
  const observations = [
    { suite: 'a.test.js', elapsed_ms: 0, status: 'pass' },
    { suite: 'a.test.js', elapsed_ms: 8, status: 'pass' },
    { suite: 'b.test.js', elapsed_ms: 10, status: 'pass' },
    { suite: 'b.test.js', elapsed_ms: 20, status: 'pass' },
    { suite: 'b.test.js', elapsed_ms: 30, status: 'pass' },
    { suite: 'b.test.js', elapsed_ms: 9999, status: 'fail' },
    { suite: 'c.test.js', elapsed_ms: null, status: 'fail' },
    { suite: 'c.test.js', elapsed_ms: null, status: 'not-run' },
    { suite: 'd.test.js', elapsed_ms: null, status: 'ambiguous' },
  ].map(entry => ({ ...entry, platform: 'win32', source_index: 0 }));
  const result = buildShardProfile({ observations, sources: [source()] });
  assert.deepEqual(result.platforms.win32.weights_ms, { 'a.test.js': 1, 'b.test.js': 20 });
  assert.equal(result.platforms.win32.default_weight_ms, 1);
  assert.equal(result.platforms.win32.observations, 5);
  assert.deepEqual(result.platforms.win32.excluded, [
    { suite: 'c.test.js', reason: 'no-passing-observation' },
    { suite: 'd.test.js', reason: 'ambiguous-observation' },
  ]);
  for (const platform of ['darwin', 'linux']) {
    assert.equal(result.platforms[platform].status, 'unavailable');
    assert.equal(result.platforms[platform].reason, 'no-observations');
    assert.deepEqual(result.platforms[platform].weights_ms, {});
  }
  assert.deepEqual(result.sources, [source()]);
  assert.equal(JSON.stringify(result), JSON.stringify(buildShardProfile({ observations: shuffled(observations), sources: [source()] })));
  throwsCode(() => buildShardProfile({ observations: [], sources: Array(65).fill(source()) }), 'shard-profile-limit');
  throwsCode(() => buildShardProfile({ observations: [{ ...observations[0], elapsed_ms: LIMITS.maxWeightMs + 1 }], sources: [source()] }), 'shard-profile-limit');
  const bigSource = source();
  // The combined source records are bounded even when each individual field fits.
  const longWeights = Array.from({ length: 5000 }, (_, i) => ({
    ...observations[0], suite: `${String(i).padStart(4, '0')}${'a'.repeat(188)}.test.js`,
  }));
  const byteBound = buildShardProfile({ observations: longWeights, sources: [bigSource] });
  assert(Buffer.byteLength(JSON.stringify(byteBound)) < LIMITS.maxProfileBytes);
  throwsCode(() => buildShardProfile({ observations: longWeights, sources: Array(64).fill(source({
    job_name: 'j'.repeat(160), runner_image: 'r'.repeat(160), runner_image_version: 'v'.repeat(160),
  })) }), 'shard-profile-limit');
  throwsCode(() => buildShardProfile({ observations: Array.from({ length: 5001 }, (_, i) => ({
    suite: `${i}.test.js`, elapsed_ms: 1, status: 'pass', platform: 'win32', source_index: 0,
  })), sources: [source()] }), 'shard-profile-limit');
  for (const changes of [{ elapsed_ms: -1 }, { elapsed_ms: 1.5 }, { source_index: 1 }, { platform: 'other' }, { suite: '../x.test.js' }]) {
    throwsCode(() => buildShardProfile({ observations: [{ ...observations[0], ...changes }], sources: [source()] }), 'shard-profile-invalid');
  }
});

test('S04-T02 key_link:0 public-APIs-seeded-properties-temporary-roots', () => {
  assert(validateShardProfile(profile()).ok);
  const suites = ['a.test.js', 'b.test.js'];
  assert(verifyPartition(suites, plan(shuffled(suites)).shards).ok);
  assert(parseShardPlanLine(formatShardPlanLine(plan(suites))));
  assert.equal(typeof loadShardProfile, 'function');
  assert.equal(typeof buildShardProfile, 'function');
});

test('S04-T02 key_link:1 real-discovery-and-positional-oracle', () => {
  const suites = discoverTests([]);
  assert(suites.length > 300);
  const weights = Object.fromEntries(suites.map((id, i) => [id, i + 1]));
  for (let count = 1; count <= 4; count += 1) for (let index = 0; index < count; index += 1) {
    const positional = plan(suites, count, index, null);
    const weighted = plan(suites, count, index, loaded(profile(weights)));
    assert.deepEqual(positional.selected, suitesForShard(suites, index, count));
    assert(verifyPartition(suites, positional.shards).ok);
    assert(verifyPartition(suites, weighted.shards).ok);
  }
});

console.log(`${passes} passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
