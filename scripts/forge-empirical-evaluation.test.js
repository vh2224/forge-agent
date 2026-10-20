#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildEmpiricalEvaluation, renderEmpiricalEvaluation, readEvaluationSource, DIMENSIONS, LIMITS } = require('./forge-empirical-evaluation');
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
    acceptance_sha256: sha256('acceptance'), enrolled_at: '2026-01-02T00:00:00Z', controls: clone(controls) })) };
  const baseline = { schema_version: 1, cases: rows.map(row => {
    const ref = writeSource(area, `observations-${row.id}`, 'observations', { schema_version: 1, case_id: row.id, observations: row.observations }, synthetic);
    return { id: row.id, delivery_id: `delivery-${row.id}`, conditions: ['fixture'], sources: [{ ...ref, format: 'observations', origin: 'synthetic' }] };
  }) };
  const sources = [writeSource(area, 'protocol', 'protocol', protocol, synthetic), writeSource(area, 'baseline', 'baseline', baseline, synthetic)];
  const outcomes = {};
  for (const row of rows) {
    outcomes[row.id] = { schema_version: 1, case_id: row.id, occurred_at: '2026-01-03T00:00:00Z', status: 'completed',
      controls: clone(controls), baseline_controls: clone(controls), repetition: 1 };
    sources.push(writeSource(area, `outcome-${row.id}`, 'outcome', outcomes[row.id], synthetic));
  }
  const input = { schema_version: 1, kind: 'empirical-evaluation-input', sources,
    candidates: [{ id: policy.id, arm: policy.arm, protocol_source: 'protocol' }], cases: rows.map(row => ({
      id: row.id, delivery_id: `delivery-${row.id}`, candidate_id: policy.id, family_id: row.family_id, split: row.split,
      evidence_type: synthetic ? 'synthetic' : row.split === 'historical-diagnostic' ? 'historical' : 'prospective', synthetic,
      baseline_source: 'baseline', baseline_case_id: row.id, outcome_source: `outcome-${row.id}` })) };
  const refresh = () => {
    protocol.candidate = policy; for (const row of protocol.registrations || []) row.policy_sha256 = fingerprint(policy);
    Object.assign(sources.find(ref => ref.id === 'protocol'), writeSource(area, 'protocol', 'protocol', protocol, synthetic));
    Object.assign(sources.find(ref => ref.id === 'baseline'), writeSource(area, 'baseline', 'baseline', baseline, synthetic));
    for (const [id, outcome] of Object.entries(outcomes)) Object.assign(sources.find(ref => ref.id === `outcome-${id}`), writeSource(area, `outcome-${id}`, 'outcome', outcome, synthetic));
  };
  return { area, input, controls, split, policy, protocol, baseline, outcomes, refresh,
    report: () => { refresh(); return buildEmpiricalEvaluation(input, { roots: [area] }); } };
}
const firstTwo = fixtures.cases.slice(0, 2);
try {
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
    assert(s.report().cases.every(row => row.eligible));
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
