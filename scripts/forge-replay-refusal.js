#!/usr/bin/env node
'use strict';

// Classification is DATA, never authority. Abandonment must reclassify live and
// independently revalidate processes, descendants, roots, questions and authority.
// No receipt, process, filesystem or provider is inspected by this classifier.
// Exports: versioned sets, producer census, classifyReplayRefusal,
// validateClassification and isEligible. CLI: --list [--version <version>].
const { deepFreeze } = require('./forge-dispatch-source-guard');
const REFUSAL_SET_VERSION = 'replay-refusal-v1';
const KNOWN_VERSIONS = Object.freeze([REFUSAL_SET_VERSION]);
const OPERATIONAL_CODES = Object.freeze([
  'replay-refusal-interrupted-no-output', 'replay-refusal-transport-no-output',
]);
const BLOCKING_CODES = Object.freeze([
  'replay-refusal-inspection-required', 'replay-refusal-not-attempted',
  'replay-refusal-identity-conflict', 'replay-refusal-caller-defect',
  'replay-refusal-claim-divergent', 'replay-refusal-question-pending',
  'replay-refusal-authority-missing', 'replay-refusal-retained-output',
  'replay-refusal-partial-continuation', 'replay-refusal-time-admission',
  'replay-refusal-input-required', 'replay-refusal-unknown-code',
]);
const REASON_CODES = Object.freeze([...OPERATIONAL_CODES, ...BLOCKING_CODES,
  'replay-refusal-version-unknown', 'replay-refusal-classification-invalid',
  'replay-refusal-input-invalid']);

// Closed census, not a heuristic over error messages. Dynamic failure codes not
// listed here remain blocking. These call sites are checked against CODE_DIR.
// App-server's starting deadline has a message but NO typed timeout code; it is
// deliberately absent. A timeout is not evidence that a destination is unavailable.
const SOURCES = deepFreeze({
  'replay-refusal-interrupted-no-output': [{
    reason_code: 'sidecar-attempt-interrupted', phase: 'started', timeout: false,
    call_sites: ['scripts/forge-unit-sidecar.js#beginArtifactAttemptInsideOwnerWindow',
      'scripts/forge-unit-sidecar.js#acceptArtifactResultCore',
      'scripts/forge-unit-sidecar.js#runUnitSidecarCore'],
  }],
  'replay-refusal-transport-no-output': [
    { reason_code: 'claude-timeout', phase: 'failed', timeout: true,
      call_sites: ['scripts/forge-claude-sidecar.js#runOwnedChild'] },
    { reason_code: 'claude-anomalous-silence', phase: 'failed', timeout: true,
      call_sites: ['scripts/forge-claude-sidecar.js#runOwnedChild'] },
    { reason_code: 'claude-exit-nonzero', phase: 'failed', timeout: false,
      call_sites: ['scripts/forge-claude-sidecar.js#runOwnedChild'] },
    { reason_code: 'claude-cancelled', phase: 'failed', timeout: false,
      call_sites: ['scripts/forge-claude-sidecar.js#runOwnedChild'] },
    { reason_code: 'appserver-anomalous-silence', phase: 'failed', timeout: true,
      call_sites: ['scripts/forge-appserver-client.js#APPSERVER_LIVENESS_CODES'] },
    // Typed nonzero exit of the app-server child (close handler). The generic
    // `sidecar-unit-failed` fallback of the unit sidecar is NOT a source: it covers
    // arbitrary caller errors and stays blocking `replay-refusal-unknown-code`.
    { reason_code: 'appserver-exit-nonzero', phase: 'failed', timeout: false,
      call_sites: ['scripts/forge-appserver-client.js#APPSERVER_EXIT_CODES'] },
  ],
});
const SOURCE_ROWS = Object.entries(SOURCES).flatMap(([code, rows]) => rows.map(row => ({ code, ...row })));
const FAILURE_CLASSES = Object.freeze(['caller', 'timeout', 'silence', 'service', 'unknown', 'active-budget', 'active-output']);
const INPUT_REQUIRED_CODE = 'appserver-input-required';
const PARTIAL_CODES = Object.freeze(['budget-exceeded-while-active']);
const EVIDENCE_BOOLEANS = Object.freeze(['receipt_checked', 'process_stopped', 'replay_attempted',
  'replay_refused', 'identity_matches', 'caller_defect', 'claim_matches', 'questions_clear',
  'authority_present', 'retained_output', 'incomplete_execution']);
const EVIDENCE_KEYS = Object.freeze([...EVIDENCE_BOOLEANS, 'replay_provider_called',
  'failure_class', 'receipt_reason_code']);
const OUTPUT_KEYS = Object.freeze(['version', 'code', 'eligible', 'class', 'source_reason_code',
  'receipt_sha256', 'provider_called', 'evidence']);
function fail(code) {
  throw Object.assign(new Error(code), { code });
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function sameKeys(value, keys) {
  return object(value) && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function provider(value) {
  return value === true || value === false ? value : 'unknown';
}
function timeCodes() {
  // Lazy to preserve the existing module seam; this is the sole time-code list.
  return require('./forge-milestone-time-admission').TRANSPORT_REFUSAL_CODES;
}
function closedSource(value) {
  return SOURCE_ROWS.some(row => row.reason_code === value) || timeCodes().includes(value)
    || PARTIAL_CODES.includes(value) || value === INPUT_REQUIRED_CODE ? value : null;
}
function receiptHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
}
function assertVersion(version) {
  if (!KNOWN_VERSIONS.includes(version)) fail('replay-refusal-version-unknown');
}

function classifyReplayRefusal(input) {
  if (!object(input)) fail('replay-refusal-input-invalid');
  const { version, inspection, receipt, replay, facts } = input;
  if (![inspection, receipt, replay, facts].every(object)) fail('replay-refusal-input-invalid');
  assertVersion(version);
  const source = closedSource(replay.reason_code);
  const failureSource = closedSource(receipt.failure?.reason_code);
  const retained = ['ready', 'executed'].includes(receipt.phase)
    || ['ready', 'executed'].includes(inspection.phase)
    || !!receipt.saved_candidate || !!receipt.returned_response
    || !!receipt.failure?.returned_response || inspection.valid_saved_response !== false
    || !!inspection.retained_output;
  const evidence = {
    receipt_checked: inspection.receipt_checked === true,
    process_stopped: inspection.process_stopped === true,
    replay_attempted: replay.attempted === true,
    replay_refused: replay.refused === true,
    replay_provider_called: provider(replay.provider_called),
    identity_matches: facts.identity_matches === true,
    caller_defect: facts.failure_class === 'caller',
    claim_matches: facts.claim_matches === true,
    // Missing question observation is not proof that there are no questions.
    questions_clear: Array.isArray(facts.pending_questions) && facts.pending_questions.length === 0
      && [receipt.pending_questions, receipt.input_pending_questions].every(value => value === undefined
        || Array.isArray(value) && value.length === 0),
    authority_present: facts.authority_present === true,
    retained_output: retained,
    incomplete_execution: inspection.incomplete_execution !== false || !!receipt.partialContinuation
      || PARTIAL_CODES.includes(replay.reason_code) || PARTIAL_CODES.includes(receipt.failure?.reason_code)
      || ['active-budget', 'active-output'].includes(facts.failure_class),
    failure_class: FAILURE_CLASSES.includes(facts.failure_class) ? facts.failure_class : 'unknown',
    receipt_reason_code: failureSource,
  };
  const sha = receiptHash(inspection.receipt_sha256);
  let code;
  // The first matching refusal wins. A known code alone never grants eligibility.
  if (!evidence.receipt_checked || !evidence.process_stopped || !sha
      || inspection.phase !== receipt.phase) code = BLOCKING_CODES[0];
  else if (!evidence.replay_attempted || !evidence.replay_refused
      || evidence.replay_provider_called !== false) code = BLOCKING_CODES[1];
  else if (!evidence.identity_matches) code = BLOCKING_CODES[2];
  else if (evidence.caller_defect) code = BLOCKING_CODES[3];
  else if (!evidence.claim_matches) code = BLOCKING_CODES[4];
  else if (!evidence.questions_clear) code = BLOCKING_CODES[5];
  else if (!evidence.authority_present) code = BLOCKING_CODES[6];
  else if (evidence.retained_output) code = BLOCKING_CODES[7];
  else if (evidence.incomplete_execution) code = BLOCKING_CODES[8];
  else if (timeCodes().includes(source) || timeCodes().includes(failureSource)) code = BLOCKING_CODES[9];
  else if (source === INPUT_REQUIRED_CODE || failureSource === INPUT_REQUIRED_CODE) code = BLOCKING_CODES[10];
  else {
    const row = SOURCE_ROWS.find(item => item.reason_code === source && item.phase === receipt.phase
      && (receipt.phase !== 'failed' || failureSource === source));
    code = row?.code || BLOCKING_CODES[11];
  }
  // A live timeout observation annotates uncertainty; only the census above can
  // select an operational source. Untyped/unknown timeouts remain blocking.
  const timeout = evidence.failure_class === 'timeout'
    || SOURCE_ROWS.some(row => row.timeout && [source, failureSource].includes(row.reason_code));
  return deepFreeze({ version, code, eligible: OPERATIONAL_CODES.includes(code),
    class: OPERATIONAL_CODES.includes(code) ? 'operational' : 'blocking', source_reason_code: source,
    receipt_sha256: sha,
    // Original attempt evidence and replay evidence are different observations.
    provider_called: provider(receipt.failure && Object.prototype.hasOwnProperty.call(receipt.failure, 'provider_called')
      ? receipt.failure.provider_called : receipt.provider_called),
    ...(timeout ? { timeout_cause: 'indeterminate' } : {}), evidence });
}

function validateClassification(value) {
  const invalid = () => fail('replay-refusal-classification-invalid');
  const keys = object(value) && Object.prototype.hasOwnProperty.call(value, 'timeout_cause')
    ? [...OUTPUT_KEYS, 'timeout_cause'] : OUTPUT_KEYS;
  if (!sameKeys(value, keys) || value.version !== REFUSAL_SET_VERSION
      || ![...OPERATIONAL_CODES, ...BLOCKING_CODES].includes(value.code)) invalid();
  const eligible = OPERATIONAL_CODES.includes(value.code);
  if (value.eligible !== eligible || value.class !== (eligible ? 'operational' : 'blocking')
      || !(value.source_reason_code === null || closedSource(value.source_reason_code) === value.source_reason_code)
      || !(value.receipt_sha256 === null || receiptHash(value.receipt_sha256))
      || ![true, false, 'unknown'].includes(value.provider_called)
      || !sameKeys(value.evidence, EVIDENCE_KEYS)) invalid();
  const e = value.evidence;
  if (!EVIDENCE_BOOLEANS.every(key => typeof e[key] === 'boolean')
      || ![true, false, 'unknown'].includes(e.replay_provider_called)
      || !FAILURE_CLASSES.includes(e.failure_class)
      || !(e.receipt_reason_code === null || closedSource(e.receipt_reason_code) === e.receipt_reason_code)) invalid();
  const timeout = e.failure_class === 'timeout' || SOURCE_ROWS.some(row => row.timeout
    && [value.source_reason_code, e.receipt_reason_code].includes(row.reason_code));
  if (timeout ? value.timeout_cause !== 'indeterminate' : keys.includes('timeout_cause')) invalid();
  if (eligible && (!value.receipt_sha256 || !e.receipt_checked || !e.process_stopped
      || !e.replay_attempted || !e.replay_refused || e.replay_provider_called !== false
      || !e.identity_matches || e.caller_defect || !e.claim_matches || !e.questions_clear
      || !e.authority_present || e.retained_output || e.incomplete_execution
      || !SOURCES[value.code].some(row => row.reason_code === value.source_reason_code)
      || value.code === OPERATIONAL_CODES[1] && e.receipt_reason_code !== value.source_reason_code
      || timeCodes().includes(e.receipt_reason_code) || e.receipt_reason_code === INPUT_REQUIRED_CODE)) invalid();
  return true;
}
function isEligible(value) {
  try { return validateClassification(value) && value.eligible; }
  catch { return false; }
}

module.exports = deepFreeze({ REFUSAL_SET_VERSION, KNOWN_VERSIONS, OPERATIONAL_CODES,
  BLOCKING_CODES, SOURCES, REASON_CODES, classifyReplayRefusal, validateClassification, isEligible });

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (!(args.length === 1 && args[0] === '--list')
        && !(args.length === 3 && args[0] === '--list' && args[1] === '--version')) {
      fail('replay-refusal-input-invalid');
    }
    assertVersion(args.length === 3 ? args[2] : REFUSAL_SET_VERSION);
    process.stdout.write(JSON.stringify({ REFUSAL_SET_VERSION, KNOWN_VERSIONS,
      OPERATIONAL_CODES, BLOCKING_CODES, SOURCES, REASON_CODES }) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ code: REASON_CODES.includes(error.code)
      ? error.code : 'replay-refusal-input-invalid' }) + '\n');
    process.exitCode = 2;
  }
}
