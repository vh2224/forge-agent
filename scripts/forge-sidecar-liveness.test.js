'use strict';

const assert = require('assert/strict');
const { POLICY, SOURCE_DEFAULT, SOURCE_CALIBRATED, DEFAULTS, TIER_CEILING_MS, STATES, TERMINATIONS,
  LOOP_REPEATS, PROOF_CAPABILITIES, PROOF_VALUES, normalizeLocalProof, createProgressTracker,
  evaluate, classifyTermination, ceilingForTier, normalizePolicy, createTracker } = require('./forge-sidecar-liveness');
const { observation } = require('./forge-sidecar-diagnostic');

const tests = [];
const test = (name, run) => tests.push({ name, run });
const active = (silence, extra = {}) => ({ elapsed_ms: silence + 10, first_remote_ms: 10,
  remote_silence_ms: silence, gap_suspended: false, ...extra });

test('locked constants and tier ceilings have a closed immutable vocabulary', () => {
  assert.equal(POLICY, 'forge-liveness-v1');
  assert.equal(SOURCE_DEFAULT, 'locked-default');
  assert.equal(SOURCE_CALIBRATED, 'persisted-calibration');
  assert.deepEqual(DEFAULTS, { startMs: 60000, suspectMs: 120000, deadMs: 240000, toolExtensionMs: 420000 });
  assert.equal(LOOP_REPEATS, 5);
  assert.deepEqual(PROOF_CAPABILITIES, ['available', 'unavailable']);
  assert.deepEqual(PROOF_VALUES, ['positive', 'negative', 'none']);
  assert.deepEqual(TIER_CEILING_MS, { light: 900000, standard: 1800000, heavy: 3600000, max: 5400000 });
  assert.deepEqual(STATES, ['starting', 'working', 'slow-suspect', 'dead']);
  assert.deepEqual(TERMINATIONS, ['dead-start', 'dead-silence', 'budget-exceeded-while-active']);
  for (const value of [DEFAULTS, TIER_CEILING_MS, STATES, TERMINATIONS, PROOF_CAPABILITIES, PROOF_VALUES]) {
    assert(Object.isFrozen(value));
  }
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
    window_ms: 60001, threshold_ms: 60000, dimension: 'initial', extension_ms: null,
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

test('tool suspension with unavailable proof survives 240001 but expires at 660001', () => {
  for (const localProof of [undefined, { available: false, proven: false },
    { capability: 'unavailable', proof: 'none' }]) {
    for (const silence of [120000, 120001, 240001, 660000, 660001]) {
      const result = evaluate(active(silence, { gap_suspended: true }), { localProof });
      assert.equal(result.state, silence > 660000 ? 'dead' : silence > 120000 ? 'slow-suspect' : 'working');
      assert.equal(result.reason, silence > 660000 ? 'tool-proof-unavailable-expired'
        : silence > 120000 ? 'proof-unavailable' : null);
      assert.equal(result.kill, silence > 660000);
      assert.equal(result.termination, silence > 660000 ? 'dead-silence' : null);
    }
  }
  for (const localProof of [null, true, [], {}, { available: true }, { available: 1, proven: false }]) {
    assert.throws(() => evaluate(active(1), { localProof }), TypeError);
  }
  assert.equal(evaluate({ elapsed_ms: 60001, gap_suspended: true }).termination, 'dead-start');
});

test('no-progress is advisory and cannot erase a real liveness failure', () => {
  const inputs = { progress: { no_progress: true } };
  for (const snapshot of [{ elapsed_ms: 1 }, active(0), active(120001), active(660000, { gap_suspended: true })]) {
    const result = evaluate(snapshot, inputs);
    assert.equal(result.state, 'slow-suspect');
    assert.equal(result.reason, 'no-progress');
    assert.equal(result.kill, false);
    assert.equal(result.termination, null);
  }
  for (const snapshot of [{ elapsed_ms: 60001 }, active(240001), active(660001, { gap_suspended: true })]) {
    assert.equal(evaluate(snapshot, inputs).state, 'dead');
    assert.equal(evaluate(snapshot, inputs).kill, true);
  }
  assert.equal(evaluate(active(0), { progress: { no_progress: 1 } }).state, 'working');
});

test('ceiling wins at equality using the active state before the ceiling', () => {
  for (const ceiling of Object.values(TIER_CEILING_MS)) {
    for (const snapshot of [active(0), active(120001), active(660000, { gap_suspended: true })]) {
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
    startMs: 60000, suspectMs: 100000, deadMs: 100000, toolExtensionMs: 420000, source: SOURCE_CALIBRATED,
  });
  for (const value of [0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, undefined]) {
    assert.deepEqual(normalizePolicy({ startMs: value, suspectMs: value, deadMs: value, toolExtensionMs: value }), {
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

test('local proof normalization covers undefined, all boolean rows and all closed enum pairs', () => {
  assert.deepEqual(normalizeLocalProof(), { capability: 'unavailable', proof: 'none' });
  for (const available of [false, true]) {
    for (const proven of [false, true]) {
      assert.deepEqual(normalizeLocalProof({ available, proven }), {
        capability: available ? 'available' : 'unavailable', proof: proven ? 'positive' : 'none',
      });
    }
  }
  for (const capability of PROOF_CAPABILITIES) {
    for (const proof of PROOF_VALUES) {
      const input = Object.freeze({ capability, proof });
      const result = normalizeLocalProof(input);
      assert.deepEqual(result, input);
      assert.notEqual(result, input);
    }
  }
  // Presence of either new field selects the new contract, without legacy fallback.
  assert.deepEqual(normalizeLocalProof({ capability: 'unavailable', proof: 'negative',
    available: true, proven: true }), { capability: 'unavailable', proof: 'negative' });
});

test('local proof rejects malformed values, partial contracts and unknown enum members', () => {
  const invalid = [null, [], [true, true], {}, true, false, 1, 'positive', () => {},
    { available: true }, { proven: true }, { available: 1, proven: false },
    { available: false, proven: 'true' }, { capability: 'available' }, { proof: 'none' },
    { capability: 'AVAILABLE', proof: 'none' }, { capability: 'unavailable', proof: 'unknown' },
    { capability: null, proof: 'none' }, { capability: 'available', proof: undefined },
    { available: true, proven: true, capability: undefined },
    { available: true, proven: true, proof: 'unknown' }];
  for (const localProof of invalid) {
    assert.throws(() => normalizeLocalProof(localProof), TypeError);
    assert.throws(() => evaluate(active(0), { localProof }), TypeError);
  }
});

test('tool boundary table covers each proof state, both capabilities and legacy forms', () => {
  const cases = [
    [{ capability: 'available', proof: 'positive' }, 'positive'],
    [{ capability: 'unavailable', proof: 'positive' }, 'positive'],
    [{ available: true, proven: true }, 'positive'],
    [{ available: false, proven: true }, 'positive'],
    [{ capability: 'available', proof: 'negative' }, 'negative'],
    [{ capability: 'unavailable', proof: 'negative' }, 'negative'],
    [{ capability: 'available', proof: 'none' }, 'unproven'],
    [{ available: true, proven: false }, 'unproven'],
    [{ capability: 'unavailable', proof: 'none' }, 'unavailable'],
    [{ available: false, proven: false }, 'unavailable'],
    [undefined, 'unavailable'],
  ];
  const boundaries = {
    positive: [
      ['working', null], ['working', 'local-proof'], ['working', 'local-proof'],
      ['slow-suspect', 'tool-extended'], ['slow-suspect', 'tool-extended'], ['dead', 'tool-extension-exhausted'],
    ],
    negative: [
      ['working', null], ['slow-suspect', 'tool-proof-negative'], ['slow-suspect', 'tool-proof-negative'],
      ['dead', 'tool-proof-negative'], ['dead', 'tool-proof-negative'], ['dead', 'tool-proof-negative'],
    ],
    unproven: [
      ['working', null], ['slow-suspect', 'tool-unproven'], ['slow-suspect', 'tool-unproven'],
      ['dead', 'tool-unproven'], ['dead', 'tool-unproven'], ['dead', 'tool-unproven'],
    ],
    unavailable: [
      ['working', null], ['slow-suspect', 'proof-unavailable'], ['slow-suspect', 'proof-unavailable'],
      ['slow-suspect', 'proof-unavailable'], ['slow-suspect', 'proof-unavailable'],
      ['dead', 'tool-proof-unavailable-expired'],
    ],
  };
  const times = [120000, 120001, 240000, 240001, 660000, 660001];
  for (const [localProof, kind] of cases) {
    const normalized = normalizeLocalProof(localProof);
    for (const [index, silence] of times.entries()) {
      const result = evaluate(active(silence, { gap_suspended: true }), { localProof });
      const [state, reason] = boundaries[kind][index];
      assert.equal(result.state, state, `${kind} at ${silence}`);
      assert.equal(result.reason, reason);
      assert.equal(result.kill, state === 'dead');
      assert.equal(result.cause, state === 'dead' ? 'liveness' : null);
      assert.equal(result.termination, state === 'dead' ? 'dead-silence' : null);
      assert.equal(result.dimension, 'gap');
      assert.equal(result.window_ms, silence);
      assert.equal(result.threshold_ms, state === 'dead' ? 240000 : 120000);
      assert.equal(result.extension_ms, state === 'dead' && ['positive', 'unavailable'].includes(kind) ? 420000 : null);
      assert.equal(result.proof_capability, normalized.capability);
      assert.equal(result.proof, normalized.proof);
    }
  }
});

test('all four tool deaths survive the unchanged diagnostic observation allowlist', () => {
  for (const [proof, silence, reason, extension] of [
    [{ capability: 'available', proof: 'none' }, 240001, 'tool-unproven', null],
    [{ capability: 'unavailable', proof: 'negative' }, 240001, 'tool-proof-negative', null],
    [{ capability: 'available', proof: 'positive' }, 660001, 'tool-extension-exhausted', 420000],
    [undefined, 660001, 'tool-proof-unavailable-expired', 420000],
  ]) {
    const error = { liveness: evaluate(active(silence, { gap_suspended: true }), { localProof: proof }) };
    assert.equal(error.liveness.kill, true);
    assert.equal(error.liveness.reason, reason);
    assert.equal(error.liveness.extension_ms, extension);
    assert.equal(error.liveness.threshold_ms, 240000);
    const { dimension, window_ms, threshold_ms } = error.liveness;
    error.silence = { dimension, window_ms, threshold_ms, policy: POLICY,
      source: SOURCE_DEFAULT, cause: 'indeterminate' };
    assert.deepEqual(observation({ silence: error.silence }).silence, error.silence);
    const loop = evaluate(active(silence, { gap_suspended: true }),
      { localProof: proof, progress: { no_progress: true } });
    assert.deepEqual(loop, error.liveness);
  }
});

test('unavailable proof uses the earlier of its fixed silence maximum and ceiling', () => {
  const snapshot = silence => active(silence, { gap_suspended: true, elapsed_ms: silence });
  assert.equal(evaluate(snapshot(299999), {}, DEFAULTS, 300000).kill, false);
  for (const silence of [300000, 300001, 660001]) {
    const result = evaluate(snapshot(silence), {}, DEFAULTS, 300000);
    assert.equal(result.kill, true);
    assert.equal(result.cause, 'ceiling');
    assert.equal(result.termination, 'budget-exceeded-while-active');
    assert.equal(result.threshold_ms, 300000);
    assert.equal(result.dimension, null);
    assert.equal(result.extension_ms, null);
  }
  for (const silence of [660001, 900000, 900001]) {
    const result = evaluate(snapshot(silence), {}, DEFAULTS, 900000);
    assert.equal(result.cause, 'liveness');
    assert.equal(result.termination, 'dead-silence');
    assert.equal(result.reason, 'tool-proof-unavailable-expired');
    assert.equal(result.threshold_ms, 240000);
    assert.equal(result.extension_ms, 420000);
  }
});

test('tightened extension applies to positive and unavailable proof without changing diagnostic threshold', () => {
  const policy = { toolExtensionMs: 1000 };
  assert.equal(normalizePolicy(policy).source, SOURCE_CALIBRATED);
  assert.equal(normalizePolicy(policy).toolExtensionMs, 1000);
  for (const localProof of [undefined, { capability: 'unavailable', proof: 'none' },
    { capability: 'available', proof: 'positive' }, { available: false, proven: true }]) {
    for (const silence of [240001, 241000, 241001]) {
      const result = evaluate(active(silence, { gap_suspended: true }), { localProof }, policy);
      assert.equal(result.kill, silence > 241000);
      assert.equal(result.extension_ms, silence > 241000 ? 1000 : null);
      assert.equal(result.threshold_ms, silence > 241000 ? 240000 : 120000);
    }
  }
});

const fingerprint = index => index.toString(16).padStart(64, '0');

test('progress tracker triggers on five occurrences, stays latched and resets every count on write', () => {
  const tracker = createProgressTracker();
  assert.deepEqual(tracker.state(), { no_progress: false, repeats: 0, fingerprint: null });
  for (let count = 1; count <= 4; count++) {
    tracker.toolCall(fingerprint(1));
    assert.equal(tracker.state().no_progress, false);
  }
  tracker.toolCall(fingerprint(1));
  const expected = { no_progress: true, repeats: 5, fingerprint: fingerprint(1) };
  assert.deepEqual(tracker.state(), expected);
  const copy = tracker.state();
  copy.fingerprint = 'modified';
  copy.no_progress = false;
  for (let count = 0; count < 6; count++) tracker.toolCall(fingerprint(2));
  assert.deepEqual(tracker.state(), expected);
  tracker.write();
  assert.deepEqual(tracker.state(), { no_progress: false, repeats: 0, fingerprint: null });
  tracker.write();
  for (let count = 0; count < 4; count++) tracker.toolCall(fingerprint(2));
  assert.equal(tracker.state().no_progress, false);
  tracker.toolCall(fingerprint(2));
  assert.equal(tracker.state().fingerprint, fingerprint(2));
});

test('distinct fingerprints do not trigger but interleaved repeats do', () => {
  const distinct = createProgressTracker();
  for (const index of [1, 2, 3, 4, 5]) distinct.toolCall(fingerprint(index));
  assert.equal(distinct.state().no_progress, false);
  const interleaved = createProgressTracker();
  for (const index of [1, 2, 1, 2, 1, 2, 1, 2]) interleaved.toolCall(fingerprint(index));
  assert.equal(interleaved.state().no_progress, false);
  interleaved.toolCall(fingerprint(1));
  assert.deepEqual(interleaved.state(), { no_progress: true, repeats: 5, fingerprint: fingerprint(1) });
  assert.equal(evaluate(active(0), { progress: interleaved.state() }).reason, 'no-progress');
  assert.equal(evaluate(active(0), { progress: interleaved.state() }).kill, false);
  assert.equal(evaluate(active(240001), { progress: interleaved.state() }).state, 'dead');
});

test('invalid fingerprints are ignored without throwing, coercing or counting (security contract)', () => {
  const tracker = createProgressTracker({ repeats: 1 });
  for (const value of ['', undefined, null, false, 5, {}, [], Symbol('hash'),
    { toString() { throw new Error('must not coerce'); } },
    'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65),
    'a'.repeat(64) + '\n', '__proto__']) {
    assert.doesNotThrow(() => tracker.toolCall(value));
    assert.deepEqual(tracker.state(), { no_progress: false, repeats: 0, fingerprint: null });
  }
  tracker.toolCall('a'.repeat(64));
  assert.deepEqual(tracker.state(), { no_progress: true, repeats: 1, fingerprint: 'a'.repeat(64) });
});

test('progress map evicts by insertion order without refreshing entries on repeated calls', () => {
  const tracker = createProgressTracker({ repeats: 3, maxDistinct: 2 });
  for (const index of [1, 2, 1, 3, 1]) tracker.toolCall(fingerprint(index));
  // A was oldest despite its second occurrence: inserting C evicted both A counts.
  assert.equal(tracker.state().no_progress, false);
  tracker.toolCall(fingerprint(1));
  assert.equal(tracker.state().no_progress, false);
  tracker.toolCall(fingerprint(1));
  assert.equal(tracker.state().fingerprint, fingerprint(1));
  const defaults = createProgressTracker({ repeats: 2 });
  for (let index = 0; index <= 256; index++) defaults.toolCall(fingerprint(index));
  defaults.toolCall(fingerprint(256));
  assert.equal(defaults.state().fingerprint, fingerprint(256));
  const evicted = createProgressTracker({ repeats: 2 });
  for (let index = 0; index <= 256; index++) evicted.toolCall(fingerprint(index));
  evicted.toolCall(fingerprint(0));
  assert.equal(evicted.state().no_progress, false);
  evicted.toolCall(fingerprint(0));
  assert.equal(evicted.state().no_progress, true);
});

test('progress tracker rejects invalid bounds and honors configurable repeat threshold', () => {
  for (const key of ['repeats', 'maxDistinct']) {
    for (const value of [null, 0, -1, 1.5, NaN, Infinity, '5', Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => createProgressTracker({ [key]: value }), TypeError);
    }
  }
  const tracker = createProgressTracker({ repeats: 2, maxDistinct: 1 });
  tracker.toolCall(fingerprint(1));
  assert.equal(tracker.state().no_progress, false);
  tracker.toolCall(fingerprint(1));
  assert.equal(tracker.state().repeats, 2);
});

test('tracker reports working to tool-extended and proof-unavailable transitions', () => {
  for (const [localProof, silence, reason] of [
    [{ capability: 'available', proof: 'positive' }, 240001, 'tool-extended'],
    [undefined, 120001, 'proof-unavailable'],
  ]) {
    const tracker = createTracker();
    const inputs = { localProof };
    const snapshot = active(silence, { gap_suspended: true });
    assert.equal(tracker.evaluate(active(0, { gap_suspended: true }), inputs).result.state, 'working');
    assert.deepEqual(tracker.evaluate(snapshot, inputs).transition,
      { from: 'working', to: 'slow-suspect', at_ms: snapshot.elapsed_ms, reason });
    assert.equal(tracker.evaluate(snapshot, inputs).transition, null);
  }
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
