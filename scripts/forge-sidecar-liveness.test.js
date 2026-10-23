'use strict';

const assert = require('assert/strict');
const { POLICY, SOURCE_DEFAULT, SOURCE_CALIBRATED, DEFAULTS, TIER_CEILING_MS, STATES, TERMINATIONS,
  evaluate, classifyTermination, ceilingForTier, normalizePolicy, createTracker } = require('./forge-sidecar-liveness');

const tests = [];
const test = (name, run) => tests.push({ name, run });
const active = (silence, extra = {}) => ({ elapsed_ms: silence + 10, first_remote_ms: 10,
  remote_silence_ms: silence, gap_suspended: false, ...extra });

test('locked constants and tier ceilings have a closed immutable vocabulary', () => {
  assert.equal(POLICY, 'forge-liveness-v1');
  assert.equal(SOURCE_DEFAULT, 'locked-default');
  assert.equal(SOURCE_CALIBRATED, 'persisted-calibration');
  assert.deepEqual(DEFAULTS, { startMs: 60000, suspectMs: 120000, deadMs: 240000 });
  assert.deepEqual(TIER_CEILING_MS, { light: 900000, standard: 1800000, heavy: 3600000, max: 5400000 });
  assert.deepEqual(STATES, ['starting', 'working', 'slow-suspect', 'dead']);
  assert.deepEqual(TERMINATIONS, ['dead-start', 'dead-silence', 'budget-exceeded-while-active']);
  for (const value of [DEFAULTS, TIER_CEILING_MS, STATES, TERMINATIONS]) assert(Object.isFrozen(value));
  for (const [tier, ceiling] of Object.entries(TIER_CEILING_MS)) assert.equal(ceilingForTier(tier), ceiling);
  for (const tier of ['unknown', 'toString', '__proto__', '', null, undefined, {}, 1]) {
    assert.equal(ceilingForTier(tier), null);
  }
});

test('initial event deadline is strict at 60000/60001 and accepts first event at zero', () => {
  for (const elapsed_ms of [0, 60000]) {
    const result = evaluate({ elapsed_ms, first_remote_ms: null });
    assert.equal(result.state, 'starting');
    assert.equal(result.kill, false);
    assert.equal(result.termination, null);
  }
  assert.deepEqual(evaluate({ elapsed_ms: 60001, first_remote_ms: null }), {
    state: 'dead', kill: true, cause: 'liveness', termination: 'dead-start', reason: null,
    window_ms: 60001, threshold_ms: 60000, dimension: 'initial',
  });
  assert.equal(evaluate(active(0, { first_remote_ms: 0 })).state, 'working');
});

test('remote silence uses strict suspect and dead boundaries', () => {
  for (const [silence, state, kill, termination] of [
    [0, 'working', false, null], [120000, 'working', false, null],
    [120001, 'slow-suspect', false, null], [240000, 'slow-suspect', false, null],
    [240001, 'dead', true, 'dead-silence'],
  ]) {
    const result = evaluate(active(silence));
    assert.equal(result.state, state);
    assert.equal(result.kill, kill);
    assert.equal(result.termination, termination);
    assert.equal(result.window_ms, silence);
    assert.equal(result.dimension, 'gap');
    assert.equal(result.threshold_ms, kill ? 240000 : 120000);
    assert.equal(result.reason, silence > 120000 ? 'silence' : null);
    assert.equal(result.cause, kill ? 'liveness' : null);
  }
});

test('tool suspension never dies from silence, with or without a valid local proof', () => {
  for (const localProof of [undefined, { available: false, proven: false },
    { available: false, proven: true }, { available: true, proven: false }, { available: true, proven: true }]) {
    for (const silence of [120000, 120001, 240001, 99999999]) {
      const result = evaluate(active(silence, { gap_suspended: true }), { localProof });
      assert.equal(result.state, silence > 120000 ? 'slow-suspect' : 'working');
      assert.equal(result.reason, silence > 120000 ? 'tool-unproven' : null);
      assert.equal(result.kill, false);
      assert.equal(result.termination, null);
    }
  }
  for (const localProof of [null, true, [], {}, { available: true }, { available: 1, proven: false }]) {
    assert.throws(() => evaluate(active(1), { localProof }), TypeError);
  }
  assert.equal(evaluate({ elapsed_ms: 60001, gap_suspended: true }).termination, 'dead-start');
});

test('no-progress is advisory and cannot erase a real liveness failure', () => {
  const inputs = { progress: { no_progress: true } };
  for (const snapshot of [{ elapsed_ms: 1 }, active(0), active(120001), active(999999, { gap_suspended: true })]) {
    const result = evaluate(snapshot, inputs);
    assert.equal(result.state, 'slow-suspect');
    assert.equal(result.reason, 'no-progress');
    assert.equal(result.kill, false);
    assert.equal(result.termination, null);
  }
  for (const snapshot of [{ elapsed_ms: 60001 }, active(240001)]) {
    assert.equal(evaluate(snapshot, inputs).state, 'dead');
    assert.equal(evaluate(snapshot, inputs).kill, true);
  }
  assert.equal(evaluate(active(0), { progress: { no_progress: 1 } }).state, 'working');
});

test('ceiling wins at equality using the active state before the ceiling', () => {
  for (const ceiling of Object.values(TIER_CEILING_MS)) {
    for (const snapshot of [active(0), active(120001), active(999999, { gap_suspended: true })]) {
      assert.equal(evaluate({ ...snapshot, elapsed_ms: ceiling - 1 }, {}, DEFAULTS, ceiling).kill, false);
      for (const elapsed_ms of [ceiling, ceiling + 1]) {
        const result = evaluate({ ...snapshot, elapsed_ms }, {}, DEFAULTS, ceiling);
        assert.equal(result.kill, true);
        assert.equal(result.cause, 'ceiling');
        assert.equal(result.termination, 'budget-exceeded-while-active');
        assert.equal(result.window_ms, elapsed_ms);
        assert.equal(result.threshold_ms, ceiling);
        assert.equal(result.dimension, null);
      }
    }
  }
  const starting = evaluate({ elapsed_ms: 10 }, {}, DEFAULTS, 10);
  assert.equal(starting.state, 'starting');
  assert.equal(starting.kill, true);
  assert.equal(starting.cause, 'ceiling');
  assert.equal(starting.termination, null);
  const dead = evaluate(active(240001), {}, DEFAULTS, 100);
  assert.equal(dead.state, 'dead');
  assert.equal(dead.cause, 'ceiling');
  assert.equal(dead.termination, null);
  const looping = evaluate(active(0, { elapsed_ms: 100 }), { progress: { no_progress: true } }, DEFAULTS, 100);
  assert.equal(looping.state, 'slow-suspect');
  assert.equal(looping.kill, true);
  assert.equal(looping.termination, 'budget-exceeded-while-active');
  for (const ceiling of [null, undefined, 0, -1, 1.5, NaN, Infinity, '100', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(evaluate(active(0), {}, DEFAULTS, ceiling).kill, false);
  }
});

test('normalization only tightens defaults and keeps suspect below dead', () => {
  assert.deepEqual(normalizePolicy(), { ...DEFAULTS, source: SOURCE_DEFAULT });
  assert.deepEqual(normalizePolicy(DEFAULTS), { ...DEFAULTS, source: SOURCE_DEFAULT });
  assert.equal(normalizePolicy({ deadMs: 999999 }).deadMs, 240000);
  assert.deepEqual(normalizePolicy({ deadMs: 100000 }), {
    startMs: 60000, suspectMs: 100000, deadMs: 100000, source: SOURCE_CALIBRATED,
  });
  for (const value of [0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, undefined]) {
    assert.deepEqual(normalizePolicy({ startMs: value, suspectMs: value, deadMs: value }), {
      ...DEFAULTS, source: SOURCE_DEFAULT,
    });
  }
  for (const key of Object.keys(DEFAULTS)) {
    assert.equal(normalizePolicy({ [key]: DEFAULTS[key] + 1 })[key], DEFAULTS[key]);
    assert.equal(normalizePolicy({ [key]: 1 }).source, SOURCE_CALIBRATED);
  }
  assert.equal(evaluate({ elapsed_ms: 11 }, {}, { startMs: 10 }).termination, 'dead-start');
  assert.equal(evaluate(active(21), {}, { suspectMs: 10, deadMs: 20 }).termination, 'dead-silence');
  assert.equal(evaluate(active(240001), {}, { deadMs: 999999 }).termination, 'dead-silence');
});

test('termination classifier is closed and preserves initial dimension', () => {
  for (const state of STATES) {
    assert.equal(classifyTermination({ cause: 'ceiling', state }),
      ['working', 'slow-suspect'].includes(state) ? 'budget-exceeded-while-active' : null);
    assert.equal(classifyTermination({ cause: 'liveness', state }), state === 'starting' ? 'dead-start' : 'dead-silence');
    assert.equal(classifyTermination({ cause: 'other', state }), null);
  }
  assert.equal(classifyTermination({ cause: 'liveness', state: 'dead', dimension: 'initial' }), 'dead-start');
  assert.equal(classifyTermination({ cause: 'ceiling', state: 'unknown' }), null);
  assert.equal(classifyTermination(), null);
});

test('invalid or absent snapshot times become null without throwing', () => {
  for (const value of [undefined, null, -1, 1.5, '60001', NaN, Infinity, {}, Number.MAX_SAFE_INTEGER + 1]) {
    const missing = evaluate({ elapsed_ms: value, first_remote_ms: value, remote_silence_ms: value });
    assert.equal(missing.state, 'starting');
    assert.equal(missing.window_ms, null);
    assert.equal(missing.kill, false);
    assert.equal(evaluate(active(value)).window_ms, null);
    assert.equal(evaluate({ elapsed_ms: 60001, first_remote_ms: value }).termination, 'dead-start');
  }
  for (const snapshot of [undefined, null, {}, false]) assert.equal(evaluate(snapshot).state, 'starting');
  assert.equal(evaluate(active(240001, { gap_suspended: 'true' })).state, 'dead');
});

test('tracker emits starting to working to suspect to dead only on state changes', () => {
  const tracker = createTracker();
  let from = null;
  for (const [snapshot, to, reason] of [
    [{ elapsed_ms: 0 }, 'starting', null], [active(0), 'working', null],
    [active(120001), 'slow-suspect', 'silence'], [active(240001), 'dead', 'silence'],
  ]) {
    const { result, transition } = tracker.evaluate(snapshot);
    assert.deepEqual(result, evaluate(snapshot));
    assert.deepEqual(transition, { from, to, at_ms: snapshot.elapsed_ms, reason });
    assert.equal(tracker.evaluate(snapshot).transition, null);
    from = to;
  }
  assert.equal(createTracker().evaluate({}).transition.at_ms, null);
  assert.equal(createTracker({ startMs: 1 }).evaluate({ elapsed_ms: 2 }).result.termination, 'dead-start');
  assert.equal(createTracker(DEFAULTS, 10).evaluate(active(0)).result.cause, 'ceiling');
});

test('same frozen inputs give identical fresh results with no input mutation', () => {
  const snapshot = Object.freeze(active(120001));
  const inputs = Object.freeze({ localProof: Object.freeze({ available: true, proven: false }),
    progress: Object.freeze({ no_progress: true }) });
  const policy = Object.freeze({ deadMs: 100000 });
  const first = evaluate(snapshot, inputs, policy, 1000000);
  const second = evaluate(snapshot, inputs, policy, 1000000);
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  first.state = 'changed';
  assert.deepEqual(evaluate(snapshot, inputs, policy, 1000000), second);
});

function main() {
  let failures = 0;
  for (const { name, run } of tests) {
    try { run(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}`); console.error(error); }
  }
  console.log(`${tests.length - failures}/${tests.length} sidecar liveness tests passed`);
  if (failures) process.exitCode = 1;
}

if (require.main === module) main();
