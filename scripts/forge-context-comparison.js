#!/usr/bin/env node
'use strict';

// Compare observations made at adapter boundaries, never intermediate bundles.
// Input is data: no command, path, approval or provider claim is executed/trusted.
const fs = require('fs');
const { sanitizeFinal, numericBudgets } = require('./forge-attempt-telemetry');
const { fingerprint } = require('./forge-delivery');
const label = value => typeof value === 'string' && /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,79}$/.test(value) ? value : null;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
const ids = value => [...new Set(Array.isArray(value) ? value.filter(id => typeof id === 'string'
  && /^[A-Za-z0-9_-]{1,80}\/MEM[0-9]{3,8}$/.test(id)) : [])].sort();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validIds = value => Array.isArray(value) && value.every(id => typeof id === 'string'
  && /^[A-Za-z0-9_-]{1,80}\/MEM[0-9]{3,8}$/.test(id)) && new Set(value).size === value.length;
const validBudgets = value => object(value) && Object.entries(value).every(([key, item]) => /^[a-z_]{1,60}$/.test(key)
  && (typeof item === 'number' ? Number.isFinite(item) && item >= 0 : validBudgets(item)));
const budgetKey = value => fingerprint(numericBudgets(value));
// Validate original observations before sanitizeFinal can discard malformed data.
// Without an explicit policy, the observed evidence/capture key sets are the
// available contract. No universal set of budget names is assumed.
function validateContextControls(row) {
  const failures = [];
  const evidence = row?.final_evidence?.budgets, capture = row?.capture?.identity?.budgets;
  if (!validBudgets(evidence) || !validBudgets(capture)) failures.push('R1-budget-control-unobserved-or-invalid');
  else if (budgetKey(evidence) !== budgetKey(capture)) failures.push('budgets-unbound');
  if (row?.controls && Object.hasOwn(row.controls, 'budget_policy')) {
    const policy = row.controls.budget_policy;
    if (!validBudgets(policy) || !Object.keys(policy).length || budgetKey(policy) !== budgetKey(evidence)
      || budgetKey(policy) !== budgetKey(capture)) failures.push('R1-budget-policy-unbound');
  }
  const flags = row?.conditions?.flags;
  if (!Array.isArray(flags) || flags.some(flag => !label(flag)) || new Set(flags).size !== flags.length) failures.push('R1-flags-control-unobserved-or-invalid');
  for (const [name, values] of [['selection', row?.selected_ids], ['delivery', row?.delivery?.delivered_ids], ['capture', row?.capture?.delivered_ids]]) {
    if (!validIds(values)) failures.push(`R2-${name}-ids-unobserved-or-invalid`);
  }
  const omitted = row?.delivery?.omitted;
  if (!Array.isArray(omitted) || omitted.some(item => !object(item) || !validIds([item.id]) || !label(item.reason))
      || !validIds(omitted.map(item => item.id))) failures.push('R2-omitted-ids-unobserved-or-invalid');
  if (!failures.some(reason => reason.startsWith('R2-'))) {
    const selected = row.selected_ids, delivered = row.delivery.delivered_ids;
    if (delivered.some(id => !selected.includes(id)) || row.capture.delivered_ids.some(id => !selected.includes(id))
      || omitted.some(item => !selected.includes(item.id) || delivered.includes(item.id))
      || selected.some(id => !delivered.includes(id) && !omitted.some(item => item.id === id))) failures.push('R2-selection-delivery-omission-incoherent');
  }
  return failures;
}
const identityFields = ['unit_type', 'scope', 'phase', 'dispatch_id', 'model_requested', 'model_sent', 'effort', 'host', 'worker', 'transport'];
function measurement(value) {
  return value?.status === 'observed' && Number.isInteger(value.bytes) && value.bytes >= 0 && hash(value.sha256)
    ? { status: 'observed', bytes: value.bytes, sha256: value.sha256, method: label(value.method) }
    : { status: 'unknown', bytes: null, sha256: null, method: null };
}
function variant(row) {
  const limitations = validateContextControls(row);
  const evidence = sanitizeFinal(row.final_evidence), capture = row.capture || {};
  const context = measurement(evidence?.context), request = measurement(evidence?.request);
  const capturedContext = measurement(capture.context), capturedRequest = measurement(capture.request);
  for (const [name, observed, captured] of [['context', context, capturedContext], ['request', request, capturedRequest]]) {
    if (observed.status !== 'observed' || captured.status !== 'observed') limitations.push(`${name}-unavailable`);
    else if (observed.bytes !== captured.bytes || observed.sha256 !== captured.sha256 || observed.method !== captured.method) limitations.push(`${name}-capture-mismatch`);
  }
  const identity = Object.fromEntries(identityFields.map(key => [key, label(evidence?.[key])]));
  for (const key of identityFields) {
    if (!identity[key] || identity[key] !== label(capture.identity?.[key])) limitations.push(`identity-${key}-unbound`);
  }
  const budgets = numericBudgets(evidence?.budgets);
  if (fingerprint(budgets) !== fingerprint(numericBudgets(capture.identity?.budgets))) limitations.push('budgets-unbound');
  const selected = ids(row.selected_ids), delivered = ids(row.delivery?.delivered_ids);
  if (!Array.isArray(row.selected_ids)) limitations.push('selection-unavailable');
  if (!Array.isArray(row.delivery?.delivered_ids) || !Array.isArray(capture.delivered_ids)) limitations.push('delivery-unavailable');
  else if (JSON.stringify(delivered) !== JSON.stringify(ids(capture.delivered_ids))) limitations.push('delivery-capture-mismatch');
  const omitted = selected.filter(id => !delivered.includes(id)).map(id => ({ id,
    reason: label(row.delivery?.omitted?.find(item => item.id === id)?.reason) || 'unknown' }));
  if (delivered.some(id => !selected.includes(id))) limitations.push('delivery-not-selected');
  if (omitted.some(item => item.reason === 'unknown')) limitations.push('omission-reason-unknown');
  const estimate = Number.isInteger(row.input_tokens) && row.input_tokens >= 0 && row.token_method === 'heuristic-chars-4'
    ? { value: row.input_tokens, method: row.token_method, provider_observed: false } : { value: null, method: null, provider_observed: false };
  if (estimate.value === null || estimate.value !== capture.input_tokens || estimate.method !== capture.token_method) {
    limitations.push('estimate-unbound'); estimate.value = null; estimate.method = null;
  }
  const conditions = { input_sha256: hash(row.conditions?.input_sha256), template_sha256: hash(row.conditions?.template_sha256),
    harness_version: label(row.conditions?.harness_version), clock: label(row.conditions?.clock),
    flags: Array.isArray(row.conditions?.flags) ? row.conditions.flags.map(label).filter(Boolean).sort() : [] };
  if (Object.values(conditions).some(value => value === null)) limitations.push('conditions-unavailable');
  return { variant: label(row.variant), availability: ['present', 'missing', 'unknown'].includes(row.availability) ? row.availability : 'unknown',
    execution_kind: row.execution_kind === 'transport-simulation' ? 'transport-simulation' : 'unknown',
    external_provider_called: 'unknown', functional_gain: null, identity, budgets, conditions,
    context, request, estimate, selected_ids: validIds(row.selected_ids) ? selected : null,
    delivered_ids: validIds(row.delivery?.delivered_ids) ? delivered : null, omitted_ids: validIds(row.selected_ids) ? omitted : null,
    binding: limitations.length ? 'unknown' : 'matched', limitations: limitations.sort() };
}
function buildContextComparison(input) {
  if (!input || input.schema_version !== 1 || !Array.isArray(input.cases) || input.cases.length > 1000) throw Error('comparison-input-invalid');
  const cases = input.cases.map(item => {
    if (!label(item.case_id) || !Array.isArray(item.variants) || item.variants.length !== 2) throw Error('comparison-case-invalid');
    const variants = item.variants.map(variant).sort((a, b) => String(a.variant).localeCompare(String(b.variant)));
    if (variants.some(row => !row.variant) || variants[0].variant === variants[1].variant) throw Error('comparison-variant-invalid');
    const [before, after] = [variants.find(row => row.variant === 'baseline'), variants.find(row => row.variant === 'current')];
    const equal = before && after && fingerprint({ ...before.conditions, budgets: before.budgets,
      identity: Object.fromEntries(identityFields.filter(key => key !== 'dispatch_id').map(key => [key, before.identity[key]])) }) === fingerprint({ ...after.conditions,
      budgets: after.budgets, identity: Object.fromEntries(identityFields.filter(key => key !== 'dispatch_id').map(key => [key, after.identity[key]])) });
    const comparable = Boolean(equal && variants.every(row => row.binding === 'matched'));
    return { case_id: item.case_id, variants, comparable, difference: {
      changed: comparable ? 'memory-selection-only' : 'unknown', context_bytes: comparable ? after.context.bytes - before.context.bytes : null,
      estimated_tokens: comparable && before.estimate.value !== null && after.estimate.value !== null ? after.estimate.value - before.estimate.value : null,
      delivered_added: comparable ? after.delivered_ids.filter(id => !before.delivered_ids.includes(id)) : [],
      delivered_removed: comparable ? before.delivered_ids.filter(id => !after.delivered_ids.includes(id)) : [] } };
  }).sort((a, b) => a.case_id.localeCompare(b.case_id));
  return { schema_version: 1, kind: 'technical-context-comparison', excluded_volatile_fields: ['captured_at', 'duration_ms'],
    comparative_ready: false, prospective_cases: 0, functional_gain: null, cases };
}
function renderContextComparison(report) {
  const lines = ['# Technical context comparison', '', 'Transport simulations; external calls and functional gain remain unknown.', '',
    '| Case | Variant | Binding | Context bytes | Estimate (chars/4) | Delivered IDs |', '| --- | --- | --- | --- | --- | --- |'];
  for (const item of report.cases) for (const row of item.variants) lines.push(`| ${item.case_id} | ${row.variant} | ${row.binding} | ${row.context.bytes ?? 'unknown'} | ${row.estimate.value ?? 'unknown'} | ${row.delivered_ids === null ? 'unknown' : row.delivered_ids.join(', ') || 'none (observed empty)'} |`);
  return lines.join('\n') + '\n';
}
module.exports = { buildContextComparison, renderContextComparison, validateContextControls };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length < 2 || args[0] !== '--input' || args.length > 3 || (args[2] && args[2] !== '--markdown')) throw Error('invalid');
    const bytes = fs.readFileSync(args[1]);
    if (bytes.length > 1024 * 1024) throw Error('limit');
    const report = buildContextComparison(JSON.parse(bytes));
    process.stdout.write(args[2] ? renderContextComparison(report) : JSON.stringify(report, null, 2) + '\n');
  } catch { process.stderr.write('forge-context-comparison: invalid comparison input\n'); process.exitCode = 2; }
}
