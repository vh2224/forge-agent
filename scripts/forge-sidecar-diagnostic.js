'use strict';

// Closed vocabulary only. Never persist provider text, paths, JSON parser
// messages, validator exceptions, environment, or classifyReturn().tail.
const REASONS = Object.freeze({
  'output-empty': 'envelope', 'marker-missing': 'envelope',
  'end-marker-missing': 'envelope', 'status-missing': 'envelope',
  'status-invalid': 'envelope', 'result-json-missing': 'envelope',
  'json-invalid': 'json',
  'status-mismatch': 'validation', 'schema-invalid': 'validation',
  'validator-failed': 'validation', 'artifact-path-invalid': 'validation',
  'artifact-duplicate': 'validation', 'artifact-missing': 'validation',
  'artifact-limit': 'validation', 'payload-limit': 'validation',
  'questions-on-done': 'validation', 'secret-output': 'security',
  'control-data-output': 'security', 'output-limit': 'transport',
  'provider-exit': 'transport', 'authentication-failed': 'transport',
  'provider-timeout': 'transport', 'provider-cancelled': 'transport',
  'provider-unavailable': 'transport', 'publication-failed': 'publication',
  'adapter-failed': 'adapter',
});
const COUNTS = ['stdout_bytes', 'stderr_bytes', 'duration_ms', 'marker_count'];
function diagnostic(reason, counts = {}) {
  const safeReason = Object.hasOwn(REASONS, reason) ? reason : 'adapter-failed';
  const value = { version: 1, stage: REASONS[safeReason], reason: safeReason };
  for (const key of COUNTS) {
    if (Number.isSafeInteger(counts[key]) && counts[key] >= 0) value[key] = counts[key];
  }
  return value;
}
module.exports = { diagnostic };
