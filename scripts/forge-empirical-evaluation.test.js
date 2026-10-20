#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildEmpiricalEvaluation, buildEmpiricalPreflight, renderEmpiricalEvaluation, readEvaluationSource, DIMENSIONS, LIMITS } = require('./forge-empirical-evaluation');
const { buildEmpiricalBaseline } = require('./forge-empirical-baseline');
const { createProcedureFixture, buildProcedureEvidence } = require('./forge-procedure-evidence');
const { buildContextComparison } = require('./forge-context-comparison');
const { captureFinal } = require('./forge-attempt-telemetry');
const { sha256, fingerprint } = require('./forge-delivery');
const fixtures = require('./fixtures/empirical-evaluation/cases.json');
const schema = require('../shared/schemas/empirical-evaluation.schema.json');
const temporaryParent = fs.realpathSync.native(os.tmpdir());
const root = fs.mkdtempSync(path.join(temporaryParent, 'forge-evaluation-'));
let sequence = 0; let passed = 0;
const clone = value => JSON.parse(JSON.stringify(value));
// Exercise the schema's used validation vocabulary without adding a runtime
// dependency. This is a test assertion, not a replacement public validator.
function assertContract(value, rule, where = '$') {
  if (rule.$ref) return assertContract(value, schema.$defs[rule.$ref.split('/').pop()], where);
  if (Object.hasOwn(rule, 'const')) assert.deepEqual(value, rule.const, where);
  if (rule.enum) assert(rule.enum.some(item => fingerprint(item) === fingerprint(value)), where);
  if (rule.type) {
    const types = Array.isArray(rule.type) ? rule.type : [rule.type];
    assert(types.some(type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value)
      : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
        : type === 'integer' ? Number.isSafeInteger(value) : typeof value === type), where);
  }
  if (typeof value === 'string' && rule.pattern) assert(new RegExp(rule.pattern).test(value), where);
  if (typeof value === 'number' && rule.minimum !== undefined) assert(value >= rule.minimum, where);
  if (typeof value === 'number' && rule.maximum !== undefined) assert(value <= rule.maximum, where);
  if (Array.isArray(value)) {
    if (rule.maxItems !== undefined) assert(value.length <= rule.maxItems, where);
    if (rule.items) value.forEach((item, index) => assertContract(item, rule.items, `${where}[${index}]`));
  } else if (value && typeof value === 'object') {
    for (const key of rule.required || []) assert(Object.hasOwn(value, key), `${where}.${key}`);
    for (const [key, item] of Object.entries(value)) {
      const child = rule.properties?.[key] || (typeof rule.additionalProperties === 'object' ? rule.additionalProperties : null);
      if (child) assertContract(item, child, `${where}.${key}`);
    }
  }
}
function test(name, fn) { fn(); passed++; process.stdout.write(`ok - ${name}\n`); }
function writeSource(area, id, kind, data, synthetic = true) {
  const relative = `${id}.json`; const buffer = Buffer.from(JSON.stringify(data));
  fs.writeFileSync(path.join(area, relative), buffer);
  return { id, kind, path: relative, sha256: sha256(buffer), revision: 'fixture-v1',
    captured_at: '2026-01-02T00:00:00Z', timezone: 'UTC', synthetic };
}
function setup(rows = fixtures.cases, synthetic = true) {
  const area = path.join(root, `case-${sequence++}`); fs.mkdirSync(area);
  const controls = { version: 'fixture-v1', component_sha256: sha256('component'), input_sha256: sha256('original-input'),
    template_sha256: sha256('template'), model: 'fixture-model', effort: 'high', host: 'codex', transport: 'native',
    preparation: 'full', review: 'required', budgets: { context: 3000, timeout_ms: 60000 },
    memory_sha256: sha256('memory'), procedure_sha256: sha256('procedure') };
  const split = { frozen_at: '2026-01-01T00:00:00Z', adjustment: [...new Set(rows.filter(row => row.split === 'adjustment').map(row => row.family_id))],
    reserved: [...new Set(rows.filter(row => row.split !== 'adjustment').map(row => row.family_id))] };
  const policy = { id: 'candidate', arm: 'baseline', hypothesis: 'Public synthetic contract hypothesis', primary_dimension: 'human_effort',
    non_regression: { functional: 0, tests: 0 }, risk: 'Synthetic validation only', review: 'Required before any change',
    rejection_criteria: ['Reject functional regression', 'Reject non-equivalent controls'], minimum_sample: { deliveries: 2, families: 2 },
    split_sha256: fingerprint(split), declared_at: '2026-01-01T01:00:00Z', updated_at: '2026-01-01T01:00:00Z' };
  const protocol = { schema_version: 1, candidate: policy, split, registrations: rows.map(row => ({ case_id: row.id,
    family_id: row.family_id, split: row.split, policy_sha256: fingerprint(policy), original_input_sha256: controls.input_sha256,
    acceptance_sha256: sha256('acceptance'), enrolled_at: fixtures.execution_chronology.enrolled_at, controls: clone(controls) })) };
  const baseline = { schema_version: 1, cases: rows.map(row => {
    const ref = writeSource(area, `observations-${row.id}`, 'observations', { schema_version: 1, case_id: row.id, observations: row.observations }, synthetic);
    return { id: row.id, delivery_id: `delivery-${row.id}`, conditions: ['fixture'], sources: [{ ...ref, format: 'observations', origin: 'synthetic' }] };
  }) };
  const sources = [writeSource(area, 'protocol', 'protocol', protocol, synthetic), writeSource(area, 'baseline', 'baseline', baseline, synthetic)];
  const outcomes = {}; const starts = {};
  for (const row of rows) {
    outcomes[row.id] = { schema_version: 1, case_id: row.id, occurred_at: fixtures.execution_chronology.occurred_at, status: 'completed',
      controls: clone(controls), baseline_controls: clone(controls), repetition: 1 };
    sources.push(writeSource(area, `outcome-${row.id}`, 'outcome', outcomes[row.id], synthetic));
    starts[row.id] = { schema_version: 1, case_id: row.id, started_at: fixtures.execution_chronology.started_at,
      registration_sha256: fingerprint(protocol.registrations.find(item => item.case_id === row.id)), controls: clone(controls) };
    sources.push(writeSource(area, `start-${row.id}`, 'execution-start', starts[row.id], synthetic));
  }
  const input = { schema_version: 1, kind: 'empirical-evaluation-input', sources,
    candidates: [{ id: policy.id, arm: policy.arm, protocol_source: 'protocol' }], cases: rows.map(row => ({
      id: row.id, delivery_id: `delivery-${row.id}`, candidate_id: policy.id, family_id: row.family_id, split: row.split,
      evidence_type: synthetic ? 'synthetic' : row.split === 'historical-diagnostic' ? 'historical' : 'prospective', synthetic,
      baseline_source: 'baseline', baseline_case_id: row.id, outcome_source: `outcome-${row.id}`, execution_start_source: `start-${row.id}` })) };
  const refresh = () => {
    protocol.candidate = policy; for (const row of protocol.registrations || []) row.policy_sha256 = fingerprint(policy);
    Object.assign(sources.find(ref => ref.id === 'protocol'), writeSource(area, 'protocol', 'protocol', protocol, synthetic));
    Object.assign(sources.find(ref => ref.id === 'baseline'), writeSource(area, 'baseline', 'baseline', baseline, synthetic));
    for (const [id, outcome] of Object.entries(outcomes)) Object.assign(sources.find(ref => ref.id === `outcome-${id}`), writeSource(area, `outcome-${id}`, 'outcome', outcome, synthetic));
    for (const [id, start] of Object.entries(starts)) {
      start.registration_sha256 = fingerprint(protocol.registrations?.find(row => row.case_id === id) || {});
      start.controls = clone(outcomes[id].controls || {});
      Object.assign(sources.find(ref => ref.id === `start-${id}`), writeSource(area, `start-${id}`, 'execution-start', start, synthetic));
    }
  };
  return { area, input, controls, split, policy, protocol, baseline, outcomes, starts, refresh,
    report: () => { refresh(); return buildEmpiricalEvaluation(input, { roots: [area] }); } };
}
const firstTwo = fixtures.cases.slice(0, 2);
// Preflight evidence is independent of outcomes. publish never repairs hashes,
// controls or chronology, so adversarial mutations remain observable.
function preflightSetup(rows = firstTwo, synthetic = false) {
  const s = setup(rows, synthetic);
  for (const row of s.baseline.cases) row.baseline_controls = clone(s.controls);
  s.refresh();
  const input = clone(s.input); input.kind = 'empirical-preflight-input';
  input.sources = input.sources.filter(ref => ref.kind !== 'outcome');
  for (const row of input.cases) delete row.outcome_source;
  const publish = () => {
    for (const [id, kind, data] of [['protocol', 'protocol', s.protocol], ['baseline', 'baseline', s.baseline],
      ...Object.entries(s.starts).map(([id, data]) => [`start-${id}`, 'execution-start', data])]) {
      Object.assign(input.sources.find(ref => ref.id === id), writeSource(s.area, id, kind, data, synthetic));
    }
  };
  const bind = () => {
    s.policy.split_sha256 = fingerprint(s.split);
    for (const row of s.protocol.registrations) row.policy_sha256 = fingerprint(s.policy);
    for (const [id, start] of Object.entries(s.starts)) start.registration_sha256 = fingerprint(s.protocol.registrations.find(row => row.case_id === id) || {});
  };
  return { ...s, input, publish, bind, preflight: () => buildEmpiricalPreflight(input, { roots: [s.area] }) };
}
// All records remain temporary adversarial metadata, including false synthetic
// flags. Exercise positive validation without claiming real provider execution.
function combinedSetup() {
  const arms = ['memory', 'procedure', 'preparation', 'review', 'combined'];
  const rows = arms.map(arm => ({ ...clone(firstTwo[0]), id: `isolated-${arm}` }));
  const s = setup(rows, false); s.input.candidates = [];
  const axes = { memory: 'memory_sha256', procedure: 'procedure_sha256', preparation: 'preparation', review: 'review' };
  const treatments = { memory_sha256: sha256('new-memory'), procedure_sha256: sha256('new-procedure'), preparation: 'reduced', review: 'expanded' };
  const fixture = createProcedureFixture();
  const protocols = {};
  for (const arm of arms) {
    const id = `isolated-${arm}`; const item = s.input.cases.find(row => row.id === id);
    const controls = { ...clone(s.controls), ...(arm === 'combined' ? treatments : { [axes[arm]]: treatments[axes[arm]] }) };
    const policy = { ...clone(s.policy), id: arm, arm };
    const registration = { ...clone(s.protocol.registrations.find(row => row.case_id === id)), controls,
      policy_sha256: fingerprint(policy), enrolled_at: arm === 'combined' ? '2026-01-04T00:00:00Z' : '2026-01-02T00:00:00Z' };
    protocols[arm] = { schema_version: 1, candidate: policy, split: clone(s.split), registrations: [registration] };
    s.input.candidates.push({ id: arm, arm, protocol_source: `protocol-${arm}` }); item.candidate_id = arm;
    s.outcomes[id].controls = clone(controls);
    if (arm === 'combined') {
      s.outcomes[id].occurred_at = '2026-01-05T00:00:00Z'; s.starts[id].started_at = '2026-01-04T01:00:00Z';
    }
    if (['memory', 'procedure'].includes(arm)) {
      const variants = ['baseline', 'current'].map(variant => {
        const row = { ...clone(fixture.after), variant };
        Object.assign(row.conditions, { input_sha256: controls.input_sha256, template_sha256: controls.template_sha256 });
        row.package.template_sha256 = controls.template_sha256;
        for (const identity of [row.final_evidence, row.capture.identity]) Object.assign(identity, {
          model_requested: controls.model, model_sent: controls.model, effort: controls.effort, host: controls.host,
          transport: controls.transport, budgets: clone(controls.budgets) });
        row.controls.budget_policy = clone(controls.budgets);
        if (arm === 'memory' && variant === 'current') row.selected_ids = row.delivery.delivered_ids = row.capture.delivered_ids = ['T01/MEM001'];
        return row;
      });
      const kind = arm === 'memory' ? 'context-comparison' : 'procedure-evidence';
      const data = arm === 'memory' ? { schema_version: 1, cases: [{ case_id: id, variants }] }
        : { schema_version: 1, before: variants[0], after: variants[1] };
      item[arm === 'memory' ? 'context_source' : 'procedure_source'] = `technical-${arm}`;
      s.input.sources.push(writeSource(s.area, `technical-${arm}`, kind, data, false));
    }
  }
  const refresh = () => {
    s.refresh();
    for (const arm of arms.filter(arm => arm !== 'combined')) {
      const ref = writeSource(s.area, `protocol-${arm}`, 'protocol', protocols[arm], false);
      const prior = s.input.sources.find(row => row.id === ref.id); if (prior) Object.assign(prior, ref); else s.input.sources.push(ref);
    }
    const combined = protocols.combined.registrations[0];
    if (!combined.isolated_comparisons) combined.isolated_comparisons = arms.filter(arm => arm !== 'combined').map(arm => ({
      arm, case_id: `isolated-${arm}`, protocol_sha256: s.input.sources.find(row => row.id === `protocol-${arm}`).sha256,
      outcome_sha256: s.input.sources.find(row => row.id === `outcome-isolated-${arm}`).sha256 }));
    for (const arm of arms) {
      const ref = writeSource(s.area, `protocol-${arm}`, 'protocol', protocols[arm], false);
      const prior = s.input.sources.find(row => row.id === ref.id); if (prior) Object.assign(prior, ref); else s.input.sources.push(ref);
      const id = `isolated-${arm}`;
      const start = { ...s.starts[id], registration_sha256: fingerprint(protocols[arm].registrations[0]), controls: s.outcomes[id].controls };
      Object.assign(s.input.sources.find(row => row.id === `start-${id}`), writeSource(s.area, `start-${id}`, 'execution-start', start, false));
    }
  };
  return { ...s, protocols, refresh, report: () => { refresh(); return buildEmpiricalEvaluation(s.input, { roots: [s.area] }); } };
}
try {
  test('preflight validates independent baseline and enrollment without an outcome or final eligibility', () => {
    const s = preflightSetup();
    // No outcome file is even available to the preflight.
    for (const name of fs.readdirSync(s.area).filter(name => name.startsWith('outcome-'))) fs.unlinkSync(path.join(s.area, name));
    const result = s.preflight();
    assert.equal(result.kind, 'empirical-preflight-report'); assert.deepEqual(result.diagnostics, []);
    for (const row of result.cases) {
      assert.deepEqual(row.exclusions, []); assert(row.enrollment_valid); assert(row.controls_available);
      assert(row.baseline_controls_available); assert(row.prospective_enrollment);
      assert.equal(row.classification, 'awaiting-outcome'); assert.equal(row.outcome, null);
      assert(row.outcome_pending); assert.equal(row.eligible, false);
    }
    assert.equal(result.eligible, false); assert.equal(result.comparative_ready, false);
    assert.equal(result.functional_gain, null); assert.equal(result.decision.apply_policy, false);
    assert.equal(result.authorization.granted, false);
    for (const candidate of [s.input, { ...s.input, kind: 'empirical-evaluation-input' }]) {
      assert.throws(() => buildEmpiricalEvaluation(candidate, { roots: [s.area] }));
    }
    const mixed = clone(s.input); mixed.cases[0].outcome_source = 'invented';
    assert.throws(() => buildEmpiricalPreflight(mixed, { roots: [s.area] }), /preflight_outcome_not_allowed/);
    const sources = clone(s.input); sources.sources.push({ id: 'outcome', kind: 'outcome' });
    assert.throws(() => buildEmpiricalPreflight(sources, { roots: [s.area] }), /preflight_outcome_not_allowed/);
  });
  test('preflight and posterior share strict chronology policy split and registration reason codes', () => {
    const id = firstTwo[0].id;
    const cases = [
      ['registration_missing_or_not_prior', s => { s.protocol.registrations[0].enrolled_at = s.policy.updated_at; }],
      ['execution_chronology_unproven', s => { s.protocol.registrations[0].enrolled_at = s.starts[id].started_at; }],
      ['execution_chronology_unproven', s => { s.protocol.registrations[0].enrolled_at = '2026-01-03T00:00:00Z'; }],
      ['execution_chronology_unproven', s => { s.policy.declared_at = '2026-01-01T02:00:00Z'; }],
      ['registration_missing_or_not_prior', s => { s.policy.updated_at = s.protocol.registrations[0].enrolled_at; }],
      ['registration_missing_or_not_prior', s => { s.split.frozen_at = s.protocol.registrations[0].enrolled_at; }],
      ['execution_chronology_unproven', s => { s.starts[id].started_at = '2026-02-30T00:00:00Z'; }],
      ['execution_chronology_unproven', s => { s.starts[id].started_at = '2026-01-02T24:00:00Z'; }],
      ['execution_start_unbound', s => { s.starts[id].case_id = 'foreign'; }],
      ['policy_missing:hypothesis', s => { delete s.policy.hypothesis; }],
      ['split_unbound_or_not_prior', s => { s.split.reserved.push(s.split.reserved[0]); }],
      ['family_split_mismatch', s => { s.split.reserved = []; }],
      ['registration_missing_or_not_prior', s => { s.protocol.registrations.push(clone(s.protocol.registrations[0])); }],
      ['registration_missing_or_not_prior', s => { s.protocol.registrations[0].acceptance_sha256 = 'bad'; }],
      ['original_input_unbound', s => { s.protocol.registrations[0].original_input_sha256 = sha256('foreign'); }]
    ];
    for (const [reason, mutate] of cases) {
      const s = preflightSetup(); mutate(s); s.bind(); s.publish();
      const preflight = s.preflight().cases.find(row => row.id === id);
      assert(preflight.exclusions.includes(reason), `${reason}: ${preflight.exclusions}`);
      assert.equal(preflight.prospective_enrollment, false); assert.equal(preflight.classification, 'observational');
      const posterior = { ...clone(s.input), kind: 'empirical-evaluation-input' };
      for (const item of posterior.cases) {
        item.outcome_source = `outcome-${item.id}`;
        posterior.sources.push(writeSource(s.area, item.outcome_source, 'outcome', s.outcomes[item.id], false));
      }
      assert(buildEmpiricalEvaluation(posterior, { roots: [s.area] }).cases.find(row => row.id === id).exclusions.includes(reason), reason);
    }
    for (const mutate of [s => { s.starts[id].registration_sha256 = sha256('foreign'); },
      s => { s.protocol.registrations[0].policy_sha256 = sha256('foreign'); },
      s => { s.policy.split_sha256 = sha256('foreign'); }]) {
      const s = preflightSetup(); mutate(s); s.publish();
      assert.equal(s.preflight().cases.find(row => row.id === id).prospective_enrollment, false);
    }
    const good = preflightSetup(); good.policy.updated_at = '2026-01-01T02:00:00+01:00'; good.bind(); good.publish();
    assert(good.preflight().cases.every(row => row.prospective_enrollment), 'equal instants declared/updated are allowed');
  });
  test('preflight requires exactly thirteen typed controls and binds each registered started and baseline axis', () => {
    const id = firstTwo[0].id;
    for (const field of Object.keys(preflightSetup().controls)) {
      for (const target of ['registration', 'start', 'baseline']) {
        for (const operation of ['missing', 'changed', 'invalid']) {
          const s = preflightSetup();
          const controls = target === 'registration' ? s.protocol.registrations[0].controls
            : target === 'start' ? s.starts[id].controls : s.baseline.cases[0].baseline_controls;
          if (operation === 'missing') delete controls[field];
          else controls[field] = operation === 'invalid' ? (field === 'budgets' ? { context: -1 } : 4)
            : field === 'budgets' ? { context: 1 } : field.endsWith('_sha256') ? sha256('foreign') : 'foreign';
          s.bind(); s.publish(); const row = s.preflight().cases.find(row => row.id === id);
          assert(!row.prospective_enrollment, `${target}/${field}/${operation}`);
          assert(row.exclusions.includes(target === 'baseline' ? 'non_equivalent_controls' : 'executed_controls_unbound'), `${target}/${field}/${operation}: ${row.exclusions}`);
        }
      }
    }
    const extra = preflightSetup(); extra.starts[id].controls.extra = 'unrecognized'; extra.publish();
    assert(!extra.preflight().cases[0].controls_available);
    for (const [arm, axis] of Object.entries({ memory: 'memory_sha256', procedure: 'procedure_sha256', preparation: 'preparation', review: 'review' })) {
      const s = preflightSetup(); s.policy.arm = s.input.candidates[0].arm = arm;
      for (const registration of s.protocol.registrations) registration.controls[axis] = axis.endsWith('_sha256') ? sha256('treatment') : 'changed';
      for (const start of Object.values(s.starts)) start.controls[axis] = axis.endsWith('_sha256') ? sha256('treatment') : 'changed';
      s.bind(); s.publish(); assert(s.preflight().cases.every(row => row.prospective_enrollment), arm);
      s.baseline.cases[0].baseline_controls.model = 'foreign'; s.publish();
      assert(!s.preflight().cases[0].prospective_enrollment, `${arm} cannot alter an untreated model`);
    }
  });
  test('preflight keeps missing ambiguous replay synthetic and contaminated baseline cases observational', () => {
    const mutations = [
      ['baseline_controls_unavailable', s => { delete s.baseline.cases[0].baseline_controls; }],
      ['baseline_controls_unbound', s => { s.baseline.cases.push(clone(s.baseline.cases[0])); }],
      ['baseline_case_unbound', s => { s.baseline.cases[0].delivery_id = 'foreign'; }],
      ['registration_missing_or_not_prior', s => { s.protocol.registrations.push(clone(s.protocol.registrations[0])); }],
      ['synthetic_not_real_sample', s => { s.input.cases[0].synthetic = true; }],
      ['synthetic_not_real_sample', s => { s.baseline.synthetic = true; }]
    ];
    for (const [reason, mutate] of mutations) {
      const s = preflightSetup(); mutate(s); s.publish(); const row = s.preflight().cases.find(row => row.id === firstTwo[0].id);
      assert(row.exclusions.includes(reason), `${reason}: ${row.exclusions}`); assert.equal(row.classification, 'observational');
    }
    const missing = preflightSetup(); missing.input.sources = missing.input.sources.filter(ref => ref.id !== 'baseline');
    assert(missing.preflight().cases.every(row => row.exclusions.includes('source_unavailable:baseline')));
    const replay = preflightSetup(); const data = buildEmpiricalBaseline(replay.baseline, { roots: [replay.area], synthetic: false });
    Object.assign(replay.input.sources.find(ref => ref.id === 'baseline'), writeSource(replay.area, 'baseline', 'baseline-report', data, false));
    assert(replay.preflight().cases.every(row => row.exclusions.includes('historical_report_replay_only') && !row.baseline_controls_available));
    const synthetic = preflightSetup(firstTwo, true); assert(synthetic.preflight().cases.every(row => !row.prospective_enrollment));
    const contamination = preflightSetup(); contamination.input.cases[1].family_id = contamination.input.cases[0].family_id;
    contamination.input.cases[1].split = 'adjustment';
    assert(contamination.preflight().cases.every(row => row.exclusions.includes('family_split_contamination')));
    const historical = preflightSetup(); historical.input.cases[0].split = historical.protocol.registrations[0].split = 'historical-diagnostic';
    historical.input.cases[0].evidence_type = 'historical'; historical.bind(); historical.publish();
    assert(historical.preflight().cases[0].exclusions.includes('historical_diagnostic_only'));
    const adjustment = preflightSetup(); adjustment.input.cases[0].split = adjustment.protocol.registrations[0].split = 'adjustment';
    adjustment.split.adjustment.push(adjustment.input.cases[0].family_id); adjustment.split.reserved.shift(); adjustment.bind(); adjustment.publish();
    assert.deepEqual(adjustment.preflight().cases[0].exclusions, []);
    assert.equal(adjustment.preflight().cases[0].classification, 'observational'); assert.equal(adjustment.preflight().cases[0].split, 'adjustment');
  });
  test('preflight retains bounded hash-pinned trusted roots and sanitized source diagnostics', () => {
    for (const change of [ref => { ref.sha256 = sha256('changed'); }, ref => { ref.path = '../escape.json'; },
      ref => { ref.path = 'source.json:stream'; }, ref => { ref.path = 'missing.json'; },
      ref => { ref.captured_at = '2026-02-30T00:00:00Z'; }, ref => { ref.revision = ''; }]) {
      const s = preflightSetup(); change(s.input.sources.find(ref => ref.id === 'baseline')); const report = s.preflight();
      assert(report.diagnostics.length); assert(report.cases.every(row => !row.prospective_enrollment));
      assert(!JSON.stringify(report.diagnostics).includes(s.area));
    }
    const changed = preflightSetup(); fs.appendFileSync(path.join(changed.area, 'baseline.json'), ' ');
    assert.equal(changed.preflight().diagnostics[0].code, 'source_hash_changed');
    const foreign = preflightSetup(); const stranger = preflightSetup(); foreign.input.roots = [foreign.area];
    const callerRoot = path.join(root, `empty-authorized-${sequence++}`); fs.mkdirSync(callerRoot);
    assert(buildEmpiricalPreflight(foreign.input, { roots: [callerRoot] }).cases.every(row => !row.prospective_enrollment));
    const linked = preflightSetup(); const link = path.join(linked.area, 'linked');
    fs.symlinkSync(stranger.area, link, process.platform === 'win32' ? 'junction' : 'dir');
    linked.input.sources.find(ref => ref.id === 'baseline').path = 'linked/baseline.json';
    assert(linked.preflight().diagnostics.length);
    const oversized = preflightSetup(); fs.writeFileSync(path.join(oversized.area, 'baseline.json'), Buffer.alloc(LIMITS.file_bytes + 1));
    assert(oversized.preflight().diagnostics.length);
    const caps = preflightSetup();
    for (const [key, limit] of [['sources', LIMITS.sources], ['cases', LIMITS.cases], ['candidates', LIMITS.candidates]]) {
      assert.throws(() => buildEmpiricalPreflight({ ...caps.input, [key]: Array(limit + 1).fill(caps.input[key][0]) }, { roots: [caps.area] }), /evaluation_input_invalid/);
    }
    assert.throws(() => buildEmpiricalPreflight({ ...caps.input, extra: 'x'.repeat(LIMITS.file_bytes) }, { roots: [caps.area] }), /evaluation_input_invalid/);
    const total = preflightSetup(); const ref = total.input.sources.find(row => row.id === 'baseline');
    const padded = JSON.parse(fs.readFileSync(path.join(total.area, ref.path))); padded.padding = 'x'.repeat(970000);
    total.input.sources = [total.input.sources[0], ...Array.from({ length: 10 }, (_, i) => writeSource(total.area, `large-${i}`, 'baseline', padded, false)), ...total.input.sources.filter(row => row.kind === 'execution-start')];
    const report = total.preflight(); assert(report.diagnostics.some(row => row.code === 'total_bytes_exceeded'));
    assert(report.cases.every(row => !row.prospective_enrollment));
  });
  test('preflight API and CLI are read-only JSON with incompatible options and input IO rejected', () => {
    const s = preflightSetup(); s.input.approved = true; s.input.command = 'PRIVATE_COMMAND_SENTINEL';
    const file = path.join(s.area, 'preflight.json'); const bytes = Buffer.from(JSON.stringify(s.input)); fs.writeFileSync(file, bytes);
    fs.writeFileSync(path.join(s.area, 'prefs.yaml'), 'unchanged'); fs.mkdirSync(path.join(s.area, '.gsd'));
    fs.writeFileSync(path.join(s.area, '.gsd', 'STATE.md'), 'unchanged');
    const snapshot = () => Object.fromEntries(fs.readdirSync(s.area, { recursive: true }).sort().filter(name => fs.statSync(path.join(s.area, name)).isFile())
      .map(name => [name, sha256(fs.readFileSync(path.join(s.area, name)))]));
    const before = snapshot(); const original = JSON.stringify(s.input);
    const api = s.preflight(); assert.equal(JSON.stringify(s.input), original);
    const args = [path.join(__dirname, 'forge-empirical-evaluation.js'), '--preflight', '--input', file, '--sha256', sha256(bytes), '--root', s.area];
    const cli = spawnSync(process.execPath, args, { encoding: 'utf8' }); assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout), api); assert(!cli.stdout.includes('PRIVATE_')); assert.deepEqual(snapshot(), before);
    for (const invalidArgs of [[...args, '--markdown'], [...args, '--preflight'], args.slice(0, -2),
      args.map(value => value === sha256(bytes) ? sha256('foreign') : value), args.map(value => value === file ? path.join(s.area, 'missing.json') : value)]) {
      const invalid = spawnSync(process.execPath, invalidArgs, { encoding: 'utf8' }); assert.equal(invalid.status, 2);
      assert(!invalid.stderr.includes(s.area)); assert(!invalid.stderr.includes('PRIVATE_')); assert.equal(invalid.stdout, '');
    }
    fs.appendFileSync(path.join(s.area, 'baseline.json'), ' ');
    const invalid = spawnSync(process.execPath, args, { encoding: 'utf8' }); assert.equal(invalid.status, 2);
    assert(JSON.parse(invalid.stdout).diagnostics.some(row => row.code === 'source_hash_changed'));
    assert(!invalid.stderr.includes(s.area));
  });
  test('preflight enrollment awaiting outcome becomes posterior evidence only after a bound later outcome', () => {
    const s = preflightSetup(); const preflight = s.preflight(); const posterior = clone(s.input); posterior.kind = 'empirical-evaluation-input';
    for (const item of posterior.cases) {
      item.outcome_source = `outcome-${item.id}`;
      posterior.sources.push(writeSource(s.area, item.outcome_source, 'outcome', s.outcomes[item.id], false));
    }
    const report = buildEmpiricalEvaluation(posterior, { roots: [s.area] });
    assert.deepEqual(report.cases.map(row => row.exclusions), preflight.cases.map(row => row.exclusions));
    assert(report.cases.every(row => row.eligible)); assert(preflight.cases.every(row => !row.eligible));
    assert.equal(report.prospective_cases, 2); assert.equal(report.comparative_ready, false);
    const id = firstTwo[0].id; s.outcomes[id].occurred_at = s.starts[id].started_at;
    Object.assign(posterior.sources.find(ref => ref.id === `outcome-${id}`), writeSource(s.area, `outcome-${id}`, 'outcome', s.outcomes[id], false));
    assert(buildEmpiricalEvaluation(posterior, { roots: [s.area] }).cases[0].exclusions.includes('execution_chronology_unproven'));
    assert(s.preflight().cases[0].prospective_enrollment, 'preflight cannot prove a later outcome');
  });
  test('R6 isolated technical comparators bind every executed control, not just internal comparability', () => {
    for (const arm of ['memory', 'procedure']) {
      const positive = combinedSetup().report();
      assert(positive.cases.find(row => row.arm === arm).eligible);
      for (const key of ['input_sha256', 'template_sha256', 'model_requested', 'model_sent', 'effort', 'host', 'transport', 'budgets']) {
        const s = combinedSetup();
        const ref = s.input.sources.find(row => row.id === `technical-${arm}`);
        const data = JSON.parse(fs.readFileSync(path.join(s.area, ref.path)));
        const variants = arm === 'memory' ? data.cases[0].variants : [data.before, data.after];
        for (const row of variants) {
          const value = key.endsWith('sha256') ? sha256('unrelated') : key === 'budgets' ? { context: 1 } : 'unrelated';
          if (key.endsWith('sha256')) {
            row.conditions[key] = value;
            if (key === 'template_sha256') row.package.template_sha256 = value;
          } else {
            row.final_evidence[key] = clone(value); row.capture.identity[key] = clone(value);
            if (key === 'budgets') row.controls.budget_policy = clone(value);
          }
        }
        assert(arm === 'memory' ? buildContextComparison(data).cases[0].comparable
          : buildProcedureEvidence(data.before, data.after).comparable, `internally comparable ${arm}/${key}`);
        Object.assign(ref, writeSource(s.area, ref.id, ref.kind, data, false));
        const report = s.report();
        assert(!report.cases.find(row => row.arm === arm).eligible, `${arm}/${key} must be excluded`);
        assert(!report.cases.find(row => row.arm === 'combined').eligible, 'combined cannot inherit invalid isolated evidence');
      }
    }
  });
  test('R2 execution starts bind registration and controls with strict prospective chronology', () => {
    const id = firstTwo[0].id;
    const negative = [s => { delete s.input.cases[0].execution_start_source; },
      s => { s.starts[id].started_at = '2025-12-31T00:00:00Z'; },
      s => { s.starts[id].started_at = s.protocol.registrations[0].enrolled_at; },
      s => { s.starts[id].started_at = s.outcomes[id].occurred_at; },
      s => { s.starts[id].started_at = '2026-01-04T00:00:00Z'; },
      s => { s.starts[id].started_at = 'invalid'; }, s => { s.starts[id].case_id = 'foreign'; },
      s => { s.policy.declared_at = '2026-01-02T02:00:00Z'; },
      s => { s.policy.updated_at = s.starts[id].started_at; },
      s => { s.split.frozen_at = s.starts[id].started_at; s.policy.split_sha256 = fingerprint(s.split); },
      s => { s.protocol.registrations.push(clone(s.protocol.registrations[0])); }];
    for (const mutate of negative) {
      const s = setup(firstTwo, false); mutate(s); const report = s.report();
      assert(!report.cases.find(row => row.id === id).eligible);
      assert(report.prospective_cases < 2);
    }
    const s = setup(firstTwo, false); s.refresh();
    for (const change of [{ registration_sha256: sha256('foreign') }, { controls: { ...s.controls, model: 'foreign' } }]) {
      const ref = s.input.sources.find(row => row.id === `start-${id}`);
      Object.assign(ref, writeSource(s.area, ref.id, 'execution-start', { ...s.starts[id], ...change }, false));
      assert(buildEmpiricalEvaluation(s.input, { roots: [s.area] }).cases.find(row => row.id === id).exclusions.includes('execution_start_unbound'));
    }
    assert(s.report().cases.every(row => row.eligible));
  });
  test('R1 combined requires validated isolated comparisons, protocol pins and executed controls', () => {
    const good = combinedSetup(); const report = good.report();
    assert(report.cases.every(row => row.eligible), JSON.stringify(report.cases.map(row => [row.id, row.exclusions])));
    assert.equal(report.technical_evidence['technical-memory'].cases[0].comparable, true);
    assert.equal(report.technical_evidence['technical-procedure'].comparable, true);
    for (const ref of good.protocols.combined.registrations[0].isolated_comparisons) assertContract(ref, schema.$defs.isolatedComparison);
    for (const mutate of [s => { s.protocols.combined.registrations[0].isolated_comparisons = []; },
      s => { s.protocols.combined.registrations[0].isolated_comparisons[0].case_id = 'missing'; },
      s => { s.protocols.combined.registrations[0].isolated_comparisons[0].protocol_sha256 = sha256('foreign'); },
      s => { s.protocols.combined.registrations[0].isolated_comparisons[0].outcome_sha256 = sha256('foreign'); },
      s => { s.protocols.combined.registrations[0].isolated_comparisons[1] = clone(s.protocols.combined.registrations[0].isolated_comparisons[0]); },
      s => { s.input.cases.find(row => row.candidate_id === 'memory').synthetic = true; },
      s => { s.outcomes['isolated-memory'].status = 'failed'; },
      s => { s.outcomes['isolated-memory'].controls.model = 'foreign'; },
      s => { s.outcomes['isolated-memory'].baseline_controls.budgets.context++; },
      s => { s.outcomes['isolated-combined'].controls.memory_sha256 = s.controls.memory_sha256; },
      s => { s.outcomes['isolated-memory'].occurred_at = '2026-01-04T00:00:00Z'; },
      s => { delete s.input.cases.find(row => row.candidate_id === 'procedure').procedure_source; }]) {
      const s = combinedSetup(); s.refresh(); mutate(s);
      assert(s.report().cases.find(row => row.arm === 'combined').exclusions.includes('combined_isolation_unproven'));
    }
    // A comparator can be internally valid yet refer to another executed input.
    const s = combinedSetup(); s.refresh(); const ref = s.input.sources.find(row => row.id === 'technical-memory');
    const data = JSON.parse(fs.readFileSync(path.join(s.area, ref.path)));
    for (const row of data.cases[0].variants) row.conditions.input_sha256 = sha256('unrelated');
    assert(buildContextComparison(data).cases[0].comparable);
    Object.assign(ref, writeSource(s.area, ref.id, ref.kind, data, false));
    assert(s.report().cases.find(row => row.arm === 'combined').exclusions.includes('combined_isolation_unproven'));
    good.refresh(); const file = path.join(good.area, 'cli.json'); const bytes = Buffer.from(JSON.stringify(good.input)); fs.writeFileSync(file, bytes);
    const cli = spawnSync(process.execPath, [path.join(__dirname, 'forge-empirical-evaluation.js'), '--input', file,
      '--sha256', sha256(bytes), '--root', good.area], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr); assert(JSON.parse(cli.stdout).cases.find(row => row.arm === 'combined').eligible);
    for (const mutate of [input => { delete input.cases.find(row => row.candidate_id === 'combined').execution_start_source; },
      input => { delete input.cases.find(row => row.candidate_id === 'memory').context_source; }]) {
      const input = clone(good.input); mutate(input); const bytes = Buffer.from(JSON.stringify(input)); fs.writeFileSync(file, bytes);
      const rejected = spawnSync(process.execPath, [path.join(__dirname, 'forge-empirical-evaluation.js'), '--input', file,
        '--sha256', sha256(bytes), '--root', good.area], { encoding: 'utf8' });
      assert.equal(rejected.status, 0, rejected.stderr);
      assert.equal(JSON.parse(rejected.stdout).cases.find(row => row.arm === 'combined').eligible, false);
    }
    const declarations = combinedSetup(); declarations.refresh();
    declarations.protocols.combined.registrations[0].isolated_comparisons = ['memory', 'procedure', 'preparation', 'review']
      .map(arm => ({ arm, case_id: `invented-${arm}`, valid: true, comparable: true }));
    assert(declarations.report().cases.find(row => row.arm === 'combined').exclusions.includes('combined_isolation_unproven'));
    const malformed = combinedSetup(); malformed.refresh(); delete malformed.outcomes['isolated-combined'].controls;
    assert.equal(malformed.report().cases.find(row => row.arm === 'combined').eligible, false);
  });
  test('recommendations integrate trusted caller context without changing dimensions or defaults', () => {
    const s = setup(firstTwo, false); s.refresh();
    const context = { risk: 'high', review: { trigger: 'always', style: 'dialectic' },
      diff: { ok: false, entries: [] }, verificationDrift: true };
    s.input.approved = true; s.input.policyContext = { risk: 'low', approved: true };
    const original = JSON.stringify(s.input);
    const before = buildEmpiricalEvaluation(s.input, { roots: [s.area] });
    const after = buildEmpiricalEvaluation(s.input, { roots: [s.area], policyContext: context });
    assert.deepEqual(after.cases, before.cases); assert.deepEqual(after.populations, before.populations);
    assert.equal(after.prospective_cases, before.prospective_cases);
    assert.equal(after.comparative_ready, false); assert.equal(after.functional_gain, null);
    assert.deepEqual(after.decision, before.decision); assert.equal(after.recommendations.apply_policy, false);
    assert.equal(after.recommendations.configured.review.decision, 'dialectic');
    assert(after.recommendations.candidates[0].reasons.includes('verification-drift'));
    assert(before.recommendations.candidates[0].reasons.includes('risk-not-low'));
    assert.equal(JSON.stringify(s.input), original);
    const markdown = renderEmpiricalEvaluation(after);
    assert(markdown.includes('Read-only recommendations'));
    assert(markdown.includes('retain-defaults/insufficient-evidence'));
    assert(markdown.includes('verification-drift'));
  });
  test('all treatment arms have distinct recommendations and imported prefs do not override defaults', () => {
    for (const arm of ['memory', 'procedure', 'preparation', 'review', 'combined']) {
      const s = setup(firstTwo); s.policy.arm = arm; s.input.candidates[0].arm = arm;
      s.policy.review = 'disabled'; s.policy.approved = true;
      const report = s.report(); const recommendation = report.recommendations.candidates[0];
      assert.equal(recommendation.arm, arm);
      assert.equal(recommendation.recommendation, 'retain-defaults/insufficient-evidence');
      assert(recommendation.reasons.includes('zero-eligible-prospective-cases'));
      assert.equal(report.recommendations.configured.review_config.mode, 'enabled');
      assert.equal(report.recommendations.authorization.granted, false);
      assert.equal(report.prospective_cases, 0);
    }
  });
  test('synthetic matrix retains independent dimensions, exclusions and zero real sample', () => {
    const s = setup(); const report = s.report(); const first = report.cases.find(row => row.id === firstTwo[0].id);
    assert.equal(first.dimensions.functional.value, true); assert.equal(first.dimensions.exception.value, true);
    assert.equal(first.dimensions.canonical_autonomy.value, false); assert.equal(first.dimensions.tests.value, 0.5);
    assert.equal(first.dimensions.tests.numerator, 1); assert.equal(first.dimensions.tests.denominator, 2);
    assert.equal(first.dimensions.human_effort.value, 700);
    assert.equal(first.dimensions.duration.value, null); assert.equal(first.dimensions.duration.state, 'unknown');
    assert.equal(first.dimensions.cost.value, null); assert.equal(report.prospective_cases, 0);
    assert.equal(report.functional_gain, null); assert.equal(report.comparative_ready, false);
    assert.equal(report.decision.status, 'preserve-defaults'); assert.equal(report.decision.apply_policy, false);
    assert.equal(report.cases.length, fixtures.cases.length);
    assert(report.cases.every(row => row.exclusions.includes('synthetic_not_real_sample')));
    assert.deepEqual(Object.keys(first.dimensions).sort(), DIMENSIONS.slice().sort());
  });
  // False synthetic flags below are adversarial metadata for contract tests,
  // never saved observations or evidence of real prospective effectiveness.
  test('two controlled families meet only the eligibility floor, never efficacy', () => {
    const s = setup(firstTwo, false); const report = s.report();
    assert(report.cases.every(row => row.eligible), JSON.stringify(report.cases.map(row => row.exclusions)));
    assert.equal(report.prospective_cases, 2); assert.equal(report.candidates[0].sample_floor_met, true);
    assert.equal(report.comparative_ready, false); assert.equal(report.functional_gain, null);
    const metric = report.candidates[0].dimensions_by_split.prospective.functional;
    assert.equal(metric.numerator, 1); assert.equal(metric.denominator, 2); assert.equal(metric.coverage, 0.5);
    assert.equal(metric.states.unknown, 1);
    s.input.cases[1].family_id = s.input.cases[0].family_id;
    s.protocol.registrations[1].family_id = s.input.cases[0].family_id;
    assert.equal(s.report().candidates[0].sample_floor_met, false);
  });
  test('missing and post-outcome criteria cannot authorize eligibility', () => {
    for (const key of ['hypothesis', 'primary_dimension', 'non_regression', 'risk', 'review', 'rejection_criteria', 'minimum_sample', 'split_sha256']) {
      const s = setup(firstTwo, false); delete s.policy[key];
      assert(s.report().cases.every(row => !row.eligible && row.exclusions.some(reason => reason.startsWith('policy_missing:'))), key);
    }
    const s = setup(firstTwo, false); s.policy.updated_at = '2026-01-04T00:00:00Z';
    assert(s.report().cases.every(row => row.exclusions.includes('policy_not_prior_to_outcome')));
    delete s.protocol.registrations; assert(s.report().cases.every(row => row.exclusions.includes('registration_missing_or_not_prior')));
  });
  test('executed model effort host transport preparation review and budgets are bound', () => {
    for (const field of ['model', 'effort', 'host', 'transport', 'preparation', 'review', 'budgets', 'input_sha256', 'version']) {
      const s = setup(firstTwo, false); const value = field === 'budgets' ? { context: 2 } : field === 'input_sha256' ? sha256('changed') : 'changed';
      s.outcomes[firstTwo[0].id].controls[field] = value;
      const row = s.report().cases.find(item => item.id === firstTwo[0].id);
      assert(row.exclusions.includes('executed_controls_unbound'), field);
      assert(row.exclusions.includes('non_equivalent_controls'), field);
    }
    const s = setup(firstTwo, false); delete s.outcomes[firstTwo[0].id].controls;
    assert(s.report().cases.find(row => row.id === firstTwo[0].id).exclusions.includes('executed_controls_unbound'));
  });
  test('isolated preparation and review arms allow only their treatment axis', () => {
    for (const arm of ['preparation', 'review']) {
      const s = setup(firstTwo, false); s.policy.arm = arm; s.input.candidates[0].arm = arm;
      for (const row of s.protocol.registrations) row.controls[arm] = 'reduced';
      for (const outcome of Object.values(s.outcomes)) outcome.controls[arm] = 'reduced';
      assert(s.report().cases.every(row => row.eligible), arm);
    }
    const s = setup(firstTwo, false); s.policy.arm = 'combined'; s.input.candidates[0].arm = 'combined';
    assert(s.report().cases.every(row => row.exclusions.includes('combined_isolation_unproven')));
    for (const outcome of Object.values(s.outcomes)) outcome.isolated_components = ['memory', 'procedure', 'preparation', 'review'];
    assert(s.report().cases.every(row => row.exclusions.includes('combined_isolation_unproven')));
  });
  test('failures remain visible and split contamination never becomes tuning', () => {
    const s = setup(firstTwo, false); s.outcomes[firstTwo[0].id].status = 'failed';
    assert(s.report().cases.find(row => row.id === firstTwo[0].id).failed);
    s.input.cases[1].family_id = s.input.cases[0].family_id; s.input.cases[1].split = 'adjustment';
    const report = s.report(); assert(report.cases.every(row => row.exclusions.includes('family_split_contamination')));
    assert.equal(report.populations.adjustment.case_ids.length, 1); assert.equal(report.populations.prospective.case_ids.length, 1);
  });
  test('duplicate versions cannot inflate delivery denominators and conflicts stay visible', () => {
    const s = setup(firstTwo, false); s.input.cases.push(clone(s.input.cases[0]));
    assert.equal(s.report().cases.length, 2); assert.equal(s.report().prospective_cases, 2);
    s.input.cases[1].delivery_id = s.input.cases[0].delivery_id;
    s.baseline.cases[1].delivery_id = s.input.cases[0].delivery_id;
    const report = s.report(); const metric = report.populations.prospective.dimensions.functional;
    assert.equal(metric.denominator, 1); assert.equal(metric.states.conflict, 1);
    assert(report.cases.every(row => row.exclusions.includes('delivery_identity_conflict')));
    s.input.cases.push({ ...s.input.cases[0], family_id: 'changed' }); assert.throws(() => s.report(), /case_identity_conflict/);
  });
  test('real builder APIs preserve package estimates and compare S03/S04 controls', () => {
    const fixture = createProcedureFixture();
    const s = setup(firstTwo); const variants = [{ ...fixture.after, variant: 'baseline' }, { ...fixture.after, variant: 'current' }];
    const context = { schema_version: 1, cases: [{ case_id: firstTwo[0].id, variants }] };
    const procedure = { schema_version: 1, before: fixture.after, after: fixture.after };
    s.input.sources.push(writeSource(s.area, 'context', 'context-comparison', context));
    s.input.sources.push(writeSource(s.area, 'procedure', 'procedure-evidence', procedure));
    s.input.cases[0].context_source = 'context'; s.input.cases[0].procedure_source = 'procedure';
    let report = s.report(); assert.equal(report.technical_evidence.context.cases[0].comparable, true);
    assert.equal(report.technical_evidence.procedure.comparable, true);
    const final = captureFinal({ context: 'public fixture package', request: { text: 'public fixture package' }, identity: { dispatchId: 'fixture-dispatch' },
      model: 'fixture-model', transport: 'native', effort: 'high', budgets: { context: 3000 } });
    const observation = { id: 'package', kind: 'package', final, context: 'public fixture package' };
    const ref = s.baseline.cases[0].sources[0]; const body = JSON.parse(fs.readFileSync(path.join(s.area, ref.path)));
    body.observations.push(observation); Object.assign(ref, { sha256: writeSource(s.area, ref.id, 'observations', body).sha256 });
    report = s.report(); const row = report.cases.find(item => item.id === firstTwo[0].id);
    assert.equal(row.dimensions.package_bytes.state, 'observed'); assert.equal(row.dimensions.package_tokens.state, 'estimated');
    assert.equal(row.dimensions.provider_input_tokens.state, 'unknown'); assert.equal(row.dimensions.cost.state, 'unknown');
    // These are the actual builder output shapes used by S02/S03/S04 catalogs.
    const baselineReport = buildEmpiricalBaseline(s.baseline, { roots: [s.area], synthetic: true });
    const replays = [['baseline-replay', 'baseline-report', baselineReport], ['context-replay', 'context-report', buildContextComparison(context)],
      ['procedure-replay', 'procedure-report', buildProcedureEvidence(fixture.after, fixture.after, { synthetic: true })]];
    for (const [id, kind, data] of replays) s.input.sources.push(writeSource(s.area, id, kind, data, false));
    Object.assign(s.input.cases[0], { baseline_source: 'baseline-replay', context_source: 'context-replay', procedure_source: 'procedure-replay' });
    report = s.report(); assert.deepEqual(report.diagnostics, []);
    assert(report.cases[0].exclusions.includes('historical_report_replay_only')); assert(report.cases[0].synthetic);
    assert.equal(report.technical_evidence['baseline-replay'].digest, baselineReport.digest);
    assert.equal(report.prospective_cases, 0);
  });
  test('nested input/autonomy manifests fail closed without dropping selected cases', () => {
    for (const key of ['input', 'autonomy']) {
      const s = setup(firstTwo, false); s.baseline.cases[0][key] = { path: 'PRIVATE_PATH_SENTINEL' };
      const report = s.report(); assert.equal(report.cases.length, 2); assert.equal(report.prospective_cases, 0);
      assert.equal(report.diagnostics[0].code, 'baseline_nested_manifest_unsupported');
      assert(report.cases.every(row => row.dimensions.duration.state === 'unknown'));
      assert(!JSON.stringify(report).includes('PRIVATE_PATH_SENTINEL'));
    }
  });
  test('hash errors, missing files and traversal remain diagnostics with selected rows', () => {
    for (const change of [ref => { ref.sha256 = '0'.repeat(64); }, ref => { ref.path = 'missing.json'; }, ref => { ref.path = '../escape.json'; },
      ref => { ref.path = 'file.json:stream'; }, ref => { ref.revision = ''; }]) {
      const s = setup(firstTwo, false); s.refresh(); change(s.input.sources[1]);
      const report = buildEmpiricalEvaluation(s.input, { roots: [s.area] });
      assert.equal(report.cases.length, 2); assert.equal(report.prospective_cases, 0); assert(report.diagnostics.length);
      assert(!JSON.stringify(report.diagnostics).includes(s.area));
    }
    const s = setup(firstTwo); s.refresh(); const ref = s.input.sources[1];
    assert.throws(() => readEvaluationSource(ref, [s.area], { bytes: LIMITS.total_bytes }), /total_bytes_exceeded/);
    fs.writeFileSync(path.join(s.area, ref.path), Buffer.alloc(LIMITS.file_bytes + 1));
    assert.throws(() => readEvaluationSource(ref, [s.area], { bytes: 0 }));
    const target = path.join(s.area, 'linked'); fs.symlinkSync(s.area, target, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => readEvaluationSource({ ...ref, path: 'linked/protocol.json' }, [s.area], { bytes: 0 }));
  });
  test('bounded schema and sanitized command data do not create execution authority', () => {
    const s = setup(firstTwo); s.input.sources[0].command = 'PRIVATE_COMMAND_SENTINEL';
    s.protocol.command = 'PRIVATE_COMMAND_SENTINEL'; s.outcomes[firstTwo[0].id].command = 'PRIVATE_COMMAND_SENTINEL';
    s.protocol.registrations[0].outcome = 'PRIVATE_OUTCOME_SENTINEL';
    const report = s.report(); assert(!JSON.stringify(report).includes('PRIVATE_'));
    assertContract(s.input, schema.$defs.input); assertContract(report, schema.$defs.report);
    for (const start of Object.values(s.starts)) assertContract(start, schema.$defs.executionStart);
    assert.throws(() => buildEmpiricalEvaluation({ ...s.input, sources: Array(LIMITS.sources + 1).fill({}) }, { roots: [s.area] }));
    assert.equal(schema.$defs.dimension.properties.state.enum.includes('estimated'), true);
    for (const key of ['input', 'report', 'source', 'policy', 'dimension', 'case', 'recommendation']) assert(schema.$defs[key], key);
    assert.deepEqual(schema.$defs.report.properties.cases.items.$ref, '#/$defs/case');
    assert.equal(schema.$defs.recommendation.properties.apply_policy.const, false);
  });
  test('CLI JSON and Markdown agree, require external roots/hash, and never write', () => {
    const s = setup(firstTwo); s.refresh(); const file = path.join(s.area, 'evaluation.json'); fs.writeFileSync(file, JSON.stringify(s.input));
    const args = [path.join(__dirname, 'forge-empirical-evaluation.js'), '--input', file, '--sha256', sha256(fs.readFileSync(file)), '--root', s.area];
    const beforeFiles = fs.readdirSync(s.area).sort(); const json = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(json.status, 0, json.stderr); const report = JSON.parse(json.stdout);
    const markdown = spawnSync(process.execPath, [...args, '--markdown'], { encoding: 'utf8' });
    assert.equal(markdown.status, 0, markdown.stderr); assert.equal(markdown.stdout, renderEmpiricalEvaluation(report));
    for (const dimension of DIMENSIONS) assert(markdown.stdout.includes(dimension));
    assert(markdown.stdout.includes('synthetic&#95;not&#95;real&#95;sample'));
    for (const ref of s.input.sources) {
      assert(markdown.stdout.includes(ref.sha256)); assert(markdown.stdout.includes(ref.captured_at)); assert(markdown.stdout.includes(ref.revision));
    }
    assert(markdown.stdout.includes(s.controls.component_sha256)); assert(markdown.stdout.includes(s.policy.updated_at));
    assert.deepEqual(fs.readdirSync(s.area).sort(), beforeFiles);
    const noRoot = spawnSync(process.execPath, args.slice(0, -2), { encoding: 'utf8' }); assert.equal(noRoot.status, 2);
    const invalid = spawnSync(process.execPath, [...args.slice(0, 4), '0'.repeat(64), '--root', s.area], { encoding: 'utf8' });
    assert.equal(invalid.status, 2); assert(!invalid.stderr.includes(s.area)); assert(!invalid.stderr.includes('PRIVATE_'));
  });
  process.stdout.write(`passed ${passed} empirical evaluation contract tests (synthetic, no provider calls)\n`);
} finally {
  const absolute = path.resolve(root);
  if (path.dirname(absolute) !== temporaryParent || !path.basename(absolute).startsWith('forge-evaluation-')) throw new Error('unsafe_fixture_cleanup');
  fs.rmSync(absolute, { recursive: true, force: true });
}
