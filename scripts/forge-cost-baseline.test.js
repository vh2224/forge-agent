#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { measureBaseline, renderMarkdown } = require('./forge-cost-baseline.js');
const { TEMPLATE_FILES } = require('./forge-prompt.js');

const root = path.resolve(__dirname, '..');
const scriptPath = path.join(__dirname, 'forge-cost-baseline.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stderr.write(`  ✗ ${name}: ${error.message}\n`);
  }
}

process.stdout.write('\n=== Forge cost-baseline regression tests ===\n\n');

test('measureBaseline covers all 11 unit types with rendered_tokens > 0', () => {
  const result = measureBaseline(root, {});
  const unitTypes = Object.keys(TEMPLATE_FILES);
  assert.strictEqual(unitTypes.length, 11, `expected 11 unit types, got ${unitTypes.length}`);
  assert.deepStrictEqual(Object.keys(result.by_unit_type).sort(), unitTypes.sort());
  for (const unitType of unitTypes) {
    const row = result.by_unit_type[unitType];
    assert.ok(Number.isInteger(row.rendered_tokens), `${unitType}: rendered_tokens not an integer`);
    assert.ok(row.rendered_tokens > 0, `${unitType}: rendered_tokens must be > 0`);
    assert.ok(Number.isInteger(row.template_tokens), `${unitType}: template_tokens not an integer`);
  }
  assert.strictEqual(result.errors.length, 0);
});

test('measureBaseline is deterministic across two consecutive calls', () => {
  const first = measureBaseline(root, {});
  const second = measureBaseline(root, {});
  assert.deepStrictEqual(first.by_unit_type, second.by_unit_type);
  assert.deepStrictEqual(first.totals, second.totals);
});

// Review S01 R2: `label` used to be interpolated into the rendered
// `description`, so two labels measured different prompt text (`before` 5977 vs
// `after` 5976; a long label +254). The label is metadata only.
test('label does not change the measurement (R2)', () => {
  const before = measureBaseline(root, { label: 'before' });
  const after = measureBaseline(root, { label: 'after' });
  const long = measureBaseline(root, { label: 'x'.repeat(400) });
  assert.deepStrictEqual(before.by_unit_type, after.by_unit_type);
  assert.deepStrictEqual(before.by_unit_type, long.by_unit_type);
  assert.deepStrictEqual(before.totals, after.totals);
  assert.deepStrictEqual(before.totals, long.totals);
  assert.strictEqual(before.label, 'before');
  assert.strictEqual(after.label, 'after', 'label still travels as result metadata');
});

test('renderMarkdown contains one row per unit_type', () => {
  const result = measureBaseline(root, {});
  const markdown = renderMarkdown(result);
  for (const unitType of Object.keys(TEMPLATE_FILES)) {
    assert.ok(markdown.includes(`| ${unitType} |`), `markdown missing row for ${unitType}`);
  }
  assert.ok(markdown.includes('| unit_type | rendered_tokens | template_tokens |'));
});

test('errors[] is an array (empty on the happy path)', () => {
  const result = measureBaseline(root, {});
  assert.ok(Array.isArray(result.errors));
  assert.strictEqual(result.errors.length, 0);
});

test('CLI --json exits 0 with parseable JSON', () => {
  const proc = spawnSync(process.execPath, [scriptPath, '--json', '--cwd', root], { encoding: 'utf8' });
  assert.strictEqual(proc.status, 0, proc.stderr);
  const parsed = JSON.parse(proc.stdout);
  assert.ok(parsed.by_unit_type);
  assert.strictEqual(Object.keys(parsed.by_unit_type).length, 11);
});

test('CLI --markdown exits 0 with a markdown table', () => {
  const proc = spawnSync(process.execPath, [scriptPath, '--markdown', '--cwd', root], { encoding: 'utf8' });
  assert.strictEqual(proc.status, 0, proc.stderr);
  assert.ok(proc.stdout.includes('| unit_type | rendered_tokens | template_tokens |'));
});

test('CLI with an unknown flag exits 2', () => {
  const proc = spawnSync(process.execPath, [scriptPath, '--nao-existe'], { encoding: 'utf8' });
  assert.strictEqual(proc.status, 2, proc.stdout);
  assert.ok(proc.stderr.length > 0);
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
