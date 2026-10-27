'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { SUITE_PROFILE_SCHEMA, LIMITS, ENV_ALLOWLIST, observeCondition, buildSuiteProfile,
  validateSuiteProfile, parseSuiteProfile, writeSuiteProfile } = require('./forge-suite-profile.js');
const { SUITE_ID_RE } = require('./forge-ci-shards.js');

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function environment() {
  return { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2',
    GITHUB_JOB: 'test', GITHUB_WORKFLOW: 'CI (all)', GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_REF: 'refs/pull/12/merge', GITHUB_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'owner/repo',
    RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64', RUNNER_ENVIRONMENT: 'github-hosted',
    ImageOS: 'win25', ImageVersion: '20261018.275.1', SECRET_SENTINEL: 'PRIVATE-TOKEN-SENTINEL' };
}
function condition(env = environment()) {
  return observeCondition({ env, platform: 'win32', arch: 'x64', nodeVersion: 'v22.23.3',
    osRelease: '10.0.26100', cpus: [{ model: 'Example CPU @ 3.00GHz' }] });
}
function input() {
  return { started_at: '2026-10-25T12:00:00.000Z', finished_at: '2026-10-25T12:00:01.000Z',
    elapsed_ms: 950, condition: condition(), selection: { discovered: 4, selected: 3, universe_sha256: 'b'.repeat(64) },
    shard: { index: 0, count: 2, algorithm: 'positional-v1', fallback: null, profile_sha256: null,
      partition_sha256: 'c'.repeat(64), predicted_ms: null, unprofiled: 0, stale: 0 },
    mode: { baseline: false, fail_fast: true, match: false, changed: false, isolation: 'isolated-home' },
    suites: [
      { id: 'one.test.js', ordinal: 1, status: 'pass', elapsed_ms: 20, exit_code: 0, signal: null, error_code: null },
      { id: 'two.test.js', ordinal: 2, status: 'fail', elapsed_ms: 50, exit_code: 1, signal: null, error_code: null },
      { id: 'three.test.js', ordinal: 3, status: 'not-run', elapsed_ms: null, exit_code: null, signal: null, error_code: null },
    ], totals: { executed: 2, passed: 1, failed: 1, not_run: 1 }, verdict: { exit_code: 1, baseline: null } };
}
let passed = 0;
function test(name, run) {
  try { run(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}
function rejected(mutate) {
  const doc = buildSuiteProfile(input()); mutate(doc);
  assert.equal(validateSuiteProfile(doc).ok, false);
  assert.throws(() => parseSuiteProfile(JSON.stringify(doc)), { code: 'suite-profile-invalid' });
}

test('S04-T03 truth:0 stable suite identity execution selection shard mode totals verdict and separate clocks', () => {
  const doc = buildSuiteProfile(input());
  assert.equal(doc.schema, SUITE_PROFILE_SCHEMA);
  assert.deepStrictEqual(Object.keys(doc), ['schema', 'started_at', 'finished_at', 'elapsed_ms', 'condition',
    'selection', 'shard', 'mode', 'suites', 'totals', 'verdict']);
  assert.equal(doc.elapsed_ms, 950); assert.equal(Date.parse(doc.finished_at) - Date.parse(doc.started_at), 1000);
  assert.deepStrictEqual(doc.suites.map(s => s.status), ['pass', 'fail', 'not-run']);
  assert.deepStrictEqual(doc.totals, { executed: 2, passed: 1, failed: 1, not_run: 1 });
  assert.equal(doc.selection.selected, 3); assert.equal(doc.mode.isolation, 'isolated-home');
  assert.equal(doc.shard.count, 2); assert.equal(doc.verdict.exit_code, 1);
  const weighted = input();
  Object.assign(weighted.shard, { algorithm: 'weighted-lpt-v1', profile_sha256: 'd'.repeat(64), predicted_ms: 40, unprofiled: 1, stale: 1 });
  assert.equal(validateSuiteProfile(buildSuiteProfile(weighted)).ok, true);
  const noShard = input(); noShard.shard = null; assert.equal(buildSuiteProfile(noShard).shard, null);
  const seconds = input(); seconds.started_at = '2026-10-25T12:00:00Z';
  assert.equal(validateSuiteProfile(buildSuiteProfile(seconds)).ok, true);
});

test('native uint32 suite exits round-trip without signed coercion; verdict domain stays closed', () => {
  for (const exitCode of [1, 2147483647, 2147483648, 3221225477, 4294967295, null]) {
    const value = input();
    value.suites[1].exit_code = exitCode;
    value.suites[1].signal = exitCode === null ? 'SIGTERM' : null;
    const parsed = parseSuiteProfile(JSON.stringify(buildSuiteProfile(value)));
    assert.strictEqual(parsed.suites[1].exit_code, exitCode);
    assert.strictEqual(parsed.suites[1].signal, value.suites[1].signal);
    assert.strictEqual(parsed.suites[1].status, 'fail');
    assert.strictEqual(parsed.verdict.exit_code, 1);
  }
  for (const exitCode of [-1, -2147483648, 0.5, 4294967296, '3221225477']) {
    rejected(doc => { doc.suites[1].exit_code = exitCode; });
  }
  // JSON converts nonfinite numbers to null, so check their in-memory rejection directly.
  for (const exitCode of [Infinity, NaN]) {
    const doc = buildSuiteProfile(input());
    doc.suites[1].exit_code = exitCode;
    assert.strictEqual(validateSuiteProfile(doc).ok, false);
  }
  rejected(doc => { doc.suites[0].exit_code = 3221225477; });
  rejected(doc => { doc.suites[2].exit_code = 3221225477; });
  rejected(doc => { doc.verdict.exit_code = 3221225477; });
});

test('S04-T03 truth:1 bounded allowlist observations null reasons and unavailable queue cache', () => {
  const reads = [];
  const env = new Proxy(environment(), { get(target, key) { reads.push(key); return target[key]; },
    ownKeys() { throw new Error('Environment enumeration forbidden'); } });
  const c = condition(env);
  assert.deepStrictEqual(reads, [...ENV_ALLOWLIST]); assert.deepStrictEqual(c.unavailable, {});
  assert.equal(c.ci.provider, 'github-actions'); assert.equal(c.cpus.count, 1);
  assert.deepStrictEqual(c.queue, { state: 'unavailable', reason: 'not-observable-inside-runner' });
  assert.deepStrictEqual(c.cache, { state: 'unknown', reason: 'runner-does-not-observe-actions-cache' });
  const absent = condition({});
  for (const key of Object.keys(absent.ci)) {
    assert.equal(absent.ci[key], null); assert.equal(absent.unavailable[`ci.${key}`], 'absent');
  }
  for (const key of ENV_ALLOWLIST) {
    const bad = environment(); bad[key] = '/private/secret\n';
    const observation = condition(bad);
    assert.equal(Object.values(observation.unavailable).includes('invalid-format'), true);
    assert.equal(JSON.stringify(observation).includes('secret'), false);
  }
  for (const key of ENV_ALLOWLIST) {
    const bad = environment(); bad[key] = 'a'.repeat(201);
    assert.equal(Object.values(condition(bad).unavailable).includes('invalid-format'), true);
  }
  const host = observeCondition({ env: {}, platform: null, arch: '/bad', nodeVersion: 'secret',
    osRelease: () => { throw new Error('private'); }, cpus: [{ model: 'x'.repeat(101) }] });
  assert.equal(host.platform, null); assert.equal(host.arch, null); assert.equal(host.cpus.model, null);
  assert.equal(host.unavailable['cpus.model'], 'invalid-format');
  assert.equal(condition({ GITHUB_ACTIONS: 'false' }).unavailable['ci.provider'], 'not-github-actions');
  const empty = observeCondition({ env: {}, cpus: [] }); assert.equal(empty.cpus.count, null);
});

test('S04-T03 truth:2 privacy closed fields and named suite byte field limits', () => {
  const doc = buildSuiteProfile(input()); const serialized = JSON.stringify(doc);
  for (const forbidden of ['SECRET_SENTINEL', 'PRIVATE-TOKEN-SENTINEL', 'stdout', 'stderr', process.cwd()]) assert.equal(serialized.includes(forbidden), false);
  for (const field of ['stdout', 'stderr', 'message', 'path', 'env']) rejected(d => { d.suites[0][field] = 'PRIVATE-TOKEN-SENTINEL'; });
  rejected(d => { d.condition.ci.extra = 'private'; });
  rejected(d => { d.condition.cpus.model = 'C:\\private\\cpu'; });
  rejected(d => { d.suites[0].error_code = 'private message'; });
  rejected(d => { d.suites[1].error_code = 'X'.repeat(41); });
  rejected(d => { d.condition.ci.workflow = 'x'.repeat(201); });
  const tooMany = input(); tooMany.suites = Array(5001).fill(tooMany.suites[0]);
  assert.throws(() => buildSuiteProfile(tooMany), { code: 'suite-profile-limit' });
  assert.throws(() => parseSuiteProfile(JSON.stringify(tooMany)), { code: 'suite-profile-limit' });
  assert.throws(() => parseSuiteProfile(' '.repeat(LIMITS.maxBytes + 1)), { code: 'suite-profile-limit' });
  assert.throws(() => buildSuiteProfile({ ...input(), stdout: 'private' }), { code: 'suite-profile-invalid' });
});

test('closed schema and every suite count clock execution ordinal shard coherence rule', () => {
  const changes = [
    d => { d.schema = 'forge-suite-profile/v2'; }, d => { d.sources = []; },
    d => { delete d.mode; }, d => { d.suites[0].id = '../escape.test.js'; },
    d => { d.suites[0].id = d.suites[1].id; }, d => { d.suites[1].ordinal = 3; },
    d => { d.suites[0].elapsed_ms = 0.5; }, d => { d.suites[0].exit_code = 1; },
    d => { d.suites[0].signal = 'SIGTERM'; }, d => { d.suites[2].elapsed_ms = 0; },
    d => { d.suites[2].exit_code = 0; }, d => { d.suites[2].signal = 'SIGTERM'; },
    d => { d.suites[2].error_code = 'ENOENT'; }, d => { d.suites[1].status = 'other'; },
    d => { d.suites[1].signal = 'private error'; }, d => { d.suites[1].exit_code = -1; },
    d => { d.selection.selected = 2; }, d => { d.selection.discovered = 2; },
    d => { d.selection.universe_sha256 = 'z'.repeat(64); },
    d => { d.totals.executed = 1; }, d => { d.totals.not_run = 0; }, d => { d.totals.passed = 2; },
    d => { d.started_at = '2026-10-26T12:00:00.000Z'; }, d => { d.finished_at = 'invalid'; },
    d => { d.started_at = '2026-02-30T12:00:00.000Z'; }, d => { d.elapsed_ms = -1; },
    d => { d.shard.index = 2; }, d => { d.shard.count = 65; }, d => { d.shard.count = 0; },
    d => { d.shard.algorithm = 'other'; }, d => { d.shard.predicted_ms = 1; },
    d => { d.shard.partition_sha256 = null; }, d => { d.shard.fallback = 'private'; },
    d => { d.mode.isolation = '/private'; }, d => { d.mode.match = 'private'; },
    d => { d.verdict.exit_code = 3; }, d => { d.verdict.baseline = 'other'; },
    d => { d.condition.queue.reason = 'observed'; }, d => { d.condition.cache.state = 'hit'; },
    d => { d.condition.unavailable.extra = 'absent'; },
    d => { d.condition.arch = null; }, d => { d.condition.unavailable.arch = 'absent'; },
  ];
  changes.forEach(rejected);
  assert.throws(() => parseSuiteProfile('{'), { code: 'suite-profile-invalid' });
  assert.throws(() => parseSuiteProfile(null), { code: 'suite-profile-invalid' });
  const sparse = input(); delete sparse.suites[1]; assert.throws(() => buildSuiteProfile(sparse), { code: 'suite-profile-invalid' });
});

test('S04-T03 truth:3 atomic stable write parse closed schema and cleanup on failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-suite-profile-'));
  try {
    const doc = buildSuiteProfile(input()); const file = path.join(root, 'profile.json');
    const written = writeSuiteProfile(file, doc); assert.equal(written.ok, true);
    const bytes = fs.readFileSync(file); assert.equal(bytes.length, written.bytes);
    assert.equal(written.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.deepStrictEqual(parseSuiteProfile(bytes), doc);
    assert.equal(bytes.toString(), `${JSON.stringify(doc, null, 2)}\n`);
    assert.deepStrictEqual(writeSuiteProfile(file, buildSuiteProfile(input())), written);
    assert.deepStrictEqual(fs.readFileSync(file), bytes);
    assert.deepStrictEqual(writeSuiteProfile(file, doc, { maxBytes: 20 }), { ok: false, code: 'suite-profile-limit' });
    assert.deepStrictEqual(fs.readFileSync(file), bytes);
    const directory = path.join(root, 'directory'); fs.mkdirSync(directory);
    assert.deepStrictEqual(writeSuiteProfile(directory, doc), { ok: false, code: 'suite-profile-write-failed' });
    assert.deepStrictEqual(fs.readdirSync(root).sort(), ['directory', 'profile.json']);
    assert.deepStrictEqual(writeSuiteProfile(path.join(root, 'absent', 'profile.json'), doc), { ok: false, code: 'suite-profile-write-failed' });
    assert.deepStrictEqual(writeSuiteProfile(file, { ...doc, extra: true }), { ok: false, code: 'suite-profile-invalid' });
    assert.deepStrictEqual(writeSuiteProfile(null, doc), { ok: false, code: 'suite-profile-write-failed' });
    assert.deepStrictEqual(writeSuiteProfile(file, doc, { maxBytes: -1 }), { ok: false, code: 'suite-profile-limit' });
    // A collision belongs to someone else: exclusive creation must preserve it.
    const originalRandom = crypto.randomBytes;
    const collision = path.join(root, `.suite-profile-${'00'.repeat(16)}.tmp`);
    fs.writeFileSync(collision, 'existing');
    try {
      crypto.randomBytes = () => Buffer.alloc(16);
      assert.deepStrictEqual(writeSuiteProfile(file, doc), { ok: false, code: 'suite-profile-write-failed' });
      assert.equal(fs.readFileSync(collision, 'utf8'), 'existing');
      assert.deepStrictEqual(fs.readFileSync(file), bytes);
    } finally { crypto.randomBytes = originalRandom; fs.unlinkSync(collision); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('S04-T03 key_link:0 public APIs exercised with synthetic secret environment and temporary roots', () => {
  assert.equal(typeof observeCondition, 'function'); assert.equal(typeof writeSuiteProfile, 'function');
  assert.deepStrictEqual(parseSuiteProfile(JSON.stringify(buildSuiteProfile(input()))), buildSuiteProfile(input()));
});
test('S04-T03 key_link:1 suite identity reuses forge-ci-shards SUITE_ID_RE', () => {
  const source = fs.readFileSync(path.join(__dirname, 'forge-suite-profile.js'), 'utf8');
  assert.match(source, /const \{ SUITE_ID_RE \} = require\('\.\/forge-ci-shards\.js'\)/);
  for (const id of ['ok.test.js', 'unicode-\u00e9.test.js', '../bad.test.js', 'C:\\bad.test.js', 'not-a-suite.js']) {
    const doc = buildSuiteProfile(input()); doc.suites[0].id = id;
    assert.equal(validateSuiteProfile(doc).ok, SUITE_ID_RE.test(id));
  }
});

console.log(`${passed} suite-profile contract checks passed`);
