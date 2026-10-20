#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildEmpiricalBaseline, measureTemplateBaseline, renderBaseline } = require('./forge-empirical-baseline');
const { captureFinal } = require('./forge-attempt-telemetry');
const { buildDispatchEvent } = require('./forge-dispatch-event');
const { createSplit } = require('./forge-empirical-input');
const { sha256 } = require('./forge-delivery');
const { TEMPLATE_FILES } = require('./forge-prompt');
const fixture = require('./fixtures/empirical-corpus/baseline/cases.json');
const inputFixture = require('./fixtures/empirical-corpus/isolation/cases.json');
const schema = require('../shared/schemas/empirical-baseline.schema.json');
const parent = fs.realpathSync.native(os.tmpdir());
const root = fs.mkdtempSync(path.join(parent, 'forge-baseline-'));
let passed = 0; let sequence = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`ok - ${name}\n`); }
function directory(prefix) { const dir = path.join(root, `${prefix}-${sequence++}`); fs.mkdirSync(dir); return dir; }
function source(area, caseId, observations, extra = {}) {
  const id = `source-${sequence++}`; const file = path.join(area, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, case_id: caseId, observations }));
  return { id, path: file, sha256: sha256(fs.readFileSync(file)), origin: 'synthetic', format: 'observations', ...extra };
}
function setup(observations = [], id = 'sample') {
  const area = directory('case');
  const c = { id, sources: [source(area, id, observations)] };
  const input = { schema_version: 1, cases: [c] }; const options = { roots: [area], synthetic: true };
  return { area, c, input, options, report: () => buildEmpiricalBaseline(input, options) };
}
const dimension = (s, key) => s.report().cases[0].dimensions[key];
function canonical(s) {
  fs.mkdirSync(path.join(s.area, '.gsd')); fs.writeFileSync(path.join(s.area, '.gsd', 'PROJECT.md'), '# fixture');
  const manifest = { schema_version: 1, owner_root: s.area, target: { type: 'task', id: 'TASK-014' },
    sources: { gates: [], events: [], results: [] } };
  s.c.autonomy = manifest;
  const write = (kind, value) => {
    const file = `${kind}-${sequence++}.json${kind === 'events' ? 'l' : ''}`;
    fs.writeFileSync(path.join(s.area, file), kind === 'events' ? value.map((r) => JSON.stringify(r)).join('\n') + '\n' : JSON.stringify(value));
    manifest.sources[kind].push(file); return path.join(s.area, file);
  };
  return { manifest, write };
}
function event(id) {
  return buildDispatchEvent({ unit: 'execute-task/TASK-014', dispatchId: id, ts: '2026-01-01T00:00:00Z' },
    { dispatch_allowed: true, model: 'fixture', worker_mode: 'native', host_runtime: 'codex',
      resolved_worker_engine: 'codex', dispatch_reason_code: 'fixture', dispatch_posture: 'native',
      dispatch_decision: 'dispatch', tier: 'heavy', reason: 'fixture', effort: 'high',
      effort_reason: 'fixture', engine: 'codex', domain: 'fixture', route_source: 'fixture', chain_len: 0 }, '2026-01-01T00:00:00Z');
}
function result(id, start, finish, seconds) { return { status: 'done', dispatch_id: id,
  started_at: `2026-01-01T00:00:${start}Z`, finished_at: `2026-01-01T00:00:${finish}Z`, duration_secs: seconds,
  summary: 'PRIVATE_SOLUTION_SENTINEL', prompt: 'PRIVATE_PROMPT_SENTINEL' }; }
function packageObservation(context) {
  const final = captureFinal({ context, request: { text: 'PRIVATE_REQUEST_SENTINEL' },
    identity: { dispatchId: 'package-1', cwd: 'PRIVATE_PATH_SENTINEL' },
    route: { model_requested: 'requested-model', host_runtime: 'codex', resolved_worker_engine: 'codex' },
    model: 'sent-model', transport: 'native', effort: 'high', budgets: { input: 1000 } });
  final.captured_at = '2026-02-01T00:00:00Z'; final.model_observed = 'observed-model';
  return { id: 'package-record', kind: 'package', final, ...(context === undefined ? {} : { context }) };
}

try {
  test('canonical case versions retain distinct rows and delivery denominator', () => {
    const s = setup([{ kind: 'tests', id: 'check', passed: true, checks: [{ id: 't', exit_code: 0 }] }], 'canonical');
    s.c.case_id = 'canonical'; s.c.version = 'v1'; s.c.id = 'version:one'; s.c.delivery_id = 'delivery:one';
    const second = { ...s.c, id: 'version:two', version: 'v2', sources: [source(s.area, 'canonical', [{ kind: 'tests', id: 'check', passed: false, checks: [{ id: 't', exit_code: 1 }] }])] };
    s.input.cases.push({ ...second, sources: s.c.sources });
    assert.equal(s.report().cases.length, 2, 'identical evidence does not collapse distinct versions');
    s.input.cases[1] = second; const report = s.report();
    assert.equal(report.cases.length, 2); assert.equal(report.coverage.tests.denominator, 1);
    assert.equal(report.cases[0].dimensions.tests.value, 1); assert.equal(report.cases[1].dimensions.tests.value, 0);
    assert(report.cases.every((r) => r.diagnostics.length === 0));
  });
  test('independent dimensions, partial checks, denominators and observed zero cost', () => {
    const area = directory('matrix');
    const cases = fixture.cases.map((c) => ({ id: c.id, delivery_id: c.delivery_id, conditions: c.conditions,
      sources: [source(area, c.id, c.observations, { component: 'forge', revision: 'v1', captured_at: '2026-02-01T00:00:00Z' })] }));
    const report = buildEmpiricalBaseline({ schema_version: 1, cases }, { roots: [area], synthetic: true });
    const first = report.cases.find((c) => c.id === 'functional-with-exception').dimensions;
    assert.strictEqual(first.functional.value, true); assert.strictEqual(first.exception.value, true);
    assert.strictEqual(first.canonical_autonomy.value, false); assert.strictEqual(first.tests.value, 0.5);
    assert.strictEqual(first.tests.numerator, 1); assert.strictEqual(first.tests.denominator, 2);
    assert.strictEqual(first.uat.value, null); assert.strictEqual(first.human_effort.value, 700);
    const zero = report.cases.find((c) => c.id === 'zero-observed-cost').dimensions;
    assert.strictEqual(zero.cost.value, 0); assert.strictEqual(zero.cost.state, 'derived');
    assert.strictEqual(zero.provider_input_tokens.state, 'observed');
    assert.strictEqual(report.coverage.cost.numerator, 1); assert.strictEqual(report.coverage.cost.denominator, 3);
    assert.strictEqual(report.cases[0].provenance[0].revision, 'v1');
    assert.deepStrictEqual(Object.keys(report.cases[0].dimensions).sort(), schema.properties.cases.items.properties.dimensions.required.slice().sort());
  });

  test('completion, imported summaries and recovery never prove UAT or cost', () => {
    const s = setup(); const file = path.join(s.area, 'summary.md');
    fs.writeFileSync(file, '# approved\nstatus: done\nUAT passed\nrecovery complete\nPRIVATE_SOLUTION_SENTINEL');
    s.c.sources.push({ id: 'summary', path: file, sha256: sha256(fs.readFileSync(file)), origin: 'synthetic', format: 'document' });
    const c = s.report().cases[0];
    for (const key of ['uat', 'cost', 'functional', 'duration']) assert.strictEqual(c.dimensions[key].value, null);
    assert.strictEqual(c.documents[0].canonical, false); assert(!JSON.stringify(c).includes('PRIVATE_SOLUTION_SENTINEL'));
  });

  test('same observations dedupe and divergent identities remain order-independent conflicts', () => {
    const row = { id: 'functional-1', kind: 'functional', value: true, check_id: 'behavior-1' };
    const s = setup([row, row]); assert.strictEqual(dimension(s, 'functional').denominator, 1);
    s.c.sources.push(source(s.area, s.c.id, [{ ...row, value: false }]));
    assert.strictEqual(dimension(s, 'functional').state, 'conflict');
    s.c.sources.reverse(); assert.strictEqual(dimension(s, 'functional').state, 'conflict');
    s.input.cases.push(s.c); assert.strictEqual(s.report().coverage.functional.denominator, 1);
    s.input.cases.push({ ...s.c, conditions: ['other'] });
    assert.throws(s.report, (e) => e.code === 'case_conflict');
  });

  test('invalid evidence stays invalid and no check-free outcome is promoted', () => {
    const s = setup([{ id: 'broken', kind: 'tests', passed: true, checks: [{ id: 'failing', exit_code: 1 }] },
      { id: 'assertion', kind: 'uat', value: true },
      { id: 'latency', kind: 'human_effort', value: 1000, unit: 'ms', measurement: 'response-latency' }]);
    for (const key of ['tests', 'uat', 'human_effort']) assert.strictEqual(dimension(s, key).state, 'invalid');
  });

  test('absence, foreign roots, changed hashes, malformed and 1 MiB excess have safe diagnostics', () => {
    const s = setup(); const ref = s.c.sources[0];
    const outside = path.join(directory('foreign'), 'PRIVATE_PATH_SENTINEL.json'); fs.writeFileSync(outside, 'PRIVATE_BODY_SENTINEL');
    for (const change of [
      { path: path.join(s.area, 'missing.json') },
      { path: outside },
      { sha256: 'a'.repeat(64) }
    ]) {
      s.c.sources = [{ ...ref, ...change }]; const c = s.report().cases[0];
      assert(c.diagnostics.length); assert.strictEqual(c.dimensions.functional.value, null);
      assert(!JSON.stringify(c).includes('PRIVATE_PATH_SENTINEL')); assert(!JSON.stringify(c).includes('PRIVATE_BODY_SENTINEL'));
    }
    fs.writeFileSync(ref.path, '{PRIVATE_MALFORMED_SENTINEL');
    s.c.sources = [{ ...ref, sha256: sha256(fs.readFileSync(ref.path)) }];
    assert(s.report().cases[0].diagnostics.length);
    fs.writeFileSync(ref.path, Buffer.alloc(1024 * 1024 + 1, 65));
    s.c.sources = [{ ...ref, sha256: sha256(fs.readFileSync(ref.path)) }];
    assert(s.report().cases[0].diagnostics.some((d) => d.code.includes('large')));
    assert(!JSON.stringify(s.report()).includes('PRIVATE_MALFORMED_SENTINEL'));
  });

  test('canonical intervals overlap and duplicate attempts never enlarge duration', () => {
    const s = setup(); const a = canonical(s);
    a.write('events', [event('d1'), event('d2'), event('d1')]);
    a.write('results', result('d1', '00', '10', 10));
    a.write('results', result('d1', '00', '10', 10));
    a.write('results', result('d2', '05', '15', 10));
    const c = s.report().cases[0];
    assert.strictEqual(c.dimensions.duration.value, 15000);
    assert.strictEqual(c.canonical.autonomy.families.time.measures.execution_sum_ms.value, 20000);
    assert(!JSON.stringify(c).includes('PRIVATE_SOLUTION_SENTINEL'));
    assert(!JSON.stringify(c).includes('PRIVATE_PROMPT_SENTINEL'));
  });

  test('inconsistent canonical duration stays conflict rather than zero', () => {
    const s = setup(); const a = canonical(s);
    a.write('events', [event('d1')]); a.write('results', result('d1', '00', '10', 50));
    assert.strictEqual(dimension(s, 'duration').value, null);
    assert.strictEqual(dimension(s, 'duration').state, 'conflict');
  });

  test('canonical sources drifting between the two public helper loads are rejected', () => {
    const s = setup(); const a = canonical(s);
    a.write('events', [event('d1')]); const file = a.write('results', result('d1', '00', '10', 10));
    const original = fs.openSync; let reads = 0;
    fs.openSync = function (candidate, flags, ...args) {
      if (candidate === file && flags === 'r' && ++reads === 2) fs.writeFileSync(file, JSON.stringify(result('d1', '00', '15', 15)));
      return original.call(this, candidate, flags, ...args);
    };
    try { assert.throws(s.report, (e) => e.code === 'autonomy_sources_changed'); }
    finally { fs.openSync = original; }
  });

  test('foreign gate retains exact bytes/cwd as documentary evidence without accepted canonical answer', () => {
    const s = setup(); const a = canonical(s);
    const file = a.write('gates', { schema: 1, id: 'g1', cwd: directory('foreign-cwd'), run_id: 'TASK-014',
      unit_id: 'execute-task/TASK-014', status: 'answered', created_at: 1000,
      answer: { source: 'human', at: 3000 }, question: 'PRIVATE_QUESTION_SENTINEL' });
    const bytes = fs.readFileSync(file); const c = s.report().cases[0];
    assert(c.diagnostics.some((d) => d.code === 'gate_cwd_foreign'));
    assert.strictEqual(c.documents[0].sha256, sha256(bytes)); assert.strictEqual(c.documents[0].canonical, false);
    assert.strictEqual(c.canonical.interventions.value, null); assert.strictEqual(c.dimensions.uat.value, null);
    assert.deepStrictEqual(fs.readFileSync(file), bytes); assert(!JSON.stringify(c).includes('PRIVATE_QUESTION_SENTINEL'));
  });

  test('canonical answer latency remains independent from unobserved active effort', () => {
    const s = setup(); const a = canonical(s);
    a.write('gates', { schema: 1, id: 'g1', cwd: s.area, run_id: 'TASK-014', unit_id: 'execute-task/TASK-014',
      status: 'answered', created_at: 1000, answer: { source: 'human', at: 3000 } });
    const c = s.report().cases[0];
    assert.strictEqual(c.canonical.interventions.value, 1); assert.strictEqual(c.canonical.response_latency.value, 2000);
    assert.strictEqual(c.dimensions.human_effort.value, null);
  });

  test('UTF-8 package bytes/hash, characters estimate and actual provider usage stay separate', () => {
    const context = 'á🙂PRIVATE_CONTEXT_SENTINEL'; const p = packageObservation(context); const s = setup([p]);
    const c = s.report().cases[0];
    assert.strictEqual(c.dimensions.package_bytes.value, Buffer.byteLength(context));
    assert.strictEqual(c.telemetry.context.sha256, sha256(Buffer.from(context)));
    assert.strictEqual(c.dimensions.package_tokens.value, Math.ceil(context.length / 4));
    assert.strictEqual(c.dimensions.package_tokens.state, 'estimated');
    assert.notStrictEqual(Math.ceil(Buffer.byteLength(context) / 4), c.dimensions.package_tokens.value);
    assert.strictEqual(c.dimensions.provider_input_tokens.value, null); assert.strictEqual(c.dimensions.cost.value, null);
    assert.strictEqual(c.telemetry.model_requested, 'requested-model'); assert.strictEqual(c.telemetry.model_sent, 'sent-model');
    assert.strictEqual(c.telemetry.model_observed, 'observed-model'); assert.strictEqual(c.telemetry.provider_called, 'unknown');
    for (const privateValue of ['PRIVATE_CONTEXT_SENTINEL', 'PRIVATE_REQUEST_SENTINEL', 'PRIVATE_PATH_SENTINEL'])
      assert(!JSON.stringify(c).includes(privateValue));
  });

  test('unmeasured context is unknown and hash mismatch is invalid', () => {
    const s = setup([packageObservation(undefined)]);
    assert.strictEqual(dimension(s, 'package_bytes').state, 'unknown');
    assert.strictEqual(dimension(s, 'package_tokens').state, 'unknown');
    s.c.sources = [source(s.area, s.c.id, [{ ...packageObservation('valid'), context: 'changed' }])];
    assert.strictEqual(dimension(s, 'package_tokens').state, 'invalid');
  });

  test('provider observation without compatible priced usage never becomes free cost', () => {
    const usage = { id: 'u1', kind: 'provider_usage', usage_id: 'u1', provider: 'fictional', model: 'model', input_tokens: 25, output_tokens: 10 };
    const s = setup([usage]); assert.strictEqual(dimension(s, 'provider_input_tokens').value, 25);
    assert.strictEqual(dimension(s, 'cost').state, 'unknown'); assert.strictEqual(dimension(s, 'cost').value, null);
    s.c.sources = [source(s.area, s.c.id, [{ ...usage, price: { model: 'other', source: 'price', currency: 'USD', unit: 'per-token', input: 1, output: 2 } }])];
    assert.strictEqual(dimension(s, 'cost').state, 'invalid');
  });

  test('fractional, unsafe and overflowing token/cost/effort aggregates remain invalid', () => {
    const price = { model: 'model', source: 'price', currency: 'USD', unit: 'per-token', input: 1, output: 2 };
    const usage = { id: 'u1', kind: 'provider_usage', usage_id: 'u1', provider: 'fictional', model: 'model', input_tokens: 1, output_tokens: 1, price };
    const s = setup();
    for (const value of [0.5, Number.MAX_SAFE_INTEGER + 1, -1]) {
      s.c.sources = [source(s.area, s.c.id, [{ ...usage, input_tokens: value }])];
      assert.strictEqual(dimension(s, 'provider_input_tokens').state, 'invalid');
      assert.strictEqual(dimension(s, 'cost').state, 'invalid');
    }
    s.c.sources = [source(s.area, s.c.id, [{ ...usage, input_tokens: Number.MAX_SAFE_INTEGER },
      { ...usage, id: 'u2', usage_id: 'u2' }])];
    assert.strictEqual(dimension(s, 'provider_input_tokens').state, 'invalid');
    s.c.sources = [source(s.area, s.c.id, [{ ...usage, input_tokens: 2, price: { ...price, input: Number.MAX_VALUE } }])];
    assert.strictEqual(dimension(s, 'cost').state, 'invalid');
    const hugePrice = { ...price, input: Number.MAX_VALUE, output: 0 };
    s.c.sources = [source(s.area, s.c.id, [{ ...usage, price: hugePrice }, { ...usage, id: 'u2', usage_id: 'u2', price: hugePrice }])];
    assert.strictEqual(dimension(s, 'cost').state, 'invalid');
    s.c.sources = [source(s.area, s.c.id, ['e1', 'e2'].map((id) => ({ id, kind: 'human_effort', measurement: 'active-work', unit: 'ms', value: Number.MAX_VALUE })))];
    assert.strictEqual(dimension(s, 'human_effort').state, 'invalid');
    assert.strictEqual(dimension(s, 'human_effort').value, null);
  });

  test('versions of one delivery preserve a delivery denominator and repeat digest ignores only collection generation', () => {
    const s = setup([{ id: 'f', kind: 'functional', check_id: 'f', value: true }]);
    s.input.cases.push({ id: 'sample-v2', delivery_id: 'sample', sources: [] });
    assert.strictEqual(s.report().coverage.functional.denominator, 1);
    s.options.templateBaseline = { digest: 'a'.repeat(64), generated_at: '2026-01-01T00:00:00Z' };
    const first = s.report(); s.options.templateBaseline.generated_at = '2027-01-01T00:00:00Z';
    assert.strictEqual(s.report().digest, first.digest);
    s.c.sources[0].captured_at = '2028-01-01T00:00:00Z'; assert.notStrictEqual(s.report().digest, first.digest);
    assert.strictEqual(s.report().cases[0].provenance[0].revision, null);
  });

  test('T03 graph/split authority validates hash and historical availability, not captured_at', () => {
    const s = setup(); const corpus = structuredClone(inputFixture.corpus); const text = 'legitimate prework';
    corpus.captured_at = '2026-06-01T00:00:00Z';
    const ref = corpus.references[0]; fs.mkdirSync(path.join(s.area, 'snapshots'));
    fs.writeFileSync(path.join(s.area, ref.path), text);
    Object.assign(ref, { bytes: Buffer.byteLength(text), sha256: sha256(Buffer.from(text)), captured_at: '2026-06-01T00:00:00Z' });
    const manifest = { schema_version: 1, case_id: corpus.candidates[0].case_id, version: 'v1', entries: ['before'],
      nodes: [{ id: 'before', ref_id: 'before', kind: 'prework', dependencies: [] }] };
    const trusted = { sourceRoot: s.area, before: '2026-02-01T00:00:00Z',
      prework: [{ ref_id: 'before', sha256: ref.sha256, available_at: '2026-01-01T00:00:00Z', evidence: 'synthetic revision attestation' }],
      split: createSplit(corpus, { freezeId: 'baseline-fixture', reservedCount: 0 }) };
    s.c.input = { corpus, manifest }; s.options.inputs = { sample: trusted };
    assert(s.report().cases[0].input.sha256); assert.strictEqual(s.report().cases[0].input.split_digest, trusted.split.digest);
    fs.writeFileSync(path.join(s.area, ref.path), 'changed bytes'); assert.throws(s.report);
    fs.writeFileSync(path.join(s.area, ref.path), text);
    trusted.prework[0].available_at = '2026-03-01T00:00:00Z'; assert.throws(s.report);
    trusted.prework[0].available_at = '2026-01-01T00:00:00Z'; trusted.split.digest = 'f'.repeat(64); assert.throws(s.report);
  });

  test('public output requires caller-attested synthetic corpus and excludes raw content', () => {
    const s = setup([packageObservation('PRIVATE_CONTEXT_SENTINEL')]);
    assert(!renderBaseline(s.report(), { public: true }).includes('PRIVATE_CONTEXT_SENTINEL'));
    s.options.synthetic = false; s.input.synthetic = true;
    assert.throws(() => renderBaseline(s.report(), { public: true }), (e) => e.code === 'public_export_requires_synthetic');
  });

  test('procedure corpus is explicit, validated, fingerprinted and drift checked', () => {
    const templateRoot = path.join(__dirname, '..', 'shared', 'templates', 'dispatch');
    const procedureRoot = directory('procedure-source');
    const sourceRoot = path.resolve(__dirname, '..');
    const manifestPath = path.join(procedureRoot, 'shared/forge-procedures.json');
    const originalManifest = fs.readFileSync(path.join(sourceRoot, 'shared/forge-procedures.json'));
    const manifest = JSON.parse(originalManifest);
    for (const relative of ['shared/forge-procedures.json', ...manifest.modules.filter(row => row.status === 'ready').map(row => row.path)]) {
      const target = path.join(procedureRoot, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(sourceRoot, relative), target);
    }
    const measurementRoot = directory('procedure-measurement');
    const options = { templateRoot, procedureRoot, measurementRoot };
    const first = measureTemplateBaseline(options);
    assert.strictEqual(first.conditions.procedure_source.root, procedureRoot);
    assert.strictEqual(first.conditions.procedure_source.inventory.length, 1 + manifest.modules.filter(row => row.status === 'ready').length);
    assert(first.conditions.procedure_source.inventory.every(row => /^[a-f0-9]{64}$/.test(row.sha256)));
    assert.strictEqual(first.totals.unit_types, Object.keys(TEMPLATE_FILES).length);
    const module = manifest.modules.find(row => row.status === 'ready');
    const staged = path.join(measurementRoot, module.path);
    const stagedBytes = fs.readFileSync(staged);
    fs.appendFileSync(staged, '\ntampered');
    assert.throws(() => measureTemplateBaseline(options), e => e.code === 'measurement_procedure_drift');
    fs.writeFileSync(staged, stagedBytes);
    const original = fs.readFileSync(path.join(procedureRoot, module.path));
    fs.appendFileSync(path.join(procedureRoot, module.path), '\ntampered');
    assert.throws(() => measureTemplateBaseline(options), e => e.code === 'procedure-integrity-mismatch');
    fs.writeFileSync(path.join(procedureRoot, module.path), original);
    assert.throws(() => measureTemplateBaseline({ ...options, onRead: () => {
      fs.appendFileSync(manifestPath, ' ');
    } }), e => e.code === 'measurement_procedure_drift');
    fs.writeFileSync(manifestPath, originalManifest);
    // Valid semantic metadata changes affect provenance even when prompt tokens agree.
    manifest.modules[0].tests.push('synthetic-metadata-change');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.unlinkSync(path.join(measurementRoot, 'shared/forge-procedures.json'));
    const changed = measureTemplateBaseline(options);
    assert.notStrictEqual(changed.digest, first.digest);
    assert.notStrictEqual(changed.conditions.procedure_source.manifest_sha256, first.conditions.procedure_source.manifest_sha256);
    fs.writeFileSync(manifestPath, '{}');
    assert.throws(() => measureTemplateBaseline(options), e => e.code === 'procedure-manifest-invalid');
    fs.unlinkSync(manifestPath);
    // A real installation may exist, but is never an alternate source here.
    assert.throws(() => measureTemplateBaseline(options), e => e.code === 'procedure-manifest-missing');
  });

  test('template replay from different source path lengths uses one physical tree and no global event reads', () => {
    const templates = path.join(__dirname, '..', 'shared', 'templates', 'dispatch');
    const short = directory('a'); const long = directory('source-with-much-longer-physical-path');
    const measurement = directory('fixed-measurement');
    for (const dest of [short, long]) for (const name of Object.values(TEMPLATE_FILES)) fs.copyFileSync(path.join(templates, name), path.join(dest, name));
    const sentinelRoot = directory('unrelated-owner'); fs.mkdirSync(path.join(sentinelRoot, '.gsd', 'forge'), { recursive: true });
    const sentinel = path.join(sentinelRoot, '.gsd', 'forge', 'events.jsonl');
    fs.writeFileSync(sentinel, '{"event":"dispatch","input_tokens":999999999,"PRIVATE_GLOBAL_SENTINEL":true}\n');
    const opened = []; const before = fs.readFileSync(sentinel);
    const first = measureTemplateBaseline({ procedureRoot: path.resolve(__dirname, '..'), templateRoot: short, measurementRoot: measurement, onRead: (p) => opened.push(p) });
    const second = measureTemplateBaseline({ procedureRoot: path.resolve(__dirname, '..'), templateRoot: long, measurementRoot: measurement, onRead: (p) => opened.push(p) });
    assert.strictEqual(first.digest, second.digest); assert.deepStrictEqual(first.by_unit_type, second.by_unit_type);
    assert.strictEqual(first.inventory.length, Object.keys(TEMPLATE_FILES).length);
    assert.strictEqual(first.conditions.configuration.inputs, 'deterministic');
    assert(opened.some((p) => p.endsWith('execute-task.md'))); assert(!opened.includes(sentinel));
    assert(!opened.some((p) => /events\.jsonl$/.test(p))); assert.deepStrictEqual(fs.readFileSync(sentinel), before);
    const different = measureTemplateBaseline({ procedureRoot: path.resolve(__dirname, '..'), templateRoot: short, measurementRoot: directory('different-path-for-measurement') });
    assert.notStrictEqual(first.conditions.measurement_root, different.conditions.measurement_root);
    assert.notStrictEqual(first.digest, different.digest);
    assert(first.limitations.includes('not_os_sandbox')); assert(!JSON.stringify(first).includes('PRIVATE_GLOBAL_SENTINEL'));
    fs.unlinkSync(path.join(short, Object.values(TEMPLATE_FILES)[0]));
    assert.throws(() => measureTemplateBaseline({ procedureRoot: path.resolve(__dirname, '..'), templateRoot: short, measurementRoot: measurement }));
    fs.writeFileSync(path.join(measurement, 'unowned-event.json'), '{}');
    assert.throws(() => measureTemplateBaseline({ procedureRoot: path.resolve(__dirname, '..'), templateRoot: long, measurementRoot: measurement }), (e) => e.code === 'measurement_tree_not_owned');
  });
  process.stdout.write(`\n${passed} passed, 0 failed\n`);
} finally {
  const resolved = fs.realpathSync.native(root);
  assert(path.relative(parent, resolved).startsWith('forge-baseline-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
