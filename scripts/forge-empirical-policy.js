#!/usr/bin/env node
'use strict';

// Recommendations are a read-only projection. Caller context is never imported
// from a corpus/protocol: in particular approved/authorized fields grant nothing.
const { evaluatePreparation } = require('./forge-entry-assessment');
const { normalizeReviewConfig, decideReview, failOpenOnDiffError } = require('./forge-cost-policy');

const ARMS = Object.freeze(['baseline', 'memory', 'procedure', 'preparation', 'review', 'combined']);
const SAFETY_DIMENSIONS = Object.freeze(['functional', 'tests', 'uat', 'canonical_autonomy']);
const measured = metric => metric && ['observed', 'derived'].includes(metric.state)
  && metric.value !== null && metric.value !== undefined;

// Reject malformed diff rows before decideReview: missing/invalid is not empty.
function validDiff(diff) {
  return diff?.ok === true && Array.isArray(diff.entries) && diff.entries.every(row =>
    row && typeof row.file === 'string' && row.file.trim().length > 0
    && Number.isSafeInteger(row.added) && row.added >= 0
    && Number.isSafeInteger(row.deleted) && row.deleted >= 0 && typeof row.binary === 'boolean');
}

/**
 * Project validated T03 evidence against the configured policies.
 * report: evaluator candidates/cases, with independent dimension states.
 * context: live caller risk/diff/review/assessment, never a report field.
 * Configuration and preparation results are returned exactly as evaluated.
 * A recommendation neither replaces those results nor authorizes their use.
 * Future validation still requires paired outcomes and its own authorization.
 * Unknown cost remains unknown even when review estimates fewer calls.
 * No filesystem writes, preference resolution or provider calls occur here.
 */
function evaluateCandidatePolicies(report, context = {}) {
  const config = normalizeReviewConfig(context.review);
  const diffOk = validDiff(context.diff);
  const review = failOpenOnDiffError(decideReview({ review: context.review,
    entries: diffOk ? context.diff.entries : [], risk: context.risk,
    securityPresent: context.securityPresent, verificationDrift: context.verificationDrift }), context.review, diffOk);
  const preparation = evaluatePreparation(context.assessment, context.assessmentContext);
  const shared = [];
  if (!diffOk) shared.push('diff-unavailable-or-invalid');
  if (context.risk !== 'low') shared.push('risk-not-low');
  if (typeof context.securityPresent !== 'boolean') shared.push('security-state-unknown');
  if (typeof context.verificationDrift !== 'boolean') shared.push('verification-drift-state-unknown');
  if (context.securityPresent) shared.push('security-checklist');
  if (context.verificationDrift) shared.push('verification-drift');
  if (context.pendingDecision || preparation.pendingDecision) shared.push('pending-functional-decision');
  shared.push(...review.risk_signals);
  const configured = { preparation, review, review_config: config };
  const candidates = Array.isArray(report?.candidates) ? report.candidates : [];
  const cases = Array.isArray(report?.cases) ? report.cases : [];
  return { apply_policy: false, authorization: { granted: false }, configured,
    candidates: candidates.map(candidate => {
      const reasons = [...shared];
      if (!ARMS.includes(candidate.arm)) reasons.push('unknown-arm');
      if (candidate.arm === 'baseline') reasons.push('baseline-is-control');
      const rows = cases.filter(row => row.candidate_id === candidate.id && row.split === 'prospective' && !row.synthetic);
      const eligible = rows.filter(row => row.eligible === true);
      if (!eligible.length) reasons.push('zero-eligible-prospective-cases');
      if (!candidate.sample_floor_met) reasons.push('insufficient-independent-sample');
      if (rows.some(row => row.eligible !== true || row.exclusions?.length)) reasons.push('ineligible-or-conflicting-evidence');
      if (rows.some(row => row.failed)) reasons.push('functional-failure');
      const required = new Set([...SAFETY_DIMENSIONS, candidate.policy?.primary_dimension,
        ...Object.keys(candidate.policy?.non_regression || {})]);
      for (const dimension of required) {
        if (!dimension || eligible.some(row => !measured(row.dimensions?.[dimension]))) {
          reasons.push(`coverage-unknown:${dimension || 'primary_dimension'}`);
          continue;
        }
        if (SAFETY_DIMENSIONS.includes(dimension) && eligible.some(row =>
          row.dimensions[dimension].value !== true && row.dimensions[dimension].value !== 1)) {
          reasons.push(`non-regression-not-established:${dimension}`);
        }
      }
      // A measured metric is not a paired treatment effect. No score combines
      // savings with safety, and even a complete sample permits only future work.
      if (!candidate.policy?.primary_dimension || !Object.keys(candidate.policy?.non_regression || {}).length) {
        reasons.push('predeclared-dimensions-missing');
      }
      if (['preparation', 'combined'].includes(candidate.arm) && preparation.preparation !== 'lean') {
        reasons.push('configured-preparation-requires-normal');
      }
      if (['review', 'combined'].includes(candidate.arm) && (config.mode === 'disabled' || config.trigger === 'always')) {
        reasons.push('explicit-review-preference');
      }
      return { id: candidate.id, arm: candidate.arm,
        recommendation: reasons.length ? 'retain-defaults/insufficient-evidence' : 'candidate-for-future-validation',
        reasons: [...new Set(reasons)].sort(), apply_policy: false,
        limitations: ['eligibility-is-not-efficacy', 'paired-non-regression-validation-pending',
          'estimated_calls-is-not-cost', 'existing-authorizations-and-gates-preserved'] };
    }), limitations: ['read-only-no-dispatch-or-configuration-change', 'no-human-acceptance-or-provider-proof'] };
}

module.exports = { evaluateCandidatePolicies };
