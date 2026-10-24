'use strict';

const liveness = require('./forge-sidecar-liveness');

// Closed vocabulary only. Never persist provider text, paths, JSON parser
// messages, validator exceptions, environment, or classifyReturn().tail.
const REASONS = Object.freeze({
  'output-empty': 'envelope', 'marker-missing': 'envelope',
  'end-marker-missing': 'envelope', 'status-missing': 'envelope',
  'status-invalid': 'envelope', 'result-json-missing': 'envelope',
  'result-error': 'envelope', 'result-envelope-invalid': 'envelope',
  'json-invalid': 'json',
  'model-substituted': 'identity', 'model-unverified': 'identity',
  'model-required': 'identity',
  'status-mismatch': 'validation', 'schema-invalid': 'validation',
  'validator-failed': 'validation', 'artifact-path-invalid': 'validation',
  'artifact-duplicate': 'validation', 'artifact-missing': 'validation',
  'artifact-limit': 'validation', 'payload-limit': 'validation',
  'questions-on-done': 'validation', 'artifacts-on-non-done': 'validation',
  'artifact-direct-write-detected': 'publication', 'secret-output': 'security',
  'control-data-output': 'security', 'output-limit': 'transport',
  'provider-exit': 'transport', 'authentication-failed': 'transport',
  'provider-timeout': 'transport', 'provider-cancelled': 'transport',
  'provider-unavailable': 'transport', 'publication-failed': 'publication',
  'adapter-failed': 'adapter', 'anomalous-silence': 'transport',
  'budget-exceeded-while-active': 'transport', 'duplicate-terminal':'envelope', 'event-after-terminal':'envelope',
});
const COUNTS = ['stdout_bytes', 'stderr_bytes', 'duration_ms', 'marker_count', 'model_count'];
// One token, no list separators, no path or shell characters; an optional
// bracketed context suffix such as `[1m]`. Shared with the Claude adapter so
// the only id a diagnostic can carry is one the adapter already validated.
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?:\[[A-Za-z0-9]{1,16}\])?$/;
function isSafeModelId(value) {
  return typeof value === 'string' && MODEL_ID_RE.test(value);
}
function diagnostic(reason, counts = {}) {
  const safeReason = Object.hasOwn(REASONS, reason) ? reason : 'adapter-failed';
  const value = { version: 1, stage: REASONS[safeReason], reason: safeReason };
  for (const key of COUNTS) {
    if (Number.isSafeInteger(counts[key]) && counts[key] >= 0) value[key] = counts[key];
  }
  // A substitution names the observed model; nothing else ever carries an id.
  if (safeReason === 'model-substituted' && isSafeModelId(counts.model_observed)) {
    value.model_observed = counts.model_observed;
  }
  if (counts.observation) value.observation = observation(counts.observation);
  return value;
}
function observation(input = {}) {
  const out = { version: 1 };
  const counters = ['elapsed_ms', 'transport_ms', 'verification_ms', 'stdout_bytes', 'stderr_bytes',
    'event_count', 'remote_event_count', 'first_remote_ms', 'last_remote_ms', 'initial_sample_ms',
    'gap_sample_ms', 'remote_silence_ms', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'];
  for (const key of counters) out[key] = Number.isSafeInteger(input[key]) && input[key] >= 0 ? input[key] : null;
  out.phase = ['local-start', 'remote-activity', 'terminal', 'closed', 'failed'].includes(input.phase)
    ? input.phase : 'local-start';
  out.cost_usd = Number.isFinite(input.cost_usd) && input.cost_usd >= 0 ? input.cost_usd : null;
  out.cost_source = out.cost_usd === null ? null : 'cli-estimate-usd';
  out.remote_source = out.remote_event_count > 0 ? 'cli-reported-protocol' : null;
  out.usage_source = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']
    .some(key => out[key] !== null) ? 'cli-reported-usage' : null;
  out.gap_suspended = input.gap_suspended === true;
  out.process_exit_observed = input.process_exit_observed === true;
  out.denials = Object.fromEntries(['read', 'write', 'shell', 'other'].map(key => [key,
    Number.isSafeInteger(input.denials?.[key]) && input.denials[key] >= 0 ? input.denials[key] : null]));
  if (isSafeModelId(input.model_observed)) {
    out.model_observed = input.model_observed;
    out.model_source = 'claude-json-modelUsage';
  }
  if (input.calibration) out.calibration = {
    diagnostic: input.calibration.diagnostic === 'calibration-unavailable' ? 'calibration-unavailable' : null,
    initial: ['uncalibrated', 'calibrating', 'calibrated'].includes(input.calibration.initial) ? input.calibration.initial : 'uncalibrated',
    gap: ['uncalibrated', 'calibrating', 'calibrated'].includes(input.calibration.gap) ? input.calibration.gap : 'uncalibrated',
  };
  const silence = input.silence;
  if (silence?.cause === 'indeterminate' && ['initial', 'gap'].includes(silence.dimension)
      && silence.policy === 'claude-silence-v1' && silence.source === 'persisted-calibration'
      && Number.isSafeInteger(silence.window_ms) && Number.isSafeInteger(silence.threshold_ms)
      && silence.threshold_ms >= 120000 && silence.window_ms > silence.threshold_ms) {
    out.silence = { dimension: silence.dimension, window_ms: silence.window_ms,
      threshold_ms: silence.threshold_ms, policy: 'claude-silence-v1',
      source: 'persisted-calibration', cause: 'indeterminate' };
  } else if (silence?.cause === 'indeterminate' && ['initial', 'gap'].includes(silence.dimension)
      && silence.policy === liveness.POLICY
      && [liveness.SOURCE_DEFAULT, liveness.SOURCE_CALIBRATED].includes(silence.source)
      && Number.isSafeInteger(silence.window_ms) && Number.isSafeInteger(silence.threshold_ms)
      && silence.threshold_ms >= 1
      && silence.threshold_ms <= (silence.dimension === 'initial' ? liveness.DEFAULTS.startMs : liveness.DEFAULTS.deadMs)
      && silence.window_ms > silence.threshold_ms) {
    out.silence = { dimension: silence.dimension, window_ms: silence.window_ms,
      threshold_ms: silence.threshold_ms, policy: silence.policy,
      source: silence.source, cause: 'indeterminate' };
  }
  const beat = input.liveness;
  if (beat && typeof beat === 'object' && !Array.isArray(beat) && beat.version === 1
      && liveness.STATES.includes(beat.state)) {
    out.liveness = { version: 1, state: beat.state,
      since_ms: Number.isSafeInteger(beat.since_ms) && beat.since_ms >= 0 ? beat.since_ms : null,
      reason: liveness.REASONS.includes(beat.reason) ? beat.reason : null };
    if (liveness.TERMINATIONS.includes(beat.termination)) out.liveness.termination = beat.termination;
  }
  return out;
}
const PROGRESS_PREFIX = '[forge-sidecar-progress] ';
/** Host-side reader: a progress line back to observation(), or null. Never throws. */
function readProgressLine(line) {
  if (typeof line !== 'string' || !line.startsWith(PROGRESS_PREFIX)) return null;
  try {
    // JSON.parse tolerates the trailing newline that progressLine appends.
    const parsed = JSON.parse(line.slice(PROGRESS_PREFIX.length));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? observation(parsed) : null;
  } catch { return null; }
}
function progressLine(value) {
  return PROGRESS_PREFIX + JSON.stringify(observation(value)) + '\n';
}
module.exports = { diagnostic, isSafeModelId, observation, progressLine, readProgressLine };
