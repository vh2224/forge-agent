#!/usr/bin/env node
'use strict';

// Standalone contract suite for environment-claim corroboration.

const {
  corroborates, checkEnvPromotion,
  splitCommandSegments, attributeNetworkFailure, commandCouldRunCitedTest,
  NETWORK_ATTRIBUTION, ATTRIBUTION_AMBIGUOUS,
} = require('./forge-env-promote.js');

let passes = 0;
let fails = 0;

function assert(value, name, detail) {
  if (value) { passes += 1; process.stdout.write(`  ✓ ${name}\n`); }
  else { fails += 1; process.stdout.write(`  ✗ ${name}${detail ? `: ${detail}` : ''}\n`); }
}

function entry(overrides) {
  return {
    item: 'environment-constrained must-have', status: 'unmet', scope: 'environment',
    reason: 'git-commit-required', note: '', ...overrides,
  };
}

function promotes(value, planText = '') {
  return checkEnvPromotion({ status: 'partial', must_haves_status: [value] }, planText);
}

const m017Note = 'Not run: this test file intentionally invokes git in its existing fixture helper, and the task prohibits running any git command. Static inspection confirms 25 tests.';
const contrafactual = entry({ note: m017Note });
assert(typeof corroborates(contrafactual, '') === 'string' && promotes(contrafactual).promote === false,
  'git mention without a write operation is rejected (M017 contrafactual)');

const honest = entry({ note: 'proving the second revision requires `git commit`; auto_commit:false forbids committing' });
assert(corroborates(honest, '') === null && promotes(honest).promote === true,
  'a genuine required git commit remains accepted');

const washed = entry({ item: 'must run git commit to prove this', note: '' });
assert(typeof corroborates(washed, '') === 'string' && promotes(washed).promote === false,
  'item-only git write evidence is rejected (wash-proof)');

const neighbors = [
  [entry({ reason: 'gsd-write-refused', note: 'refused .gsd/STATE.md' }), '', true],
  [entry({ reason: 'out-of-scope-test-failure', note: 'existing tests/foo.test.js fails' }), 'writes:\n - src/example.js', true],
  [entry({ reason: 'network-required', note: 'must install package from network registry' }), '', true],
  [entry({ reason: 'sandbox-exec-blocked', note: 'ran `npm test`: EPERM: operation not permitted' }), '', true],
];
for (const [neighbor, planText, expected] of neighbors) {
  assert(promotes(neighbor, planText).promote === expected,
    `${neighbor.reason} retains its existing corroboration verdict`);
}

// ── M018 S06/T02: runtime-first corroboration for the promotable reasons ────

function command(overrides) {
  return {
    ts: '2026-08-06T00:00:00.000Z', source: 'codex-runtime', kind: 'command',
    unit: 'execute-task/T02', cmd: 'npm test', cwd: null,
    exit_code: 0, duration_ms: 10, status: 'completed', ...overrides,
  };
}

function withRuntime(value, entries, planText = '', census = {}) {
  return checkEnvPromotion({
    status: 'partial',
    must_haves_status: [value],
    runtime_evidence: {
      census: { outcome: 'collected', items_received: entries.length, types_seen: {}, admitted: entries.length, inadmissible: 0, rejected: [], turn_status: 'completed', ...census },
      entries,
    },
  }, planText);
}

// The heart: same claim, same note — the verdict moves with the observed exit code.
const netClaim = entry({ reason: 'network-required', note: 'must install package from network registry' });

const netRejected = withRuntime(netClaim, [command({ cmd: 'npm test', exit_code: 0 })]);
assert(netRejected.promote === false && /runtime/i.test(netRejected.rejected[0].why),
  'network-required is rejected by observed runtime evidence when no network command failed');

const netAccepted = withRuntime(netClaim, [command({ cmd: 'curl https://registry.npmjs.org/foo', exit_code: 6 })]);
assert(netAccepted.promote === true,
  'network-required is accepted when a network command carries a non-zero exit code');

const netNull = withRuntime(netClaim, [command({ cmd: 'curl https://registry.npmjs.org/foo', exit_code: null })]);
assert(netNull.promote === false,
  'exit_code null never corroborates: it is an observed value, not a failure');

// Named fallback — three distinct state names, never a silent textual accept.
const fbAbsent = promotes(netClaim);
const fbEmpty = withRuntime(netClaim, [{ kind: 'file', path: 'a.js' }]);
const fbFailed = checkEnvPromotion({
  status: 'partial', must_haves_status: [netClaim],
  runtime_evidence: { census: { outcome: 'collector-failed' }, entries: [] },
}, '');

// Read defensively: a missing fallback entry must be REPORTED as a failure, not
// thrown as a TypeError that aborts every assert below it (measured — silencing
// the sink crashed the suite at this line and skipped the git/additivity/DP1
// cases entirely, so one regression hid four others).
const fbName = r => ((r && Array.isArray(r.fallbacks) && r.fallbacks[0]) || {}).fallback || '(none)';

assert(fbAbsent.promote === true && fbName(fbAbsent) === 'not-collected',
  'a result-file with no runtime_evidence falls back to text AND names the fallback', fbName(fbAbsent));
assert(fbEmpty.promote === true && fbName(fbEmpty) === 'no-command-entries',
  'collected-with-zero-command-entries falls back to text under its own name (A4 class (c))', fbName(fbEmpty));
assert(fbFailed.promote === true && fbName(fbFailed) === 'collector-failed',
  'collector-failed falls back to text under its own name', fbName(fbFailed));

const fbNames = [fbAbsent, fbEmpty, fbFailed].map(fbName);
assert(new Set(fbNames).size === 3, 'the three fallback names are pairwise distinct', fbNames.join(','));

// out-of-scope-test-failure keeps BOTH halves: runtime proves (i), text proves (ii).
const oosPlan = 'writes:\n - src/example.js';
const oos = entry({ reason: 'out-of-scope-test-failure', note: 'existing tests/foo.test.js fails' });

const oosInPlan = withRuntime(oos, [command({ cmd: 'npx vitest run tests/foo.test.js', exit_code: 1 })], 'writes:\n - tests/foo.test.js');
assert(oosInPlan.promote === false && oosInPlan.rejected[0].why === 'cited test path appears in planText',
  'out-of-scope-test-failure: half (ii) survives — a cited path inside the plan is still refused');

const oosNoFail = withRuntime(oos, [command({ cmd: 'npx vitest run', exit_code: 0 })], oosPlan);
assert(oosNoFail.promote === false && /runtime/i.test(oosNoFail.rejected[0].why),
  'out-of-scope-test-failure: half (i) is refused by runtime when no runner command failed');

const oosBoth = withRuntime(oos, [command({ cmd: 'npx vitest run tests/foo.test.js', exit_code: 1 })], oosPlan);
assert(oosBoth.promote === true,
  'out-of-scope-test-failure is accepted when the runtime proves (i) and the text proves (ii)');

// sandbox-exec-blocked is untouched: it is measured-gap, never runtime-gated.
const sandbox = entry({ reason: 'sandbox-exec-blocked', note: 'ran `npm test`: EPERM: operation not permitted' });
const sandboxBare = promotes(sandbox);
const sandboxWithRuntime = withRuntime(sandbox, [command({ cmd: 'npm test', exit_code: 1 })]);
assert(JSON.stringify(sandboxBare) === JSON.stringify(sandboxWithRuntime) && sandboxBare.promote === true,
  'sandbox-exec-blocked verdict is byte-identical with and without runtime evidence');

// GIT_WRITE_RE gains the modern alias without losing the TASK-020 contrafactual.
const gitSwitch = entry({ note: 'proving this needs `git switch -c feature` on the slice branch' });
assert(corroborates(gitSwitch, '') === null && promotes(gitSwitch).promote === true,
  'git switch -c is recognised as a git write operation');
assert(promotes(contrafactual).promote === false,
  'the TASK-020 contrafactual is still rejected after the alias is added');

// Additivity (DP7): pre-existing keys survive verbatim; new keys are added only.
const shape = promotes(netClaim);
const preExisting = ['promote', 'env_constraints', 'rejected'];
assert(preExisting.every(key => key in shape), 'the pre-existing checkEnvPromotion key set is intact');
assert(Object.keys(shape).sort().join(',') === [...preExisting, 'fallbacks'].sort().join(','),
  'checkEnvPromotion gained exactly `fallbacks` and lost nothing', Object.keys(shape).join(','));
// `fallbacks` is attached only when non-empty, so a non-promotable reason with no
// fallback keeps its pre-T02 serialisation byte-for-byte (the invariant the
// whole-object guard in forge-smoke.js Section 71 relies on).
const legacyShape = checkEnvPromotion({
  status: 'partial',
  must_haves_status: [entry({ reason: 'gsd-write-refused', item: 'legacy', note: 'refused .gsd/STATE.md' })],
}, '');
assert(JSON.stringify(legacyShape) === JSON.stringify({
  promote: true,
  env_constraints: [{ item: 'legacy', reason: 'gsd-write-refused', note: 'refused .gsd/STATE.md' }],
  rejected: [],
}), 'a no-fallback verdict serialises byte-identically to its pre-T02 shape', JSON.stringify(legacyShape));
const naShape = checkEnvPromotion({ status: 'blocked' }, '');
assert(['promote', 'env_constraints', 'rejected', 'reason'].every(key => key in naShape) && naShape.reason === 'not-applicable',
  'the not-applicable path keeps its pre-existing keys');

// DP1 proof, behavioural rather than textual: flip `network-required` out of
// `promotable` in the coverage module and the runtime gate must STOP applying to
// it. A second literal list in forge-env-promote.js would keep the rejection
// alive and fail this assert — which is what stops the table being decoration.
const coverage = require('./forge-env-coverage.js');
const realPromotable = coverage.promotableReasons;
coverage.promotableReasons = () => realPromotable().filter(r => r !== 'network-required');
const deprived = withRuntime(netClaim, [command({ cmd: 'npm test', exit_code: 0 })]);
coverage.promotableReasons = realPromotable;
assert(deprived.promote === true && fbName(deprived) === '(none)',
  'the runtime-first set is derived from forge-env-coverage: dropping a verdict drops the gate');
assert(withRuntime(netClaim, [command({ cmd: 'npm test', exit_code: 0 })]).promote === false,
  'and the gate is restored once the coverage table is intact (control)');

// ── M018 triage, S06 review R6: segment attribution of a compound failure ───
//
// `exit_code` is a property of the COMPOUND. The measured false accept was
// `curl x && npm test` exiting 1: npm test failed, curl never did, and the
// claim was promoted anyway by a regex tested against the whole string.

assert(splitCommandSegments('cd dir && npm install').length === 2
  && splitCommandSegments('a; b | c || d').length === 4,
  'splitCommandSegments splits on &&, ||, ; and |',
  JSON.stringify(splitCommandSegments('a; b | c || d')));
assert(splitCommandSegments("curl 'a && b'").length === 1,
  'an operator inside quotes is not a segment boundary',
  JSON.stringify(splitCommandSegments("curl 'a && b'")));

const attr = cmd => attributeNetworkFailure(cmd).verdict;
assert(attr('curl https://x') === NETWORK_ATTRIBUTION.ATTRIBUTED,
  'a single network segment is attributable', attr('curl https://x'));
assert(attr('npm install && curl https://x') === NETWORK_ATTRIBUTION.ATTRIBUTED,
  'an all-network chain is attributable whichever member failed', attr('npm install && curl https://x'));
assert(attr('npm test && tsc --noEmit') === NETWORK_ATTRIBUTION.NONE,
  'a chain with no network segment attributes nothing', attr('npm test && tsc --noEmit'));
assert(attr('curl https://x && npm test') === NETWORK_ATTRIBUTION.AMBIGUOUS,
  'a mixed chain is AMBIGUOUS — the exit code does not say which segment failed',
  attr('curl https://x && npm test'));

// The measured false accept, end to end. The note reports a TEST failure, so the
// textual corroborator rejects it; before the fix the runtime promoted it alone.
const compoundClaim = entry({ reason: 'network-required', note: 'npm test exited 1 while the suite ran' });
const compoundFalseAccept = withRuntime(compoundClaim, [command({ cmd: 'curl https://registry.npmjs.org/foo && npm test', exit_code: 1 })]);
assert(compoundFalseAccept.promote === false,
  'R6: `curl x && npm test` failing no longer promotes a claim the text rejects',
  JSON.stringify(compoundFalseAccept));
assert(fbName(compoundFalseAccept) === ATTRIBUTION_AMBIGUOUS,
  'R6: and the uncertainty is NAMED in fallbacks[], never silent', fbName(compoundFalseAccept));

// The shape the conservative fix would have destroyed still works — via the
// textual gate, which is where it lived before any runtime evidence existed.
const installClaim = entry({ reason: 'network-required', note: 'had to run npm install to fetch deps from the registry' });
const installOk = withRuntime(installClaim, [command({ cmd: 'cd packages/app && npm install', exit_code: 1 })]);
assert(installOk.promote === true && fbName(installOk) === ATTRIBUTION_AMBIGUOUS,
  'R6: `cd dir && npm install` survives, and says it was decided textually',
  `${installOk.promote} / ${fbName(installOk)}`);

// ── M018 triage, S05 review R5: the runtime half must reject unrelated runners ─

const oosCited = entry({ reason: 'out-of-scope-test-failure', note: 'existing tests/foo.test.js fails' });

const oosLint = withRuntime(oosCited, [command({ cmd: 'npm run lint', exit_code: 1 })], oosPlan);
assert(oosLint.promote === false && /runtime/i.test(oosLint.rejected[0].why),
  'R5: a failed `npm run lint` no longer corroborates a claim about a test file',
  JSON.stringify(oosLint.rejected));

const oosOtherTest = withRuntime(oosCited, [command({ cmd: 'npx vitest run tests/other.test.js', exit_code: 1 })], oosPlan);
assert(oosOtherTest.promote === false && /runtime/i.test(oosOtherTest.rejected[0].why),
  'R5: a failed run of a DIFFERENT specific test path does not corroborate',
  JSON.stringify(oosOtherTest.rejected));

const oosWholeSuite = withRuntime(oosCited, [command({ cmd: 'npm test', exit_code: 1 })], oosPlan);
assert(oosWholeSuite.promote === true,
  'R5: an unscoped suite run still corroborates — the cited test is inside it',
  JSON.stringify(oosWholeSuite));

assert(commandCouldRunCitedTest('pytest', ['tests/foo.test.js']) === true
  && commandCouldRunCitedTest('pytest tests/other.test.js', ['tests/foo.test.js']) === false
  && commandCouldRunCitedTest('pytest ./tests/foo.test.js', ['tests/foo.test.js']) === true,
  'R5: commandCouldRunCitedTest is unscoped-permissive and specific-strict, normalising ./');

process.stdout.write(`Results: ${passes} passed, ${fails} failed\n`);
process.exitCode = fails ? 1 : 0;
