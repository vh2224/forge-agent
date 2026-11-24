#!/usr/bin/env node
'use strict';

// Offline contract checks only. No fixture here calls a transport or writes a receipt.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const api = require('./forge-replay-refusal');
const { TRANSPORT_REFUSAL_CODES } = require('./forge-milestone-time-admission');
const recovery = require('./forge-attempt-recovery');
const prefix = 'replay-refusal-';
let passed = 0;
function test(name, check) {
  check();
  passed++;
  console.log('PASS ' + name);
}
function fixture() {
  return {
    version: 'replay-refusal-v1',
    inspection: { receipt_checked: true, process_stopped: true,
      receipt_sha256: 'a'.repeat(64), phase: 'started',
      valid_saved_response: false, incomplete_execution: false },
    receipt: { phase: 'started', provider_called: 'unknown' },
    replay: { attempted: true, refused: true,
      reason_code: 'sidecar-attempt-interrupted', provider_called: false },
    facts: { identity_matches: true, claim_matches: true,
      pending_questions: [], authority_present: true, failure_class: 'unknown' },
  };
}
function classify(change = () => {}) {
  const input = fixture();
  change(input);
  return api.classifyReplayRefusal(input);
}
function blocked(name, code, change) {
  test(name, () => {
    const result = classify(change);
    assert.equal(result.code, prefix + code);
    assert.equal(result.eligible, false);
    assert.equal(result.class, 'blocking');
  });
}
function frozen(value) {
  if (value && typeof value === 'object') {
    assert(Object.isFrozen(value));
    Object.values(value).forEach(frozen);
  }
}
function symbolSource(site) {
  const [file, symbol] = site.split('#');
  assert.match(file, /^scripts\/forge-[a-z0-9-]+\.js$/);
  const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = new RegExp('^(?:(?:async )?function |const )' + symbol + '\\b', 'm').exec(text);
  assert(start, 'declared symbol exists: ' + site);
  const tail = text.slice(start.index + start[0].length);
  // Canonical producers are top-level declarations; nested declarations are indented.
  const end = /^(?:(?:async )?function |const |module\.exports)/m.exec(tail);
  return start[0] + tail.slice(0, end ? end.index : tail.length);
}

test('T0 closed version and reason-code sets are pinned and deeply frozen', () => {
  assert.equal(api.REFUSAL_SET_VERSION, 'replay-refusal-v1');
  assert.deepEqual(api.KNOWN_VERSIONS, ['replay-refusal-v1']);
  assert.deepEqual(api.OPERATIONAL_CODES, [prefix + 'interrupted-no-output', prefix + 'transport-no-output']);
  assert.deepEqual(api.BLOCKING_CODES, ['inspection-required', 'not-attempted',
    'identity-conflict', 'caller-defect', 'claim-divergent', 'question-pending',
    'authority-missing', 'retained-output', 'partial-continuation', 'time-admission',
    'input-required', 'unknown-code'].map(code => prefix + code));
  assert.deepEqual(api.REASON_CODES, [...api.OPERATIONAL_CODES, ...api.BLOCKING_CODES,
    prefix + 'version-unknown', prefix + 'classification-invalid', prefix + 'input-invalid']);
  frozen(api);
});
test('T1 producer census pins operational codes and literals inside named symbols', () => {
  assert.deepEqual(api.SOURCES[prefix + 'interrupted-no-output'].map(row => row.reason_code),
    ['sidecar-attempt-interrupted']);
  assert.deepEqual(api.SOURCES[prefix + 'transport-no-output'].map(row => row.reason_code),
    ['claude-timeout', 'claude-anomalous-silence', 'claude-exit-nonzero',
      'claude-cancelled', 'appserver-anomalous-silence', 'appserver-exit-nonzero']);
  for (const [code, rows] of Object.entries(api.SOURCES)) {
    for (const row of rows) {
      assert.equal(row.phase, code.endsWith('interrupted-no-output') ? 'started' : 'failed');
      for (const site of row.call_sites) {
        assert(symbolSource(site).includes("'" + row.reason_code + "'"), site + ': literal in declared symbol');
      }
    }
  }
  const interrupted = api.SOURCES[prefix + 'interrupted-no-output'][0];
  assert.deepEqual(interrupted.call_sites, ['scripts/forge-unit-sidecar.js#beginArtifactAttemptInsideOwnerWindow',
    'scripts/forge-unit-sidecar.js#acceptArtifactResultCore', 'scripts/forge-unit-sidecar.js#runUnitSidecarCore']);
  assert(symbolSource('scripts/forge-attempt-recovery.js#inspectReceipt').includes('incomplete_execution: incomplete'));
  const capture = symbolSource('scripts/forge-attempt-recovery.js#captureFailure');
  assert(capture.includes('INPUT_REQUIRED_CODE'));
  assert(capture.includes("'budget-exceeded-while-active'"));
  assert(capture.includes('TRANSPORT_REFUSAL_CODES.includes(code)'));
  const appserver = symbolSource('scripts/forge-appserver-client.js#startAppServerTurn');
  assert(appserver.includes('APPSERVER_LIVENESS_CODES.SILENCE'));
  assert(appserver.includes('timeout after ${seconds}s'));
  // The typed nonzero-exit producer is the close handler, narrow to a real nonzero code (no signal, no zero exit).
  assert(appserver.includes('APPSERVER_EXIT_CODES.NONZERO_EXIT'));
  assert(appserver.includes('!signal && Number.isInteger(code) && code !== 0'));
  const nonzero = api.SOURCES[prefix + 'transport-no-output'].find(row => row.reason_code === 'appserver-exit-nonzero');
  assert.deepEqual([nonzero.phase, nonzero.timeout, nonzero.call_sites], ['failed', false,
    ['scripts/forge-appserver-client.js#APPSERVER_EXIT_CODES']]);
  console.log('CENSUS interruption: started / beginArtifactAttemptInsideOwnerWindow, acceptArtifactResultCore, runUnitSidecarCore');
  console.log('CENSUS transport: claude-timeout, claude-anomalous-silence, claude-exit-nonzero, claude-cancelled / runOwnedChild; appserver-anomalous-silence / APPSERVER_LIVENESS_CODES -> startAppServerTurn; appserver-exit-nonzero / APPSERVER_EXIT_CODES -> startAppServerTurn close handler');
  console.log('CENSUS remaining failures: dynamic receipt failure reason; unlisted codes stay unknown-code; caller facts block before table; time codes reuse canonical export; appserver untyped timeout is unknown-code');
});
test('T1 time codes reuse canonical list and input-required pins recovery literal', () => {
  assert.equal(recovery.INPUT_REQUIRED_CODE, 'appserver-input-required');
  const moduleSource = fs.readFileSync(path.join(__dirname, 'forge-replay-refusal.js'), 'utf8');
  assert(moduleSource.includes("require('./forge-milestone-time-admission').TRANSPORT_REFUSAL_CODES"));
  assert(!moduleSource.includes('milestone-budget-exhausted'));
  for (const code of TRANSPORT_REFUSAL_CODES) {
    assert.equal(classify(input => { input.replay.reason_code = code; }).code, prefix + 'time-admission');
  }
  assert.equal(classify(input => { input.replay.reason_code = recovery.INPUT_REQUIRED_CODE; }).code,
    prefix + 'input-required');
});
test('T2 interrupted-no-output positive requires all observations', () => {
  const result = classify();
  assert.equal(result.code, prefix + 'interrupted-no-output');
  assert.equal(result.eligible, true);
  assert.equal(api.isEligible(result), true);
});
test('T2 transport-no-output positives require matching failed phase and failure code', () => {
  for (const row of api.SOURCES[prefix + 'transport-no-output']) {
    const result = classify(input => {
      input.receipt = { phase: 'failed', failure: { reason_code: row.reason_code, provider_called: true } };
      input.inspection.phase = 'failed';
      input.replay.reason_code = row.reason_code;
    });
    assert.equal(result.code, prefix + 'transport-no-output');
    assert.equal(result.provider_called, true);
    assert.equal(result.evidence.replay_provider_called, false);
  }
});
blocked('T2 receipt_checked removed', 'inspection-required', input => { delete input.inspection.receipt_checked; });
blocked('T2 process_stopped removed', 'inspection-required', input => { delete input.inspection.process_stopped; });
blocked('T3 isolated interruption with live process', 'inspection-required', input => { input.inspection.process_stopped = false; });
blocked('T2 canonical replay not attempted', 'not-attempted', input => { input.replay.attempted = false; });
blocked('T2 canonical replay not refused', 'not-attempted', input => { input.replay.refused = false; });
blocked('T2 canonical replay called provider', 'not-attempted', input => { input.replay.provider_called = true; });
blocked('T2 canonical replay provider unknown', 'not-attempted', input => { delete input.replay.provider_called; });
blocked('T2 identity mismatch', 'identity-conflict', input => { input.facts.identity_matches = false; });
blocked('T2 identity observation absent', 'identity-conflict', input => { delete input.facts.identity_matches; });
blocked('T2 caller defect', 'caller-defect', input => { input.facts.failure_class = 'caller'; });
blocked('T2 claim mismatch', 'claim-divergent', input => { input.facts.claim_matches = false; });
blocked('T2 claim observation absent', 'claim-divergent', input => { delete input.facts.claim_matches; });
blocked('T2 pending question', 'question-pending', input => { input.facts.pending_questions = [{ id: 'pending' }]; });
blocked('T2 pending questions observation absent', 'question-pending', input => { delete input.facts.pending_questions; });
blocked('T2 missing authority', 'authority-missing', input => { input.facts.authority_present = false; });
blocked('T2 authority observation absent', 'authority-missing', input => { delete input.facts.authority_present; });
blocked('T2 missing receipt hash', 'inspection-required', input => { delete input.inspection.receipt_sha256; });
blocked('T2 retained receipt question', 'question-pending', input => { input.receipt.pending_questions = ['pending']; });
blocked('T2 malformed receipt question observation', 'question-pending', input => { input.receipt.pending_questions = {}; });
for (const phase of ['ready', 'executed']) {
  blocked('T3 retained phase ' + phase, 'retained-output', input => {
    input.receipt.phase = phase;
    input.inspection.phase = phase;
  });
}
for (const field of ['saved_candidate', 'returned_response']) {
  blocked('T3 retained ' + field, 'retained-output', input => { input.receipt[field] = { raw: 'secret' }; });
}
blocked('T2 inspected valid saved response', 'retained-output', input => { input.inspection.valid_saved_response = true; });
blocked('T2 saved response observation absent', 'retained-output', input => { delete input.inspection.valid_saved_response; });
blocked('T2 inspected retained output', 'retained-output', input => { input.inspection.retained_output = true; });
blocked('T2 incomplete execution', 'partial-continuation', input => { input.inspection.incomplete_execution = true; });
blocked('T2 incomplete execution observation absent', 'partial-continuation', input => { delete input.inspection.incomplete_execution; });
blocked('T2 active budget cut', 'partial-continuation', input => { input.replay.reason_code = 'budget-exceeded-while-active'; });
blocked('T2 phase not censused', 'unknown-code', input => {
  input.receipt.phase = 'failed';
  input.inspection.phase = 'failed';
});
blocked('T2 conflicting inspected phase', 'inspection-required', input => { input.inspection.phase = 'failed'; });
blocked('T2 failed source code mismatch', 'unknown-code', input => {
  input.receipt = { phase: 'failed', failure: { reason_code: 'claude-timeout' } };
  input.inspection.phase = 'failed';
  input.replay.reason_code = 'claude-exit-nonzero';
});
blocked('T3 unknown source code', 'unknown-code', input => { input.replay.reason_code = 'fabricated-timeout'; });
const nonzeroExit = (input, code = 'appserver-exit-nonzero') => {
  input.receipt = { phase: 'failed', failure: { reason_code: code } };
  input.inspection.phase = 'failed';
  input.replay.reason_code = code;
};
test('T3 typed app-server nonzero exit is operational only through the full gates', () => {
  const result = classify(input => nonzeroExit(input));
  assert.equal(result.code, prefix + 'transport-no-output');
  assert.equal(result.eligible, true);
  assert.equal(result.source_reason_code, 'appserver-exit-nonzero');
  assert.equal(result.timeout_cause, undefined, 'a nonzero exit is not a timeout');
  assert.equal(api.validateClassification(result), true);
  assert.equal(api.isEligible(result), true);
  // The code alone never grants eligibility: every independent gate still blocks first.
  for (const [name, change, code] of [
    ['process not stopped', input => { input.inspection.process_stopped = false; }, 'inspection-required'],
    ['replay not attempted', input => { input.replay.attempted = false; }, 'not-attempted'],
    ['identity conflict', input => { input.facts.identity_matches = false; }, 'identity-conflict'],
    ['claim divergent', input => { input.facts.claim_matches = false; }, 'claim-divergent'],
    ['question pending', input => { input.facts.pending_questions = ['q']; }, 'question-pending'],
    ['authority missing', input => { input.facts.authority_present = false; }, 'authority-missing'],
    ['retained output', input => { input.receipt.returned_response = { content: 'x' }; }, 'retained-output'],
    ['incomplete execution', input => { input.inspection.incomplete_execution = true; }, 'partial-continuation'],
    ['caller defect', input => { input.facts.failure_class = 'caller'; }, 'caller-defect'],
  ]) {
    const blockedResult = classify(input => { nonzeroExit(input); change(input); });
    assert.equal(blockedResult.code, prefix + code, name);
    assert.equal(blockedResult.eligible, false, name);
  }
  // The receipt failure must carry the same typed code as the replay refusal.
  assert.equal(classify(input => { nonzeroExit(input); input.receipt.failure.reason_code = 'claude-exit-nonzero'; }).code, prefix + 'unknown-code');
});
test('T3 generic sidecar-unit-failed and untyped exits stay blocking unknown', () => {
  assert(!JSON.stringify(api.SOURCES).includes('sidecar-unit-failed'), 'the generic unit-sidecar fallback is never a census source');
  for (const code of ['sidecar-unit-failed', 'app-server-exited', 'appserver-exit', 'appserver-exit-signal']) {
    const result = classify(input => nonzeroExit(input, code));
    assert.equal(result.code, prefix + 'unknown-code', code);
    assert.equal(result.eligible, false, code);
    assert.equal(result.source_reason_code, null, code);
  }
  assert.equal(classify(input => { nonzeroExit(input, 'appserver-exit-nonzero'); input.receipt.failure.reason_code = 'sidecar-unit-failed'; }).code,
    prefix + 'unknown-code', 'typed replay code with the generic receipt fallback is not eligible');
});
test('T3 timeout has indeterminate cause and classification uses only census', () => {
  const result = classify(input => {
    input.receipt = { phase: 'failed', failure: { reason_code: 'claude-timeout' } };
    input.inspection.phase = 'failed';
    input.replay.reason_code = 'claude-timeout';
  });
  assert.equal(result.timeout_cause, 'indeterminate');
  assert.equal(result.code, prefix + 'transport-no-output');
  assert.equal(classify(input => { input.replay.reason_code = 'timeout'; }).code, prefix + 'unknown-code');
  console.log('TIMEOUT claude-timeout -> transport-no-output / indeterminate; appserver starting deadline (no typed code), fabricated-timeout -> unknown-code; active ceiling -> partial-continuation');
});
test('T3 observed unknown or untyped timeout stays blocking and preserves provider tri-state', () => {
  for (const reasonCode of [undefined, 'attempt-failed', 'fabricated-timeout', 'worker-timed-out']) {
    for (const provider of [true, false, 'unknown', undefined]) {
      const result = classify(input => {
        input.receipt = { phase: 'failed', failure: {} };
        if (reasonCode !== undefined) input.receipt.failure.reason_code = reasonCode;
        if (provider !== undefined) input.receipt.failure.provider_called = provider;
        input.inspection.phase = 'failed';
        input.replay.reason_code = reasonCode;
        input.facts.failure_class = 'timeout';
      });
      assert.equal(result.code, prefix + 'unknown-code');
      assert.equal(result.eligible, false);
      assert.equal(result.class, 'blocking');
      assert.equal(result.source_reason_code, null);
      assert.equal(result.evidence.receipt_reason_code, null);
      assert.equal(result.evidence.failure_class, 'timeout');
      assert.equal(result.timeout_cause, 'indeterminate');
      assert.equal(result.provider_called, provider === undefined ? 'unknown' : provider);
      assert.equal(result.evidence.replay_provider_called, false);
      assert.equal(api.validateClassification(result), true);
      assert.equal(api.isEligible(result), false);
      frozen(result);
    }
  }
});
test('T3 timeout-like text without observation never adds timeout evidence or eligibility', () => {
  for (const reasonCode of ['timeout', 'fabricated-timeout', 'worker-timed-out', 'timeout after 60s']) {
    for (const failureClass of [undefined, 'unknown', 'service', 'free-form-timeout']) {
      const result = classify(input => {
        input.receipt = { phase: 'failed', failure: { reason_code: reasonCode } };
        input.inspection.phase = 'failed';
        input.replay.reason_code = reasonCode;
        input.facts.failure_class = failureClass;
        input.replay.diagnostic = { reason: 'timeout', timeout_cause: 'unavailable' };
      });
      assert.equal(result.code, prefix + 'unknown-code');
      assert.equal(result.eligible, false);
      assert.equal(result.source_reason_code, null);
      assert.equal(result.evidence.receipt_reason_code, null);
      assert.equal(Object.hasOwn(result, 'timeout_cause'), false);
      assert.equal(api.validateClassification(result), true);
    }
  }
});
test('T3 observed timeout annotation preserves earlier blocking precedence', () => {
  for (const [code, change] of [
    ['inspection-required', input => { input.inspection.process_stopped = false; }],
    ['not-attempted', input => { input.replay.attempted = false; }],
    ['question-pending', input => { input.facts.pending_questions = ['pending']; }],
    ['retained-output', input => { input.receipt.saved_candidate = {}; }],
  ]) {
    const result = classify(input => {
      input.facts.failure_class = 'timeout';
      input.replay.reason_code = 'untyped-timeout';
      change(input);
    });
    assert.equal(result.code, prefix + code);
    assert.equal(result.eligible, false);
    assert.equal(result.timeout_cause, 'indeterminate');
    assert.equal(api.validateClassification(result), true);
  }
});
test('T5 validator binds timeout cause to closed failure observation or census', () => {
  const result = classify(input => {
    input.facts.failure_class = 'timeout';
    delete input.replay.reason_code;
  });
  assert.equal(api.validateClassification(result), true);
  assert.equal(result.code, prefix + 'unknown-code');
  assert.equal(result.timeout_cause, 'indeterminate');
  for (const change of [
    value => { delete value.timeout_cause; },
    value => { value.timeout_cause = 'unavailable'; },
    value => { value.timeout_cause = null; },
    value => { value.evidence.failure_class = 'unknown'; },
    value => { value.evidence.failure_class = 'fabricated-timeout'; },
    value => { value.eligible = true; },
    value => { value.evidence.timeout_observed = true; },
  ]) {
    const value = JSON.parse(JSON.stringify(result));
    change(value);
    assert.throws(() => api.validateClassification(value), { code: prefix + 'classification-invalid' });
    assert.equal(api.isEligible(value), false);
  }
  const typed = classify(input => {
    input.receipt = { phase: 'failed', failure: { reason_code: 'claude-timeout' } };
    input.inspection.phase = 'failed';
    input.replay.reason_code = 'claude-timeout';
  });
  assert.equal(api.validateClassification(typed), true);
  const missing = JSON.parse(JSON.stringify(typed));
  delete missing.timeout_cause;
  assert.throws(() => api.validateClassification(missing), { code: prefix + 'classification-invalid' });
});
test('T2 precedence first matching blocker wins for every pair', () => {
  const stages = [
    input => { input.inspection.process_stopped = false; },
    input => { input.replay.attempted = false; },
    input => { input.facts.identity_matches = false; },
    input => { input.facts.failure_class = 'caller'; },
    input => { input.facts.claim_matches = false; },
    input => { input.facts.pending_questions = ['pending']; },
    input => { input.facts.authority_present = false; },
    input => { input.receipt.saved_candidate = {}; },
    input => { input.inspection.incomplete_execution = true; },
    input => { input.replay.reason_code = TRANSPORT_REFUSAL_CODES[0]; },
    input => { input.receipt.failure = { reason_code: recovery.INPUT_REQUIRED_CODE }; },
  ];
  for (let i = 0; i < stages.length; i++) {
    for (let j = i + 1; j < stages.length; j++) {
      const result = classify(input => { stages[i](input); stages[j](input); });
      assert.equal(result.code, api.BLOCKING_CODES[i], 'precedence ' + i + ' before ' + j);
    }
  }
});
test('T4 deterministic frozen sanitized data preserves provider tri-state', () => {
  const secret = 'secret-do-not-leak';
  const input = fixture();
  input.receipt.payload = secret;
  input.receipt.path = 'C:/Users/private-person/secret';
  input.replay.diagnostic = { reason: secret, stderr: input.receipt.path };
  const before = JSON.stringify(input);
  const a = api.classifyReplayRefusal(input), b = api.classifyReplayRefusal(input);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(input), before);
  frozen(a);
  const serialized = JSON.stringify(a);
  for (const denied of [secret, input.receipt.path, 'private-person', 'stderr', 'diagnostic']) {
    assert(!serialized.includes(denied));
  }
  assert.deepEqual(Object.keys(a).sort(), ['version', 'code', 'eligible', 'class',
    'source_reason_code', 'receipt_sha256', 'provider_called', 'evidence'].sort());
  for (const provider of [true, false, 'unknown', undefined]) {
    assert.equal(classify(value => { value.receipt.provider_called = provider; }).provider_called,
      provider === undefined ? 'unknown' : provider);
  }
  assert.equal(classify(value => { value.replay.reason_code = secret; }).source_reason_code, null);
});
test('T1 complete adapter code census defaults unlisted producers to blocking', () => {
  for (const site of ['scripts/forge-claude-sidecar.js#CLAUDE_SIDECAR_REASON_CODES',
    'scripts/forge-appserver-client.js#APPSERVER_LIVENESS_CODES',
    'scripts/forge-appserver-client.js#APPSERVER_TERMINAL_CODES',
    'scripts/forge-appserver-client.js#APPSERVER_EXIT_CODES',
    'scripts/forge-appserver-client.js#APPSERVER_INPUT_CODES']) {
    const codes = [...symbolSource(site).matchAll(/\b[A-Z][A-Z_]+: '([^']+)'/g)].map(match => match[1]);
    assert(codes.length > 0, site);
    for (const code of codes) {
      const result = classify(input => {
        input.receipt = { phase: 'failed', failure: { reason_code: code } };
        input.inspection.phase = 'failed';
        input.replay.reason_code = code;
      });
      const operational = api.SOURCES[prefix + 'transport-no-output'].some(row => row.reason_code === code);
      const expected = operational ? 'transport-no-output' : code === recovery.INPUT_REQUIRED_CODE ? 'input-required'
        : code === 'budget-exceeded-while-active' ? 'partial-continuation' : 'unknown-code';
      assert.equal(result.code, prefix + expected);
      console.log('CENSUS ' + site + ' ' + code + ' -> ' + expected);
    }
  }
});
test('T4 sanitization covers every precedence branch and invalid receipt hash', () => {
  const secret = 'payload-secret-personal-path-C:/Users/private-person';
  for (const change of [
    input => { input.inspection.process_stopped = false; },
    input => { input.replay.attempted = false; },
    input => { input.facts.identity_matches = false; },
    input => { input.facts.failure_class = 'caller'; },
    input => { input.facts.claim_matches = false; },
    input => { input.facts.pending_questions = [secret]; },
    input => { input.facts.authority_present = false; },
    input => { input.receipt.returned_response = { content: secret }; },
    input => { input.inspection.incomplete_execution = true; },
    input => { input.replay.reason_code = TRANSPORT_REFUSAL_CODES[0]; },
    input => { input.replay.reason_code = recovery.INPUT_REQUIRED_CODE; },
    input => { input.replay.reason_code = secret; },
    input => { input.inspection.receipt_sha256 = secret; },
  ]) {
    const input = fixture();
    input.receipt.stderr = secret;
    input.inspection.diagnostic = secret;
    input.replay.diagnostic = { reason: secret };
    change(input);
    const result = api.classifyReplayRefusal(input);
    assert(!JSON.stringify(result).includes(secret));
    assert.equal(api.validateClassification(result), true);
  }
});
test('T6 classification and validation perform zero filesystem or process I/O', () => {
  const childProcess = require('child_process');
  const replaced = [];
  try {
    for (const [target, keys] of [[fs, ['readFileSync', 'writeFileSync', 'appendFileSync', 'statSync', 'lstatSync', 'existsSync']],
      [childProcess, ['spawn', 'spawnSync', 'execSync', 'execFileSync']]]) {
      for (const key of keys) {
        replaced.push([target, key, target[key]]);
        target[key] = () => { throw Error('unexpected I/O: ' + key); };
      }
    }
    assert.equal(api.isEligible(classify()), true);
    assert.equal(classify(input => { input.replay.reason_code = TRANSPORT_REFUSAL_CODES[0]; }).eligible, false);
  } finally {
    for (const [target, key, value] of replaced) target[key] = value;
  }
});
test('T5 validator accepts current strict output and rejects forged schemas', () => {
  const result = classify();
  assert.equal(api.validateClassification(result), true);
  for (const change of [
    value => { value.extra = 'injected'; },
    value => { value[Symbol('extra')] = 'injected'; },
    value => { value.version = 'future'; },
    value => { value.code = 'unknown'; },
    value => { value.eligible = false; },
    value => { value.class = 'blocking'; },
    value => { value.source_reason_code = 'secret'; },
    value => { value.receipt_sha256 = 'path'; },
    value => { value.provider_called = null; },
    value => { value.evidence.extra = 'secret'; },
    value => { value.evidence.receipt_checked = 'true'; },
    value => { value.timeout_cause = 'outage'; },
    value => { delete value.evidence; },
  ]) {
    const value = JSON.parse(JSON.stringify(result));
    change(value);
    assert.throws(() => api.validateClassification(value), { code: prefix + 'classification-invalid' });
    assert.equal(api.isEligible(value), false);
  }
});
test('T0 unknown version and malformed inputs fail with closed errors', () => {
  assert.throws(() => classify(input => { input.version = 'future'; }), { code: prefix + 'version-unknown' });
  for (const value of [null, [], {}, { ...fixture(), inspection: [] }, { ...fixture(), replay: null }]) {
    assert.throws(() => api.classifyReplayRefusal(value), { code: prefix + 'input-invalid' });
  }
});
test('T0 CLI lists closed set and rejects unknown version with exit 2', () => {
  const cli = path.join(__dirname, 'forge-replay-refusal.js');
  const good = spawnSync(process.execPath, [cli, '--list'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(good.status, 0, good.stderr);
  const data = JSON.parse(good.stdout);
  assert.equal(data.REFUSAL_SET_VERSION, api.REFUSAL_SET_VERSION);
  assert.deepEqual(data.SOURCES, api.SOURCES);
  assert.deepEqual(data.REASON_CODES, api.REASON_CODES);
  const bad = spawnSync(process.execPath, [cli, '--list', '--version', 'future'],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(bad.status, 2);
  assert.equal(JSON.parse(bad.stderr).code, prefix + 'version-unknown');
});
console.log('replay-refusal: ' + passed + ' named checks passed; provider invocations: 0 (offline fixtures)');
