#!/usr/bin/env node
'use strict';

// A read-only projection, never an experiment runner or a source of authority.
const fs = require('fs');
const path = require('path');
const { buildEmpiricalBaseline } = require('./forge-empirical-baseline');
const { buildContextComparison } = require('./forge-context-comparison');
const { buildProcedureEvidence } = require('./forge-procedure-evidence');
const { evaluateCandidatePolicies } = require('./forge-empirical-policy');
const { sha256, fingerprint, resolveSafeFile } = require('./forge-delivery');
const { readBoundedStableFile } = require('./forge-autonomy-sources');
const { checkedPath, relativePath, fail } = require('./forge-empirical-sources');

const LIMITS = Object.freeze({ file_bytes: 1048576, total_bytes: 8388608, sources: 100, cases: 100, candidates: 32 });
const DIMENSIONS = Object.freeze(['functional', 'tests', 'uat', 'canonical_autonomy', 'exception',
  'interruptions', 'interventions', 'human_effort', 'duration', 'package_bytes', 'package_tokens',
  'provider_input_tokens', 'provider_output_tokens', 'cost']);
const SPLITS = Object.freeze(['historical-diagnostic', 'adjustment', 'reserved', 'prospective']);
const ARMS = Object.freeze(['baseline', 'memory', 'procedure', 'preparation', 'review', 'combined']);
const CONTROL_FIELDS = Object.freeze(['version', 'component_sha256', 'input_sha256', 'template_sha256',
  'model', 'effort', 'host', 'transport', 'preparation', 'review', 'budgets', 'memory_sha256', 'procedure_sha256']);
const HASH = /^[a-f0-9]{64}$/;
const label = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 1000;
const time = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)$/.test(value)
  && Number.isFinite(Date.parse(value));
const before = (a, b) => time(a) && time(b) && Date.parse(a) < Date.parse(b);
const list = (value, max) => Array.isArray(value) && value.length <= max;
const numbers = value => object(value) && Object.keys(value).length > 0 && Object.entries(value).every(([key, item]) =>
  /^[a-z_]{1,60}$/.test(key) && (typeof item === 'number' ? Number.isFinite(item) && item >= 0 : numbers(item)));
const project = (value, keys) => object(value) ? Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])) : null;
const policyView = value => project(value, ['id', 'arm', 'hypothesis', 'primary_dimension', 'non_regression', 'risk', 'review',
  'rejection_criteria', 'minimum_sample', 'split_sha256', 'declared_at', 'updated_at']);
const metricValid = value => object(value) && (value.value === null || typeof value.value === 'boolean'
  || (typeof value.value === 'number' && Number.isFinite(value.value)))
  && ['observed', 'derived', 'estimated', 'unknown', 'invalid', 'conflict'].includes(value.state)
  && typeof value.unit === 'string' && typeof value.method === 'string'
  && ['numerator', 'denominator'].every(key => value[key] === null || (typeof value[key] === 'number' && Number.isFinite(value[key])))
  && Array.isArray(value.references) && Array.isArray(value.limitations);

// Previous slices publish reports, not their original capture inputs. Replays
// preserve those measurements but cannot establish prospective enrollment.
function readReportReplay(kind, data) {
  if (kind === 'baseline-report') {
    const { digest, generated_at, ...body } = data;
    if (!list(data.cases, LIMITS.cases) || !HASH.test(digest || '') || fingerprint(body) !== digest
        || data.cases.some(row => !label(row.id) || !label(row.delivery_id) || !object(row.dimensions)
          || DIMENSIONS.some(key => !metricValid(row.dimensions[key])) || !Array.isArray(row.diagnostics))) fail('baseline_report_invalid');
  } else if (kind === 'context-report') {
    if (data.kind !== 'technical-context-comparison' || !list(data.cases, LIMITS.cases)
        || data.cases.some(row => !label(row.case_id) || typeof row.comparable !== 'boolean')) fail('context_report_invalid');
  } else if (data.kind !== 'procedure-package-evidence' || typeof data.comparable !== 'boolean'
      || !object(data.before) || !object(data.after)) fail('procedure_report_invalid');
  // Diagnostic replay is explicitly labelled even for an otherwise valid report.
  return { ...data, replay_only: true };
}

function unknown(reason = 'unavailable') {
  return { value: null, unit: 'unknown', state: 'unknown', method: 'unavailable', numerator: null,
    denominator: null, references: [], limitations: [reason] };
}

// Shared by API source reads and the CLI. Root authority is supplied by the
// caller, never read from imported JSON; symlink ancestors and ADS are refused.
function readEvaluationSource(ref, roots, budget) {
  if (!object(ref) || !label(ref.id) || !HASH.test(ref.sha256 || '') || !label(ref.revision)
      || !time(ref.captured_at) || !text(ref.timezone) || typeof ref.synthetic !== 'boolean') fail('source_identity_invalid');
  relativePath(ref.path);
  const resolved = resolveSafeFile(ref.path, roots, { base: roots[0], maxBytes: LIMITS.file_bytes });
  if (resolved.error) fail(resolved.error);
  checkedPath(path.resolve(roots[0], ref.path));
  checkedPath(resolved.path);
  const read = readBoundedStableFile(resolved.path, LIMITS.file_bytes, { expectedReal: resolved.path });
  if (read.error) fail(read.error);
  budget.bytes += read.buffer.length;
  if (budget.bytes > LIMITS.total_bytes) fail('total_bytes_exceeded');
  if (sha256(read.buffer) !== ref.sha256) fail('source_hash_changed');
  return { buffer: read.buffer, path: resolved.path };
}

function validControls(value) {
  return object(value) && CONTROL_FIELDS.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => CONTROL_FIELDS.includes(key))
    && CONTROL_FIELDS.filter(key => key !== 'budgets').every(key => label(value[key]))
    && ['component_sha256', 'input_sha256', 'template_sha256', 'memory_sha256', 'procedure_sha256'].every(key => HASH.test(value[key]))
    && numbers(value.budgets);
}

function policyReasons(policy, candidate, outcomeAt) {
  const reasons = [];
  if (!object(policy) || policy.id !== candidate.id || policy.arm !== candidate.arm) return ['policy_missing_or_mismatched'];
  for (const key of ['hypothesis', 'risk', 'review']) if (!text(policy[key])) reasons.push(`policy_missing:${key}`);
  if (!DIMENSIONS.includes(policy.primary_dimension)) reasons.push('policy_missing:primary_dimension');
  if (!object(policy.non_regression) || !Object.keys(policy.non_regression).length
      || Object.entries(policy.non_regression).some(([key, value]) => !DIMENSIONS.includes(key)
        || typeof value !== 'number' || !Number.isFinite(value) || value < 0)) reasons.push('policy_missing:non_regression');
  if (!list(policy.rejection_criteria, 32) || !policy.rejection_criteria.length || !policy.rejection_criteria.every(text)) reasons.push('policy_missing:rejection_criteria');
  if (!object(policy.minimum_sample) || !Number.isSafeInteger(policy.minimum_sample.deliveries) || policy.minimum_sample.deliveries < 1
      || !Number.isSafeInteger(policy.minimum_sample.families) || policy.minimum_sample.families < 2) reasons.push('policy_missing:minimum_sample');
  if (!HASH.test(policy.split_sha256 || '')) reasons.push('policy_missing:split_sha256');
  if (!before(policy.declared_at, outcomeAt) || !before(policy.updated_at, outcomeAt)) reasons.push('policy_not_prior_to_outcome');
  return reasons;
}

function describeCase(item, candidate, sources, reports) {
  const reasons = [];
  const protocol = sources.get(candidate.protocol_source);
  const outcome = sources.get(item.outcome_source);
  const baseline = sources.get(item.baseline_source);
  const policy = protocol?.data?.candidate;
  const split = protocol?.data?.split;
  const result = outcome?.data;
  const registration = Array.isArray(protocol?.data?.registrations) ? protocol.data.registrations.find(row => row.case_id === item.id) : null;
  const sourceIds = [candidate.protocol_source, item.outcome_source, item.baseline_source,
    item.context_source, item.procedure_source].filter(Boolean);
  for (const id of sourceIds) if (!sources.get(id)?.data) reasons.push(`source_unavailable:${id}`);
  if (protocol?.ref.kind !== 'protocol' || outcome?.ref.kind !== 'outcome' || !['baseline', 'baseline-report'].includes(baseline?.ref.kind)) reasons.push('source_kind_mismatch');
  if (sourceIds.some(id => reports.get(id)?.replay_only)) reasons.push('historical_report_replay_only');
  const synthetic = item.synthetic || sourceIds.some(id => sources.get(id)?.ref.synthetic === true
    || sources.get(id)?.data?.synthetic === true || reports.get(id)?.synthetic === true);
  if (synthetic) reasons.push('synthetic_not_real_sample');
  if (item.split === 'historical-diagnostic') reasons.push('historical_diagnostic_only');
  if (!object(result) || result.case_id !== item.id || !time(result.occurred_at)
      || !['completed', 'failed'].includes(result.status)) reasons.push('outcome_metadata_invalid');
  reasons.push(...policyReasons(policy, candidate, result?.occurred_at));
  if (!object(split) || !Array.isArray(split.adjustment) || !Array.isArray(split.reserved)
      || [...split.adjustment, ...split.reserved].some(id => !label(id))
      || new Set([...split.adjustment, ...split.reserved]).size !== split.adjustment.length + split.reserved.length
      || policy?.split_sha256 !== fingerprint(split) || !before(split.frozen_at, result?.occurred_at)) reasons.push('split_unbound_or_not_prior');
  const expectedSplit = item.split === 'adjustment' ? 'adjustment' : 'reserved';
  if (!Array.isArray(split?.[expectedSplit]) || !split[expectedSplit].includes(item.family_id)) reasons.push('family_split_mismatch');
  if (!registration || registration.family_id !== item.family_id || registration.split !== item.split
      || registration.policy_sha256 !== fingerprint(policy || {}) || !HASH.test(registration.original_input_sha256 || '')
      || !HASH.test(registration.acceptance_sha256 || '') || !before(registration.enrolled_at, result?.occurred_at)
      || !before(policy?.updated_at, registration.enrolled_at) || !before(split?.frozen_at, registration.enrolled_at)) reasons.push('registration_missing_or_not_prior');
  if (!validControls(registration?.controls) || !validControls(result?.controls)
      || fingerprint(registration?.controls || {}) !== fingerprint(result?.controls || {})) reasons.push('executed_controls_unbound');
  if (registration?.original_input_sha256 !== result?.controls?.input_sha256) reasons.push('original_input_unbound');
  const changed = { baseline: [], memory: ['memory_sha256'], procedure: ['procedure_sha256'],
    preparation: ['preparation'], review: ['review'], combined: ['memory_sha256', 'procedure_sha256', 'preparation', 'review'] }[candidate.arm];
  if (!validControls(result?.baseline_controls) || !validControls(result?.controls)
      || CONTROL_FIELDS.filter(key => !changed.includes(key)).some(key => fingerprint(result.baseline_controls[key]) !== fingerprint(result.controls[key]))) reasons.push('non_equivalent_controls');
  if (candidate.arm === 'combined' && (!Array.isArray(result?.isolated_components)
      || !['memory', 'procedure', 'preparation', 'review'].every(key => result.isolated_components.includes(key)))) reasons.push('combined_isolation_unproven');
  const measured = reports.get(item.baseline_source)?.cases?.find(row => row.id === item.baseline_case_id);
  if (!measured || measured.delivery_id !== item.delivery_id) reasons.push('baseline_case_unbound');
  if (measured?.diagnostics?.length) reasons.push('baseline_source_diagnostic');
  if (candidate.arm === 'memory' && !reports.get(item.context_source)?.cases?.find(row => row.case_id === item.id)?.comparable) reasons.push('context_control_unavailable');
  if (candidate.arm === 'procedure' && !reports.get(item.procedure_source)?.comparable) reasons.push('procedure_control_unavailable');
  if (item.context_source && !['context-comparison', 'context-report'].includes(sources.get(item.context_source)?.ref.kind)) reasons.push('context_source_kind_mismatch');
  if (item.procedure_source && !['procedure-evidence', 'procedure-report'].includes(sources.get(item.procedure_source)?.ref.kind)) reasons.push('procedure_source_kind_mismatch');
  return { id: item.id, delivery_id: item.delivery_id, candidate_id: candidate.id, arm: candidate.arm,
    family_id: item.family_id, split: item.split, evidence_type: item.evidence_type, synthetic,
    eligible: reasons.length === 0, exclusions: [...new Set(reasons)].sort(), failed: result?.status === 'failed',
    policy: policyView(policy), registration: project(registration, ['case_id', 'family_id', 'split', 'policy_sha256',
      'original_input_sha256', 'acceptance_sha256', 'enrolled_at']), outcome: result ? { occurred_at: time(result.occurred_at) ? result.occurred_at : null,
      status: ['completed', 'failed'].includes(result.status) ? result.status : null, controls: validControls(result.controls) ? result.controls : null,
      baseline_controls: validControls(result.baseline_controls) ? result.baseline_controls : null,
      repetition: Number.isSafeInteger(result.repetition) && result.repetition >= 0 ? result.repetition : null } : null,
    dimensions: Object.fromEntries(DIMENSIONS.map(key => [key, measured?.dimensions[key] || unknown()])),
    source_ids: sourceIds, baseline_diagnostics: measured?.diagnostics || [] };
}

// The denominator is a delivery, never a document, version or repetition.
// Disagreeing versions keep their rows but contribute one explicit conflict.
function summarizeDimensions(cases) {
  const groups = new Map();
  for (const row of cases) { const rows = groups.get(row.delivery_id) || []; rows.push(row); groups.set(row.delivery_id, rows); }
  return Object.fromEntries(DIMENSIONS.map(key => {
    const deliveries = [...groups.entries()].map(([delivery_id, rows]) => {
      const values = rows.map(row => row.dimensions[key]);
      const signatures = new Set(values.map(value => fingerprint({ value: value.value, state: value.state, unit: value.unit,
        numerator: value.numerator, denominator: value.denominator, method: value.method })));
      return { delivery_id, ...(signatures.size === 1 ? values[0] : { ...unknown('delivery_version_conflict'), state: 'conflict' }) };
    });
    const usable = deliveries.filter(row => ['observed', 'derived', 'estimated'].includes(row.state) && row.value !== null);
    return [key, { numerator: usable.length, denominator: deliveries.length, coverage: deliveries.length ? usable.length / deliveries.length : null,
      method: 'unique-delivery-per-dimension; no cross-dimension score',
      states: Object.fromEntries(['observed', 'derived', 'estimated', 'unknown', 'invalid', 'conflict'].map(state => [state, deliveries.filter(row => row.state === state).length])),
      deliveries, limitations: ['estimates_are_not_billed_usage', 'coverage_is_not_effectiveness'] }];
  }));
}

function buildEmpiricalEvaluation(input, options = {}) {
  if (!object(input) || Buffer.byteLength(JSON.stringify(input)) > LIMITS.file_bytes || input.schema_version !== 1
      || input.kind !== 'empirical-evaluation-input' || !list(input.sources, LIMITS.sources)
      || !list(input.candidates, LIMITS.candidates) || !list(input.cases, LIMITS.cases)
      || !list(options.roots, 16) || !options.roots.length) fail('evaluation_input_invalid');
  const roots = options.roots.map(root => checkedPath(root));
  if (roots.some(root => !fs.statSync(root).isDirectory())) fail('root_invalid');
  const sources = new Map(); const reports = new Map(); const diagnostics = []; const budget = { bytes: 0 };
  for (const ref of input.sources) {
    if (!label(ref?.id) || sources.has(ref.id)) fail('source_id_invalid_or_duplicate');
    const source = { ref, data: null }; sources.set(ref.id, source);
    try {
      const read = readEvaluationSource(ref, roots, budget);
      source.data = JSON.parse(read.buffer.toString('utf8'));
      if (source.data?.schema_version !== 1) fail('source_schema_invalid');
      if (ref.kind === 'baseline') {
        if (!list(source.data.cases, LIMITS.cases)) fail('baseline_cases_invalid');
        for (const row of source.data.cases) {
          // No implicit corpus/agent view or unbound canonical manifest reads.
          if (row.input || row.autonomy || !list(row.sources, LIMITS.sources)) fail('baseline_nested_manifest_unsupported');
          for (const nested of row.sources) readEvaluationSource({ ...nested, synthetic: ref.synthetic,
            timezone: nested.timezone || ref.timezone }, roots, budget);
        }
        const report = buildEmpiricalBaseline(source.data, { roots, synthetic: ref.synthetic });
        const { generated_at, ...stable } = report; reports.set(ref.id, stable);
      } else if (ref.kind === 'context-comparison') reports.set(ref.id, buildContextComparison(source.data));
      else if (ref.kind === 'procedure-evidence') reports.set(ref.id, buildProcedureEvidence(source.data.before, source.data.after, { synthetic: ref.synthetic }));
      else if (['baseline-report', 'context-report', 'procedure-report'].includes(ref.kind)) reports.set(ref.id, readReportReplay(ref.kind, source.data));
      else if (!['protocol', 'outcome'].includes(ref.kind)) fail('source_kind_invalid');
    } catch (error) {
      source.data = null;
      diagnostics.push({ source_id: ref.id, code: label(error.code) ? error.code : 'source_invalid' });
    }
  }
  const candidates = new Map();
  for (const item of input.candidates) {
    if (!label(item?.id) || candidates.has(item.id) || !ARMS.includes(item.arm) || !label(item.protocol_source)) fail('candidate_invalid');
    candidates.set(item.id, item);
  }
  const unique = new Map();
  for (const item of input.cases) {
    if (!object(item) || !['id', 'delivery_id', 'candidate_id', 'family_id', 'baseline_source', 'baseline_case_id', 'outcome_source'].every(key => label(item[key]))
        || !SPLITS.includes(item.split) || !['historical', 'prospective', 'synthetic'].includes(item.evidence_type)
        || typeof item.synthetic !== 'boolean' || !candidates.has(item.candidate_id)
        || ['context_source', 'procedure_source'].some(key => item[key] !== undefined && !label(item[key]))
        || (item.evidence_type === 'synthetic' && !item.synthetic)
        || (item.split === 'prospective' && item.evidence_type === 'historical')) fail('case_metadata_invalid');
    const prior = unique.get(item.id);
    if (prior && fingerprint(prior) !== fingerprint(item)) fail('case_identity_conflict');
    unique.set(item.id, item);
  }
  const cases = [...unique.values()].sort((a, b) => a.id.localeCompare(b.id))
    .map(row => describeCase(row, candidates.get(row.candidate_id), sources, reports));
  for (const row of cases) if (cases.some(other => other.delivery_id === row.delivery_id
      && (other.candidate_id !== row.candidate_id || other.split !== row.split || other.family_id !== row.family_id
        || fingerprint(other.dimensions) !== fingerprint(row.dimensions)))) {
    row.eligible = false; row.exclusions.push('delivery_identity_conflict');
  }
  // A family cannot be adjusted and reserved/prospective, even across protocols.
  for (const row of cases) if (cases.some(other => other.family_id === row.family_id && other.split !== row.split
      && !(new Set([other.split, row.split]).size === 2 && ['reserved', 'prospective'].includes(other.split) && ['reserved', 'prospective'].includes(row.split)))) {
    row.eligible = false; row.exclusions.push('family_split_contamination');
  }
  const populations = Object.fromEntries(SPLITS.map(split => [split, cases.filter(row => row.split === split)]));
  const real = cases.filter(row => !row.synthetic);
  const prospective = real.filter(row => row.split === 'prospective' && row.eligible);
  const candidateReports = [...candidates.values()].map(candidate => {
    const rows = real.filter(row => row.candidate_id === candidate.id);
    const eligible = rows.filter(row => row.eligible && row.split === 'prospective');
    const policy = policyView(sources.get(candidate.protocol_source)?.data?.candidate);
    return { id: candidate.id, arm: candidate.arm, protocol_source: candidate.protocol_source, policy, eligible_prospective_deliveries: new Set(eligible.map(row => row.delivery_id)).size,
      eligible_prospective_families: new Set(eligible.map(row => row.family_id)).size,
      sample_floor_met: Boolean(policy?.minimum_sample && new Set(eligible.map(row => row.delivery_id)).size >= policy.minimum_sample.deliveries
        && new Set(eligible.map(row => row.family_id)).size >= Math.max(2, policy.minimum_sample.families)),
      dimensions_by_split: Object.fromEntries(SPLITS.map(split => [split, summarizeDimensions(rows.filter(row => row.split === split))])) };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const report = { schema_version: 1, kind: 'empirical-evaluation-report', comparative_ready: false, functional_gain: null,
    prospective_cases: new Set(prospective.map(row => row.delivery_id)).size,
    decision: { status: 'preserve-defaults', apply_policy: false, reason: prospective.length ? 'prospective_validation_pending' : 'zero_eligible_prospective_cases' },
    candidates: candidateReports, cases, populations: Object.fromEntries(Object.entries(populations).map(([key, rows]) => [key, {
      case_ids: rows.map(row => row.id), real_deliveries: new Set(rows.filter(row => !row.synthetic).map(row => row.delivery_id)).size,
      synthetic_cases: rows.filter(row => row.synthetic).length, dimensions: summarizeDimensions(rows.filter(row => !row.synthetic)) }])),
    technical_evidence: Object.fromEntries(reports), provenance: [...sources.values()].map(({ ref, data }) => ({
      ...project(ref, ['id', 'kind', 'path', 'sha256', 'revision', 'captured_at', 'timezone', 'synthetic']), available: data !== null })), diagnostics,
    limitations: ['descriptive_not_causal', 'supplied_hashes_are_not_authentication', 'metadata_does_not_enroll_or_execute_cases',
      'two_reserved_families_are_only_an_eligibility_floor', 'no_effectiveness_installation_UAT_or_provider_proof',
      'reserved_agent_view_remains_closed', 'canonical_manifests_require_separately_bound_sources',
      'nested_input_or_autonomy_manifests_fail_closed_without_dropping_selected_cases',
      'historical_report_replays_are_diagnostic_only', 'recommendations_do_not_apply_policy'] };
  // Only the trusted API caller supplies current policy context. Imported
  // candidates, protocols and outcome claims cannot supply prefs or authority.
  report.recommendations = evaluateCandidatePolicies(report, options.policyContext);
  return report;
}

function renderEmpiricalEvaluation(report) {
  const escape = value => String(value).replace(/[|<>*_`\[\]\\]/g, char => `&#${char.charCodeAt(0)};`).replace(/[\r\n]/g, ' ');
  const lines = ['# Empirical evaluation', '', `comparative_ready: ${report.comparative_ready}; functional_gain: ${report.functional_gain ?? 'null'}; prospective_cases: ${report.prospective_cases}.`,
    `Decision: ${report.decision.status}; ${report.decision.reason}.`, '',
    '| Candidate | Split | Dimension | Numerator | Denominator | Coverage | Method | States |', '| --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const candidate of report.candidates) for (const [split, dimensions] of Object.entries(candidate.dimensions_by_split))
    for (const [key, value] of Object.entries(dimensions)) lines.push(`| ${escape(candidate.id)} | ${split} | ${key} | ${value.numerator} | ${value.denominator} | ${value.coverage ?? 'unknown'} | ${escape(value.method)} | ${escape(JSON.stringify(value.states))} |`);
  lines.push('', '## Cases and exclusions', '');
  for (const row of report.cases) {
    lines.push(`- ${escape(row.id)}: split=${row.split}; synthetic=${row.synthetic}; eligible=${row.eligible}; failed=${row.failed}; ${escape(row.exclusions.join(', ') || 'no exclusions')}.`);
    for (const [key, value] of Object.entries(row.dimensions)) lines.push(`  - ${key}: ${escape(value.value ?? 'unknown')} (${value.state}); numerator=${value.numerator ?? 'unknown'}; denominator=${value.denominator ?? 'unknown'}; method=${escape(value.method)}.`);
  }
  lines.push('', '## Diagnostics', '');
  for (const diagnostic of report.diagnostics) lines.push(`- ${escape(diagnostic.source_id)}: ${escape(diagnostic.code)}`);
  lines.push('', '## Provenance and predeclared policies', '', '| Source | Kind | Path | SHA-256 | Revision | Captured at | Timezone | Synthetic | Available |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const source of report.provenance) lines.push(`| ${['id', 'kind', 'path', 'sha256', 'revision', 'captured_at', 'timezone', 'synthetic', 'available'].map(key => escape(source[key] ?? 'unknown')).join(' | ')} |`);
  for (const candidate of report.candidates) lines.push('', `- ${escape(candidate.id)} policy: ${escape(JSON.stringify(candidate.policy))}; sample_floor_met=${candidate.sample_floor_met}.`);
  if (report.recommendations) {
    lines.push('', '## Read-only recommendations', '',
      `Configured policies: ${escape(JSON.stringify(report.recommendations.configured))}.`,
      'apply_policy: false; authorization.granted: false.');
    for (const candidate of report.recommendations.candidates) lines.push(
      `- ${escape(candidate.id)} (${escape(candidate.arm)}): ${escape(candidate.recommendation)}; reasons=${escape(candidate.reasons.join(', ') || 'eligible for future validation only')}; ${escape(candidate.limitations.join(', '))}.`);
  }
  for (const row of report.cases) lines.push(`- ${escape(row.id)} registration: ${escape(JSON.stringify(row.registration))}; observed controls: ${escape(JSON.stringify(row.outcome))}.`);
  lines.push('', '## Limitations', '', ...report.limitations.map(value => `- ${value}`));
  return lines.join('\n') + '\n';
}

module.exports = { buildEmpiricalEvaluation, renderEmpiricalEvaluation, readEvaluationSource, LIMITS, DIMENSIONS };
if (require.main === module) {
  try {
    const args = process.argv.slice(2); const parsed = { roots: [] };
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--markdown' && !parsed.markdown) parsed.markdown = true;
      else if (arg === '--root' && args[i + 1]) parsed.roots.push(checkedPath(path.resolve(args[++i])));
      else if (['--input', '--sha256'].includes(arg) && args[i + 1] && !parsed[arg]) parsed[arg] = args[++i];
      else fail('cli_arguments_invalid');
    }
    if (!parsed.roots.length || !parsed['--input'] || !HASH.test(parsed['--sha256'] || '')) fail('cli_authority_missing');
    const absolute = checkedPath(path.resolve(parsed['--input']));
    const ref = { id: 'cli-input', path: path.relative(parsed.roots[0], absolute).replace(/\\/g, '/'), sha256: parsed['--sha256'],
      revision: 'caller-pinned', captured_at: new Date().toISOString(), timezone: 'UTC', synthetic: false };
    const read = readEvaluationSource(ref, parsed.roots, { bytes: 0 });
    const report = buildEmpiricalEvaluation(JSON.parse(read.buffer.toString('utf8')), { roots: parsed.roots });
    process.stdout.write(parsed.markdown ? renderEmpiricalEvaluation(report) : JSON.stringify(report, null, 2) + '\n');
  } catch { process.stderr.write('forge-empirical-evaluation: invalid or unavailable bounded input; defaults preserved\n'); process.exitCode = 2; }
}
