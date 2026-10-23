'use strict';

const POLICY = 'forge-liveness-v1';
const SOURCE_DEFAULT = 'locked-default';
const SOURCE_CALIBRATED = 'persisted-calibration';
const DEFAULTS = Object.freeze({ startMs: 60000, suspectMs: 120000, deadMs: 240000 });
const TIER_CEILING_MS = Object.freeze({ light: 900000, standard: 1800000, heavy: 3600000, max: 5400000 });
const STATES = Object.freeze(['starting', 'working', 'slow-suspect', 'dead']);
const TERMINATIONS = Object.freeze(['dead-start', 'dead-silence', 'budget-exceeded-while-active']);

function ceilingForTier(tier) {
  return typeof tier === 'string' && Object.hasOwn(TIER_CEILING_MS, tier) ? TIER_CEILING_MS[tier] : null;
}

/** Only enforces the locked upper bounds; calibration floors belong to S08. */
function normalizePolicy(override) {
  const result = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const value = override?.[key];
    if (Number.isSafeInteger(value) && value > 0 && value <= DEFAULTS[key]) result[key] = value;
  }
  result.suspectMs = Math.min(result.suspectMs, result.deadMs);
  result.source = Object.keys(DEFAULTS).some(key => result[key] < DEFAULTS[key])
    ? SOURCE_CALIBRATED : SOURCE_DEFAULT;
  return result;
}

function milliseconds(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Closed termination vocabulary; dimension preserves initial liveness failures. */
function classifyTermination({ cause, state, dimension } = {}) {
  if (cause === 'ceiling' && (state === 'working' || state === 'slow-suspect')) {
    return 'budget-exceeded-while-active';
  }
  if (cause === 'liveness') return state === 'starting' || dimension === 'initial' ? 'dead-start' : 'dead-silence';
  return null;
}

/**
 * Pure decision over injected elapsed times from the stream snapshot (no clock/I/O).
 * localProof, when supplied, must contain boolean available/proven fields. Both
 * valid shapes and undefined have identical behavior here: S02 implements the
 * maximum local-proof extension and termination at its end.
 * No-progress is advisory; it cannot cancel silence termination or the ceiling.
 */
function evaluate(snapshot, inputs = {}, policy = DEFAULTS, ceilingMs = null) {
  const limits = normalizePolicy(policy);
  const elapsed = milliseconds(snapshot?.elapsed_ms);
  const first = milliseconds(snapshot?.first_remote_ms);
  const silence = milliseconds(snapshot?.remote_silence_ms);
  const localProof = inputs?.localProof;
  if (localProof !== undefined && (!localProof || typeof localProof !== 'object' || Array.isArray(localProof)
      || typeof localProof.available !== 'boolean' || typeof localProof.proven !== 'boolean')) {
    throw new TypeError('localProof must contain boolean available and proven fields');
  }

  const result = { state: 'working', kill: false, cause: null, termination: null,
    reason: null, window_ms: silence, threshold_ms: limits.suspectMs, dimension: 'gap' };
  if (first === null) {
    result.state = 'starting';
    result.dimension = 'initial';
    result.window_ms = elapsed;
    result.threshold_ms = limits.startMs;
    if (elapsed !== null && elapsed > limits.startMs) {
      result.state = 'dead';
      result.kill = true;
      result.cause = 'liveness';
      result.termination = classifyTermination(result);
    }
  } else if (snapshot?.gap_suspended === true) {
    if (silence !== null && silence > limits.suspectMs) {
      result.state = 'slow-suspect';
      result.reason = 'tool-unproven';
    }
  } else if (silence !== null && silence > limits.deadMs) {
    result.state = 'dead';
    result.kill = true;
    result.cause = 'liveness';
    result.termination = classifyTermination(result);
    result.reason = 'silence';
    result.threshold_ms = limits.deadMs;
  } else if (silence !== null && silence > limits.suspectMs) {
    result.state = 'slow-suspect';
    result.reason = 'silence';
  }

  if (result.state !== 'dead' && inputs?.progress?.no_progress === true) {
    result.state = 'slow-suspect';
    result.reason = 'no-progress';
    result.kill = false;
  }
  // Apply the highest-priority ceiling using the state that held without it.
  if (Number.isSafeInteger(ceilingMs) && ceilingMs > 0 && elapsed !== null && elapsed >= ceilingMs) {
    result.kill = true;
    result.cause = 'ceiling';
    result.termination = classifyTermination(result);
    result.window_ms = elapsed;
    result.threshold_ms = ceilingMs;
    result.dimension = null;
  }
  return result;
}

/** Minimal stateful wrapper; tracker.evaluate receives every time via snapshot. */
function createTracker(policy = DEFAULTS, ceilingMs = null) {
  const limits = normalizePolicy(policy);
  let previous = null;
  return {
    evaluate(snapshot, inputs = {}) {
      const result = evaluate(snapshot, inputs, limits, ceilingMs);
      const transition = previous === result.state ? null
        : { from: previous, to: result.state, at_ms: milliseconds(snapshot?.elapsed_ms), reason: result.reason };
      previous = result.state;
      return { result, transition };
    },
  };
}

module.exports = { POLICY, SOURCE_DEFAULT, SOURCE_CALIBRATED, DEFAULTS, TIER_CEILING_MS,
  STATES, TERMINATIONS, ceilingForTier, normalizePolicy, evaluate, classifyTermination, createTracker };
