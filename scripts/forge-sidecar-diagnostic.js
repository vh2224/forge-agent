'use strict';

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
  'adapter-failed': 'adapter',
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
  return value;
}
module.exports = { diagnostic, isSafeModelId };
