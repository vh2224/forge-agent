'use strict';

const assert = require('assert/strict');
const { POLICY, SOURCE_DEFAULT, SOURCE_CALIBRATED, DEFAULTS, CALIBRATION_FLOORS, TIER_CEILING_MS, STATES, TERMINATIONS, REASONS,
  LOOP_REPEATS, PROOF_CAPABILITIES, PROOF_VALUES, normalizeLocalProof, createProgressTracker,
  evaluate, classifyTermination, ceilingForTier, normalizePolicy, createTracker } = require('./forge-sidecar-liveness');
const { observation } = require('./forge-sidecar-diagnostic');
const { createLocalProof } = require('./forge-sidecar-local-proof');

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

test('ceiling and tool deadline crossed together return a consistent active decision (R7)', () => {
  const snapshot = active(240001, { gap_suspended: true, elapsed_ms: 240001, first_remote_ms: 0 });
  const result = evaluate(snapshot, { localProof: { capability: 'available', proof: 'none' } }, DEFAULTS, 240000);
  assert.equal(result.kill, true);
  assert.equal(result.cause, 'ceiling');
  assert.equal(result.state, 'slow-suspect');
  assert.equal(result.termination, 'budget-exceeded-while-active');
});

test('no-progress episode is reported from and to a slow-suspect state (R8)', () => {
  const tracker = createTracker();
  const snapshot = active(130000, { gap_suspended: true });
  const unavailable = { localProof: undefined };
  const looping = { localProof: undefined, progress: { no_progress: true, repeats: 5, fingerprint: 'a'.repeat(64) } };
  assert.equal(tracker.evaluate(snapshot, unavailable).result.reason, 'proof-unavailable');
  const entry = tracker.evaluate(snapshot, looping);
  assert.deepEqual(entry.transition, { from: 'slow-suspect', to: 'slow-suspect', at_ms: snapshot.elapsed_ms,
    reason: 'no-progress' });
  assert.equal(tracker.evaluate(snapshot, looping).transition, null);
  const exit = tracker.evaluate(snapshot, unavailable);
  assert.deepEqual(exit.transition, { from: 'slow-suspect', to: 'slow-suspect', at_ms: snapshot.elapsed_ms,
    reason: 'proof-unavailable' });
  assert.equal(tracker.evaluate(snapshot, looping).transition.reason, 'no-progress');
});

test('REASONS is the closed vocabulary and covers every reason evaluate() produces', () => {
  assert.deepEqual([...REASONS], ['silence', 'local-proof', 'tool-extended', 'tool-unproven',
    'tool-proof-negative', 'proof-unavailable', 'tool-extension-exhausted',
    'tool-proof-unavailable-expired', 'no-progress']);
  assert(Object.isFrozen(REASONS));
  const proofs = [];
  for (const capability of PROOF_CAPABILITIES) for (const proof of PROOF_VALUES) proofs.push({ capability, proof });
  const snapshots = [];
  for (const elapsed of [0, 59999, 60001, 500000]) {
    snapshots.push({ elapsed_ms: elapsed, first_remote_ms: null, remote_silence_ms: null, gap_suspended: false });
  }
  for (const silence of [0, 100000, 121000, 130000, 241000, 250000, 700000]) {
    for (const suspended of [false, true]) snapshots.push(active(silence, { gap_suspended: suspended }));
  }
  const seen = new Set();
  for (const snapshot of snapshots) {
    for (const localProof of [undefined, ...proofs]) {
      for (const no_progress of [false, true]) {
        for (const ceiling of [null, 1000000]) {
          const { reason } = evaluate(snapshot, { localProof, progress: { no_progress } }, DEFAULTS, ceiling);
          if (reason !== null) { assert(REASONS.includes(reason), String(reason)); seen.add(reason); }
        }
      }
    }
  }
  // Every vocabulary entry is actually reachable, so the list has no dead words.
  assert.deepEqual([...seen].sort(), [...REASONS].sort());
});

// #205: the proof-probe timeline ported to createTracker over the real provider
// with injected readers and a fake clock (no I/O, no provider call). The tool keeps
// burning CPU until the 250000 sample and is idle (pid alive) at 265000.
const PROBE_SAMPLES = [0, ...Array.from({ length: 18 }, (_, k) => 10000 + 15000 * k)];
const probeSnapshot = time => ({ elapsed_ms: time + 10, first_remote_ms: 10, last_remote_ms: 10,
  remote_silence_ms: time, gap_suspended: true, suspension_epoch: 1 });

async function probeTimeline(platform, extraSamples = []) {
  let now = 0, cpu = 0;
  const p = createLocalProof({ pid: 4242, platform, clock: () => now, readers: {
    pidAlive: async () => true,
    cpuTreeMs: async () => cpu,
  } });
  const tracker = createTracker();
  const ticks = new Map();
  for (const time of [...PROBE_SAMPLES, ...extraSamples]) {
    now = time;
    if (time > 0 && time <= 250000) cpu += 1000;
    await p.sample();
    ticks.set(time, { proof: p.current(), ...tracker.evaluate(probeSnapshot(time), { localProof: p.current() }) });
  }
  return { ticks, tracker, proof: p };
}

test('MH-01 probe timeline: an earned extension survives the idle 265000 sample on linux and darwin', async () => {
  assert.deepEqual(PROBE_SAMPLES.slice(-2), [250000, 265000]);
  for (const platform of ['linux', 'darwin']) {
    const { ticks } = await probeTimeline(platform);
    assert.equal(ticks.get(250000).proof.proof, 'positive', platform);
    assert.equal(ticks.get(265000).proof.proof, 'none', `${platform}: the idle sample is reported as none`);
    assert.equal(ticks.get(250000).result.kill, false);
    assert.equal(ticks.get(250000).result.reason, 'tool-extended');
    const idle = ticks.get(265000).result;
    assert.equal(idle.kill, false, `${platform}: idle@265000 ${idle.state}/${idle.reason}`);
    assert.equal(idle.state, 'slow-suspect');
    assert.equal(idle.reason, 'tool-extended');
    assert.equal(idle.proof_capability, 'available');
    assert.equal(idle.proof, 'none');
  }
});

const NONE = Object.freeze({ capability: 'available', proof: 'none' });
const POSITIVE = Object.freeze({ capability: 'available', proof: 'positive' });
const NEGATIVE = Object.freeze({ capability: 'available', proof: 'negative' });
const sampled = (proof, sampled_at_ms) => ({ ...proof, sampled_at_ms });
const windowAt = (silence, extra = {}) => active(silence, { gap_suspended: true, last_remote_ms: 10,
  suspension_epoch: 1, ...extra });
// Baseline, first new sample (its delta crosses the opening) and the second new
// sample, the first one measured inside the window: only that one earns.
function earn(tracker, extra = {}) {
  tracker.evaluate(windowAt(0, extra), { localProof: sampled(POSITIVE, 1) });
  tracker.evaluate(windowAt(1000, extra), { localProof: sampled(POSITIVE, 2) });
  return tracker.evaluate(windowAt(2000, extra), { localProof: sampled(POSITIVE, 3) });
}
const verdict = ({ state, kill, reason }) => ({ state, kill, reason });
const EXTENDED = { state: 'slow-suspect', kill: false, reason: 'tool-extended' };
const UNPROVEN_DEAD = { state: 'dead', kill: true, reason: 'tool-unproven' };

test('MH-02 pure evaluate keeps its contract unless extensionEarned is exactly true', () => {
  assert.deepEqual(CALIBRATION_FLOORS, { startMs: 30000, deadMs: 120000 });
  assert(Object.isFrozen(CALIBRATION_FLOORS));
  // Literal proof-probe verdicts through the pure function.
  const positive = evaluate(probeSnapshot(250000), { localProof: POSITIVE });
  assert.deepEqual(verdict(positive), EXTENDED);
  assert.deepEqual(verdict(evaluate(probeSnapshot(265000), { localProof: NONE })), UNPROVEN_DEAD);
  assert.equal(evaluate(probeSnapshot(660001), { localProof: POSITIVE }).reason, 'tool-extension-exhausted');
  // Same grid as the REASONS sweep, plus the exact tool boundaries.
  const proofs = [undefined];
  for (const capability of PROOF_CAPABILITIES) for (const proof of PROOF_VALUES) proofs.push({ capability, proof });
  const snapshots = [];
  for (const elapsed of [0, 59999, 60001, 500000]) {
    snapshots.push({ elapsed_ms: elapsed, first_remote_ms: null, remote_silence_ms: null, gap_suspended: false });
    snapshots.push({ elapsed_ms: elapsed, first_remote_ms: null, remote_silence_ms: null, gap_suspended: true });
  }
  for (const silence of [0, 100000, 120000, 120001, 121000, 130000, 240000, 240001, 241000, 250000,
    660000, 660001, 700000]) {
    for (const suspended of [false, true]) snapshots.push(active(silence, { gap_suspended: suspended }));
  }
  let changed = 0;
  for (const snapshot of snapshots) {
    for (const localProof of proofs) {
      for (const no_progress of [false, true]) {
        for (const ceiling of [null, 1000000]) {
          const inputs = { localProof, progress: { no_progress } };
          const plain = evaluate(snapshot, inputs, DEFAULTS, ceiling);
          for (const extensionEarned of [undefined, false, 'true', 1, {}, null]) {
            assert.deepEqual(evaluate(snapshot, { ...inputs, extensionEarned }, DEFAULTS, ceiling), plain);
          }
          const earned = evaluate(snapshot, { ...inputs, extensionEarned: true }, DEFAULTS, ceiling);
          if (earned.reason !== null) assert(REASONS.includes(earned.reason), earned.reason);
          assert(STATES.includes(earned.state));
          const idle = localProof?.capability === 'available' && localProof.proof === 'none';
          if (idle) assert.notEqual(earned.reason, 'local-proof', 'a conserved extension is never fresh local proof');
          const applies = snapshot.gap_suspended === true && snapshot.first_remote_ms !== null
            && idle && snapshot.remote_silence_ms > DEFAULTS.deadMs;
          if (!applies) { assert.deepEqual(earned, plain); continue; }
          if (JSON.stringify(earned) !== JSON.stringify(plain)) changed++;
          if (no_progress || ceiling !== null) continue;
          const silence = snapshot.remote_silence_ms;
          assert.deepEqual(earned, silence > 660000 ? {
            state: 'dead', kill: true, cause: 'liveness', termination: 'dead-silence',
            reason: 'tool-extension-exhausted', window_ms: silence, threshold_ms: 240000, dimension: 'gap',
            extension_ms: 420000, proof_capability: 'available', proof: 'none',
          } : {
            state: 'slow-suspect', kill: false, cause: null, termination: null, reason: 'tool-extended',
            window_ms: silence, threshold_ms: 120000, dimension: 'gap', extension_ms: null,
            proof_capability: 'available', proof: 'none',
          });
        }
      }
    }
  }
  assert(changed > 0, 'the differential sweep exercised the earned branch');
  for (const silence of [120001, 240000]) {
    assert.deepEqual(verdict(evaluate(windowAt(silence), { localProof: NONE, extensionEarned: true })),
      { state: 'slow-suspect', kill: false, reason: 'tool-unproven' });
  }
  for (const localProof of [NEGATIVE, undefined, { capability: 'unavailable', proof: 'none' }, POSITIVE]) {
    for (const silence of [240001, 660001]) {
      assert.deepEqual(evaluate(windowAt(silence), { localProof, extensionEarned: true }),
        evaluate(windowAt(silence), { localProof }));
    }
  }
});

test('MH-03 the tracker derives the extension itself and assess commits nothing', () => {
  // A caller flag is replaced by the derivation: nothing was earned here.
  const forged = createTracker();
  forged.evaluate(windowAt(0), { localProof: sampled(NONE, 1), extensionEarned: true });
  assert.deepEqual(verdict(forged.assess(windowAt(240001), { localProof: sampled(NONE, 2), extensionEarned: true })),
    UNPROVEN_DEAD);
  assert.deepEqual(verdict(forged.evaluate(windowAt(240001),
    { localProof: sampled(NONE, 2), extensionEarned: true }).result), UNPROVEN_DEAD);
  const earned = createTracker();
  earn(earned, {}, 0);
  assert.deepEqual(verdict(earned.evaluate(windowAt(240001),
    { localProof: sampled(NONE, 4), extensionEarned: false }).result), EXTENDED);

  // assess interleaved with tempting inputs never changes evaluate's results or transitions.
  const ticks = [];
  for (let silence = 0, id = 1; silence <= 240001; silence += silence === 240000 ? 1 : 20000, id++) {
    ticks.push([windowAt(silence), { localProof: sampled(NONE, id) }]);
  }
  const plain = createTracker(DEFAULTS, 900000);
  const probed = createTracker(DEFAULTS, 900000);
  for (const [index, [snapshot, inputs]] of ticks.entries()) {
    for (let k = 0; k < 3; k++) probed.assess(snapshot, { localProof: sampled(POSITIVE, 1000 + index * 3 + k) });
    probed.assess(windowAt(1, { suspension_epoch: 9 }), { localProof: sampled(POSITIVE, 5000 + index) });
    assert.deepEqual(probed.evaluate(snapshot, inputs), plain.evaluate(snapshot, inputs), `tick ${index}`);
  }
  assert.deepEqual(verdict(plain.evaluate(windowAt(240002), { localProof: sampled(NONE, 999) }).result),
    UNPROVEN_DEAD);

  // assess applies the same derivation, including the current snapshot, with no ceiling.
  const tracker = createTracker(DEFAULTS, 100);
  earn(tracker);
  const inputs = { localProof: sampled(NONE, 4) };
  assert.deepEqual(tracker.assess(windowAt(300000), inputs),
    evaluate(windowAt(300000), { ...inputs, extensionEarned: true }, DEFAULTS, null));
  assert.notEqual(tracker.assess(windowAt(300000), inputs).cause, 'ceiling');
  assert.deepEqual(verdict(tracker.assess(windowAt(300000, { suspension_epoch: 2 }), inputs)), UNPROVEN_DEAD);
  assert.deepEqual(verdict(tracker.assess(windowAt(300000), { localProof: sampled(NEGATIVE, 5) })),
    { state: 'dead', kill: true, reason: 'tool-proof-negative' });
  // Neither assessment committed its reset nor its revocation.
  const after = createTracker();
  earn(after);
  after.assess(windowAt(300000, { suspension_epoch: 2 }), inputs);
  after.assess(windowAt(300000), { localProof: sampled(NEGATIVE, 5) });
  after.assess(active(300000), inputs);
  assert.deepEqual(verdict(after.evaluate(windowAt(300000), inputs).result), EXTENDED);
});

test('MH-04 an intermittent tool keeps its earned extension up to exactly 660000', async () => {
  for (const platform of ['linux', 'darwin']) {
    const { ticks } = await probeTimeline(platform, [280000, 400000, 520000, 660000, 660001]);
    for (const time of [265000, 280000, 400000, 520000, 660000]) {
      assert.deepEqual(verdict(ticks.get(time).result), EXTENDED, `${platform} ${time}`);
      assert.equal(ticks.get(time).proof.proof, 'none');
    }
    assert.deepEqual(ticks.get(660001).result, {
      state: 'dead', kill: true, cause: 'liveness', termination: 'dead-silence',
      reason: 'tool-extension-exhausted', window_ms: 660001, threshold_ms: 240000, dimension: 'gap',
      extension_ms: 420000, proof_capability: 'available', proof: 'none',
    });
    assert.deepEqual(ticks.get(660001).transition,
      { from: 'slow-suspect', to: 'dead', at_ms: 660011, reason: 'tool-extension-exhausted' });
  }
  // Positives after the conquest never move the limit: it stays anchored.
  const tracker = createTracker();
  earn(tracker);
  let id = 10;
  for (const [silence, proof] of [[250000, NONE], [500000, POSITIVE], [600000, POSITIVE], [650000, NONE],
    [660000, NONE]]) {
    assert.equal(tracker.evaluate(windowAt(silence), { localProof: sampled(proof, id++) }).result.kill, false);
  }
  const last = tracker.evaluate(windowAt(660001), { localProof: sampled(NONE, id++) }).result;
  assert.equal(last.reason, 'tool-extension-exhausted');
  assert.equal(last.extension_ms, 420000);
});

test('MH-05 never-positive tools and the window opening keep the ordinary 240000 cutoff', () => {
  // (a) only fresh available/none samples: identical to the pure function on every tick.
  const tracker = createTracker();
  let id = 1;
  for (const silence of [0, 15000, 120000, 120001, 200000, 240000, 240001]) {
    const inputs = { localProof: sampled(NONE, id++) };
    assert.deepEqual(tracker.evaluate(windowAt(silence), inputs).result, evaluate(windowAt(silence), inputs));
  }
  assert.deepEqual(verdict(evaluate(windowAt(240000), { localProof: NONE })),
    { state: 'slow-suspect', kill: false, reason: 'tool-unproven' });
  // (b) a cached positive from before the window (baseline) and a positive first new
  // sample whose CPU delta crosses the opening are the model streaming, not the tool.
  const crossing = createTracker();
  crossing.evaluate(windowAt(0), { localProof: sampled(POSITIVE, 1) });
  crossing.evaluate(windowAt(5000), { localProof: sampled(POSITIVE, 2) });
  crossing.evaluate(windowAt(20000), { localProof: sampled(NONE, 3) });
  assert.deepEqual(verdict(crossing.evaluate(windowAt(240000), { localProof: sampled(NONE, 4) }).result),
    { state: 'slow-suspect', kill: false, reason: 'tool-unproven' });
  assert.deepEqual(verdict(crossing.evaluate(windowAt(240001), { localProof: sampled(NONE, 5) }).result),
    UNPROVEN_DEAD);
  // (c) Accepted: a positive sample (id 3) that is born and replaced between two
  // ticks is never observed, so it cannot earn; the tool dies at 240001.
  const missed = createTracker();
  for (const [silence, id] of [[0, 1], [15000, 2], [45000, 4], [240001, 5]]) {
    const { result } = missed.evaluate(windowAt(silence), { localProof: sampled(NONE, id) });
    if (silence === 240001) assert.deepEqual(verdict(result), UNPROVEN_DEAD);
  }
  // (d) absent, non-finite or repeated (frozen clock) identities never earn.
  for (const identity of [undefined, null, NaN, Infinity, -Infinity, '5', {}, 'repeat']) {
    const frozen = createTracker();
    for (const silence of [0, 1000, 2000, 3000, 4000]) {
      const localProof = identity === 'repeat' ? sampled(POSITIVE, 7)
        : identity === undefined ? { ...POSITIVE } : sampled(POSITIVE, identity);
      frozen.evaluate(windowAt(silence), { localProof });
    }
    const localProof = identity === 'repeat' ? sampled(NONE, 7) : sampled(NONE, 8);
    assert.deepEqual(verdict(frozen.evaluate(windowAt(240001), { localProof }).result), UNPROVEN_DEAD,
      String(identity));
  }
});

test('MH-06 a negative proof wins without killing before the ordinary deadline', () => {
  const early = createTracker();
  earn(early);
  assert.deepEqual(verdict(early.evaluate(windowAt(200000), { localProof: sampled(NEGATIVE, 4) }).result),
    { state: 'slow-suspect', kill: false, reason: 'tool-proof-negative' });
  assert.equal(early.evaluate(windowAt(240000), { localProof: sampled(NEGATIVE, 4) }).result.kill, false);
  const killed = early.evaluate(windowAt(240001), { localProof: sampled(NEGATIVE, 4) }).result;
  assert.deepEqual(verdict(killed), { state: 'dead', kill: true, reason: 'tool-proof-negative' });
  assert.equal(killed.extension_ms, null);
  assert.equal(killed.threshold_ms, 240000);

  const late = createTracker();
  earn(late);
  assert.deepEqual(verdict(late.evaluate(windowAt(299999), { localProof: sampled(NONE, 4) }).result), EXTENDED);
  const dead = late.evaluate(windowAt(300000), { localProof: sampled(NEGATIVE, 5) }).result;
  assert.deepEqual(verdict(dead), { state: 'dead', kill: true, reason: 'tool-proof-negative' });
  assert.equal(dead.extension_ms, null);

  // The revocation lasts until the episode ends: a later none conserves nothing.
  const revoked = createTracker();
  earn(revoked);
  revoked.evaluate(windowAt(100000), { localProof: sampled(NEGATIVE, 4) });
  revoked.evaluate(windowAt(110000), { localProof: sampled(POSITIVE, 5) });
  revoked.evaluate(windowAt(120000), { localProof: sampled(POSITIVE, 6) });
  assert.deepEqual(verdict(revoked.evaluate(windowAt(240001), { localProof: sampled(NONE, 7) }).result),
    UNPROVEN_DEAD);
});

test('MH-07 the earned state resets with the window, epoch, anchor and tracker (also fractional anchors)', () => {
  for (const anchor of [10, 10.25]) {
    const base = { last_remote_ms: anchor };
    const retained = createTracker();
    earn(retained, base);
    assert.deepEqual(verdict(retained.evaluate(windowAt(400000, base), { localProof: sampled(NONE, 4) }).result),
      EXTENDED, `retained with anchor ${anchor}`);
    const resets = [
      ['window closed for one tick', [active(5000, { ...base, suspension_epoch: 1 })], windowAt(240001, base)],
      ['different anchor, same epoch', [], windowAt(240001, { last_remote_ms: anchor + 1 })],
      ['same anchor, new epoch (close and reopen in the same ms)', [], windowAt(240001, { ...base, suspension_epoch: 2 })],
    ];
    for (const [label, between, final] of resets) {
      const tracker = createTracker();
      earn(tracker, base);
      for (const snapshot of between) tracker.evaluate(snapshot, { localProof: sampled(NONE, 4) });
      assert.deepEqual(verdict(tracker.evaluate(final, { localProof: sampled(NONE, 5) }).result), UNPROVEN_DEAD,
        `${label} (anchor ${anchor})`);
    }
    // A new tracker fed the same snapshots and identities (replay, session, retry)
    // starts from its own baseline and inherits nothing.
    const replay = createTracker();
    replay.evaluate(windowAt(2000, base), { localProof: sampled(POSITIVE, 3) });
    assert.deepEqual(verdict(replay.evaluate(windowAt(240001, base), { localProof: sampled(NONE, 4) }).result),
      UNPROVEN_DEAD);
    // No indefinite renewal: each new epoch must earn again, from its own anchor.
    const renewed = createTracker();
    earn(renewed, base);
    const next = { last_remote_ms: anchor + 500000, suspension_epoch: 2 };
    earn(renewed, next);
    assert.deepEqual(verdict(renewed.evaluate(windowAt(660000, next), { localProof: sampled(NONE, 9) }).result),
      EXTENDED);
    assert.equal(renewed.evaluate(windowAt(660001, next), { localProof: sampled(NONE, 10) }).result.reason,
      'tool-extension-exhausted');
  }
  // An absent or invalid epoch/anchor behaves exactly like the pure function.
  for (const invalid of [{ suspension_epoch: undefined }, { suspension_epoch: 1.5 }, { suspension_epoch: -1 },
    { suspension_epoch: Number.MAX_SAFE_INTEGER + 1 }, { suspension_epoch: '1' }, { suspension_epoch: null },
    { last_remote_ms: undefined }, { last_remote_ms: NaN }, { last_remote_ms: -1 }, { last_remote_ms: Infinity },
    { last_remote_ms: '10' }, { last_remote_ms: null }]) {
    const tracker = createTracker();
    let id = 1;
    for (const [silence, proof] of [[0, POSITIVE], [1000, POSITIVE], [2000, POSITIVE], [3000, POSITIVE],
      [240000, NONE], [240001, NONE]]) {
      const snapshot = windowAt(silence, invalid);
      const inputs = { localProof: sampled(proof, id++) };
      assert.deepEqual(tracker.evaluate(snapshot, inputs).result, evaluate(snapshot, inputs), JSON.stringify(invalid));
    }
  }
});

test('MH-10 the window counter and sample identity never reach the diagnostic observation', () => {
  const { createReducer } = require('./forge-claude-stream');
  const { createNotificationReducer } = require('./forge-appserver-liveness');
  const claude = createReducer({ clock: () => 0 });
  claude.push(Buffer.from(JSON.stringify({ type: 'assistant', message: { id: 'm', role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] } }) + '\n'));
  const appserver = createNotificationReducer({ clock: () => 0 });
  appserver.turnSent();
  appserver.push({ method: 'item/started', params: { item: { id: 'i', type: 'commandExecution' } } });
  for (const snapshot of [claude.snapshot(), appserver.snapshot()]) {
    assert.equal(snapshot.suspension_epoch, 1);
    const observed = observation({ ...snapshot, sampled_at_ms: 5 });
    assert(!Object.hasOwn(observed, 'suspension_epoch'));
    assert(!Object.hasOwn(observed, 'sampled_at_ms'));
    assert.equal(observed.gap_suspended, true);
  }
  // The conserved decision reports the real current proof, not fresh activity.
  const tracker = createTracker();
  earn(tracker);
  const { result } = tracker.evaluate(windowAt(300000), { localProof: sampled(NONE, 4) });
  assert.deepEqual({ capability: result.proof_capability, proof: result.proof }, NONE);
  assert(!Object.hasOwn(result, 'sampled_at_ms') && !Object.hasOwn(result, 'extensionEarned'));
});

test('MH-13 the tier ceiling still wins and unavailable or absent proof never earns', () => {
  const light = TIER_CEILING_MS.light;
  assert.equal(light, 900000);
  const anchored = (elapsed, anchor) => ({ elapsed_ms: elapsed, first_remote_ms: 10, last_remote_ms: anchor,
    remote_silence_ms: elapsed - anchor, gap_suspended: true, suspension_epoch: 1 });
  const late = createTracker(DEFAULTS, light);
  let id = 1;
  for (const elapsed of [300000, 301000, 302000]) late.evaluate(anchored(elapsed, 300000), { localProof: sampled(POSITIVE, id++) });
  assert.deepEqual(verdict(late.evaluate(anchored(899999, 300000), { localProof: sampled(NONE, id++) }).result), EXTENDED);
  const capped = late.evaluate(anchored(900000, 300000), { localProof: sampled(NONE, id++) }).result;
  assert.equal(capped.kill, true);
  assert.equal(capped.cause, 'ceiling');
  assert.equal(capped.termination, 'budget-exceeded-while-active');
  assert.equal(capped.state, 'slow-suspect');
  assert.equal(capped.extension_ms, null);
  assert.equal(capped.threshold_ms, 900000);

  const early = createTracker(DEFAULTS, light);
  earn(early);
  assert.equal(early.evaluate(windowAt(660000), { localProof: sampled(NONE, 4) }).result.kill, false);
  const exhausted = early.evaluate(windowAt(660001), { localProof: sampled(NONE, 5) }).result;
  assert.equal(windowAt(660001).elapsed_ms, 660011);
  assert.equal(exhausted.cause, 'liveness');
  assert.equal(exhausted.termination, 'dead-silence');
  assert.equal(exhausted.reason, 'tool-extension-exhausted');

  for (const proof of [undefined, { capability: 'unavailable', proof: 'none' },
    { capability: 'unavailable', proof: 'positive' }]) {
    const tracker = createTracker();
    let n = 1;
    for (const silence of [0, 1000, 2000, 3000, 120001, 240001, 660000, 660001]) {
      const inputs = { localProof: proof === undefined ? undefined : sampled(proof, n++) };
      assert.deepEqual(tracker.evaluate(windowAt(silence), inputs).result, evaluate(windowAt(silence), inputs));
    }
    const switched = createTracker();
    for (const silence of [0, 1000, 2000, 3000]) {
      switched.evaluate(windowAt(silence), { localProof: proof === undefined ? undefined : sampled(proof, n++) });
    }
    assert.deepEqual(verdict(switched.evaluate(windowAt(240001), { localProof: sampled(NONE, n++) }).result),
      UNPROVEN_DEAD, 'unavailable proof never marks a conquest');
  }
  assert.equal(evaluate(windowAt(660001)).reason, 'tool-proof-unavailable-expired');
  assert.equal(evaluate(windowAt(240001)).reason, 'proof-unavailable');
});

async function main() {
  let failures = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}`); console.error(error); }
  }
  console.log(`${tests.length - failures}/${tests.length} sidecar liveness tests passed`);
  if (failures) process.exitCode = 1;
}

if (require.main === module) main();
