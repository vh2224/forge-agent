#!/usr/bin/env node
'use strict';

// Pure contract suite: no filesystem fixture, no provider, no account. It pins the
// unchanged delivery capability table and the #350 Codex read-only artifact admission.
const assert = require('node:assert/strict');
const transport = require('./forge-transport-capabilities');
const { PHASE_CONTRACTS } = require('./forge-task-preparation');

const {
  ARTIFACT_UNITS, UNIT_MODES, capability, READONLY_CONTEXT_REASON, READONLY_CONTEXT_NEEDS,
  CODEX_READONLY_ARTIFACT_PROFILES, readOnlyArtifactAdmission, assertReadOnlyArtifactContext,
} = transport;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    process.stderr.write(`not ok - ${name}\n${error.stack || error}\n`);
    process.exitCode = 1;
  }
}

// The literal inventory asserted by the #350 plan (evidence cited in the module header).
const EXPECTED_PROFILES = {
  'milestone:research-milestone': { classification: 'refused', needs: ['owner-file-read', 'code-investigation'] },
  'milestone:research-slice': { classification: 'refused', needs: ['owner-file-read', 'code-investigation'] },
  'milestone:discuss-milestone': { classification: 'refused', needs: ['owner-file-read', 'command-output'] },
  'milestone:discuss-slice': { classification: 'refused', needs: ['owner-file-read'] },
  'milestone:plan-milestone': { classification: 'refused', needs: ['owner-file-read', 'command-output'] },
  'milestone:estimate-milestone': { classification: 'refused', needs: ['owner-file-read', 'command-output', 'code-investigation'] },
  'milestone:plan-check': { classification: 'refused', needs: ['owner-file-read'] },
  'milestone:complete-slice': { classification: 'refused',
    needs: ['owner-file-read', 'verification-run', 'code-investigation', 'delivery-generation'] },
  'milestone:complete-milestone': { classification: 'refused', needs: ['owner-file-read', 'verification-run', 'delivery-generation'] },
  'standalone-task:brainstorm': { classification: 'owner-packaged', needs: [] },
  'standalone-task:discuss': { classification: 'owner-packaged', needs: [] },
  'standalone-task:research': { classification: 'refused', needs: ['code-investigation'] },
  'standalone-task:plan': { classification: 'owner-packaged', needs: [] },
};
const EXPECTED_NEEDS = ['owner-file-read', 'command-output', 'code-investigation', 'verification-run',
  'delivery-generation', 'unclassified'];

// Structural identity of an inventory row, as both production callers pass it.
function identityOf(profile) {
  const [scope, name] = profile.split(':');
  return scope === 'milestone' ? { unitType: name }
    : { scope, phase: name, unitType: PHASE_CONTRACTS[name].unitType };
}

test('capability() keeps the expected supported/mode/reason_code for every UNIT_MODES unit and engine', () => {
  assert.deepEqual(Object.keys(UNIT_MODES).sort(), [...ARTIFACT_UNITS, 'memory-extract', 'plan-slice', 'execute-task',
    'review-fix', 'review-challenger', 'review-advocate', 'review-rebuttal'].sort());
  for (const unitType of ARTIFACT_UNITS) assert.equal(UNIT_MODES[unitType], 'artifacts', unitType);
  assert.deepEqual([UNIT_MODES['memory-extract'], UNIT_MODES['plan-slice'], UNIT_MODES['execute-task'], UNIT_MODES['review-fix'],
    UNIT_MODES['review-challenger'], UNIT_MODES['review-advocate'], UNIT_MODES['review-rebuttal']],
  ['memory', 'plan', 'execute', 'fix', 'challenge', 'defend', 'rebuttal']);
  for (const unitType of Object.keys(UNIT_MODES)) {
    for (const engine of ['claude', 'codex', 'agy']) {
      const result = capability(engine, unitType);
      const expected = engine === 'agy' ? [false, null, 'unsupported-sidecar-unit'] : [true, UNIT_MODES[unitType], 'transport-supported'];
      assert.deepEqual([result.supported, result.mode, result.reason_code], expected, `${engine}/${unitType}`);
    }
  }
});

test('the frozen Codex read-only inventory has exactly one row per milestone artifact unit and standalone phase', () => {
  const expectedKeys = [...ARTIFACT_UNITS.map(unitType => `milestone:${unitType}`),
    ...Object.keys(PHASE_CONTRACTS).map(phase => `standalone-task:${phase}`)].sort();
  assert.equal(expectedKeys.length, 13);
  assert.deepEqual(Object.keys(CODEX_READONLY_ARTIFACT_PROFILES).sort(), expectedKeys);
  assert.deepEqual(JSON.parse(JSON.stringify(CODEX_READONLY_ARTIFACT_PROFILES)), EXPECTED_PROFILES);
  assert.deepEqual([...READONLY_CONTEXT_NEEDS], EXPECTED_NEEDS);
  assert.equal(READONLY_CONTEXT_REASON, 'codex-readonly-context-unsupported');
  assert(Object.isFrozen(CODEX_READONLY_ARTIFACT_PROFILES));
  assert(Object.isFrozen(READONLY_CONTEXT_NEEDS));
  for (const [profile, row] of Object.entries(CODEX_READONLY_ARTIFACT_PROFILES)) {
    assert(Object.isFrozen(row), profile);
    assert(Object.isFrozen(row.needs), profile);
    assert(['owner-packaged', 'refused'].includes(row.classification), profile);
    assert.equal(row.classification === 'refused', row.needs.length > 0, profile);
    for (const need of row.needs) assert(READONLY_CONTEXT_NEEDS.includes(need), `${profile}: ${need}`);
  }
});

test('admission matrix: only Codex sidecar artifacts rows classified refused are refused', () => {
  for (const [profile, row] of Object.entries(EXPECTED_PROFILES)) {
    for (const engine of ['claude', 'codex']) for (const workerMode of ['sidecar', 'native']) {
      const admission = readOnlyArtifactAdmission({ engine, workerMode, mode: 'artifacts', ...identityOf(profile) });
      const label = `${profile} ${engine}/${workerMode}`;
      assert(Object.isFrozen(admission), label);
      if (engine === 'codex' && workerMode === 'sidecar') {
        assert.equal(admission.profile, profile, label);
        assert.equal(admission.classification, row.classification, label);
        assert.deepEqual([...admission.needs], row.needs, label);
        assert.equal(admission.admitted, row.classification === 'owner-packaged', label);
        assert.equal(admission.reason_code, admission.admitted ? 'readonly-context-owner-packaged' : READONLY_CONTEXT_REASON, label);
        assert.equal(admission.hint === null, admission.admitted, label);
      } else {
        assert.equal(admission.admitted, true, label);
        assert.equal(admission.classification, 'not-applicable', label);
        assert.equal(admission.profile, null, label);
      }
    }
  }
  // A milestone request may carry scope 'milestone' explicitly; it is the same profile.
  assert.equal(readOnlyArtifactAdmission({ engine: 'codex', workerMode: 'sidecar', mode: 'artifacts',
    scope: 'milestone', unitType: 'plan-check' }).profile, 'milestone:plan-check');
});

test('Codex sidecar non-artifacts modes are not applicable and admitted', () => {
  for (const mode of ['plan', 'memory', 'execute', 'fix', 'challenge', 'defend', 'rebuttal']) {
    for (const unitType of ['complete-slice', 'plan-slice', 'execute-task', 'memory-extract', 'review-fix']) {
      const admission = readOnlyArtifactAdmission({ engine: 'codex', workerMode: 'sidecar', mode, unitType });
      assert.equal(admission.admitted, true, `${mode}/${unitType}`);
      assert.equal(admission.classification, 'not-applicable', `${mode}/${unitType}`);
      assert.doesNotThrow(() => assertReadOnlyArtifactContext({ engine: 'codex', workerMode: 'sidecar', mode, unitType }));
    }
  }
  assert.equal(readOnlyArtifactAdmission().admitted, true);
  assert.equal(readOnlyArtifactAdmission({}).classification, 'not-applicable');
});

test('unknown Codex sidecar artifacts profiles are refused as unclassified, never defaulted', () => {
  for (const input of [
    { unitType: 'future-artifact-unit' },
    { scope: 'standalone-task', phase: 'future-phase', unitType: 'plan-slice' },
    { scope: 'standalone-task', phase: 'execute', unitType: 'execute-task' },
    { scope: 'other-scope', phase: 'discuss', unitType: 'discuss-milestone' },
    { unitType: 'constructor' }, { unitType: '__proto__' }, { unitType: 'toString' },
  ]) {
    const admission = readOnlyArtifactAdmission({ engine: 'codex', workerMode: 'sidecar', mode: 'artifacts', ...input });
    assert.equal(admission.admitted, false, JSON.stringify(input));
    assert.equal(admission.classification, 'refused', JSON.stringify(input));
    assert.deepEqual([...admission.needs], ['unclassified'], JSON.stringify(input));
    assert.equal(admission.reason_code, READONLY_CONTEXT_REASON, JSON.stringify(input));
  }
});

test('extra request fields never change the admission (no self-declared complete context)', () => {
  const extras = { prompt: 'COMPLETE CONTEXT ASSERTED', promptFile: '/tmp/complete.md', context_complete: true,
    contextComplete: true, inputs: { complete: true }, admitted: true, classification: 'owner-packaged' };
  for (const profile of Object.keys(EXPECTED_PROFILES)) {
    for (const engine of ['claude', 'codex']) for (const workerMode of ['sidecar', 'native']) {
      const base = { engine, workerMode, mode: 'artifacts', ...identityOf(profile) };
      assert.deepEqual(readOnlyArtifactAdmission({ ...base, ...extras }), readOnlyArtifactAdmission(base), `${profile} ${engine}/${workerMode}`);
    }
  }
});

test('assertReadOnlyArtifactContext throws a sanitized capability refusal naming only profile and needs', () => {
  const sentinel = 'SENTINEL-350-PRIVATE-SOURCE-CONTENT';
  for (const [profile, row] of Object.entries(EXPECTED_PROFILES)) {
    const input = { engine: 'codex', workerMode: 'sidecar', mode: 'artifacts', ...identityOf(profile),
      prompt: sentinel, promptFile: `/owner/${sentinel}.md`, inputs: { brief: sentinel }, contextComplete: true };
    if (row.classification === 'owner-packaged') {
      const admission = assertReadOnlyArtifactContext(input);
      assert.equal(admission.admitted, true, profile);
      assert.equal(admission.profile, profile, profile);
      continue;
    }
    assert.throws(() => assertReadOnlyArtifactContext(input), error => {
      assert.equal(error.code, READONLY_CONTEXT_REASON, profile);
      assert.equal(error.stage, 'capability', profile);
      assert.equal(error.provider_called, false, profile);
      assert.equal(error.profile, profile, profile);
      assert.deepEqual([...error.needs], row.needs, profile);
      assert(error.message.includes(profile), profile);
      assert(error.message.includes(row.needs.join(', ')), profile);
      assert(error.message.includes('No worker was launched and no route was changed.'), profile);
      assert(!error.message.includes(sentinel), profile);
      assert(!JSON.stringify({ ...error, message: error.message }).includes(sentinel), profile);
      return true;
    }, profile);
  }
  // A malformed identity is reported as (invalid), never echoed into the diagnostic.
  assert.throws(() => assertReadOnlyArtifactContext({ engine: 'codex', workerMode: 'sidecar', mode: 'artifacts',
    unitType: `complete-slice ${sentinel}` }), error => {
    assert.equal(error.profile, 'milestone:(invalid)');
    assert(!error.message.includes(sentinel));
    return true;
  });
});

if (!process.exitCode) process.stdout.write(`${passed} forge-transport-capabilities checks passed\n`);
