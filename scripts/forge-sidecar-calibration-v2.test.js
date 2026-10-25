'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const v1 = require('./forge-sidecar-calibration');
const v2 = require('./forge-sidecar-calibration-v2');
const liveness = require('./forge-sidecar-liveness');

const binding = { receipt: 'fixture-receipt', fingerprint: 'fixture-fingerprint' };
const base = { model: 'claude-fixture', effort: 'high', phase: 'execute' };
const homes = [];
function fresh() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-calibration-v2-')));
  homes.push(home);
  return { userHome: home };
}
const storeFile = (options, name = 'calibration-v2.json') => path.join(v2.directory(options), name);
function accept(input, options, initial, gap) {
  const proposal = v2.propose(input, { initial_sample_ms: initial, gap_sample_ms: gap });
  return { proposal, result: v2.commit(proposal, binding, options) };
}
function censor(input, options, dimension, window) {
  const proposal = v2.proposeCensored(input, { dimension, window_ms: window });
  return { proposal, result: v2.commit(proposal, binding, options) };
}
function fill(input, options, initial, gap, count = 5) {
  for (let i = 0; i < count; i++) assert.strictEqual(accept(input, options, initial, gap).result.committed, true);
}

try {
  // Floors and frozen constants.
  assert.deepStrictEqual({ ...liveness.CALIBRATION_FLOORS }, { startMs: 30000, deadMs: 120000 });
  assert(Object.isFrozen(liveness.CALIBRATION_FLOORS));
  assert.strictEqual(v2.POLICY, 'claude-silence-v2');
  assert.strictEqual(v2.identity(base).policy, 'claude-silence-v2');
  assert.strictEqual(v1.identity(base).policy, 'claude-silence-v1');
  assert.throws(() => v2.identity({ ...base, effort: 'bogus' }), /calibration-identity-invalid/);
  assert.throws(() => v2.identity({ ...base, phase: 'nope' }), /calibration-identity-invalid/);

  // thresholdFor formula (Demo 1 numbers).
  const t = v2.thresholdFor;
  assert.strictEqual(t('gap', [10000, 1, 1, 1, 1], null), 120000);
  assert.strictEqual(t('gap', [50000], null), 215000);
  assert.strictEqual(t('gap', [999999], null), 240000);
  assert.strictEqual(t('initial', [2000], null), 30000);
  assert.strictEqual(t('initial', [20000], null), 60000);
  assert.strictEqual(t('initial', [999999], null), 60000);
  assert.strictEqual(t('gap', [10000], 999999), 240000);
  assert.strictEqual(t('gap', [10000], 150000), 165000);
  assert.throws(() => t('suspect', [1], null), /calibration-threshold-invalid/);
  assert.throws(() => t('gap', [-1], null), /calibration-threshold-invalid/);

  // Calibrated thresholds persisted through commit.
  for (const [initial, gap, expectInitial, expectGap] of [[2000, 10000, 30000, 120000],
    [20000, 50000, 60000, 215000], [70000, 999999, 60000, 240000]]) {
    const options = fresh();
    fill(base, options, initial, gap);
    const record = v2.read(base, options);
    assert.strictEqual(record.diagnostic, null);
    assert.strictEqual(record.initial.state, 'calibrated');
    assert.strictEqual(record.initial.threshold_ms, expectInitial);
    assert.strictEqual(record.gap.threshold_ms, expectGap);
    assert(record.initial.threshold_ms >= 30000 && record.initial.threshold_ms <= 60000);
    assert(record.gap.threshold_ms >= 120000 && record.gap.threshold_ms <= 240000);
  }

  // 4 samples are not enough; calibration freezes at 5 distinct samples.
  {
    const options = fresh();
    fill(base, options, 2000, 10000, 4);
    assert.strictEqual(v2.read(base, options).gap.state, 'calibrating');
    assert.strictEqual(v2.read(base, options).gap.threshold_ms, null);
    fill(base, options, 2000, 10000, 1);
    const frozen = accept(base, options, 900000, 900000);
    assert.deepStrictEqual(frozen.result, { committed: true, noop: 'frozen' });
    assert.strictEqual(v2.read(base, options).gap.threshold_ms, 120000);
  }

  // Replay of the same proposal counts once.
  {
    const options = fresh();
    const { proposal } = accept(base, options, 2000, 10000);
    assert.deepStrictEqual(v2.commit(proposal, { receipt: 'other', fingerprint: 'other' }, options),
      { committed: true, noop: 'replay' });
    assert.strictEqual(v2.read(base, options).gap.count, 1);
    const censoredReplay = censor(base, options, 'gap', 90000);
    assert.deepStrictEqual(v2.commit(censoredReplay.proposal, binding, options), { committed: true, noop: 'replay' });
    assert.strictEqual(v2.read(base, options).gap.censored.count, 1);
  }

  // Censored samples: lower bound only.
  {
    const options = fresh();
    censor(base, options, 'gap', 999999);
    censor(base, options, 'initial', 999999);
    const only = v2.read(base, options);
    assert.strictEqual(only.gap.state, 'uncalibrated');
    assert.strictEqual(only.gap.calibrated, false);
    assert.strictEqual(only.gap.threshold_ms, null);
    assert.strictEqual(only.gap.censored.count, 1);
    assert.strictEqual(v2.resolve(base, options).gap.threshold_ms, null);
    fill(base, options, 2000, 10000);
    assert.strictEqual(v2.read(base, options).gap.threshold_ms, 240000);
    assert.strictEqual(v2.read(base, options).initial.threshold_ms, 60000);
  }
  {
    const options = fresh();
    fill(base, options, 2000, 10000);
    let previous = v2.read(base, options).gap.threshold_ms;
    assert.strictEqual(previous, 120000);
    for (const window of [50000, 130000, 80000, 500000, 1]) {
      assert.strictEqual(censor(base, options, 'gap', window).result.committed, true);
      const current = v2.read(base, options).gap.threshold_ms;
      assert(current >= previous && current <= 240000, `censored ${window}: ${previous} -> ${current}`);
      previous = current;
    }
    assert.strictEqual(previous, 240000);
  }
  {
    const options = fresh();
    let last;
    for (let i = 0; i < 32; i++) last = censor(base, options, 'gap', 1000 + i);
    assert.strictEqual(last.result.committed, true);
    assert.strictEqual(v2.read(base, options).gap.censored.count, 32);
    assert.deepStrictEqual(censor(base, options, 'gap', 5000).result, { committed: true, noop: 'censored-full' });
    assert.strictEqual(v2.read(base, options).gap.censored.count, 32);
  }

  // Empty proposals and invalid shapes.
  {
    const options = fresh();
    assert.deepStrictEqual(accept(base, options, null, null).result, { committed: true, noop: 'no-samples' });
    assert.strictEqual(fs.existsSync(storeFile(options)), false);
    const proposal = v2.propose(base, { initial_sample_ms: 1, gap_sample_ms: 1 });
    assert.strictEqual(v2.commit({ ...proposal, extra: 1 }, binding, options).diagnostic, 'calibration-binding-invalid');
    assert.strictEqual(v2.commit({ ...proposal, version: 1 }, binding, options).diagnostic, 'calibration-binding-invalid');
    assert.strictEqual(v2.commit(proposal, { receipt: 'r' }, options).diagnostic, 'calibration-binding-invalid');
    assert.strictEqual(v2.commit(v1.propose(base, { initial_sample_ms: 1, gap_sample_ms: 1 }), binding, options).diagnostic,
      'calibration-binding-invalid');
    assert.strictEqual(v2.commit({ ...proposal, key: 'a'.repeat(64) }, binding, options).diagnostic, 'calibration-binding-invalid');
  }

  // Model fallback.
  const phases = ['execute', 'plan', 'research'];
  {
    const options = fresh();
    for (let i = 0; i < 5; i++) accept({ ...base, phase: 'execute', effort: 'low' }, options, 2000, 10000);
    // Exact (high/plan) is uncalibrated: 5 samples from one phase are not enough for fallback.
    const target = { ...base, phase: 'plan' };
    assert.deepStrictEqual(v2.resolve(target, options).gap, { state: 'uncalibrated', threshold_ms: null, source: null });
    for (let i = 0; i < 4; i++) accept({ ...base, phase: 'research' }, options, 2000, 10000);
    // 9 samples from 2 phases: refused.
    assert.strictEqual(v2.resolve(target, options).gap.threshold_ms, null);
    assert.strictEqual(v2.resolve(target, options).gap.state, 'uncalibrated');
    accept({ ...base, phase: 'research' }, options, 2000, 10000);
    // 10 samples from 2 phases: accepted for any effort/phase of the same model.
    const resolved = v2.resolve(target, options);
    assert.deepStrictEqual(resolved.gap, { state: 'calibrated', threshold_ms: 120000, source: 'model-fallback' });
    assert.deepStrictEqual(resolved.initial, { state: 'calibrated', threshold_ms: 30000, source: 'model-fallback' });
    // A different model never benefits from the fallback.
    assert.strictEqual(v2.resolve({ ...target, model: 'claude-other' }, options).gap.threshold_ms, null);
    // The exact calibrated dimension wins over the fallback.
    fill(target, options, 20000, 50000);
    assert.deepStrictEqual(v2.resolve(target, options).gap, { state: 'calibrated', threshold_ms: 215000, source: 'persisted-calibration' });
    assert.strictEqual(v2.read(target, options).gap.threshold_ms, 215000);
  }
  {
    // 10+ samples from a single phase across efforts is refused (one phase).
    const options = fresh();
    for (const effort of ['low', 'medium']) for (let i = 0; i < 5; i++) accept({ ...base, effort }, options, 2000, 10000);
    assert.strictEqual(v2.resolve({ ...base, effort: 'max', phase: 'plan' }, options).gap.threshold_ms, null);
    assert.strictEqual(v2.resolve({ ...base, effort: 'max' }, options).gap.source, null);
  }
  {
    // Fallback honours the largest censored window of the model.
    const options = fresh();
    for (const phase of phases.slice(0, 2)) for (let i = 0; i < 5; i++) accept({ ...base, phase }, options, 2000, 10000);
    censor({ ...base, phase: 'research' }, options, 'gap', 150000);
    assert.strictEqual(v2.resolve({ ...base, phase: 'plan', effort: 'low' }, options).gap.threshold_ms, 165000);
  }

  // Isolation between v1 and v2 stores.
  {
    const options = fresh();
    for (let i = 0; i < 5; i++) assert.strictEqual(v1.commit(v1.propose(base, { initial_sample_ms: 1000, gap_sample_ms: 1000 }), binding, options).committed, true);
    const v1File = storeFile(options, 'calibration.json');
    const before = fs.readFileSync(v1File), beforeStat = fs.statSync(v1File);
    assert.strictEqual(v1.read(base, options).gap.calibrated, true);
    assert.strictEqual(v2.read(base, options).gap.state, 'uncalibrated');
    assert.strictEqual(v2.resolve(base, options).gap.threshold_ms, null);
    fill(base, options, 2000, 10000);
    censor(base, options, 'gap', 100000);
    assert(before.equals(fs.readFileSync(v1File)));
    assert.strictEqual(fs.statSync(v1File).mtimeMs, beforeStat.mtimeMs);
    assert.strictEqual(v1.read(base, options).gap.threshold_ms, 120000);
    assert.strictEqual(v2.read(base, options).gap.threshold_ms, 120000);
    // commitAccepted dispatches by proposal version.
    const viaV2 = v2.propose({ ...base, phase: 'plan' }, { initial_sample_ms: 1000, gap_sample_ms: 1000 });
    v1.commitAccepted(viaV2, binding, options).then(outcome => {
      assert.deepStrictEqual(outcome, { committed: true, attempts: 1, diagnostic: null, retry_pending: false });
      assert.strictEqual(v2.read({ ...base, phase: 'plan' }, options).gap.count, 1);
      assert.strictEqual(v1.read({ ...base, phase: 'plan' }, options).gap.count, 0);
      assert(before.equals(fs.readFileSync(v1File)));
    }).catch(error => { console.error(error); process.exit(1); });
  }
  {
    // A corrupted v1 store does not stop the v2 store, and vice versa.
    const options = fresh();
    fs.mkdirSync(v2.directory(options), { recursive: true });
    fs.writeFileSync(storeFile(options, 'calibration.json'), '{broken');
    fill(base, options, 2000, 10000);
    assert.strictEqual(v2.read(base, options).gap.threshold_ms, 120000);
    assert.strictEqual(v1.read(base, options).diagnostic, 'calibration-unavailable');
  }

  // Corrupt, oversized, tampered and symlinked v2 stores are refused without throwing.
  {
    const options = fresh();
    fill(base, options, 2000, 10000);
    const file = storeFile(options);
    const good = fs.readFileSync(file, 'utf8');
    const unavailable = () => {
      const r = v2.read(base, options), s = v2.resolve(base, options);
      assert.strictEqual(r.diagnostic, 'calibration-unavailable');
      assert.strictEqual(r.gap.threshold_ms, null);
      assert.strictEqual(s.diagnostic, 'calibration-unavailable');
      assert.strictEqual(s.gap.threshold_ms, null);
      assert.strictEqual(accept(base, options, 1, 1).result.diagnostic, 'calibration-unavailable');
    };
    fs.writeFileSync(file, '{not json');
    unavailable();
    fs.writeFileSync(file, good.replace('"threshold_ms":120000', '"threshold_ms":30000'));
    unavailable();
    fs.writeFileSync(file, good.replace('"version":2', '"version":1'));
    unavailable();
    fs.writeFileSync(file, good.replace('claude-silence-v2', 'claude-silence-v1'));
    unavailable();
    fs.writeFileSync(file, good.replace('"censored":{"count":0', '"censored":{"count":1'));
    unavailable();
    fs.writeFileSync(file, ' '.repeat(1048577));
    unavailable();
    fs.writeFileSync(file, good);
    assert.strictEqual(v2.read(base, options).diagnostic, null);
    fs.rmSync(file);
    let linked = false;
    try { fs.symlinkSync(path.join(options.userHome, 'target.json'), file); linked = true; } catch { /* no symlink privilege */ }
    if (linked) unavailable();
  }

  // Restart: a fresh process reads the same state.
  {
    const options = fresh();
    fill(base, options, 2000, 50000);
    censor(base, options, 'gap', 100000);
    const code = `const v=require(process.argv[1]);const r=v.read(JSON.parse(process.argv[2]),{userHome:process.argv[3]});`
      + `process.stdout.write(JSON.stringify({g:r.gap.threshold_ms,i:r.initial.threshold_ms,c:r.gap.censored.count,d:r.diagnostic}));`;
    const child = spawnSync(process.execPath, ['-e', code, require.resolve('./forge-sidecar-calibration-v2'),
      JSON.stringify(base), options.userHome], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(child.status, 0, child.stderr);
    assert.deepStrictEqual(JSON.parse(child.stdout), { g: 215000, i: 30000, c: 1, d: null });
  }

  // No temp files left behind.
  {
    const options = fresh();
    fill(base, options, 2000, 10000);
    assert.deepStrictEqual(fs.readdirSync(v2.directory(options)).filter(name => name.endsWith('.tmp')), []);
  }
  process.on('exit', () => { for (const home of homes) fs.rmSync(home, { recursive: true, force: true }); });
  console.log('forge-sidecar-calibration-v2 tests passed');
} catch (error) {
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
  throw error;
}
