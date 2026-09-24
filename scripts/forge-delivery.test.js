#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const delivery = require('./forge-delivery.js');

const roots = [];
let passed = 0;
let skipped = 0;
function test(name, fn) {
  try { fn(); passed++; process.stdout.write(`ok - ${name}\n`); }
  catch (error) {
    if (error && error.testSkip) { skipped++; process.stdout.write(`ok - ${name} # SKIP ${error.message}\n`); return; }
    process.stderr.write(`not ok - ${name}\n${error.stack}\n`); process.exitCode = 1;
  }
}
function skip(reason) { const error = new Error(reason); error.testSkip = true; throw error; }
function tempRoot(label) { const root = fs.mkdtempSync(path.join(os.tmpdir(), `forge-delivery-${label}-`)); roots.push(root); return root; }
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; }
function writeJson(file, value) { return write(file, `${JSON.stringify(value, null, 2)}\n`); }
function plan(truth = 'observable behavior') {
  return `---
id: T01
must_haves:
  truths:
    - "${truth}"
  artifacts:
    - path: scripts/result.js
      provides: "result module"
      min_lines: 1
  key_links:
    - from: scripts/result.js
      to: scripts/dependency.js
      via: "require"
expected_output:
  - scripts/result.js
---
# Plan
`;
}
function fixture(label = 'base', unit = { type: 'task', id: 'T01' }, planText = plan()) {
  const root = tempRoot(label);
  const owner = path.join(root, 'owner');
  const code = path.join(root, 'code');
  fs.mkdirSync(owner, { recursive: true }); fs.mkdirSync(code, { recursive: true });
  write(path.join(owner, 'task', 'PLAN.md'), planText);
  const planFingerprint = delivery.sha256(planText);
  const input = { schema_version: 1, unit, plan: 'task/PLAN.md', plan_fingerprint: planFingerprint, bindings: [] };
  return { root, owner, code, unit, planText, planFingerprint, input };
}
function criterionId(unit, kind, index) { return `${delivery.unitKey(unit)}:${kind}:${index}`; }
function verificationEnvelope(fx, checks, extra = {}) {
  const named = checks.map((check, index) => ({ command: `fixture-check-${index}`, ...check }));
  return {
    schema_version: 1, kind: 'verification', unit: fx.unit, plan_fingerprint: fx.planFingerprint,
    code_dir: fx.code, revision: 'abc123', environment: 'node-test', captured_at: '2026-09-24T12:00:00Z',
    result: { passed: named.every((check) => (check.exitCode ?? check.exit_code) === 0), checks: named }, ...extra,
  };
}
function artifactEnvelope(fx, rows, extra = {}) {
  return {
    schema_version: 1, kind: 'artifact', unit: fx.unit, plan_fingerprint: fx.planFingerprint,
    code_dir: fx.code, revision: 'abc123', environment: 'filesystem', captured_at: '2026-09-24T12:00:00Z',
    result: { legacy: false, rows }, ...extra,
  };
}
function bind(kind, pathRef, criterion, selector, coverage, aspect) {
  return { criterion_id: criterion, aspect, coverage, source: { kind, path: pathRef, ...selector } };
}
function build(fx, input = fx.input) { return delivery.buildDelivery(input, { ownerRoot: fx.owner, codeDir: fx.code }); }
function byId(output, id) { return output.criteria.find((criterion) => criterion.id === id); }

test('inventories every structured plan criterion with qualified stable IDs', () => {
  const fx = fixture('inventory');
  const output = build(fx);
  assert.deepStrictEqual(output.criteria.map((item) => item.id), [
    criterionId(fx.unit, 'truth', 0), criterionId(fx.unit, 'artifact', 0), criterionId(fx.unit, 'key_link', 0),
  ]);
  assert(output.criteria.every((item) => item.status === 'não verificado'));
});

test('legacy, empty, malformed, missing and fingerprint-mismatched plans stay diagnostic', () => {
  const legacy = fixture('legacy', { type: 'task', id: 'TL' }, '# legacy\n## Must-Haves\n- old\n');
  assert(build(legacy).diagnostics.includes('plan_legacy'));
  const empty = fixture('empty', { type: 'task', id: 'TE' }, '');
  assert(build(empty).diagnostics.includes('plan_empty'));
  const malformed = fixture('malformed', { type: 'task', id: 'TM' }, '---\nmust_haves:\n  truths: []\n---\n');
  assert(build(malformed).diagnostics.includes('plan_malformed'));
  const missing = fixture('missing'); missing.input.plan = 'absent.md';
  assert(build(missing).diagnostics.includes('plan_source_missing'));
  const mismatch = fixture('mismatch'); mismatch.input.plan_fingerprint = 'wrong';
  writeJson(path.join(mismatch.owner, 'verify.json'), verificationEnvelope(mismatch, [{ exitCode: 0 }]));
  mismatch.input.bindings = [bind('verification', 'verify.json', criterionId(mismatch.unit, 'truth', 0), { check_index: 0 }, 'behavioral')];
  const mismatchOutput = build(mismatch);
  assert(mismatchOutput.diagnostics.includes('plan_fingerprint_mismatch'));
  assert.strictEqual(byId(mismatchOutput, criterionId(mismatch.unit, 'truth', 0)).status, 'não verificado');
});

test('bindings cannot erase inventory and invalid additional selectors are diagnosed', () => {
  const fx = fixture('selectors');
  const input = { ...fx.input, additional_criteria: [
    { id: 'qa', text: 'QA accepted', reference: 'ticket#qa', type: 'functional' },
    { id: 'qa', text: 'duplicate', reference: 'ticket#qa2', type: 'functional' },
  ], bindings: [{ criterion_id: 'missing', coverage: 'behavioral', source: { kind: 'verification', path: 'none', check_index: 0 } }] };
  const output = build(fx, input);
  assert.strictEqual(output.criteria.length, 4);
  assert(output.diagnostics.includes('additional_criterion_duplicate:qa'));
  assert(output.diagnostics.includes('binding_unknown_criterion:0'));
});

test('complete explicit behavioral and exact structural coverage verifies every criterion', () => {
  const fx = fixture('complete');
  writeJson(path.join(fx.owner, 'evidence', 'verify.json'), verificationEnvelope(fx, [{ command: 'test one', exitCode: 0 }]));
  writeJson(path.join(fx.owner, 'evidence', 'artifact.json'), artifactEnvelope(fx, [{ path: 'scripts/result.js', exists: true, substantive: true, wired: true, flags: [] }]));
  const input = { ...fx.input, bindings: [
    bind('verification', 'evidence/verify.json', criterionId(fx.unit, 'truth', 0), { check_index: 0 }, 'behavioral'),
    bind('artifact', 'evidence/artifact.json', criterionId(fx.unit, 'artifact', 0), { row_index: 0, property: 'substantive' }, 'structural'),
    bind('verification', 'evidence/verify.json', criterionId(fx.unit, 'key_link', 0), { check_index: 0 }, 'behavioral'),
  ] };
  const output = build(fx, input);
  assert(output.criteria.every((item) => item.status === 'verificado'));
  assert(output.criteria.every((item) => item.evidence[0].environment));
});

test('required aspects produce partial status when only one has positive coverage', () => {
  const fx = fixture('aspects');
  writeJson(path.join(fx.owner, 'verify.json'), verificationEnvelope(fx, [{ exitCode: 0 }]));
  const input = { ...fx.input, additional_criteria: [{ id: 'two', text: 'two aspects', reference: 'acceptance#two', type: 'functional', aspects: ['api', 'ui'] }], bindings: [
    bind('verification', 'verify.json', criterionId(fx.unit, 'additional', 'two'), { check_index: 0 }, 'behavioral', 'api'),
  ] };
  const criterion = byId(build(fx, input), criterionId(fx.unit, 'additional', 'two'));
  assert.strictEqual(criterion.status, 'parcialmente verificado');
  assert(criterion.pending.includes('aspect_unverified:ui'));
});

test('revision compatibility is criterion-scoped, stable and recomputed for children', () => {
  const childUnit = { type: 'task', id: 'T01', milestone: 'M001', slice: 'S01' };
  const fx = fixture('revision-compatibility', childUnit);
  const revA = verificationEnvelope(fx, [{ exitCode: 0 }, { exitCode: 0 }, { exitCode: 0 }]);
  const revB = verificationEnvelope(fx, [{ exitCode: 0 }, { exitCode: 0 }]); revB.revision = 'rev-B';
  revA.revision = 'rev-A';
  writeJson(path.join(fx.owner, 'a.json'), revA); writeJson(path.join(fx.owner, 'b.json'), revB);
  const ids = Object.fromEntries(['split', 'same', 'left', 'right'].map((id) => [id, criterionId(childUnit, 'additional', id)]));
  const additional = [
    { id: 'split', text: 'split revisions', reference: 'acceptance#split', type: 'functional', aspects: ['api', 'ui'] },
    { id: 'same', text: 'same revision', reference: 'acceptance#same', type: 'functional', aspects: ['api', 'ui'] },
    { id: 'left', text: 'left criterion', reference: 'acceptance#left', type: 'functional' },
    { id: 'right', text: 'right criterion', reference: 'acceptance#right', type: 'functional' },
  ];
  const bindings = [
    bind('verification', 'a.json', ids.split, { check_index: 0 }, 'behavioral', 'api'),
    bind('verification', 'b.json', ids.split, { check_index: 0 }, 'behavioral', 'ui'),
    bind('verification', 'a.json', ids.same, { check_index: 0 }, 'behavioral', 'api'),
    bind('verification', 'a.json', ids.same, { check_index: 1 }, 'behavioral', 'ui'),
    bind('verification', 'a.json', ids.left, { check_index: 2 }, 'behavioral'),
    bind('verification', 'b.json', ids.right, { check_index: 1 }, 'behavioral'),
  ];
  const child = build(fx, { ...fx.input, additional_criteria: additional, bindings });
  const split = byId(child, ids.split);
  assert.strictEqual(split.status, 'parcialmente verificado');
  assert(split.pending.includes('revision_mismatch:rev-A,rev-B'));
  assert.strictEqual(byId(child, ids.same).status, 'verificado');
  assert.strictEqual(byId(child, ids.left).status, 'verificado');
  assert.strictEqual(byId(child, ids.right).status, 'verificado');
  const reordered = build(fx, { ...fx.input, additional_criteria: additional, bindings: [...bindings].reverse() });
  assert.deepStrictEqual(byId(reordered, ids.split).pending, split.pending);
  assert.strictEqual(byId(reordered, ids.split).status, split.status);

  writeJson(path.join(fx.owner, 'child.json'), child);
  const parentUnit = { type: 'slice', id: 'S01', milestone: 'M001' };
  write(path.join(fx.owner, 'parent.md'), plan('parent behavior'));
  const parent = delivery.buildDelivery({ schema_version: 1, unit: parentUnit, plan: 'parent.md',
    plan_fingerprint: delivery.sha256(plan('parent behavior')), bindings: [],
    expected_children: [{ unit: childUnit, delivery: 'child.json' }] }, { ownerRoot: fx.owner, codeDir: fx.code });
  assert.strictEqual(byId(parent, ids.split).status, 'parcialmente verificado');
  assert(byId(parent, ids.split).pending.includes('revision_mismatch:rev-A,rev-B'));
});

test('negative-only, timeout and absent check never become success', () => {
  for (const [label, checks, index, reason] of [
    ['failure', [{ exitCode: 2 }], 0, 'negative_evidence:default'],
    ['timeout', [{ exitCode: 124 }], 0, 'negative_evidence:default'],
    ['missing-check', [{ exitCode: 0 }], 3, 'default:verification_check_missing'],
  ]) {
    const fx = fixture(label);
    writeJson(path.join(fx.owner, 'verify.json'), verificationEnvelope(fx, checks));
    const output = build(fx, { ...fx.input, bindings: [bind('verification', 'verify.json', criterionId(fx.unit, 'truth', 0), { check_index: index }, 'behavioral')] });
    const criterion = byId(output, criterionId(fx.unit, 'truth', 0));
    assert.strictEqual(criterion.status, 'não verificado');
    assert(criterion.pending.includes(reason), `${label}: ${criterion.pending.join(',')}`);
  }
});

test('pass plus failure on one aspect is explicit conflict and partial', () => {
  const fx = fixture('conflict');
  writeJson(path.join(fx.owner, 'verify.json'), verificationEnvelope(fx, [{ exitCode: 0 }, { exitCode: 1 }]));
  const id = criterionId(fx.unit, 'truth', 0);
  const output = build(fx, { ...fx.input, bindings: [
    bind('verification', 'verify.json', id, { check_index: 0 }, 'behavioral'),
    bind('verification', 'verify.json', id, { check_index: 1 }, 'behavioral'),
  ] });
  assert.strictEqual(byId(output, id).status, 'parcialmente verificado');
  assert(byId(output, id).pending.includes('evidence_conflict:default'));
});

test('named checks and whole-result consistency gate behavioral evidence', () => {
  for (const [label, mutate, reason] of [
    ['nameless', (source) => { delete source.result.checks[0].command; }, 'verification_checks_schema_invalid'],
    ['aggregate-missing', (source) => { delete source.result.passed; }, 'verification_aggregate_missing'],
    ['aggregate-nonboolean', (source) => { source.result.passed = 'yes'; }, 'verification_aggregate_missing'],
    ['aggregate-contradictory', (source) => { source.result.passed = false; }, 'verification_aggregate_inconsistent'],
  ]) {
    const fx = fixture(`check-schema-${label}`); const source = verificationEnvelope(fx, [{ exitCode: 0 }]); mutate(source);
    writeJson(path.join(fx.owner, 'verify.json'), source);
    const id = criterionId(fx.unit, 'truth', 0);
    const criterion = byId(build(fx, { ...fx.input, bindings: [bind('verification', 'verify.json', id, { check_index: 0 }, 'behavioral')] }), id);
    assert.strictEqual(criterion.status, 'não verificado');
    assert(criterion.pending.some((item) => item.includes(reason)), `${label}: ${criterion.pending.join(',')}`);
  }
});

test('consistent mixed suite preserves explicitly selected named pass and fail', () => {
  const fx = fixture('mixed-suite');
  writeJson(path.join(fx.owner, 'verify.json'), verificationEnvelope(fx, [{ exitCode: 0 }, { exitCode: 3 }]));
  const passId = criterionId(fx.unit, 'truth', 0); const failId = criterionId(fx.unit, 'additional', 'failure');
  const output = build(fx, { ...fx.input,
    additional_criteria: [{ id: 'failure', text: 'failing scenario', reference: 'acceptance#failure', type: 'functional' }],
    bindings: [
      bind('verification', 'verify.json', passId, { check_index: 0 }, 'behavioral'),
      bind('verification', 'verify.json', failId, { check_index: 1 }, 'behavioral'),
    ] });
  assert.strictEqual(byId(output, passId).status, 'verificado');
  assert.strictEqual(byId(output, failId).status, 'não verificado');
  assert(byId(output, failId).pending.includes('negative_evidence:default'));
});

test('no-stack and disabled-by-pref with no checks are not verified', () => {
  for (const skippedReason of ['no-stack', 'disabled-by-pref']) {
    const fx = fixture(`skip-${skippedReason}`);
    const envelope = verificationEnvelope(fx, []); envelope.result = { passed: true, skipped: skippedReason, checks: [] };
    writeJson(path.join(fx.owner, 'verify.json'), envelope);
    const output = build(fx, { ...fx.input, bindings: [bind('verification', 'verify.json', criterionId(fx.unit, 'truth', 0), { check_index: 0 }, 'behavioral')] });
    const criterion = byId(output, criterionId(fx.unit, 'truth', 0));
    assert.strictEqual(criterion.status, 'não verificado');
    assert(criterion.pending.some((item) => item.includes(`verification_skipped:${skippedReason}`)));
  }
});

test('unreadable, malformed and context-incompatible sources stay limited', () => {
  const fx = fixture('bad-sources');
  write(path.join(fx.owner, 'bad.json'), '{bad');
  writeJson(path.join(fx.owner, 'array.json'), []);
  const mismatch = verificationEnvelope(fx, [{ exitCode: 0 }]);
  mismatch.unit = { type: 'task', id: 'OTHER' }; mismatch.plan_fingerprint = 'wrong'; delete mismatch.environment;
  writeJson(path.join(fx.owner, 'mismatch.json'), mismatch);
  const id = criterionId(fx.unit, 'truth', 0);
  const output = build(fx, { ...fx.input, bindings: [
    bind('verification', 'missing.json', id, { check_index: 0 }, 'behavioral'),
    bind('verification', 'bad.json', id, { check_index: 0 }, 'behavioral'),
    bind('verification', 'array.json', id, { check_index: 0 }, 'behavioral'),
    bind('verification', 'mismatch.json', id, { check_index: 0 }, 'behavioral'),
  ] });
  const pending = byId(output, id).pending.join('|');
  assert.match(pending, /source_missing/); assert.match(pending, /source_malformed_json/);
  assert.match(pending, /source_schema_invalid/);
  assert.match(pending, /source_unit_mismatch/); assert.match(pending, /source_plan_fingerprint_mismatch/);
  assert.match(pending, /source_context_missing:environment/);
});

test('global test without binding and advisory substring pointer are not proof', () => {
  const fx = fixture('advisory');
  fs.mkdirSync(path.join(fx.owner, '.gsd', 'forge'), { recursive: true });
  write(path.join(fx.owner, '.gsd', 'forge', 'evidence~none~none~T01.jsonl'), '{"cmd":"global test","exit_code":0}\n');
  const id = criterionId(fx.unit, 'truth', 0);
  const noBinding = build(fx);
  assert.strictEqual(byId(noBinding, id).status, 'não verificado');
  const advisory = build(fx, { ...fx.input, bindings: [{ criterion_id: id, coverage: 'behavioral', source: { kind: 'advisory', path: 'evidence pointer', axes: { unit: 'T01' } } }] });
  assert.strictEqual(byId(advisory, id).status, 'não verificado');
  assert(byId(advisory, id).pending.some((item) => item.includes('advisory_evidence_not_proof')));
});

test('artifact evidence is structural-only and approximate rows remain unverified', () => {
  const fx = fixture('artifact-limits');
  writeJson(path.join(fx.owner, 'artifact.json'), artifactEnvelope(fx, [{ path: 'scripts/result.js', exists: true, substantive: true, wired: true, approximate: true, flags: [] }]));
  const truthId = criterionId(fx.unit, 'truth', 0);
  const artifactId = criterionId(fx.unit, 'artifact', 0);
  const output = build(fx, { ...fx.input, bindings: [
    bind('artifact', 'artifact.json', truthId, { row_index: 0, property: 'substantive' }, 'structural'),
    bind('artifact', 'artifact.json', artifactId, { row_index: 0, property: 'substantive' }, 'structural'),
  ] });
  assert.strictEqual(byId(output, truthId).status, 'não verificado');
  assert.strictEqual(byId(output, artifactId).status, 'não verificado');
  assert(byId(output, artifactId).pending.some((item) => item.includes('artifact_result_approximate')));
});

test('artifact evidence requires exact normalized artifact identity', () => {
  const fx = fixture('artifact-identity'); const id = criterionId(fx.unit, 'artifact', 0);
  writeJson(path.join(fx.owner, 'matched.json'), artifactEnvelope(fx, [{ path: './scripts/result.js', exists: true, substantive: true, wired: true, flags: [] }]));
  writeJson(path.join(fx.owner, 'other.json'), artifactEnvelope(fx, [{ path: 'scripts/other.js', exists: true, substantive: true, wired: true, flags: [] }]));
  const matched = byId(build(fx, { ...fx.input, bindings: [bind('artifact', 'matched.json', id, { row_index: 0, property: 'substantive' }, 'structural')] }), id);
  assert.strictEqual(matched.status, 'verificado');
  const other = byId(build(fx, { ...fx.input, bindings: [bind('artifact', 'other.json', id, { row_index: 0, property: 'substantive' }, 'structural')] }), id);
  assert.strictEqual(other.status, 'não verificado');
  assert(other.pending.some((item) => item.includes('artifact_path_mismatch')));
});

test('generic wired artifact row cannot prove a declared directed key link', () => {
  const fx = fixture('directed-link'); const id = criterionId(fx.unit, 'key_link', 0);
  writeJson(path.join(fx.owner, 'artifact.json'), artifactEnvelope(fx, [{ path: 'scripts/dependency.js', exists: true, substantive: true, wired: true, flags: [] }]));
  writeJson(path.join(fx.owner, 'verify.json'), verificationEnvelope(fx, [{ command: 'assert result requires dependency', exitCode: 0 }]));
  const generic = byId(build(fx, { ...fx.input, bindings: [bind('artifact', 'artifact.json', id, { row_index: 0, property: 'wired' }, 'structural')] }), id);
  assert.strictEqual(generic.status, 'não verificado');
  assert(generic.pending.some((item) => item.includes('key_link_requires_behavioral_evidence')));
  const explicit = byId(build(fx, { ...fx.input, bindings: [bind('verification', 'verify.json', id, { check_index: 0 }, 'behavioral')] }), id);
  assert.strictEqual(explicit.status, 'verificado');
});

test('malformed artifact rows and flags become stable invalid observations', () => {
  const cases = [
    ['flags-object', [{ path: 'scripts/result.js', substantive: true, flags: {} }], 'artifact_flags_invalid'],
    ['flags-string', [{ path: 'scripts/result.js', substantive: true, flags: 'bad' }], 'artifact_flags_invalid'],
    ['flags-null-entry', [{ path: 'scripts/result.js', substantive: true, flags: [null] }], 'artifact_flags_invalid'],
    ['property-type', [{ path: 'scripts/result.js', substantive: 'yes', flags: [] }], 'artifact_row_property_invalid'],
    ['row-path-type', [{ path: 42, substantive: true, flags: [] }], 'artifact_row_path_invalid'],
    ['rows-object', { path: 'scripts/result.js' }, 'artifact_rows_invalid'],
  ];
  for (const [label, rows, reason] of cases) {
    const fx = fixture(`malformed-artifact-${label}`); const id = criterionId(fx.unit, 'artifact', 0);
    writeJson(path.join(fx.owner, 'artifact.json'), artifactEnvelope(fx, [], { result: { legacy: false, rows } }));
    const criterion = byId(build(fx, { ...fx.input, bindings: [bind('artifact', 'artifact.json', id, { row_index: 0, property: 'substantive' }, 'structural')] }), id);
    assert.strictEqual(criterion.status, 'não verificado');
    assert(criterion.pending.some((item) => item.includes(reason)), `${label}: ${criterion.pending.join(',')}`);
  }
});

test('observation truncation is criterion-level and cannot leave failures green', () => {
  for (const order of ['failure-last', 'failure-first']) {
    const fx = fixture(`truncation-${order}`); const id = criterionId(fx.unit, 'truth', 0);
    const checks = Array.from({ length: delivery.MAX_OBSERVATIONS + 1 }, (_, index) => ({ exitCode: order === 'failure-last' ? (index === delivery.MAX_OBSERVATIONS ? 1 : 0) : (index === 0 ? 1 : 0) }));
    writeJson(path.join(fx.owner, 'verify.json'), verificationEnvelope(fx, checks));
    const bindings = checks.map((_, index) => bind('verification', 'verify.json', id, { check_index: index }, 'behavioral'));
    const criterion = byId(build(fx, { ...fx.input, bindings }), id);
    assert.notStrictEqual(criterion.status, 'verificado');
    assert(criterion.pending.some((item) => item.includes('evidence_truncated')));
  }
  const fx = fixture('truncation-aspects'); const id = criterionId(fx.unit, 'additional', 'many');
  const checks = Array.from({ length: delivery.MAX_OBSERVATIONS + 1 }, () => ({ exitCode: 0 }));
  writeJson(path.join(fx.owner, 'verify.json'), verificationEnvelope(fx, checks));
  const bindings = checks.map((_, index) => bind('verification', 'verify.json', id, { check_index: index }, 'behavioral', index < delivery.MAX_OBSERVATIONS ? 'a' : 'b'));
  const criterion = byId(build(fx, { ...fx.input, additional_criteria: [{ id: 'many', text: 'many observations', reference: 'acceptance#many', type: 'functional', aspects: ['a', 'b'] }], bindings }), id);
  assert.notStrictEqual(criterion.status, 'verificado');
  assert(criterion.pending.some((item) => item === 'b:evidence_truncated'));
});

test('current environment is not substituted for missing historical context', () => {
  const fx = fixture('historic-context');
  const envelope = verificationEnvelope(fx, [{ exitCode: 0 }]); delete envelope.environment;
  writeJson(path.join(fx.owner, 'verify.json'), envelope);
  const id = criterionId(fx.unit, 'truth', 0);
  const criterion = byId(build(fx, { ...fx.input, bindings: [bind('verification', 'verify.json', id, { check_index: 0 }, 'behavioral')] }), id);
  assert.strictEqual(criterion.status, 'não verificado');
  assert.strictEqual(criterion.evidence[0].environment, null);
});

test('external and traversal references cannot read beyond explicit roots', () => {
  const fx = fixture('external');
  const outside = writeJson(path.join(fx.root, 'outside.json'), verificationEnvelope(fx, [{ exitCode: 0 }]));
  const id = criterionId(fx.unit, 'truth', 0);
  const output = build(fx, { ...fx.input, bindings: [bind('verification', outside, id, { check_index: 0 }, 'behavioral'), bind('verification', '../outside.json', id, { check_index: 0 }, 'behavioral')] });
  assert(output.criteria[0].pending.filter((item) => item.includes('source_outside_roots')).length >= 1);
  assert.strictEqual(output.criteria[0].status, 'não verificado');
});

test('oversized evidence is rejected before JSON parsing', () => {
  const fx = fixture('oversized');
  write(path.join(fx.owner, 'large.json'), ' '.repeat(delivery.MAX_FILE_BYTES + 1));
  const id = criterionId(fx.unit, 'truth', 0);
  const output = build(fx, { ...fx.input, bindings: [bind('verification', 'large.json', id, { check_index: 0 }, 'behavioral')] });
  assert(byId(output, id).pending.some((item) => item.includes('source_too_large')));
});

test('symlink escaping roots is refused when symlink fixtures are available', () => {
  const fx = fixture('symlink');
  const outside = writeJson(path.join(fx.root, 'outside.json'), verificationEnvelope(fx, [{ exitCode: 0 }]));
  const link = path.join(fx.owner, 'link.json');
  try { fs.symlinkSync(outside, link, 'file'); }
  catch (error) { skip(error.code || 'symlink unavailable'); }
  const id = criterionId(fx.unit, 'truth', 0);
  const output = build(fx, { ...fx.input, bindings: [bind('verification', 'link.json', id, { check_index: 0 }, 'behavioral')] });
  assert(byId(output, id).pending.some((item) => item.includes('source_outside_roots')));
});

test('commands inside evidence remain inert data', () => {
  const fx = fixture('inert-command');
  const marker = path.join(fx.root, 'must-not-exist');
  writeJson(path.join(fx.owner, 'verify.json'), verificationEnvelope(fx, [{ command: `New-Item ${marker}`, exitCode: 0 }]));
  const id = criterionId(fx.unit, 'truth', 0);
  build(fx, { ...fx.input, bindings: [bind('verification', 'verify.json', id, { check_index: 0 }, 'behavioral')] });
  assert.strictEqual(fs.existsSync(marker), false);
});

test('Markdown rendering escapes pipes, line breaks, markup and backticks', () => {
  const fx = fixture('markdown', { type: 'task', id: 'TMD' }, plan('pipe | line <tag> `code` ![x](url) **bold**'));
  const markdown = delivery.renderDeliveryMarkdown(build(fx));
  assert.match(markdown, /&#124;/); assert.match(markdown, /&lt;tag&gt;/); assert.match(markdown, /&#96;code&#96;/);
  assert.match(markdown, /&#33;&#91;x&#93;\(url\)/); assert.match(markdown, /&#42;&#42;bold&#42;&#42;/);
  assert(!markdown.includes('pipe | line <tag>'));
});

test('child aggregation preserves missing children, same text and parent criteria', () => {
  const root = tempRoot('aggregate'); const owner = path.join(root, 'owner'); const code = path.join(root, 'code'); fs.mkdirSync(owner, { recursive: true }); fs.mkdirSync(code, { recursive: true });
  const parentUnit = { type: 'slice', id: 'S01', milestone: 'M001' }; const childUnit = { type: 'task', id: 'T01', milestone: 'M001', slice: 'S01' };
  write(path.join(owner, 'parent.md'), plan('same text')); write(path.join(owner, 'child.md'), plan('same text'));
  const childInput = { schema_version: 1, unit: childUnit, plan: 'child.md', plan_fingerprint: delivery.sha256(plan('same text')), bindings: [] };
  const childOutput = delivery.buildDelivery(childInput, { ownerRoot: owner, codeDir: code });
  writeJson(path.join(owner, 'child-delivery.json'), childOutput);
  const parentInput = { schema_version: 1, unit: parentUnit, plan: 'parent.md', plan_fingerprint: delivery.sha256(plan('same text')), bindings: [], expected_children: [
    { unit: childUnit, delivery: 'child-delivery.json' },
    { unit: { type: 'task', id: 'T02', milestone: 'M001', slice: 'S01' }, delivery: 'missing.json' },
  ] };
  const output = delivery.buildDelivery(parentInput, { ownerRoot: owner, codeDir: code });
  assert.strictEqual(output.criteria.filter((item) => item.text === 'same text').length, 2);
  assert(output.criteria.some((item) => item.id.startsWith(`${delivery.unitKey(parentUnit)}:`)));
  assert(output.criteria.some((item) => item.id.startsWith(`${delivery.unitKey(childUnit)}:`)));
  assert(output.diagnostics.some((item) => item.startsWith('child_source_missing:')));
});

test('parent recomputes child status instead of trusting supplied JSON status', () => {
  const root = tempRoot('child-status'); const owner = path.join(root, 'owner'); const code = path.join(root, 'code'); fs.mkdirSync(owner, { recursive: true }); fs.mkdirSync(code, { recursive: true });
  const parentUnit = { type: 'slice', id: 'S01' }; const childUnit = { type: 'task', id: 'T01', slice: 'S01' };
  write(path.join(owner, 'parent.md'), plan()); write(path.join(owner, 'child.md'), plan());
  let child = delivery.buildDelivery({ schema_version: 1, unit: childUnit, plan: 'child.md', plan_fingerprint: delivery.sha256(plan()), bindings: [] }, { ownerRoot: owner, codeDir: code });
  child.criteria[0].status = 'verificado'; child = delivery.finalizeOutput(child);
  writeJson(path.join(owner, 'child.json'), child);
  const parent = delivery.buildDelivery({ schema_version: 1, unit: parentUnit, plan: 'parent.md', plan_fingerprint: delivery.sha256(plan()), bindings: [], expected_children: [{ unit: childUnit, delivery: 'child.json' }] }, { ownerRoot: owner, codeDir: code });
  assert.strictEqual(byId(parent, criterionId(childUnit, 'truth', 0)).status, 'não verificado');
});

test('legacy child remains an explicit aggregate gap', () => {
  const root = tempRoot('legacy-child'); const owner = path.join(root, 'owner'); const code = path.join(root, 'code'); fs.mkdirSync(owner, { recursive: true }); fs.mkdirSync(code, { recursive: true });
  const parentUnit = { type: 'slice', id: 'S01' }; const childUnit = { type: 'task', id: 'T01', slice: 'S01' };
  write(path.join(owner, 'parent.md'), plan()); write(path.join(owner, 'legacy.md'), '# legacy plan\n');
  const child = delivery.buildDelivery({ schema_version: 1, unit: childUnit, plan: 'legacy.md', plan_fingerprint: delivery.sha256('# legacy plan\n'), bindings: [] }, { ownerRoot: owner, codeDir: code });
  writeJson(path.join(owner, 'legacy-delivery.json'), child);
  const parent = delivery.buildDelivery({ schema_version: 1, unit: parentUnit, plan: 'parent.md', plan_fingerprint: delivery.sha256(plan()), bindings: [], expected_children: [{ unit: childUnit, delivery: 'legacy-delivery.json' }] }, { ownerRoot: owner, codeDir: code });
  assert(parent.diagnostics.some((item) => item.startsWith('child_plan_legacy_or_unstructured:')));
  assert(parent.diagnostics.some((item) => item.includes('child_reported:plan_legacy')));
});

test('tampered child fingerprint is diagnosed', () => {
  const fx = fixture('child-invalid', { type: 'slice', id: 'S01' });
  const childUnit = { type: 'task', id: 'T01', slice: 'S01' };
  const child = delivery.finalizeOutput({ schema_version: 1, generated_by: 'forge-delivery', unit: childUnit, plan: {}, criteria: [], facts: [], diagnostics: [], depth: 0, lineage: [delivery.unitKey(fx.unit)], source_limits: {} });
  child.delivery_fingerprint = 'tampered'; writeJson(path.join(fx.owner, 'child.json'), child);
  const output = build(fx, { ...fx.input, expected_children: [{ unit: childUnit, delivery: 'child.json' }, { unit: childUnit, delivery: 'child.json' }] });
  assert(output.diagnostics.some((item) => item.startsWith('child_fingerprint_invalid:')));
});

test('child cycles, duplicate paths, maximum depth and child count are bounded', () => {
  const fx = fixture('child-bounds', { type: 'slice', id: 'S01' });
  const childUnit = { type: 'task', id: 'T01', slice: 'S01' };
  const cycle = delivery.finalizeOutput({ schema_version: 1, generated_by: 'forge-delivery', unit: childUnit, plan: {}, criteria: [], facts: [], diagnostics: [], depth: 0, lineage: [delivery.unitKey(fx.unit)], source_limits: {} });
  const deepUnit = { type: 'task', id: 'T02', slice: 'S01' };
  const deep = delivery.finalizeOutput({ schema_version: 1, generated_by: 'forge-delivery', unit: deepUnit, plan: {}, criteria: [], facts: [], diagnostics: [], depth: delivery.MAX_DEPTH, lineage: [delivery.unitKey(deepUnit)], source_limits: {} });
  writeJson(path.join(fx.owner, 'cycle.json'), cycle); writeJson(path.join(fx.owner, 'deep.json'), deep);
  const bounded = build(fx, { ...fx.input, expected_children: [
    { unit: childUnit, delivery: 'cycle.json' }, { unit: childUnit, delivery: 'cycle.json' }, { unit: deepUnit, delivery: 'deep.json' },
  ] });
  assert(bounded.diagnostics.some((item) => item.startsWith('child_cycle:')));
  assert(bounded.diagnostics.some((item) => item.startsWith('child_cycle_or_duplicate:')));
  assert(bounded.diagnostics.some((item) => item.startsWith('child_depth_invalid:')));
  const tooMany = build(fx, { ...fx.input, expected_children: Array.from({ length: delivery.MAX_CHILDREN + 1 }, (_, index) => ({ unit: { type: 'task', id: `T${index}` }, delivery: `missing-${index}.json` })) });
  assert(tooMany.diagnostics.includes('children_limit_exceeded'));
});

test('facts do not promote one another and table limits point to full detail', () => {
  const fx = fixture('facts');
  const output = build(fx, { ...fx.input, facts: { implementation: { status: 'concluída', reference: 'commit abc' } } });
  assert.strictEqual(output.facts.find((item) => item.name === 'implementation').status, 'concluída');
  for (const item of output.facts.filter((fact) => fact.name !== 'implementation')) assert.strictEqual(item.status, 'não informado/pendente');
  const markdown = delivery.renderDeliveryMarkdown(output, { tableLimit: 1, detailReference: 'full.json' });
  assert.match(markdown, /critério\(s\) no detalhe integral/); assert.match(markdown, /full\.json/);
});

test('same input produces byte-equivalent delivery without generated timestamp', () => {
  const fx = fixture('deterministic');
  const left = JSON.stringify(build(fx)); const right = JSON.stringify(build(fx));
  assert.strictEqual(left, right); assert(!left.includes('generated_at'));
});

test('CLI reads declared input and prints JSON or Markdown without writing artifacts', () => {
  const fx = fixture('cli'); const inputPath = writeJson(path.join(fx.owner, 'input.json'), fx.input);
  for (const format of ['--json', '--markdown']) {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'forge-delivery.js'), '--input', inputPath, '--owner-root', fx.owner, '--code-dir', fx.code, format], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr); assert(result.stdout.length > 20);
  }
  assert.strictEqual(fs.existsSync(path.join(fx.owner, 'T01-DELIVERY.json')), false);
});

for (const root of roots) { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
process.stdout.write(`\n${passed} passed, ${skipped} skipped\n`);
