#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const evidence = require('./forge-procedure-evidence');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
const fixture = evidence.createProcedureFixture();
const copy = value => JSON.parse(JSON.stringify(value));
test('final real renderer/native package is measured without authentic historical baseline', () => {
  const report = evidence.buildProcedureEvidence(fixture.before, fixture.after, { synthetic: true });
  assert.equal(report.comparable, false); assert.equal(report.comparative_ready, false);
  assert.equal(report.provenance.historical_baseline_eligible, false);
  assert.equal(report.difference.context_bytes, null);
  assert(report.after.context.bytes > 1000); assert(report.after.request.bytes > report.after.context.bytes);
  assert.equal(report.after.final_sha256, report.after.context.sha256);
  assert(report.after.modules.some(row => row.id === 'execution'));
  assert(report.after.modules.some(row => row.id === 'core'));
  assert.equal(report.after.estimated_tokens, Math.ceil(report.after.chars / 4));
  assert.equal(report.after.provider_tokens, null); assert.equal(report.functional_gain, null);
  assert.equal(report.prospective_cases, 0); assert.equal(report.closure_guard.status, 'pending-owner-closure');
});
test('same independently bound controls permit only a technical comparison', () => {
  const first = copy(fixture.after), second = copy(fixture.after);
  const report = evidence.buildProcedureEvidence(first, second);
  assert.equal(report.comparable, true); assert.equal(report.difference.context_bytes, 0);
  assert.equal(report.difference.changed, 'observed-package-delta');
  assert(!JSON.stringify(report).includes('memory-selection-only'));
  assert.equal(report.comparative_ready, false); assert.equal(report.functional_gain, null);
});
test('declared package hashes must agree with original template and both final captures', () => {
  for (const mutate of [row => { row.package.template_sha256 = '0'.repeat(64); },
    row => { row.package.final_sha256 = '0'.repeat(64); }, row => { delete row.package.final_sha256; }]) {
    const row = copy(fixture.after); mutate(row);
    const report = evidence.buildProcedureEvidence(row, fixture.after);
    assert.equal(report.comparable, false); assert.equal(report.comparison, null);
    assert(report.limitations.some(reason => reason.includes('package-') && reason.includes('binding-mismatch')));
  }
});
test('R1 original missing budgets/flags are ineligible before S03 normalization', () => {
  for (const mutate of [row => { delete row.controls; }, row => { delete row.final_evidence.budgets; },
    row => { delete row.capture.identity.budgets; }, row => { delete row.conditions.flags; },
    row => { row.controls.budget_policy = {}; }, row => { row.conditions.flags = null; }]) {
    const row = copy(fixture.after); mutate(row);
    const report = evidence.buildProcedureEvidence(row, fixture.after);
    assert.equal(report.comparable, false); assert.equal(report.comparison, null);
    assert(report.limitations.some(reason => reason.includes('R1-')));
  }
});
test('R2 malformed original IDs never become equality after filtering', () => {
  for (const mutate of [row => { row.selected_ids = ['bad']; }, row => { row.delivery.delivered_ids = ['bad']; },
    row => { row.capture.delivered_ids = ['bad']; }, row => { row.delivery.omitted = [{ id: 'bad', reason: 'budget' }]; },
    row => { row.selected_ids = ['T01/MEM001', 'T01/MEM001']; }]) {
    const row = copy(fixture.after); mutate(row);
    const report = evidence.buildProcedureEvidence(row, fixture.after);
    assert.equal(report.comparable, false); assert.equal(report.comparison, null);
    assert(report.limitations.some(reason => reason.includes('R2-')));
  }
});
test('all original matching conditions are required before invoking the prior comparator', () => {
  for (const key of ['input_sha256', 'template_sha256', 'harness_version', 'clock']) {
    const row = copy(fixture.after); delete row.conditions[key];
    const report = evidence.buildProcedureEvidence(row, fixture.after);
    assert.equal(report.comparison, null); assert.equal(report.comparable, false);
    assert(report.limitations.includes('before:comparison-original-controls-unobserved-or-invalid'));
  }
});
test('unknown delivery remains null and Markdown unknown, observed empty remains none', () => {
  const row = copy(fixture.after); row.delivery.delivered_ids = null;
  const report = evidence.buildProcedureEvidence(row, fixture.after);
  assert.equal(report.before.delivered_ids, null); assert.deepEqual(report.after.delivered_ids, []);
  assert(evidence.renderProcedureEvidence(report).includes('| Delivered memory | unknown | none (observed empty) |'));
});
test('capture mismatch and different template/budget controls stay incomparable', () => {
  for (const mutate of [row => { row.capture.request.sha256 = '0'.repeat(64); },
    row => { row.conditions.template_sha256 = '0'.repeat(64); },
    row => { row.final_evidence.budgets = { auto_memory: 1 }; }]) {
    const row = copy(fixture.after); mutate(row);
    assert.equal(evidence.buildProcedureEvidence(row, fixture.after).comparable, false);
  }
});
test('private imported prose, paths, commands and approval/provider claims are data', () => {
  const row = copy(fixture.after);
  Object.assign(row, { prompt: 'RAW_PRIVATE_SENTINEL', command: 'DO_NOT_EXECUTE', approved: true, provider_called: true,
    private_path: 'C:/PRIVATE_SENTINEL', findings: [{ id: 'R4', status: 'corrected-local-regression' }] });
  row.final_evidence.model_observed = 'INVENTED_MODEL';
  const report = evidence.buildProcedureEvidence(row, fixture.after);
  const text = JSON.stringify(report) + evidence.renderProcedureEvidence(report);
  for (const forbidden of ['RAW_PRIVATE_SENTINEL', 'DO_NOT_EXECUTE', 'C:/PRIVATE_SENTINEL', 'INVENTED_MODEL']) assert(!text.includes(forbidden));
  assert.equal(report.after.external_provider_called, 'unknown'); assert.equal(report.after.model_observed, null);
  assert(report.findings.filter(item => ['R4', 'R5', 'CLI'].includes(item.id)).every(item => item.status === 'unverified'));
  assert(report.findings.filter(item => ['R1', 'R2', 'R3'].includes(item.id)).every(item => item.status === 'open-S05'));
});
test('explicit file CLI reads only supplied metadata, rejects unknown modes without leaking input', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-procedure-report-'));
  try {
    const before = path.join(root, 'before.json'), after = path.join(root, 'after.json'), out = path.join(root, 'out');
    fs.writeFileSync(before, JSON.stringify(fixture.before)); fs.writeFileSync(after, JSON.stringify(fixture.after));
    const run = args => spawnSync(process.execPath, [path.join(__dirname, 'forge-procedure-evidence.js'), ...args], { encoding: 'utf8', shell: false, windowsHide: true });
    assert.equal(run(['--before-file', before, '--after-file', after, '--output-dir', out]).status, 0);
    const first = fs.readFileSync(path.join(out, 'report.json'));
    assert.equal(run(['--before-file', before, '--after-file', after, '--output-dir', out]).status, 0);
    assert.deepEqual(fs.readFileSync(path.join(out, 'report.json')), first);
    fs.writeFileSync(before, 'PRIVATE_INVALID_JSON');
    const bad = run(['--before-file', before, '--after-file', after, '--output-dir', out]);
    assert.equal(bad.status, 2); assert(!bad.stderr.includes('PRIVATE_INVALID_JSON'));
    assert.equal(run(['--fixture', '--before-file', before, '--output-dir', out]).status, 2);
    assert.equal(run(['--discover-private', '--output-dir', out]).status, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
console.log(`${passed} procedure evidence tests passed; explicit sanitized inputs, no provider/UAT`);
