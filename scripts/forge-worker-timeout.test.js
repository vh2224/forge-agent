'use strict';

const assert = require('assert/strict');
const { TIER_CEILING_MS } = require('./forge-sidecar-liveness');
const timeoutModule = require('./forge-worker-timeout');
const { LEGACY_WORKER_TIMEOUT_SECS, MAX_EXPLICIT_TIMEOUT_SECS, CEILING_SOURCES,
  PROTECTED_WINDOW_GRACE_MS, MAX_PROTECTED_WINDOW_MS, resolveWorkerCeiling, ceilingFromRoute,
  protectedWindowMs } = require('./forge-worker-timeout');

const tests = [];
const test = (name, run) => tests.push({ name, run });
const KEYS = ['ms', 'seconds', 'source', 'tier', 'tier_fallback', 'warning'];
const TIERS = { light: 900, standard: 1800, heavy: 3600, max: 5400 };

test('the legacy 300 default is no longer exported (S03/T04)', () => {
  assert.deepEqual(Object.keys(timeoutModule).sort(), ['CEILING_SOURCES', 'LEGACY_WORKER_TIMEOUT_SECS',
    'MAX_EXPLICIT_TIMEOUT_SECS', 'MAX_PROTECTED_WINDOW_MS', 'PROTECTED_WINDOW_GRACE_MS', 'ceilingFromRoute',
    'protectedWindowMs', 'resolveWorkerCeiling']);
});

test('constants are derived from the single liveness tier table', () => {
  assert.equal(LEGACY_WORKER_TIMEOUT_SECS, 300);
  assert.equal(MAX_EXPLICIT_TIMEOUT_SECS, 86400);
  assert.equal(PROTECTED_WINDOW_GRACE_MS, 60000);
  assert.equal(MAX_PROTECTED_WINDOW_MS, 5460000);
  assert.equal(MAX_PROTECTED_WINDOW_MS, Math.max(...Object.values(TIER_CEILING_MS)) + PROTECTED_WINDOW_GRACE_MS);
  assert.deepEqual(CEILING_SOURCES, ['tier-default', 'explicit', 'legacy-300-ignored']);
  assert.ok(Object.isFrozen(CEILING_SOURCES));
});

test('tier default resolves 900/1800/3600/5400 s without warning', () => {
  for (const [tier, seconds] of Object.entries(TIERS)) {
    const r = resolveWorkerCeiling({ tier });
    assert.deepEqual({ ...r }, { seconds, ms: seconds * 1000, source: 'tier-default', tier,
      tier_fallback: false, warning: null });
    assert.equal(r.ms, TIER_CEILING_MS[tier]);
  }
});

test('absent, null and undefined explicit keep the tier ceiling without warning', () => {
  for (const input of [{ tier: 'heavy' }, { tier: 'heavy', explicit: null }, { tier: 'heavy', explicit: undefined }]) {
    const r = resolveWorkerCeiling(input);
    assert.equal(r.seconds, 3600);
    assert.equal(r.source, 'tier-default');
    assert.equal(r.warning, null);
  }
});

test('valid explicit value overrides the tier', () => {
  for (const explicit of [1, 299, 301, 1234, 7200, 86400]) {
    const r = resolveWorkerCeiling({ tier: 'light', explicit });
    assert.equal(r.seconds, explicit);
    assert.equal(r.ms, explicit * 1000);
    assert.equal(r.source, 'explicit');
    assert.equal(r.warning, null);
    assert.equal(r.tier, 'light');
  }
});

test('explicit 300 is the ignored legacy default with a pt-BR warning naming tier and seconds', () => {
  for (const [tier, seconds] of Object.entries(TIERS)) {
    const r = resolveWorkerCeiling({ tier, explicit: 300 });
    assert.equal(r.seconds, seconds);
    assert.equal(r.source, 'legacy-300-ignored');
    assert.equal(r.warning.code, 'legacy-300-ignored');
    assert.match(r.warning.message, /default antigo/);
    assert.ok(r.warning.message.includes(`tier ${tier}`));
    assert.ok(r.warning.message.includes(`${seconds}s`));
  }
});

test('CLI provenance permits an intentional 300 while legacy and unknown sources retain compatibility', () => {
  for (const tier of Object.keys(TIERS)) {
    const chosen = resolveWorkerCeiling({ tier, explicit: 300, explicitSource: 'cli' });
    assert.equal(chosen.seconds, 300);
    assert.equal(chosen.source, 'explicit');
    assert.equal(chosen.warning, null);
    for (const explicitSource of [undefined, 'configuration', 'unknown']) {
      const legacy = resolveWorkerCeiling({ tier, explicit: 300, explicitSource });
      assert.equal(legacy.seconds, TIERS[tier]);
      assert.equal(legacy.source, 'legacy-300-ignored');
    }
    for (const explicit of [0, -1, 1.5, 86401, NaN]) {
      const invalid = resolveWorkerCeiling({ tier, explicit, explicitSource: 'cli' });
      assert.equal(invalid.seconds, TIERS[tier]);
      assert.equal(invalid.warning.code, 'workers-timeout-invalid');
    }
  }
});

test('invalid explicit falls back to the tier with workers-timeout-invalid', () => {
  for (const explicit of [0, -1, 1.5, 'abc', 86401, NaN, '1800', true, {}]) {
    const r = resolveWorkerCeiling({ tier: 'max', explicit });
    assert.equal(r.seconds, 5400, String(explicit));
    assert.equal(r.source, 'tier-default');
    assert.equal(r.warning.code, 'workers-timeout-invalid');
    assert.match(r.warning.message, /inválido/);
  }
});

test('unknown, empty or non-string tier falls back to standard', () => {
  for (const tier of ['huge', '', undefined, null, 3, {}, 'toString', 'Standard']) {
    const r = resolveWorkerCeiling({ tier });
    assert.equal(r.seconds, 1800);
    assert.equal(r.tier, 'standard');
    assert.equal(r.tier_fallback, true);
  }
  assert.equal(resolveWorkerCeiling().tier_fallback, true);
  assert.equal(resolveWorkerCeiling({ tier: 'unknown', explicit: 300 }).warning.message.includes('tier standard (1800s)'), true);
});

test('result is frozen with exactly the contract keys', () => {
  for (const r of [resolveWorkerCeiling({ tier: 'light' }), resolveWorkerCeiling({ tier: 'x', explicit: 300 }),
    resolveWorkerCeiling({ explicit: 'abc' }), ceilingFromRoute({ tier: 'heavy', workers_timeout: 42,
      workers_timeout_source: 'explicit' })]) {
    assert.ok(Object.isFrozen(r));
    assert.deepEqual(Object.keys(r).sort(), KEYS);
    if (r.warning) assert.ok(Object.isFrozen(r.warning));
  }
});

test('ceilingFromRoute trusts a route resolved with a valid source', () => {
  const r = ceilingFromRoute({ tier: 'standard', workers_timeout: 42, workers_timeout_source: 'explicit' });
  assert.equal(r.seconds, 42);
  assert.equal(r.source, 'explicit');
  const d = ceilingFromRoute({ tier: 'heavy', workers_timeout: 3600, workers_timeout_source: 'tier-default' });
  assert.equal(d.seconds, 3600);
  assert.equal(d.source, 'tier-default');
});

test('ceilingFromRoute applies the resolver to a legacy route', () => {
  const legacy = ceilingFromRoute({ tier: 'heavy', workers_timeout: 300 });
  assert.equal(legacy.seconds, 3600);
  assert.equal(legacy.source, 'legacy-300-ignored');
  assert.equal(legacy.warning.code, 'legacy-300-ignored');
  const missing = ceilingFromRoute({ tier: 'light' });
  assert.equal(missing.seconds, 900);
  assert.equal(missing.source, 'tier-default');
  assert.equal(missing.warning, null);
  const badSource = ceilingFromRoute({ tier: 'max', workers_timeout: 300, workers_timeout_source: 'prefs' });
  assert.equal(badSource.seconds, 5400);
  assert.equal(badSource.source, 'legacy-300-ignored');
  const badValue = ceilingFromRoute({ tier: 'light', workers_timeout: 86401, workers_timeout_source: 'explicit' });
  assert.equal(badValue.seconds, 900);
  assert.equal(badValue.warning.code, 'workers-timeout-invalid');
  assert.equal(ceilingFromRoute(null).seconds, 1800);
  assert.equal(ceilingFromRoute(undefined).tier_fallback, true);
});

test('protectedWindowMs covers every tier ceiling and refuses to silently cover larger ones', () => {
  for (const ms of Object.values(TIER_CEILING_MS)) {
    const w = protectedWindowMs(ms);
    assert.deepEqual({ ...w }, { duration_ms: ms + 60000, covers: true });
    assert.ok(Object.isFrozen(w));
  }
  assert.deepEqual({ ...protectedWindowMs(7200000) }, { duration_ms: 5460000, covers: false });
});

test('ceilingFromRoute ignores a historical integer remainder written over a tier-default source', () => {
  const r = ceilingFromRoute({ tier: 'heavy', workers_timeout: 21, workers_timeout_source: 'tier-default' });
  assert.strictEqual(r.seconds, 3600);
  assert.strictEqual(r.ms, 3600000);
  assert.strictEqual(r.source, 'tier-default');
  const l = ceilingFromRoute({ tier: 'heavy', workers_timeout: 21, workers_timeout_source: 'legacy-300-ignored' });
  assert.strictEqual(l.seconds, 3600);
  assert.strictEqual(ceilingFromRoute({ tier: 'heavy', workers_timeout: 21, workers_timeout_source: 'explicit' }).seconds, 21);
});

let failed = 0;
for (const { name, run } of tests) {
  try {
    run();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`not ok - ${name}\n${error.stack}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exitCode = 1;
