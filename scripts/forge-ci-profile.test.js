'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const shards = require('./forge-ci-shards.js');
const suiteProfiles = require('./forge-suite-profile.js');
const release = require('./forge-release-checks.js');
const bounded = require('./forge-autonomy-sources.js');
const runner = require('./run-tests.js');

// Observe actual public dependency calls while keeping their real behavior.
const called = {};
const originals = [];
for (const [module, names] of [[shards, ['buildShardProfile', 'validateShardProfile', 'parseShardPlanLine', 'planShards']],
  [suiteProfiles, ['parseSuiteProfile']], [release, ['expandJobs']],
  [bounded, ['readBoundedStableFile']], [runner, ['discoverTests']]]) {
  for (const name of names) {
    const original = module[name]; originals.push([module, name, original]);
    module[name] = (...args) => { called[name] = (called[name] || 0) + 1; return original(...args); };
  }
}
delete require.cache[require.resolve('./forge-ci-profile.js')];
const collector = require('./forge-ci-profile.js');
originals.forEach(([module, name, original]) => { module[name] = original; });

const fixtures = path.join(__dirname, 'fixtures', 'ci-profile');
const versioned = path.join(__dirname, 'fixtures', 'ci-shards', 'shard-profile.json');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ci-profile-'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fixture = name => fs.readFileSync(path.join(fixtures, name), 'utf8');
const json = name => JSON.parse(fixture(name));
let passed = 0, failed = 0;
function test(name, body) {
  try { body(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${error.stack}`); }
}
function cli(args) {
  return spawnSync(process.execPath, [path.join(__dirname, 'forge-ci-profile.js'), ...args], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024,
  });
}
function write(name, value) { const file = path.join(root, name); fs.writeFileSync(file, value); return file; }
function inputSource(name) { return collector.sourceFrom(collector.readInput(path.join(fixtures, name))); }
function loaded() {
  const bytes = fs.readFileSync(versioned);
  return { state: 'loaded', doc: JSON.parse(bytes), sha256: hash(bytes) };
}

try {
  test('S04-T05 truth:0 exact log parse BOM timestamps ANSI counts failures metadata and fail-closed ambiguity', () => {
    const first = collector.parseRunTestsLog(fixture('windows-shard-1.log'), { name: 'windows-shard-1.log' });
    assert.strictEqual(first.platform, 'win32'); assert.strictEqual(first.semantic_key, 'test');
    assert.strictEqual(first.job_name, 'Tests (windows-latest, shard 1/2)');
    assert.strictEqual(first.runner_image, 'windows-synthetic');
    assert.strictEqual(first.runner_image_version, '20261001.1');
    assert.strictEqual(first.node_version, 'v22.23.3');
    assert.strictEqual(first.head_sha, 'abcdef1');
    assert.strictEqual(first.toolcache, 'hit'); assert.strictEqual(first.cache, 'hit');
    assert.strictEqual(first.baseline, 'match');
    assert.strictEqual(first.observed_from, '2026-10-21T10:00:00.0000000Z');
    assert.strictEqual(first.observed_to, '2026-10-21T10:00:30.0000000Z');
    assert.strictEqual(first.suites[0].observed_at, '2026-10-21T10:00:16.0000000Z');
    assert.strictEqual(first.suites_declared, 3); assert.strictEqual(first.suites_observed, 3);
    assert.strictEqual(first.suites_failed, 0); assert.strictEqual(first.summary.elapsed_ms, 3330);
    assert.deepStrictEqual(first.suites.map(row => row.elapsed_ms), [1230, 2000, 100]);
    assert.deepStrictEqual(first.suites.map(row => row.status), ['pass', 'pass', 'pass']);
    assert.strictEqual(first.shard.count, 2); assert.strictEqual(first.shard.algorithm, 'positional-v1');
    assert.strictEqual(first.ambiguous, false);
    assert.deepStrictEqual(first, collector.parseRunTestsLog(fixture('windows-shard-1.log').replace(/\n/g, '\r\n'), { name: 'windows-shard-1.log' }));
    const second = collector.parseRunTestsLog(fixture('windows-shard-2.log'));
    assert.strictEqual(second.suites_failed, 1); assert.strictEqual(second.suites_observed, 3);
    assert.strictEqual(second.toolcache, 'miss'); assert.strictEqual(second.cache, 'miss');
    assert.deepStrictEqual(second.failures, [{ suite: 'epsilon.test.js', exit_code: 1, signal: null }]);
    assert(second.anomalies.includes('duplicate-suite')); assert(second.anomalies.includes('declared-count-mismatch'));
    assert(second.suites.every(row => row.status === 'ambiguous'));
    const mismatch = collector.parseRunTestsLog(fixture('windows-shard-1.log').replace('Running 3', 'Running 4'));
    assert(mismatch.ambiguous); assert(mismatch.suites.every(row => row.status === 'ambiguous'));
    const signal = collector.parseRunTestsLog('Running 1 test suite sequentially...\nFAIL one.test.js (0.01s)\n1 of 1 executed suite failed in 0.01s:\n  - one.test.js (signal SIGTERM)\n');
    assert.strictEqual(signal.failures[0].signal, 'SIGTERM'); assert.strictEqual(signal.suites_failed, 1);
    const local = collector.parseRunTestsLog(fixture('local-run.log'));
    assert.strictEqual(local.platform, null); assert.strictEqual(local.observed_from, null);
    assert(local.unavailable.platform); assert.strictEqual(local.unavailable.queue, 'not-observable-inside-runner');
    const long = collector.parseRunTestsLog(fixture('local-run.log') + 'x'.repeat(collector.LIMITS.line + 1));
    assert(long.anomalies.includes('line-too-long')); assert(long.ambiguous);
    const profile = collector.profileFromSources([inputSource('windows-shard-2.log')]);
    assert.deepStrictEqual(profile.platforms.win32.weights_ms, {});
    assert(profile.platforms.win32.excluded.every(row => row.reason === 'ambiguous-observation'));
  });

  test('S04-T05 truth:1 policy jobs runs clocks wait execution steps null reasons and private-field exclusion', () => {
    const jobs = collector.normalizeJobs(json('jobs-page.json'));
    assert.strictEqual(jobs.length, 5); assert.strictEqual(jobs[0].semantic_key, 'test');
    assert.strictEqual(jobs[0].platform, 'win32'); assert.strictEqual(jobs[0].kind, 'native');
    assert.strictEqual(jobs[0].created_to_started_ms, 5000);
    assert.strictEqual(jobs[0].started_to_completed_ms, 60000);
    assert.match(jobs[0].created_to_started_label, /fila, dependências e provisionamento/);
    assert.strictEqual(jobs[0].steps[0].elapsed_ms, 1000);
    assert.strictEqual(jobs[0].steps[1].name, 'Run test suites');
    assert.strictEqual(jobs[1].semantic_key, 'required-tests-windows'); assert.strictEqual(jobs[1].kind, 'alias');
    assert.strictEqual(jobs[1].platform, null); assert(jobs[1].unavailable.platform);
    assert.strictEqual(jobs[2].semantic_key, 'operational-offline'); assert.strictEqual(jobs[2].platform, 'linux');
    assert.strictEqual(jobs[2].created_at, null); assert.strictEqual(jobs[2].created_to_started_ms, null);
    assert.strictEqual(jobs[2].unavailable.created_at, 'timestamp-invalid');
    assert.strictEqual(jobs[3].semantic_key, 'app');
    assert.strictEqual(jobs[3].started_to_completed_ms, null);
    assert.strictEqual(jobs[3].completed_at, null);
    assert.strictEqual(jobs[3].unavailable.completed_at, 'timestamps-out-of-order');
    assert.strictEqual(jobs[3].unavailable.started_to_completed_ms, 'timestamps-out-of-order');
    assert.strictEqual(jobs[4].semantic_key, null);
    assert.strictEqual(jobs[4].unavailable.semantic_key, 'name-not-in-current-policy');
    assert.strictEqual(jobs[4].unavailable.started_at, 'timestamp-absent');
    const runs = collector.normalizeRuns({ total_count: 2, workflow_runs: [
      { id: 1, run_attempt: 2, event: 'pull_request', status: 'completed', conclusion: 'success',
        head_sha: 'a'.repeat(40), head_branch: 'synthetic', path: '.github/workflows/ci.yml',
        created_at: '2026-10-21T10:00:00Z', run_started_at: '2026-10-21T10:00:05Z', updated_at: '2026-10-21T10:01:05Z',
        actor: { login: 'PRIVATE_SENTINEL' }, display_title: 'PRIVATE_SENTINEL', url: 'PRIVATE_SENTINEL', body: 'PRIVATE_SENTINEL' },
      { id: 2, created_at: '2026-02-30T10:00:00Z', run_started_at: 'invalid', updated_at: null },
    ] });
    assert.strictEqual(runs[0].created_to_run_started_ms, 5000);
    assert.strictEqual(runs[0].updated_minus_created_ms, 65000);
    assert.match(runs[0].updated_minus_created_label, /Aproximado/);
    assert.strictEqual(runs[1].created_at, null); assert(runs[1].unavailable.created_to_run_started_ms);
    const backwards = collector.normalizeRuns({ total_count: 1, workflow_runs: [{
      created_at: '2026-10-21T10:00:05Z', run_started_at: '2026-10-21T10:00:00Z', updated_at: '2026-10-21T10:00:01Z',
    }] })[0];
    assert.strictEqual(backwards.created_to_run_started_ms, null);
    assert.strictEqual(backwards.updated_minus_created_ms, null);
    assert.strictEqual(backwards.run_started_at, null);
    assert.strictEqual(backwards.updated_at, null);
    assert.strictEqual(backwards.unavailable.run_started_at, 'timestamps-out-of-order');
    assert(!JSON.stringify({ jobs, runs }).includes('PRIVATE_SENTINEL'));
    for (const key of ['actor', 'display_title', 'url', 'html_url', 'body']) {
      assert(jobs.every(row => !Object.hasOwn(row, key))); assert(runs.every(row => !Object.hasOwn(row, key)));
    }
    assert.throws(() => collector.normalizeJobs({ total_count: 1001, jobs: Array(1001).fill({}) }));
    assert.throws(() => collector.normalizeJobs({ total_count: 1, jobs: [{ steps: Array(201).fill({}) }] }));
    assert.throws(() => collector.normalizeRuns({ total_count: 0, workflow_runs: [null] }));
  });

  test('S04-T05 truth:2 CLI reproducible passing-only profile bounded provenance and identified CI platforms', () => {
    const input = path.join(fixtures, 'suite-profile.json');
    const first = path.join(root, 'first.json'), second = path.join(root, 'second.json');
    for (const output of [first, second]) {
      const result = cli(['build-shard-profile', '--input', input, '--out', output]);
      assert.strictEqual(result.status, 0, result.stderr);
    }
    assert(fs.readFileSync(first).equals(fs.readFileSync(second)));
    const profile = JSON.parse(fs.readFileSync(first));
    assert(shards.validateShardProfile(profile).ok);
    assert.strictEqual(profile.platforms.linux.weights_ms['structured-pass.test.js'], 120);
    assert(!Object.hasOwn(profile.platforms.linux.weights_ms, 'structured-fail.test.js'));
    assert.deepStrictEqual(profile.platforms.linux.excluded, [{ suite: 'structured-fail.test.js', reason: 'no-passing-observation' }]);
    const source = profile.sources[0];
    assert.strictEqual(source.name, 'suite-profile.json'); assert.strictEqual(source.sha256, hash(fs.readFileSync(input)));
    assert.strictEqual(source.bytes, fs.statSync(input).size); assert.strictEqual(source.job_name, 'test');
    assert.strictEqual(source.runner_image, 'ubuntu24'); assert.strictEqual(source.node_version, 'v22.23.3');
    assert.strictEqual(source.observed_from, '2026-10-21T10:00:00Z'); assert.strictEqual(source.suites_failed, 1);
    assert(!JSON.stringify(profile).includes(root)); assert(!JSON.stringify(profile).includes('PRIVATE_SENTINEL'));
    const parsed = collector.sourceFrom(collector.readInput(input));
    assert.deepStrictEqual(collector.observationsFrom(parsed.parsed).map(row => row.status), ['pass', 'fail']);
    assert(collector.profileFromSources([parsed]).platforms.linux.weights_ms['structured-pass.test.js']);
    assert.throws(() => collector.profileFromSources([inputSource('local-run.log')]), /platform-required/);
    const local = JSON.parse(JSON.stringify(parsed.parsed)); local.condition.ci.provider = null;
    local.condition.unavailable['ci.provider'] = 'absent';
    assert.deepStrictEqual(collector.observationsFrom(local), []);
    const noPlatform = inputSource('windows-shard-1.log'); noPlatform.identity.platform = null;
    assert.throws(() => collector.profileFromSources([noPlatform]), /platform-required/);
  });

  test('issue 215 same-name runs and attempts never acquire source attribution', () => {
    const source = inputSource('windows-shard-1.log');
    const jobs = collector.normalizeJobs(json('jobs-page.json'));
    const matching = jobs.find(job => job.name === source.identity.job_name);
    assert(matching);
    const other = { ...matching, job_id: 9999, run_id: 999, run_attempt: 2 };
    const report = collector.buildProfileReport({ sources: [source, source], jobs: [matching, other, matching] });
    assert.deepStrictEqual(report.strata[0].job_durations, []);
    assert.strictEqual(report.strata[0].unavailable.job, 'source-job-identity-unverified');
    assert.deepStrictEqual(report.jobs, [matching, other, matching]);
    assert.strictEqual(report.strata[0].source_indices.length, 2);
  });

  test('S04-T05 truth:3 report source strata suites jobs queue unavailable estimated partitions and comparable-only deltas', () => {
    const source = inputSource('windows-shard-1.log');
    const local = collector.sourceFrom(collector.readInput(path.join(fixtures, 'local-run.log')), { local_platform: 'win32' });
    assert.strictEqual(local.source_kind, 'local'); assert.deepStrictEqual(collector.observationsFrom(local.parsed, { local: true }), []);
    const report = collector.buildProfileReport({ sources: [source, local], jobs: collector.normalizeJobs(json('jobs-page.json')),
      shard_profile: loaded(), partitions: [{ platform: 'win32', count: 2 }] });
    assert.strictEqual(report.schema, 'forge-ci-profile-report/v1'); assert.strictEqual(report.strata.length, 2);
    assert.strictEqual(report.strata[0].total_suite_ms, 3330);
    assert.strictEqual(report.strata[0].suites.length, 3);
    assert(report.anomalies.some(row => row.job_index === 3 && row.reason === 'completed_at:timestamps-out-of-order'));
    assert.deepStrictEqual(report.strata[0].job_durations, []);
    assert.strictEqual(report.strata[0].unavailable.job, 'source-job-identity-unverified');
    assert.strictEqual(report.jobs[0].created_to_started_ms, 5000);
    assert.strictEqual(report.strata[0].key.runner_image_version, '20261001.1');
    assert.deepStrictEqual(Object.keys(report.strata[0].key), collector.STRATUM_FIELDS);
    assert(report.strata[0].unavailable.event); assert(report.strata[1].unavailable.queue);
    assert.strictEqual(report.predictions[0].status, 'estimated');
    assert.strictEqual(report.predictions[0].weighted.algorithm, 'weighted-lpt-v1');
    assert.strictEqual(report.predictions[0].profile_sha256, loaded().sha256);
    assert(Array.isArray(report.predictions[0].weighted.unprofiled));
    assert(report.predictions[0].positional.predicted_ms.every(Number.isSafeInteger));
    assert(report.unavailable.billing); assert(report.unavailable.after);
    assert.strictEqual(report.comparisons[0].status, 'not-comparable');
    const before = JSON.parse(JSON.stringify(report.strata[0]));
    Object.assign(before.key, { event: 'push', cache: 'hit', universe_size: 6 });
    const after = JSON.parse(JSON.stringify(before));
    after.key.algorithm = 'weighted-lpt-v1'; after.total_suite_ms += 1000;
    const comparable = collector.compareStrata(before, after);
    assert.strictEqual(comparable.status, 'comparable'); assert.strictEqual(comparable.suite_delta_seconds, 1);
    assert.strictEqual(comparable.before_count, 3); assert.strictEqual(comparable.after_count, 3);
    after.key.node_version = 'v24.0.0';
    assert(collector.compareStrata(before, after).reasons.includes('node_version:different'));
    after.key.node_version = before.key.node_version; after.key.event = null;
    assert.strictEqual(collector.compareStrata(before, after).status, 'not-comparable');
    const markdown = collector.renderProfileReport(report);
    assert(!JSON.stringify(report).includes('%')); assert(!markdown.includes('%'));
    assert(markdown.includes('estimated')); assert(markdown.includes('indisponível'));
    assert(markdown.includes('Run test suites')); assert(markdown.includes('5000'));
    const output = path.join(root, 'report.json'), md = path.join(root, 'report.md');
    const result = cli(['report', '--input', path.join(fixtures, 'windows-shard-1.log'), '--local-log', `win32=${path.join(fixtures, 'local-run.log')}`,
      '--jobs', path.join(fixtures, 'jobs-page.json'), '--shard-profile', versioned, '--partition', 'win32:2', '--json', output, '--markdown', md]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout.trim().split('\n').length, 1);
    const saved = JSON.parse(fs.readFileSync(output));
    assert.strictEqual(saved.api_sources[0].kind, 'jobs'); assert(saved.api_sources[0].sha256);
    assert(!fs.readFileSync(md, 'utf8').includes('%'));
    const anomalous = cli(['report', '--input', path.join(fixtures, 'windows-shard-2.log')]);
    assert.strictEqual(anomalous.status, 0); assert(anomalous.stdout.includes('duplicate-suite'));
  });

  test('S04-T05 truth:4 versioned observed profile valid sanitized provenance integer weights complete disjoint real universe', () => {
    const profile = loaded(); assert(shards.validateShardProfile(profile.doc).ok);
    const names = new Set(release.expandJobs(release.POLICY.workflows.ci).filter(row => row.key === 'test').map(row => row.name));
    for (const source of profile.doc.sources) {
      assert.strictEqual(path.basename(source.name), source.name); assert(!/[\\/]/.test(source.name));
      assert(/^[a-f0-9]{64}$/.test(source.sha256)); assert(Number.isSafeInteger(source.bytes));
      assert(names.has(source.job_name)); assert.strictEqual(source.kind, 'run-tests-log');
      assert(timestampInWindow(source.observed_from)); assert(timestampInWindow(source.observed_to));
      assert(Number.isSafeInteger(source.suites_failed)); assert(source.suites_failed >= 0);
    }
    function timestampInWindow(value) { return typeof value === 'string' && /^2026-10-21T/.test(value); }
    function hygiene(value) {
      if (typeof value === 'string') { assert(!/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(value)); assert(!value.includes('.gsd')); }
      else if (Array.isArray(value)) value.forEach(hygiene);
      else if (value && typeof value === 'object') Object.values(value).forEach(hygiene);
    }
    hygiene(profile.doc);
    const universe = runner.discoverTests([]);
    for (const [platform, count] of [['win32', 2], ['linux', 1], ['darwin', 1]]) {
      const row = profile.doc.platforms[platform]; assert.strictEqual(row.status, 'observed');
      assert(Object.values(row.weights_ms).every(weight => Number.isSafeInteger(weight) && weight >= 1));
      row.excluded.forEach(excluded => assert(!Object.hasOwn(row.weights_ms, excluded.suite)));
      const plan = shards.planShards({ suites: universe, platform, index: 0, count, profile });
      assert.strictEqual(plan.algorithm, 'weighted-lpt-v1'); assert.strictEqual(plan.fallback, null);
      assert(shards.verifyPartition(universe, plan.shards).ok);
      assert.strictEqual(new Set(plan.shards.flat()).size, universe.length);
      assert.strictEqual(plan.shards.flat().length, universe.length);
    }
  });

  test('issue 216 output identities collide before publication without residue', () => {
    const dir = fs.mkdtempSync(path.join(root, 'outputs-'));
    const first = path.join(dir, 'report.json'), second = path.join(dir, 'other.json');
    fs.writeFileSync(first, 'unchanged'); fs.linkSync(first, second);
    const invoke = (a, b) => cli(['report', '--json', a, '--markdown', b]);
    let result = invoke(first, second);
    assert.notStrictEqual(result.status, 0); assert(result.stderr.includes('ci-profile-output-collision'));
    assert.strictEqual(fs.readFileSync(first, 'utf8'), 'unchanged');
    assert.strictEqual(fs.readFileSync(second, 'utf8'), 'unchanged');
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['other.json', 'report.json']);
    const probe = path.join(dir, 'CaseProbe'); fs.writeFileSync(probe, 'probe');
    const insensitive = fs.existsSync(path.join(dir, 'caseprobe')); fs.unlinkSync(probe);
    const lower = path.join(dir, 'fresh.json'), upper = path.join(dir, 'FRESH.JSON');
    result = invoke(lower, upper);
    if (insensitive) {
      assert.notStrictEqual(result.status, 0); assert(result.stderr.includes('ci-profile-output-collision'));
      assert(!fs.existsSync(lower)); assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['other.json', 'report.json']);
      result = invoke(first, path.join(dir, 'REPORT.JSON'));
      assert.notStrictEqual(result.status, 0); assert.strictEqual(fs.readFileSync(first, 'utf8'), 'unchanged');
    } else {
      assert.strictEqual(result.status, 0, result.stderr);
      assert(JSON.parse(fs.readFileSync(lower)).schema); assert(fs.readFileSync(upper, 'utf8').startsWith('#'));
    }
    result = invoke(path.join(dir, 'distinct.json'), path.join(dir, 'distinct.md'));
    assert.strictEqual(result.status, 0, result.stderr);
  });

  test('bounded explicit files strict UTF8 link refusal and closed CLI output safety', () => {
    const good = write('good.log', fixture('windows-shard-1.log'));
    assert.strictEqual(collector.readInput(good).bytes, fs.statSync(good).size);
    const badUtf8 = write('bad-utf8.log', Buffer.from([0xc3, 0x28]));
    const oversized = path.join(root, 'oversized.log');
    const descriptor = fs.openSync(oversized, 'wx');
    try { fs.ftruncateSync(descriptor, collector.LIMITS.bytes + 1); } finally { fs.closeSync(descriptor); }
    for (const file of [badUtf8, oversized, root, path.join(root, 'missing')]) {
      assert.strictEqual(cli(['report', '--input', file]).status, 2);
    }
    const link = path.join(root, 'link.log');
    let linked = false;
    try { fs.symlinkSync(good, link); linked = true; }
    catch (error) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error; console.log('SKIP physical symlink creation denied by OS; injected refusal still checked'); }
    if (linked) assert.strictEqual(cli(['report', '--input', link]).status, 2);
    const original = fs.lstatSync;
    try {
      fs.lstatSync = file => path.resolve(file) === good ? { isSymbolicLink: () => true } : original(file);
      assert.throws(() => collector.readInput(good), /link-refused/);
    } finally { fs.lstatSync = original; }
    const before = hash(fs.readFileSync(good));
    for (const args of [[], ['unknown'], ['report', '--wat', 'x'], ['report', '--input'],
      ['report', '--partition', 'win32:65'], ['report', '--partition', 'other:2'],
      ['report', '--json', path.join(root, 'same'), '--markdown', path.join(root, 'same')],
      ['report', '--input', good, '--json', good], ['build-shard-profile', '--input', good, '--out', good],
      ['build-shard-profile', '--input', path.join(fixtures, 'local-run.log'), '--out', path.join(root, 'bad.json')]]) {
      assert.strictEqual(cli(args).status, 2, JSON.stringify(args));
    }
    assert.strictEqual(hash(fs.readFileSync(good)), before);
    const many = ['report']; for (let i = 0; i < 65; i += 1) many.push('--input', good);
    assert.strictEqual(cli(many).status, 2);
    const hardlink = path.join(root, 'hardlink.log'); fs.linkSync(good, hardlink);
    assert.strictEqual(cli(['report', '--input', good, '--json', hardlink]).status, 2);
    const runFile = write('runs.json', JSON.stringify({ total_count: 1, workflow_runs: [{ id: 2 }] }));
    const output = path.join(root, 'runs-report.json');
    assert.strictEqual(cli(['report', '--runs', runFile, '--json', output]).status, 0);
    const report = JSON.parse(fs.readFileSync(output)); assert(report.runs[0].unavailable.created_at);
    assert.strictEqual(report.api_sources[0].kind, 'runs');
  });

  test('S04-T05 key_link:0 real shard builder validator plan-line parser and load prediction calls', () => {
    for (const name of ['buildShardProfile', 'validateShardProfile', 'parseShardPlanLine', 'planShards']) assert(called[name] > 0, name);
  });
  test('S04-T05 key_link:1 structured profile parsing uses public parseSuiteProfile', () => assert(called.parseSuiteProfile > 0));
  test('S04-T05 key_link:2 rendered semantic platform identity uses expandJobs over POLICY', () => assert(called.expandJobs > 0));
  test('S04-T05 key_link:3 untrusted explicit files use readBoundedStableFile after link refusal', () => assert(called.readBoundedStableFile > 0));
  test('S04-T05 key_link:4 estimated partition universe uses discoverTests only', () => {
    assert(called.discoverTests > 0);
    assert.match(fs.readFileSync(path.join(__dirname, 'forge-ci-profile.js'), 'utf8'), /const \{ discoverTests \} = require\('\.\/run-tests\.js'\)/);
  });
  test('S04-T05 key_link:5 versioned fixture validated provenance hygiene and real-universe partition', () => {
    const profile = loaded(); assert(shards.validateShardProfile(profile.doc).ok);
    const universe = runner.discoverTests([]);
    for (const platform of shards.PLATFORMS) {
      assert.strictEqual(profile.doc.platforms[platform].status, 'observed');
      assert(shards.verifyPartition(universe, shards.planShards({ suites: universe, platform, count: platform === 'win32' ? 2 : 1, index: 0, profile }).shards).ok);
    }
    assert(profile.doc.sources.every(source => /^[a-f0-9]{64}$/.test(source.sha256) && !/[\\/]/.test(source.name)));
  });
} finally {
  assert.strictEqual(path.dirname(root), path.resolve(os.tmpdir()));
  assert(path.basename(root).startsWith('forge-ci-profile-'));
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`forge-ci-profile: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
