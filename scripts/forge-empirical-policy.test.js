#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { evaluateCandidatePolicies } = require('./forge-empirical-policy');
const { evaluatePreparation, captureAssessment } = require('./forge-entry-assessment');
const { decideReview, failOpenOnDiffError, normalizeReviewConfig } = require('./forge-cost-policy');
const clone = value => JSON.parse(JSON.stringify(value));
const metric = value => ({ value, state: 'observed' });
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }
function fixture(arm = 'memory') {
  return { candidates: [{ id: arm, arm, sample_floor_met: true,
    policy: { primary_dimension: 'human_effort', non_regression: { functional: 0, tests: 0 } } }],
  cases: [0, 1].map(i => ({ id: `case-${i}`, delivery_id: `delivery-${i}`, family_id: `family-${i}`,
    candidate_id: arm, split: 'prospective', synthetic: false, eligible: true, exclusions: [], failed: false,
    dimensions: { functional: metric(true), tests: metric(1), uat: metric(true), canonical_autonomy: metric(true), human_effort: metric(30), cost: { value: null, state: 'unknown' } } })) };
}
const context = { risk: 'low', securityPresent: false, verificationDrift: false,
  diff: { ok: true, entries: [{ file: 'scripts/normal.js', added: 2, deleted: 0, binary: false }] } };
const first = (report, ctx = context) => evaluateCandidatePolicies(report, ctx).candidates[0];
test('eligible isolated arms permit future validation only, never apply or cost claims', () => {
  for (const arm of ['memory', 'procedure', 'review']) {
    const result = evaluateCandidatePolicies(fixture(arm), context);
    assert.equal(result.candidates[0].recommendation, 'candidate-for-future-validation');
    assert.equal(result.apply_policy, false); assert.equal(result.authorization.granted, false);
    assert(result.candidates[0].limitations.includes('estimated_calls-is-not-cost'));
    assert(result.candidates[0].limitations.includes('paired-non-regression-validation-pending'));
  }
});
test('zero prospective, insufficient, excluded and conflicting evidence retain defaults', () => {
  for (const mutate of [r => { r.cases = []; }, r => { r.candidates[0].sample_floor_met = false; },
    r => { r.cases[0].eligible = false; r.cases[0].exclusions = ['conflict']; },
    r => { r.cases[0].synthetic = true; r.candidates[0].sample_floor_met = false; },
    r => { r.cases.forEach(row => { row.split = 'historical-diagnostic'; }); }]) {
    const report = fixture(); mutate(report); assert.equal(first(report).recommendation, 'retain-defaults/insufficient-evidence');
  }
});
test('functional regression or unknown safety cannot be offset by apparent savings', () => {
  for (const dimension of ['functional', 'tests', 'uat', 'canonical_autonomy', 'human_effort']) {
    for (const state of ['unknown', 'estimated', 'invalid', 'conflict']) {
      const r = fixture(); r.cases[0].dimensions[dimension] = { value: 0, state };
      assert(first(r).reasons.includes(`coverage-unknown:${dimension}`));
    }
  }
  for (const dimension of ['functional', 'tests', 'uat', 'canonical_autonomy']) {
    const r = fixture(); r.cases[0].dimensions[dimension].value = false;
    r.cases[0].dimensions.human_effort.value = 0;
    assert(first(r).reasons.includes(`non-regression-not-established:${dimension}`));
  }
  const r = fixture(); r.cases[0].failed = true; assert(first(r).reasons.includes('functional-failure'));
});
test('risk security drift sensitive binary and large changes preserve configured behavior', () => {
  const contexts = [{ risk: 'high' }, { risk: 'critical' }, { securityPresent: true }, { verificationDrift: true },
    { diff: { ok: true, entries: [{ file: 'auth.js', added: 1, deleted: 0, binary: false }] } },
    { diff: { ok: true, entries: [{ file: 'image.png', added: 0, deleted: 0, binary: true }] } },
    { diff: { ok: true, entries: [{ file: 'x.js', added: 500, deleted: 0, binary: false }] } }];
  for (const extra of contexts) {
    const ctx = { ...context, ...extra }; const result = evaluateCandidatePolicies(fixture('review'), ctx);
    assert.equal(result.candidates[0].recommendation, 'retain-defaults/insufficient-evidence');
    assert.equal(result.configured.review.decision, 'dialectic');
  }
});
test('absent and invalid security or drift observations never masquerade as observed false', () => {
  for (const key of ['securityPresent', 'verificationDrift']) {
    for (const value of [undefined, null, 0, '', 'false', [], {}]) {
      const result = first(fixture('review'), { ...context, [key]: value });
      assert.equal(result.recommendation, 'retain-defaults/insufficient-evidence');
      assert(result.reasons.includes(key === 'securityPresent' ? 'security-state-unknown' : 'verification-drift-state-unknown'));
    }
  }
});
test('unavailable and invalid diff fails open; explicit disabled and always remain authoritative', () => {
  for (const diff of [undefined, { ok: false, entries: [] }, { ok: true }, { ok: true, entries: [{ file: 'x' }] },
    { ok: true, entries: [{ file: 'x', added: NaN, deleted: 0, binary: false }] }]) {
    for (const review of [{}, { mode: 'disabled' }, { trigger: 'always', style: 'dialectic' }]) {
      const result = evaluateCandidatePolicies(fixture('review'), { ...context, diff, review });
      assert(result.candidates[0].reasons.includes('diff-unavailable-or-invalid'));
      const expected = failOpenOnDiffError(decideReview({ review, entries: [] }), review, false);
      assert.deepEqual(result.configured.review, expected);
      assert.equal(result.configured.review.decision, review.mode === 'disabled' ? 'skip' : review.trigger === 'always' ? 'dialectic' : 'flags');
    }
  }
  for (const review of [{ mode: 'disabled' }, { trigger: 'always' }]) {
    assert(first(fixture('review'), { ...context, review }).reasons.includes('explicit-review-preference'));
  }
});
test('preparation uses actual validator; imported approval and live pending decisions grant nothing', () => {
  const assessment = { approved: true, authorized: true, risk: 'low' };
  const result = evaluateCandidatePolicies(fixture('preparation'), { ...context, assessment, pendingDecision: true });
  assert.deepEqual(result.configured.preparation, evaluatePreparation(assessment));
  assert.equal(result.configured.preparation.preparation, 'normal');
  assert.equal(result.configured.preparation.authorization.granted, false);
  assert(result.candidates[0].reasons.includes('pending-functional-decision'));
  assert(result.candidates[0].reasons.includes('configured-preparation-requires-normal'));
  assert(first(fixture('combined')).reasons.includes('configured-preparation-requires-normal'));
});
test('real low-risk assessment reuses preparation; pending question and source drift retain defaults', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-policy-')));
  try {
    fs.mkdirSync(path.join(root, '.gsd', 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'source.js'), 'module.exports = 1;\n');
    const input = { project: root, intent: 'mudanca', risk: 'low', uncertainty: 'investigated',
      request: 'Correct source message', scope: { localized: true, summary: 'source.js' }, sources: ['source.js'],
      findings: [{ text: 'Single source', source: 'source.js' }],
      alternatives: [{ text: 'Replace flow', tradeoff: 'More changes' }],
      risks: [{ text: 'Changed message', mitigation: 'Verify text' }], decisions: [{ text: 'Keep flow' }], pendingQuestions: [] };
    const assessmentContext = { project: root, request: input.request, scope: 'source.js' };
    const captured = captureAssessment(input); assert.equal(captured.status, 'ok');
    const ctx = { ...context, assessment: captured.assessment, assessmentContext };
    for (const arm of ['preparation', 'combined']) {
      const result = evaluateCandidatePolicies(fixture(arm), ctx);
      assert.equal(result.configured.preparation.preparation, 'lean');
      assert.equal(result.candidates[0].recommendation, 'candidate-for-future-validation');
    }
    const pending = captureAssessment({ ...input, pendingQuestions: [{ text: 'Which text?', required: true }] });
    assert(first(fixture('preparation'), { ...ctx, assessment: pending.assessment }).reasons.includes('pending-functional-decision'));
    fs.writeFileSync(path.join(root, 'source.js'), 'module.exports = 2;\n');
    assert(first(fixture('preparation'), ctx).reasons.includes('configured-preparation-requires-normal'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('arms stay independent and current defaults inputs files and real counters are invariant', () => {
  const r = fixture('review'); const ctx = clone(context); const before = JSON.stringify({ r, ctx });
  const files = ['forge-cost-policy.js', 'forge-entry-assessment.js'];
  const bytes = files.map(file => fs.readFileSync(path.join(__dirname, file)));
  const defaults = normalizeReviewConfig();
  const result = evaluateCandidatePolicies(r, ctx);
  assert.deepEqual(result.configured.review, decideReview({ entries: ctx.diff.entries, risk: 'low' }));
  assert.equal(JSON.stringify({ r, ctx }), before); assert.deepEqual(normalizeReviewConfig(), defaults);
  files.forEach((file, i) => assert.deepEqual(fs.readFileSync(path.join(__dirname, file)), bytes[i]));
  assert.equal(first(fixture('memory')).recommendation, 'candidate-for-future-validation');
  assert.equal(first(fixture('baseline')).recommendation, 'retain-defaults/insufficient-evidence');
  const originalWrite = fs.writeFileSync; const originalAppend = fs.appendFileSync;
  fs.writeFileSync = fs.appendFileSync = () => { throw new Error('unexpected write'); };
  try { evaluateCandidatePolicies(r, ctx); } finally { fs.writeFileSync = originalWrite; fs.appendFileSync = originalAppend; }
});
console.log(`${passed} policy test groups passed`);
