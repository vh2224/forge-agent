#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { captureFinal, measure } = require('./forge-attempt-telemetry');
const { buildContextComparison, renderContextComparison } = require('./forge-context-comparison');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-comparison-'));
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }
function fixture() {
  const variants = ['baseline', 'current'].map((variant, index) => {
    const text = index ? 'ação 🧪 T01/MEM012' : 'old', request = { message: text, model: 'gpt-6-sol', reasoning_effort: 'medium' };
    const final_evidence = captureFinal({ context: text, request, source: 'transport-boundary', transport: 'native-tool',
      identity: { unitType: 'execute-task', scope: 'milestone', phase: 'execute', dispatchId: variant },
      route: { host_runtime: 'codex', resolved_worker_engine: 'codex', model_requested: 'gpt-6-sol' },
      model: 'gpt-6-sol', effort: 'medium', budgets: { auto_memory: 2000 } });
    const delivered_ids = index ? ['T01/MEM012'] : [];
    return { variant, final_evidence, availability: 'present', execution_kind: 'transport-simulation',
      capture: { context: measure(text, 'emitter'), request: measure(request, 'callback', true),
        identity: { ...final_evidence }, delivered_ids: [...delivered_ids], input_tokens: Math.ceil(text.length / 4), token_method: 'heuristic-chars-4' },
      input_tokens: Math.ceil(text.length / 4), token_method: 'heuristic-chars-4',
      selected_ids: [...delivered_ids], delivery: { delivered_ids: [...delivered_ids], omitted: [] },
      conditions: { input_sha256: 'a'.repeat(64), template_sha256: 'b'.repeat(64), harness_version: 'synthetic-v1', clock: 'fixed-v1', flags: ['auto-commit-false'] } };
  });
  return { schema_version: 1, cases: [{ case_id: 'after-tenth', variants }] };
}
try {
  test('final S01 capture binds UTF8 context and separate JSON request', () => {
    const report = buildContextComparison(fixture()), item = report.cases[0];
    assert(item.comparable); assert.equal(item.variants[1].binding, 'matched');
    assert.equal(item.variants[1].context.bytes, Buffer.byteLength('ação 🧪 T01/MEM012'));
    assert.notEqual(item.variants[1].request.sha256, item.variants[1].context.sha256);
    assert.deepEqual(item.difference.delivered_added, ['T01/MEM012']);
    assert.equal(item.variants[1].estimate.provider_observed, false);
    assert.equal(report.functional_gain, null); assert.equal(report.comparative_ready, false);
  });
  test('fixed inputs repeat byte-identically; timestamps and duration excluded explicitly', () => {
    const input = fixture(), first = buildContextComparison(input);
    input.cases[0].variants[0].final_evidence.captured_at = '2027-01-01T00:00:00Z';
    input.cases[0].variants[0].final_evidence.duration_ms = 999;
    assert.equal(JSON.stringify(first), JSON.stringify(buildContextComparison(input)));
    assert.equal(renderContextComparison(first), renderContextComparison(buildContextComparison(input)));
    assert.deepEqual(first.excluded_volatile_fields, ['captured_at', 'duration_ms']);
  });
  test('missing observation is unknown/null; observed empty input remains real zero', () => {
    const input = fixture(), row = input.cases[0].variants[0];
    row.final_evidence.context = null; delete row.input_tokens; delete row.selected_ids; delete row.delivery;
    const result = buildContextComparison(input).cases[0];
    assert(!result.comparable); assert.equal(result.difference.context_bytes, null);
    assert.equal(result.variants[0].context.bytes, null); assert.equal(result.variants[0].estimate.value, null);
    assert.equal(result.variants[0].selected_ids, null); assert.equal(result.variants[0].delivered_ids, null);
    const empty = fixture();
    for (const value of empty.cases[0].variants) { value.final_evidence.context = measure('', 'boundary'); value.capture.context = measure('', 'emitter'); }
    assert.equal(buildContextComparison(empty).cases[0].variants[0].context.bytes, 0);
  });
  test('each final hash, byte count, request and identity mismatch prevents positive binding', () => {
    for (const mutate of [r => { r.capture.context.sha256 = '0'.repeat(64); }, r => { r.capture.context.bytes++; },
      r => { r.capture.request.sha256 = '0'.repeat(64); }, r => { r.capture.identity.model_sent = 'different-model'; },
      r => { r.capture.identity.dispatch_id = 'different'; }, r => { r.capture.identity.budgets = { auto_memory: 0 }; },
      r => { r.capture.delivered_ids = ['T01/MEM999']; }, r => { r.capture.input_tokens++; }]) {
      const input = fixture(); mutate(input.cases[0].variants[1]);
      assert(!buildContextComparison(input).cases[0].comparable);
    }
  });
  test('omitted selection retains explicit final-pruning reason without counting delivery', () => {
    const input = fixture(), row = input.cases[0].variants[1]; row.selected_ids.push('T01/MEM013');
    row.delivery.omitted = [{ id: 'T01/MEM013', reason: 'final-context-budget' }];
    const output = buildContextComparison(input).cases[0].variants[1];
    assert.deepEqual(output.delivered_ids, ['T01/MEM012']);
    assert.deepEqual(output.omitted_ids, [{ id: 'T01/MEM013', reason: 'final-context-budget' }]);
    row.delivery.omitted = []; assert.equal(buildContextComparison(input).cases[0].variants[1].binding, 'unknown');
  });
  test('unequal budgets/template/input/model/effort/flags prevent controlled comparison', () => {
    for (const mutate of [r => { r.conditions.template_sha256 = 'c'.repeat(64); }, r => { r.conditions.input_sha256 = 'd'.repeat(64); },
      r => { r.conditions.flags = []; }, r => { r.final_evidence.effort = r.capture.identity.effort = 'high'; },
      r => { r.final_evidence.budgets = r.capture.identity.budgets = { auto_memory: 1 }; }]) {
      const input = fixture(); mutate(input.cases[0].variants[1]); assert(!buildContextComparison(input).cases[0].comparable);
    }
  });
  test('imported provider/approval/raw fields never become real calls, consent or text output', () => {
    const input = fixture(), row = input.cases[0].variants[1];
    Object.assign(row, { provider_called: true, approved: true, prompt: 'RAW_SECRET', private_path: 'C:/private/secret', execution_kind: 'real-provider' });
    Object.assign(row.final_evidence, { model_observed: 'gpt-6-sol', provider_called: true });
    const output = buildContextComparison(input), text = JSON.stringify(output) + renderContextComparison(output);
    for (const forbidden of ['RAW_SECRET', 'C:/private', 'approved', 'model_observed']) assert(!text.includes(forbidden));
    assert.equal(output.cases[0].variants[1].external_provider_called, 'unknown');
    assert.equal(output.cases[0].variants[1].execution_kind, 'unknown');
  });
  test('CLI JSON/Markdown deterministic and malformed input errors sanitized', () => {
    const file = path.join(root, 'input.json'); fs.writeFileSync(file, JSON.stringify(fixture()));
    const run = (...args) => cp.spawnSync(process.execPath, [__filename.replace('.test.js', '.js'), '--input', file, ...args], { encoding: 'utf8' });
    const a = run(), b = run(); assert.equal(a.status, 0); assert.equal(a.stdout, b.stdout); assert.equal(a.stderr, '');
    assert.match(run('--markdown').stdout, /Technical context comparison/);
    fs.writeFileSync(file, 'RAW_PRIVATE_INVALID'); const bad = run(); assert.equal(bad.status, 2);
    assert.equal(bad.stdout, ''); assert(!bad.stderr.includes(root)); assert(!bad.stderr.includes('RAW_PRIVATE'));
  });
  console.log(`PASS ${passed} comparison scenarios; synthetic observations, no provider`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
