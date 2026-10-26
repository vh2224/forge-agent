#!/usr/bin/env node
'use strict';

// Exercise the real runner in a disposable root containing only synthetic
// suites. Never spawn the repository runner from this suite (it would recurse).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const runner = require('./run-tests.js');
const { buildShardProfile, loadShardProfile, planShards, parseShardPlanLine,
  LIMITS } = require('./forge-ci-shards.js');
const { parseSuiteProfile } = require('./forge-suite-profile.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runner-shards-'));
const scripts = path.join(root, 'scripts');
const markers = path.join(root, 'markers');
const weightsFile = path.join(root, 'weights.json');
const baselineFile = path.join(root, 'baseline.json');
const outputSentinel = 'SYNTHETIC_OUTPUT_PRIVATE_9327';
const envSentinel = 'SYNTHETIC_ENV_PRIVATE_5418';
const suites = ['a-fail', 'b-fast', 'c-fast', 'd-fast', 'e-fast', 'f-fast', 'g-fast', 'h-slow']
  .map(stem => `${stem}.test.js`);
let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}\n${error.stack}`); }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function resetMarkers() {
  fs.rmSync(markers, { recursive: true, force: true });
  fs.mkdirSync(markers);
}

function observed() {
  const file = path.join(markers, 'executed.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [];
}

function invoke(args, wrapper = null) {
  const argv = wrapper === null ? [path.join(scripts, 'run-tests.js'), ...args]
    : ['-e', wrapper, '--', ...args];
  const result = spawnSync(process.execPath, argv, {
    cwd: root, windowsHide: true, timeout: 20000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, FORGE_SYNTHETIC_MARKERS: markers,
      FORGE_SYNTHETIC_SECRET: envSentinel, FORGE_KEYCHAIN_DISABLED: '0' },
  });
  assert.ifError(result.error);
  assert.strictEqual(result.signal, null);
  return result;
}

function shardArgs(index, profile = weightsFile) {
  return ['--shard-index', String(index), '--shard-count', '2',
    ...(profile === null ? [] : ['--shard-profile', profile])];
}

function planLine(result, list = false) {
  const lines = (list ? result.stderr : result.stdout).split(/\r?\n/)
    .filter(line => line.startsWith('Shard plan:'));
  assert.strictEqual(lines.length, 1, 'exactly one plan line on the selected stream');
  assert(!(list ? result.stdout : result.stderr).includes('Shard plan:'));
  const plan = parseShardPlanLine(lines[0]);
  assert(plan, 'the public plan-line parser accepts the emitted line');
  return plan;
}

function readProfile(file) {
  const text = fs.readFileSync(file, 'utf8');
  assert(!text.includes(outputSentinel), 'suite stdout and stderr stay out of the profile');
  assert(!text.includes(envSentinel), 'non-allowlisted environment stays out of the profile');
  assert(!text.includes(root.replace(/\\/g, '\\\\')), 'temporary absolute paths stay out of the profile');
  return parseSuiteProfile(text);
}

function normalized(text) {
  return text.replace(/\r\n/g, '\n').replace(/\(\d+\.\d{2}s\)/g, '(TIME)')
    .replace(/in \d+\.\d{2}s/g, 'in TIME');
}

try {
  fs.mkdirSync(scripts);
  resetMarkers();
  for (const name of ['run-tests.js', 'forge-ci-shards.js', 'forge-suite-profile.js']) {
    fs.copyFileSync(path.join(__dirname, name), path.join(scripts, name));
    assert.deepStrictEqual(fs.readFileSync(path.join(scripts, name)), fs.readFileSync(path.join(__dirname, name)));
  }
  for (const id of suites) {
    // Exclusive lock makes accidental concurrent suite execution fail loudly.
    // Record only fixture facts, never the caller's full environment.
    const source = [
      "'use strict';", "const fs = require('fs');", "const path = require('path');",
      'const dir = process.env.FORGE_SYNTHETIC_MARKERS;',
      "const lock = path.join(dir, 'active.lock');", "const fd = fs.openSync(lock, 'wx');",
      `const id = ${JSON.stringify(id)};`,
      'try {',
      `  if (id === 'h-slow.test.js') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);`,
      "  fs.appendFileSync(path.join(dir, 'executed.jsonl'), JSON.stringify({ id,",
      '    home: process.env.HOME, userprofile: process.env.USERPROFILE, appdata: process.env.APPDATA,',
      "    keychain: process.env.FORGE_KEYCHAIN_DISABLED }) + '\\n');",
      "} finally { fs.closeSync(fd); fs.unlinkSync(lock); }",
      `if (id === 'a-fail.test.js') { console.log(${JSON.stringify(outputSentinel)});`,
      `  console.error(${JSON.stringify(outputSentinel)}); process.exitCode = 3; }`,
    ].join('\n');
    fs.writeFileSync(path.join(scripts, id), source);
  }
  const source = { kind: 'run-tests-log', name: 'synthetic.log', sha256: 'a'.repeat(64), bytes: 1,
    platform: process.platform, job_name: null, runner_image: null, runner_image_version: null,
    node_version: null, observed_from: null, observed_to: null, suites_declared: suites.length,
    suites_observed: suites.length, suites_failed: 0,
    unavailable: Object.fromEntries(['job_name', 'runner_image', 'runner_image_version',
      'node_version', 'observed_from', 'observed_to'].map(key => [key, 'synthetic'])) };
  const weights = buildShardProfile({ sources: [source], observations: suites.map((suite, index) => ({
    platform: process.platform, suite, elapsed_ms: [1000, 200, 100, 90, 80, 70, 60, 50][index],
    status: 'pass', source_index: 0,
  })) });
  writeJson(weightsFile, weights);
  const baselineEntry = { suite: suites[0], item: 'I-0000', reason: 'synthetic exit 3' };
  const baseline = { win32: [], darwin: [], linux: [], [process.platform]: [baselineEntry] };
  writeJson(baselineFile, baseline);

  test('S04-T04 truth:0 legacy selection order output exits baseline changed and exports', () => {
    const list = invoke(['--list']);
    assert.strictEqual(list.status, 0);
    assert.strictEqual(list.stdout, `${suites.join('\n')}\n`);
    assert.strictEqual(list.stderr, '');
    for (const count of [2, LIMITS.maxShards + 1]) {
      for (const index of [0, 1]) {
        const listed = invoke(['--shard-index', String(index), '--shard-count', String(count), '--list']);
        assert.strictEqual(listed.status, 0);
        assert.strictEqual(listed.stdout, `${runner.suitesForShard(suites, index, count).join('\n')}\n`);
        assert.strictEqual(listed.stderr, '');
      }
    }
    // Inject discovery only, so the compatibility check does not need thousands
    // of fixture files and still exercises the copied runner's actual selector.
    const largeUniverse = Array.from({ length: LIMITS.maxSuites + 1 }, (_, i) =>
      `virtual-${String(i).padStart(5, '0')}.test.js`);
    const largeDiscovery = "const fs=require('fs'); const path=require('path'); const original=fs.readdirSync;"
      + `const names=Array.from({length:${largeUniverse.length}},(_,i)=>'virtual-'+String(i).padStart(5,'0')+'.test.js');`
      + "fs.readdirSync=(dir,...rest)=>path.resolve(dir)===path.resolve('./scripts')"
      + "?names.map(name=>({name,isFile:()=>true})):original(dir,...rest);"
      + "process.exitCode=require('./scripts/run-tests.js').main(process.argv.slice(1));";
    const largeList = invoke(['--shard-index', '1', '--shard-count', '2', '--list'], largeDiscovery);
    assert.strictEqual(largeList.status, 0, largeList.stderr);
    assert.strictEqual(largeList.stdout, `${runner.suitesForShard(largeUniverse, 1, 2).join('\n')}\n`);
    assert.strictEqual(largeList.stderr, '');
    const result = invoke(['--baseline', baselineFile]);
    assert.strictEqual(result.status, 0);
    const stdout = ['Running 8 test suites sequentially...', 'FAIL a-fail.test.js (TIME)', outputSentinel,
      ...suites.slice(1).map(id => `PASS ${id} (TIME)`), '',
      `Baseline match on ${process.platform}: 1 known failure(s), 0 new, 0 stale.`,
      '  - a-fail.test.js (I-0000) \u2014 synthetic exit 3', ''].join('\n');
    assert.strictEqual(normalized(result.stdout), stdout);
    assert.strictEqual(normalized(result.stderr), `${outputSentinel}\n\n1 of 8 executed suites failed in TIME:\n  - a-fail.test.js (exit 3)\n`);
    assert.deepStrictEqual(observed().map(row => row.id), suites);
    resetMarkers();
    const clean = invoke(['--match', 'b-fast']);
    assert.strictEqual(clean.status, 0);
    assert.strictEqual(normalized(clean.stdout), 'Running 1 test suite sequentially...\nPASS b-fast.test.js (TIME)\n\nAll 1 suites passed in TIME.\n');
    assert.strictEqual(clean.stderr, '');
    const red = invoke(['--match', 'a-fail']);
    assert.strictEqual(red.status, 1);
    const usage = invoke(['--unknown']);
    assert.strictEqual(usage.status, 2);
    assert(!result.stdout.includes('Shard plan:'));
    assert.deepStrictEqual(runner.suitesForChangedFiles(['scripts/b-fast.js'], suites), ['b-fast.test.js']);
    assert.deepStrictEqual(Object.keys(runner).sort(), ['childEnv', 'compareFailures', 'discoverTests',
      'isolatedEnv', 'main', 'parseArgs', 'resolveBaseline', 'suitesForChangedFiles', 'BASELINE_PLATFORMS',
      'baselineEntriesForSuites', 'suitesForShard'].sort());
    resetMarkers();
  });

  const weightedProfiles = [];
  test('S04-T04 truth:1 weighted shards self-check sequential isolated execution and one plan line', () => {
    const plans = [];
    for (const index of [0, 1]) {
      resetMarkers();
      const out = path.join(root, `weighted-${index}.json`);
      const result = invoke([...shardArgs(index), '--baseline', baselineFile, '--profile-out', out]);
      assert.strictEqual(result.status, 0, result.stderr);
      const line = planLine(result);
      assert.strictEqual(line.algorithm, 'weighted-lpt-v1');
      assert.strictEqual(line.fallback, null);
      const expected = planShards({ suites, index, count: 2, platform: process.platform,
        profile: loadShardProfile(weightsFile) });
      const rows = observed();
      assert.deepStrictEqual(rows.map(row => row.id), expected.selected);
      assert.deepStrictEqual(result.stdout.split(/\r?\n/).filter(text => /^(PASS|FAIL) /.test(text))
        .map(text => text.split(' ')[1]), expected.selected);
      assert.strictEqual(new Set(rows.map(row => row.home)).size, rows.length);
      for (const row of rows) {
        assert.strictEqual(row.home, row.userprofile);
        assert.notStrictEqual(row.home, process.env.HOME);
        assert.notStrictEqual(row.home, process.env.USERPROFILE);
        assert(row.appdata.startsWith(`${row.home}${path.sep}`));
        assert.strictEqual(row.keychain, '1');
        assert(!fs.existsSync(row.home), 'runner cleans isolated homes');
      }
      const profile = readProfile(out);
      assert.deepStrictEqual(profile.suites.map(row => row.id), expected.selected);
      assert.strictEqual(profile.verdict.baseline, 'match');
      assert.strictEqual(profile.verdict.exit_code, 0);
      assert.strictEqual(profile.mode.isolation, 'isolated-home');
      assert.strictEqual(profile.shard.partition_sha256, line.partition_sha256);
      assert.strictEqual(profile.shard.profile_sha256, line.profile_sha256);
      assert.strictEqual(profile.selection.universe_sha256, line.universe_sha256);
      assert.strictEqual(profile.selection.discovered, suites.length);
      if (expected.selected.includes(suites[0])) {
        assert(result.stdout.includes(outputSentinel));
        assert(result.stderr.includes(outputSentinel));
        assert.strictEqual(profile.suites.find(row => row.id === suites[0]).exit_code, 3);
      }
      weightedProfiles.push(profile);
      plans.push(line);
    }
    assert.strictEqual(plans[0].partition_sha256, plans[1].partition_sha256);
    assert.strictEqual(plans[0].universe_sha256, plans[1].universe_sha256);
    assert.notDeepStrictEqual(weightedProfiles[0].suites.map(row => row.id), runner.suitesForShard(suites, 0, 2));
    assert(weightedProfiles.flatMap(profile => profile.suites).find(row => row.id === 'h-slow.test.js').elapsed_ms >= 150);
  });

  test('S04-T04 truth:2 fallback and closed input or partition errors before any suite', () => {
    const missing = path.join(root, 'missing.json');
    const platformMissing = path.join(root, 'platform-missing.json');
    const other = JSON.parse(JSON.stringify(weights));
    delete other.platforms[process.platform];
    writeJson(platformMissing, other);
    for (const [file, fallback] of [[missing, 'profile-absent'], [platformMissing, 'platform-missing']]) {
      for (const index of [0, 1]) {
        resetMarkers();
        const legacy = invoke([...shardArgs(index, null), '--list']);
        const result = invoke([...shardArgs(index, file), '--list']);
        assert.strictEqual(result.status, 0);
        assert.strictEqual(result.stdout, legacy.stdout);
        assert.strictEqual(planLine(result, true).fallback, fallback);
        assert.deepStrictEqual(observed(), []);
      }
    }
    const invalidJson = path.join(root, 'invalid.json');
    const invalidSchema = path.join(root, 'invalid-schema.json');
    const oversized = path.join(root, 'oversized.json');
    fs.writeFileSync(invalidJson, '{');
    writeJson(invalidSchema, { ...weights, surprise: 'not allowed' });
    fs.writeFileSync(oversized, Buffer.alloc(LIMITS.maxProfileBytes + 1, 32));
    for (const file of [invalidJson, invalidSchema, oversized, root]) {
      resetMarkers();
      const result = invoke(shardArgs(0, file));
      assert.strictEqual(result.status, 2);
      assert(result.stderr.includes('Shard profile FAILED: shard-profile-'));
      assert(!result.stdout.includes('Running '));
      assert.deepStrictEqual(observed(), []);
    }
    for (const args of [['--shard-profile', weightsFile], ['--profile-out', missing, '--list']]) {
      const result = invoke(args);
      assert.strictEqual(result.status, 2);
      assert.deepStrictEqual(observed(), []);
    }
    const brokenPartition = "require('./scripts/forge-ci-shards.js').verifyPartition = () => ({ok:false});"
      + "process.exitCode = require('./scripts/run-tests.js').main(process.argv.slice(1));";
    const refused = invoke(shardArgs(0), brokenPartition);
    assert.strictEqual(refused.status, 2);
    assert(refused.stderr.includes('Shard plan FAILED'));
    assert(!refused.stdout.includes('Running '));
    assert.deepStrictEqual(observed(), []);
  });

  test('S04-T04 truth:3 complete bounded profiles fail-fast not-run and write-failure verdicts', () => {
    resetMarkers();
    const out = path.join(root, 'fail-fast.json');
    const result = invoke(['--fail-fast', '--profile-out', out]);
    assert.strictEqual(result.status, 1);
    const profile = readProfile(out);
    assert.deepStrictEqual(profile.suites.map(row => row.id), suites);
    assert.deepStrictEqual(profile.suites.map(row => row.status), ['fail', ...suites.slice(1).map(() => 'not-run')]);
    assert.deepStrictEqual(profile.totals, { executed: 1, passed: 0, failed: 1, not_run: 7 });
    assert.strictEqual(profile.mode.fail_fast, true);
    assert.strictEqual(profile.verdict.exit_code, 1);
    assert.deepStrictEqual(observed().map(row => row.id), [suites[0]]);
    for (const args of [[], ['--baseline', baselineFile], ['--match', 'b-fast']]) {
      const plain = invoke(args);
      const unwritable = invoke([...args, '--profile-out', root]);
      assert.strictEqual(unwritable.status, plain.status);
      assert(unwritable.stderr.includes('Suite profile not written: suite-profile-write-failed'));
    }
    for (const args of [['--match', 'does-not-exist'], ['--baseline', path.join(root, 'absent-baseline')]]) {
      const skipped = path.join(root, 'not-written.json');
      const result = invoke([...args, '--profile-out', skipped]);
      assert.strictEqual(result.status, 2);
      assert(result.stderr.includes('Suite profile not written:'));
      assert(!fs.existsSync(skipped));
    }
    const positional = path.join(root, 'positional.json');
    const sharded = invoke([...shardArgs(1, null), '--profile-out', positional]);
    assert.strictEqual(sharded.status, 0);
    assert(!sharded.stdout.includes('Shard plan:'));
    assert.strictEqual(readProfile(positional).shard.algorithm, 'positional-v1');
    assert(!fs.readdirSync(root).some(name => name.startsWith('.suite-profile-')));
  });

  test('native uint32 and signal child outcomes retain a parseable failure profile and runner verdict', () => {
    for (const status of [3221225477, 4294967295, null]) {
      resetMarkers();
      const signal = status === null ? 'SIGTERM' : null;
      // Inject the native spawn result; no crashing process or platform-specific
      // process.exit conversion is needed to exercise runner/profile integration.
      const wrapper = `require('child_process').spawnSync=()=>(${JSON.stringify({ status, signal, error: null })});`
        + "process.exitCode=require('./scripts/run-tests.js').main(process.argv.slice(1));";
      const out = path.join(root, `native-${status}.json`);
      const result = invoke(['--match', 'b-fast', '--profile-out', out], wrapper);
      assert.strictEqual(result.status, 1);
      assert(!result.stderr.includes('Suite profile not written:'), result.stderr);
      const profile = readProfile(out);
      assert.strictEqual(profile.suites.length, 1);
      assert.strictEqual(profile.suites[0].exit_code, status);
      assert.strictEqual(profile.suites[0].signal, signal);
      assert.strictEqual(profile.suites[0].status, 'fail');
      assert.strictEqual(profile.verdict.exit_code, 1);
      assert.deepStrictEqual(profile.totals, { executed: 1, passed: 0, failed: 1, not_run: 0 });
      assert.deepStrictEqual(observed(), [], 'only spawn results are injected');
    }
  });

  test('S04-T04 truth:4 copied runner synthetic partition union disjunction fingerprints baseline fallback privacy', () => {
    assert.strictEqual(weightedProfiles.length, 2);
    const ids = weightedProfiles.flatMap(profile => profile.suites.map(row => row.id));
    assert.deepStrictEqual([...ids].sort(), [...suites].sort());
    assert.strictEqual(new Set(ids).size, suites.length);
    assert.strictEqual(weightedProfiles[0].shard.partition_sha256, weightedProfiles[1].shard.partition_sha256);
    assert(weightedProfiles.every(profile => profile.verdict.baseline === 'match'));
    assert.deepStrictEqual(fs.readdirSync(scripts).filter(name => name.endsWith('.test.js')).sort(), [...suites].sort());
    assert(fs.readdirSync(scripts).every(name => suites.includes(name)
      || ['run-tests.js', 'forge-ci-shards.js', 'forge-suite-profile.js'].includes(name)));
  });

  test('S04-T04 key_link:0 runner calls loadShardProfile planShards verifyPartition formatShardPlanLine', () => {
    const trace = path.join(markers, 'calls.jsonl');
    resetMarkers();
    const wrapper = "const fs=require('fs'); const path=require('path');"
      + "const api=require('./scripts/forge-ci-shards.js');"
      + "for(const key of ['loadShardProfile','planShards','verifyPartition','formatShardPlanLine']) {"
      + "const original=api[key]; api[key]=(...args)=>{fs.appendFileSync(path.join(process.env.FORGE_SYNTHETIC_MARKERS,'calls.jsonl'),JSON.stringify(key)+'\\n'); return original(...args);};}"
      + "process.exitCode=require('./scripts/run-tests.js').main(process.argv.slice(1));";
    const result = invoke([...shardArgs(0), '--list'], wrapper);
    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse),
      ['loadShardProfile', 'planShards', 'verifyPartition', 'formatShardPlanLine']);
    planLine(result, true);
  });

  test('S04-T04 key_link:1 runner calls observeCondition buildSuiteProfile writeSuiteProfile after execution', () => {
    resetMarkers();
    const trace = path.join(markers, 'profile-calls.jsonl');
    const wrapper = "const fs=require('fs'); const path=require('path');"
      + "const api=require('./scripts/forge-suite-profile.js');"
      + "for(const key of ['observeCondition','buildSuiteProfile','writeSuiteProfile']) {"
      + "const original=api[key]; api[key]=(...args)=>{"
      + "if(!fs.existsSync(path.join(process.env.FORGE_SYNTHETIC_MARKERS,'executed.jsonl')))throw new Error('profile-before-suite');"
      + "fs.appendFileSync(path.join(process.env.FORGE_SYNTHETIC_MARKERS,'profile-calls.jsonl'),JSON.stringify(key)+'\\n'); return original(...args);};}"
      + "process.exitCode=require('./scripts/run-tests.js').main(process.argv.slice(1));";
    const out = path.join(root, 'wired-profile.json');
    const result = invoke(['--match', 'b-fast', '--profile-out', out], wrapper);
    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse),
      ['observeCondition', 'buildSuiteProfile', 'writeSuiteProfile']);
    assert.strictEqual(readProfile(out).totals.passed, 1);
  });

  test('S04-T04 key_link:2 real runner byte copies execute via process.execPath only synthetic suites', () => {
    for (const name of ['run-tests.js', 'forge-ci-shards.js', 'forge-suite-profile.js']) {
      assert.deepStrictEqual(fs.readFileSync(path.join(scripts, name)), fs.readFileSync(path.join(__dirname, name)));
    }
    resetMarkers();
    const result = invoke(['--match', 'b-fast']);
    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(observed().map(row => row.id), ['b-fast.test.js']);
    assert(result.stdout.includes('PASS b-fast.test.js'));
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
