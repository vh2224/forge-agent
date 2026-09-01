#!/usr/bin/env node
'use strict';

// Standalone by design: the guard must remain testable before dependencies or
// a package runner are installed.
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const guard = require('./forge-dispatch-guard.js');

const SCRIPT = path.join(__dirname, 'forge-dispatch-guard.js');
const EXPECTED_LEGS = [
  'claude→claude',
  'claude→codex',
  'codex→claude',
  'codex→codex',
];
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

function evaluate(host_runtime, worker_engine, environment) {
  return guard.evaluateDispatchGuard({ host_runtime, worker_engine }, environment || {});
}

function runCli(host, worker, environmentOverrides) {
  const env = { ...process.env };
  // Default-process assertions must never inherit an operator escape hatch.
  delete env.FORGE_RUNTIME_ENFORCE;
  if (environmentOverrides &&
      Object.prototype.hasOwnProperty.call(environmentOverrides, 'FORGE_RUNTIME_ENFORCE')) {
    env.FORGE_RUNTIME_ENFORCE = environmentOverrides.FORGE_RUNTIME_ENFORCE;
  }
  return spawnSync(process.execPath, [
    SCRIPT,
    '--host-runtime', host,
    '--worker-engine', worker,
    '--json',
  ], {
    cwd: path.join(__dirname, '..'),
    env,
    encoding: 'utf8',
  });
}

function jsonOutput(result) {
  assert.strictEqual(result.error, undefined, result.error && result.error.message);
  assert.notStrictEqual(result.stdout.trim(), '', `empty stdout; stderr=${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('reason codes are a frozen named enum', () => {
  assert(Object.isFrozen(guard.REASON_CODES));
  assert.strictEqual(guard.REASON_CODES.RUNTIME_POSTURE_OBSERVED, 'runtime-posture-observed');
  assert.strictEqual(guard.REASON_CODES.CODEX_CLAUDE_UNROUTABLE, 'codex-claude-unroutable');
  assert.strictEqual(guard.REASON_CODES.RUNTIME_POSTURE_UNMAPPED, 'runtime-posture-unmapped');
  assert.strictEqual(guard.REASON_CODES.INVALID_RUNTIME_GUARD_INPUT, 'invalid-runtime-guard-input');
});

test('posture map is deeply frozen and covers exactly four quadrants', () => {
  assert(Object.isFrozen(guard.RUNTIME_POSTURE_MAP));
  assert.deepStrictEqual(Object.keys(guard.RUNTIME_POSTURE_MAP).sort(), EXPECTED_LEGS.slice().sort());
  for (const leg of EXPECTED_LEGS) {
    const cell = guard.RUNTIME_POSTURE_MAP[leg];
    assert(Object.isFrozen(cell), `${leg} cell must be frozen`);
    assert.strictEqual(typeof cell.reason_code, 'string');
    assert.notStrictEqual(cell.hint.trim(), '');
  }
});

test('only codex to claude has enforcing posture', () => {
  const postures = Object.fromEntries(EXPECTED_LEGS.map((leg) => [
    leg,
    guard.RUNTIME_POSTURE_MAP[leg].posture,
  ]));
  assert.deepStrictEqual(postures, {
    'claude→claude': 'observe',
    'claude→codex': 'observe',
    'codex→claude': 'enforce',
    'codex→codex': 'observe',
  });
});

test('native is resolved through the runtime identity seam before map lookup', () => {
  const claude = evaluate(' Claude ', ' NATIVE ');
  const codex = evaluate('CODEX', 'native');
  assert.strictEqual(claude.worker_engine, 'native');
  assert.strictEqual(claude.resolved_worker_engine, 'claude');
  assert.strictEqual(claude.leg, 'claude→claude');
  assert.strictEqual(codex.resolved_worker_engine, 'codex');
  assert.strictEqual(codex.leg, 'codex→codex');
});

test('an otherwise valid engine without a map cell is a named error', () => {
  const result = evaluate('codex', 'agy');
  assert.strictEqual(result.host_runtime, 'codex');
  assert.strictEqual(result.worker_engine, 'agy');
  assert.strictEqual(result.resolved_worker_engine, 'agy');
  assert.strictEqual(result.leg, 'codex→agy');
  assert.strictEqual(result.posture, null);
  assert.strictEqual(result.decision, 'error');
  assert.strictEqual(result.dispatch_allowed, false);
  assert.strictEqual(result.reason_code, 'runtime-posture-unmapped');
});

test('invalid identity input uses the guard input reason code', () => {
  const missing = guard.evaluateDispatchGuard({ host_runtime: 'codex' }, {});
  const unknown = evaluate('cursor', 'codex');
  assert.strictEqual(missing.reason_code, 'invalid-runtime-guard-input');
  assert.strictEqual(missing.decision, 'error');
  assert.strictEqual(unknown.reason_code, 'invalid-runtime-guard-input');
  assert.strictEqual(unknown.dispatch_allowed, false);
});

test('observe posture is always advisory and allowed', () => {
  for (const leg of ['claude→claude', 'claude→codex', 'codex→codex']) {
    const [host, worker] = leg.split('→');
    const result = evaluate(host, worker);
    assert.strictEqual(result.posture, 'observe', leg);
    assert.strictEqual(result.decision, 'advisory', leg);
    assert.strictEqual(result.dispatch_allowed, true, leg);
    assert.strictEqual(result.reason_code, 'runtime-posture-observed', leg);
    assert.strictEqual('suppressed_action' in result, false, leg);
  }
});

test('the enforced leg refuses, and the verdict names no suppression', () => {
  const result = evaluate('codex', 'claude');
  assert.strictEqual(result.posture, 'enforce');
  assert.strictEqual(result.decision, 'refuse');
  assert.strictEqual(result.dispatch_allowed, false);
  assert.strictEqual(result.reason_code, 'codex-claude-unroutable');
  assert.strictEqual('enforcement_enabled' in result, false);
  assert.strictEqual('suppressed_action' in result, false);
});

// The escape hatch was removed on purpose: codex→claude has no delivery path
// (every skill gates its sidecar on a codex worker, and the only --engine claude
// occurrence in forge-xllm.js is its own rejection message), so an "allowed"
// verdict for this leg could never be honoured by anything downstream.
test('no environment value unlocks the enforced leg', () => {
  const baseline = JSON.stringify(evaluate('codex', 'claude'));
  for (const value of ['0', 0, '00', 'false', '', ' 0 ', 'off', '1']) {
    const attempted = evaluate('codex', 'claude', { FORGE_RUNTIME_ENFORCE: value });
    assert.strictEqual(attempted.decision, 'refuse',
      `value ${JSON.stringify(value)} must not unlock the enforced leg`);
    assert.strictEqual(attempted.dispatch_allowed, false, JSON.stringify(value));
    assert.strictEqual(JSON.stringify(attempted), baseline,
      `value ${JSON.stringify(value)} changed the verdict at all`);
  }
});

test('CLI parser uses the same host/worker flag vocabulary as dispatch resolve', () => {
  assert.deepStrictEqual(guard.parseArgs([
    '--host-runtime', 'codex',
    '--worker-engine', 'native',
    '--json',
  ]), {
    host_runtime: 'codex',
    worker_engine: 'native',
    json: true,
  });
  assert.throws(
    () => guard.parseArgs(['--host-runtime', 'codex']),
    (error) => error.code === 'invalid-runtime-guard-input',
  );
});

test('real CLI process refuses codex to claude with status 1 and actionable hint', () => {
  const child = runCli('codex', 'claude');
  const result = jsonOutput(child);
  assert.strictEqual(child.status, 1, child.stderr);
  assert.strictEqual(result.reason_code, 'codex-claude-unroutable');
  assert.strictEqual(result.decision, 'refuse');
  assert.strictEqual(result.dispatch_allowed, false);
  assert(/worker Codex roteável/.test(result.hint), result.hint);
  assert(/host Claude/.test(result.hint), result.hint);
});

test('real CLI process keeps codex to codex advisory with status 0', () => {
  const child = runCli('codex', 'codex');
  const result = jsonOutput(child);
  assert.strictEqual(child.status, 0, child.stderr);
  assert.strictEqual(result.posture, 'observe');
  assert.strictEqual(result.decision, 'advisory');
  assert.strictEqual(result.dispatch_allowed, true);
});

test('real CLI process refuses codex to claude even with the removed escape set', () => {
  const escapeAttempt = runCli('codex', 'claude', { FORGE_RUNTIME_ENFORCE: '0' });
  const enforced = runCli('codex', 'claude');
  assert.strictEqual(escapeAttempt.status, 1, escapeAttempt.stderr);
  assert.strictEqual(jsonOutput(escapeAttempt).decision, 'refuse');
  assert.strictEqual(jsonOutput(escapeAttempt).dispatch_allowed, false);
  // Byte-identical to the run without the variable: a spawned process cannot
  // tell the two apart, which is the whole point of removing the hatch.
  assert.strictEqual(escapeAttempt.stdout, enforced.stdout);
});

test('real CLI process reports an unmapped leg with status 2', () => {
  const child = runCli('codex', 'agy');
  const result = jsonOutput(child);
  assert.strictEqual(child.status, 2, child.stderr);
  assert.strictEqual(result.leg, 'codex→agy');
  assert.strictEqual(result.reason_code, 'runtime-posture-unmapped');
  assert.strictEqual(result.decision, 'error');
});

test('real CLI process emits parseable JSON for invalid input with status 2', () => {
  const env = { ...process.env };
  delete env.FORGE_RUNTIME_ENFORCE;
  const child = spawnSync(process.execPath, [SCRIPT, '--host-runtime', 'codex', '--json'], {
    cwd: path.join(__dirname, '..'),
    env,
    encoding: 'utf8',
  });
  const result = jsonOutput(child);
  assert.strictEqual(child.status, 2, child.stderr);
  assert.strictEqual(result.reason_code, 'invalid-runtime-guard-input');
  assert.notStrictEqual(result.hint, '');
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
