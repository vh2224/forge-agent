#!/usr/bin/env node
'use strict';

// Acceptance for the versioned model policy. The frozen oracle below is the
// resolver behavior at 223e6fa (family regex clamp + thinkingHeaderFor), kept
// literal so every model outside the documented Sonnet entries is proven
// byte-identical. Sonnet 5 / 5.5 / 4.6 deviations are asserted explicitly.

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const policy = require('./forge-model-policy.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`  ✗ ${name}\n    ${error.stack || error.message}\n`);
  }
}

// Oracle frozen from scripts/forge-dispatch-resolve.js at 223e6fa.
function oracleEffort(model, effort) {
  const rank = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };
  const cap = /^claude-(haiku|sonnet)/.test(model) ? 'medium' : 'max';
  return rank[effort] > rank[cap] ? cap : effort;
}
function oracleHeader(model, effort) {
  if (model.startsWith('claude-fable-5')) return 'adaptive';
  if (model.startsWith('claude-opus-5') && (effort === 'xhigh' || effort === 'max')) return 'adaptive';
  return '';
}

const GRID = ['claude-sonnet-5', 'claude-sonnet-5-20260801', 'claude-haiku-4-5-20251001', 'claude-opus-5',
  'claude-opus-5[1m]', 'claude-opus-5-5', 'claude-fable-5', 'claude-fable-5-1', 'gpt-6.1-sol', 'gpt-5.6-terra',
  'unknown-model-x'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DOCUMENTED_SONNET_5 = new Set(['claude-sonnet-5', 'claude-sonnet-5-20260801']);

test('table integrity: version, documented entries carry URL sources and consultation date', () => {
  assert.match(policy.POLICY_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  assert.ok(Object.isFrozen(policy.MODEL_POLICY) && Object.isFrozen(policy.MODEL_POLICY['claude-sonnet-5-5']));
  for (const [id, entry] of Object.entries(policy.MODEL_POLICY)) {
    assert.ok(['documented', 'legacy-preserved'].includes(entry.status), id);
    assert.strictEqual(entry.consulted_at, '2026-09-30', id);
    if (entry.status === 'documented') {
      assert.ok(entry.sources.length > 0 && entry.sources.every(url => /^https:\/\//.test(url)), id);
      assert.ok(Array.isArray(entry.efforts), `${id} lists documented efforts`);
    }
  }
});

test('matching: 5.5 never falls into 5; dated and [1m] variants; unknown is null', () => {
  assert.strictEqual(policy.matchPolicy('claude-sonnet-5-5').id, 'claude-sonnet-5-5');
  assert.strictEqual(policy.matchPolicy('claude-sonnet-5-5-20261001').id, 'claude-sonnet-5-5');
  assert.strictEqual(policy.matchPolicy('claude-sonnet-5-5[1m]').id, 'claude-sonnet-5-5');
  assert.strictEqual(policy.matchPolicy('claude-sonnet-5').id, 'claude-sonnet-5');
  assert.strictEqual(policy.matchPolicy('claude-sonnet-5-20260801').id, 'claude-sonnet-5');
  assert.strictEqual(policy.matchPolicy('claude-opus-5[1m]').id, 'claude-opus-5');
  assert.strictEqual(policy.matchPolicy('claude-opus-5-5'), null, 'opus 5.5 has no entry');
  assert.strictEqual(policy.matchPolicy('claude-fable-5-1'), null);
  assert.strictEqual(policy.matchPolicy('gpt-6.1-sol'), null);
});

test('frozen oracle: clamp and header identical for every non-documented-sonnet model', () => {
  for (const model of GRID) {
    for (const effort of EFFORTS) {
      const applied = policy.applyEffortPolicy({ model, effort });
      const header = policy.thinkingHeader({ model, effort: applied.effort });
      if (DOCUMENTED_SONNET_5.has(model)) {
        assert.strictEqual(applied.effort, effort, `${model}/${effort} documented: no clamp`);
        assert.strictEqual(applied.clamped, false);
      } else {
        assert.strictEqual(applied.effort, oracleEffort(model, effort), `${model}/${effort} effort`);
        assert.strictEqual(applied.clamped, oracleEffort(model, effort) !== effort, `${model}/${effort} clamped flag`);
      }
      assert.strictEqual(header.header, oracleHeader(model, applied.effort), `${model}/${effort} header`);
      if (!policy.matchPolicy(model)) {
        assert.ok(applied.diagnostics.some(d => d.code === 'model-policy-unknown' && d.model === model), `${model} unknown diag`);
      }
      if (applied.clamped) {
        const diag = applied.diagnostics.find(d => d.code === 'effort-clamped-by-policy');
        assert.deepStrictEqual({ requested: diag.requested, applied: diag.applied }, { requested: effort, applied: applied.effort });
      }
    }
  }
});

test('sonnet 5.5: full scale without clamp, adaptive header', () => {
  for (const effort of EFFORTS) {
    const applied = policy.applyEffortPolicy({ model: 'claude-sonnet-5-5', effort });
    assert.strictEqual(applied.effort, effort);
    assert.deepStrictEqual(applied.diagnostics, []);
    assert.strictEqual(policy.thinkingHeader({ model: 'claude-sonnet-5-5', effort }).header, 'adaptive');
  }
});

test('sonnet 4.6: xhigh is refused by name, never clamped', () => {
  const applied = policy.applyEffortPolicy({ model: 'claude-sonnet-4-6', effort: 'xhigh' });
  assert.strictEqual(applied.unsupported, true);
  assert.strictEqual(applied.effort, 'xhigh', 'requested value preserved');
  assert.ok(applied.diagnostics.some(d => d.code === 'effort-unsupported-by-model'));
  for (const effort of ['low', 'medium', 'high', 'max']) {
    assert.strictEqual(policy.applyEffortPolicy({ model: 'claude-sonnet-4-6', effort }).unsupported, false, effort);
  }
});

test('sonnet 5.5 thinking: adaptive ok; enabled/disabled refused; between_tools API-only', () => {
  const model = 'claude-sonnet-5-5';
  assert.strictEqual(policy.evaluateThinking({ model, effort: 'high', mode: 'adaptive' }).ok, true);
  assert.strictEqual(policy.evaluateThinking({ model, effort: 'high' }).mode_effective, 'adaptive');
  const disabled = policy.evaluateThinking({ model, effort: 'low', mode: 'disabled', transport: 'claude-cli' });
  assert.deepStrictEqual([disabled.ok, disabled.reason_code], [false, 'thinking-disabled-incompatible']);
  assert.strictEqual(disabled.mode_effective, null, 'never rewritten to adaptive');
  assert.strictEqual(policy.evaluateThinking({ model, effort: 'low', mode: 'enabled' }).ok, false);
  for (const effort of ['low', 'medium', 'high']) {
    assert.strictEqual(policy.evaluateThinking({ model, effort, mode: 'between_tools', transport: 'api' }).ok, true, effort);
  }
  for (const effort of ['xhigh', 'max']) {
    assert.strictEqual(policy.evaluateThinking({ model, effort, mode: 'between_tools', transport: 'api' }).reason_code,
      'thinking-between-tools-incompatible', effort);
  }
  assert.strictEqual(policy.evaluateThinking({ model, effort: 'low', mode: 'between_tools', transport: 'api',
    extraFields: ['budget_tokens'] }).ok, false);
  for (const transport of ['claude-cli', 'claude-native']) {
    assert.strictEqual(policy.evaluateThinking({ model, effort: 'low', mode: 'between_tools', transport }).reason_code,
      'thinking-transport-unsupported', transport);
  }
});

test('transport support: CLI minimum version and native alias-only', () => {
  const model = 'claude-sonnet-5-5';
  const old = policy.transportSupport({ model, transport: 'claude-cli', cliVersion: '2.1.283' });
  assert.deepStrictEqual([old.supported, old.reason_code], [false, 'claude-cli-version-unsupported']);
  assert.strictEqual(policy.transportSupport({ model, transport: 'claude-cli', cliVersion: '2.1.284 (Claude Code)' }).supported, true);
  const unknown = policy.transportSupport({ model, transport: 'claude-cli', cliVersion: 'garbage' });
  assert.ok(unknown.supported && unknown.diagnostics.some(d => d.code === 'transport-version-unverified'));
  const native = policy.transportSupport({ model, transport: 'claude-native' });
  assert.strictEqual(native.version_proof, 'alias-only');
  assert.ok(native.diagnostics.some(d => d.code === 'native-alias-not-version-proof'));
  assert.strictEqual(policy.transportSupport({ model: 'claude-sonnet-5', transport: 'claude-cli' }).min_version, null,
    'models without a minimum keep the probe-free path');
});

test('CLI emits one JSON line and never changes the model', () => {
  const run = spawnSync(process.execPath, [path.join(__dirname, 'forge-model-policy.js'), '--model', 'claude-sonnet-5-5',
    '--effort', 'max', '--json'], { encoding: 'utf8', shell: false });
  assert.strictEqual(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.strictEqual(out.model, 'claude-sonnet-5-5');
  assert.strictEqual(out.effort.effort, 'max');
  assert.strictEqual(out.policy_version, policy.POLICY_VERSION);
  const bad = spawnSync(process.execPath, [path.join(__dirname, 'forge-model-policy.js'), '--bogus'], { encoding: 'utf8', shell: false });
  assert.strictEqual(bad.status, 2);
});

process.stdout.write(`\nforge-model-policy: ${passed} passed, ${failed} failed\n`);
if (failed) process.exitCode = 1;
