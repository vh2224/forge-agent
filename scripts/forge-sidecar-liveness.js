'use strict';

const POLICY = 'forge-liveness-v1';
const SOURCE_DEFAULT = 'locked-default';
const SOURCE_CALIBRATED = 'persisted-calibration';
const DEFAULTS = Object.freeze({ startMs: 60000, suspectMs: 120000, deadMs: 240000, toolExtensionMs: 420000 });
const LOOP_REPEATS = 5;
const PROOF_CAPABILITIES = Object.freeze(['available', 'unavailable']);
const PROOF_VALUES = Object.freeze(['positive', 'negative', 'none']);
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

/** Normalize the legacy boolean contract and the closed three-state proof contract. */
function normalizeLocalProof(localProof) {
  if (localProof === undefined) return { capability: 'unavailable', proof: 'none' };
  if (localProof && typeof localProof === 'object' && !Array.isArray(localProof)) {
    if ('capability' in localProof || 'proof' in localProof) {
      if (PROOF_CAPABILITIES.includes(localProof.capability) && PROOF_VALUES.includes(localProof.proof)) {
        return { capability: localProof.capability, proof: localProof.proof };
      }
    } else if (typeof localProof.available === 'boolean' && typeof localProof.proven === 'boolean') {
      return { capability: localProof.available ? 'available' : 'unavailable',
        proof: localProof.proven ? 'positive' : 'none' };
    }
  }
  throw new TypeError('localProof must contain valid capability/proof or boolean available/proven fields');
}

/** Bounded insertion-order counts; only a write establishes new progress. */
function createProgressTracker({ repeats = LOOP_REPEATS, maxDistinct = 256 } = {}) {
  if (!Number.isSafeInteger(repeats) || repeats < 1
      || !Number.isSafeInteger(maxDistinct) || maxDistinct < 1) {
    throw new TypeError('repeats and maxDistinct must be positive safe integers');
  }
  const counts = new Map();
  let trigger = null;
  return {
    toolCall(fingerprint) {
      // Invalid reducer input is ignored without coercion, retention or counting.
      if (typeof fingerprint !== 'string' || fingerprint.length !== 64 || !/^[0-9a-f]{64}$/.test(fingerprint)) return;
      if (!counts.has(fingerprint) && counts.size >= maxDistinct) {
        counts.delete(counts.keys().next().value);
      }
      const count = Math.min((counts.get(fingerprint) || 0) + 1, repeats);
      counts.set(fingerprint, count);
      if (!trigger && count >= repeats) trigger = { repeats: count, fingerprint };
    },
    write() {
      counts.clear();
      trigger = null;
    },
    state() {
      return { no_progress: trigger !== null, repeats: trigger?.repeats ?? 0,
        fingerprint: trigger?.fingerprint ?? null };
    },
  };
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
 * localProof accepts legacy available/proven booleans or capability/proof enums.
 * Positive and unavailable/none proofs permit a bounded tool extension; negative
 * and available/none proofs retain the ordinary dead-silence deadline.
 * No-progress is advisory; it cannot cancel silence termination or the ceiling.
 */
function evaluate(snapshot, inputs = {}, policy = DEFAULTS, ceilingMs = null) {
  const limits = normalizePolicy(policy);
  const elapsed = milliseconds(snapshot?.elapsed_ms);
  const first = milliseconds(snapshot?.first_remote_ms);
  const silence = milliseconds(snapshot?.remote_silence_ms);
  const { capability, proof } = normalizeLocalProof(inputs?.localProof);

  const result = { state: 'working', kill: false, cause: null, termination: null,
    reason: null, window_ms: silence, threshold_ms: limits.suspectMs, dimension: 'gap', extension_ms: null };
  if (snapshot?.gap_suspended === true) {
    result.proof_capability = capability;
    result.proof = proof;
  }
  const extendedMaximum = limits.deadMs + limits.toolExtensionMs;
  const extended = proof === 'positive' || (capability === 'unavailable' && proof === 'none');
  const toolMaximum = extended ? extendedMaximum : limits.deadMs;
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
    if (silence !== null && silence > toolMaximum) {
      result.state = 'dead';
      result.kill = true;
      result.cause = 'liveness';
      result.termination = classifyTermination(result);
      result.threshold_ms = limits.deadMs;
      result.reason = proof === 'positive' ? 'tool-extension-exhausted'
        : proof === 'negative' ? 'tool-proof-negative'
          : capability === 'available' ? 'tool-unproven' : 'tool-proof-unavailable-expired';
      result.extension_ms = extended ? limits.toolExtensionMs : null;
    } else if (silence !== null && silence > limits.suspectMs) {
      result.state = 'slow-suspect';
      if (proof === 'positive') {
        result.state = silence > limits.deadMs ? 'slow-suspect' : 'working';
        result.reason = silence > limits.deadMs ? 'tool-extended' : 'local-proof';
      } else {
        result.reason = proof === 'negative' ? 'tool-proof-negative'
          : capability === 'available' ? 'tool-unproven' : 'proof-unavailable';
      }
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
  // A tool deadline that expired before the ceiling retains its liveness cause.
  const toolDiedFirst = snapshot?.gap_suspended === true && first !== null && result.state === 'dead'
    && elapsed !== null && silence !== null && ceilingMs > elapsed - silence + toolMaximum;
  if (!toolDiedFirst && Number.isSafeInteger(ceilingMs) && ceilingMs > 0 && elapsed !== null && elapsed >= ceilingMs) {
    result.kill = true;
    result.cause = 'ceiling';
    // A tool deadline crossed in the same tick is subsumed by the ceiling: the
    // reported state and termination agree (active child over budget).
    if (snapshot?.gap_suspended === true && first !== null && result.state === 'dead') result.state = 'slow-suspect';
    result.termination = classifyTermination(result);
    result.extension_ms = null;
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
  let previousLoop = false;
  return {
    evaluate(snapshot, inputs = {}) {
      const result = evaluate(snapshot, inputs, limits, ceilingMs);
      // The no-progress episode is tracked independently of the state: it can
      // begin or end while the state stays slow-suspect.
      const loop = result.reason === 'no-progress';
      const transition = previous === result.state && previousLoop === loop ? null
        : { from: previous, to: result.state, at_ms: milliseconds(snapshot?.elapsed_ms), reason: result.reason };
      previous = result.state;
      previousLoop = loop;
      return { result, transition };
    },
  };
}

module.exports = { POLICY, SOURCE_DEFAULT, SOURCE_CALIBRATED, DEFAULTS, TIER_CEILING_MS,
  STATES, TERMINATIONS, LOOP_REPEATS, PROOF_CAPABILITIES, PROOF_VALUES, ceilingForTier,
  normalizePolicy, normalizeLocalProof, createProgressTracker, evaluate, classifyTermination, createTracker };
