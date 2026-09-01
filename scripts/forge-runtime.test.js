#!/usr/bin/env node
'use strict';

// This test is intentionally dependency-free: it protects the protocol before
// either host adapter, package manager, or JSON Schema validator is installed.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const runtime = require('./forge-runtime.js');
const { resolveWorkerIdentity, resolveWorker } = runtime;

const schemaPath = path.join(__dirname, '..', 'schemas', 'forge-runtime.schema.json');
const scriptPath = path.join(__dirname, 'forge-runtime.js');
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

function expectCode(code, fn) {
  assert.throws(fn, (error) => error && error.code === code, `expected reason code ${code}`);
}

function enumAt(schema, name) {
  return schema.$defs[name].enum;
}

test('exports the versioned protocol surface', () => {
  assert.strictEqual(runtime.PROTOCOL_VERSION, '1.0.0');
  assert(runtime.REASON_CODES.includes('implicit-recursion-refused'));
  assert.strictEqual(typeof resolveWorkerIdentity, 'function');
  assert.strictEqual(typeof runtime.resolveWorker, 'function');
  assert.strictEqual(typeof runtime.validateRuntimeContract, 'function');
});

test('defaults preserve the legacy Claude-first native route', () => {
  const resolved = runtime.resolveWorker({});
  assert.deepStrictEqual(resolved, {
    protocol_version: '1.0.0',
    host_runtime: 'claude',
    worker_engine: 'native',
    worker_mode: 'native',
    resolved_engine: 'claude',
    sidecar_declared: false,
    reason_code: 'native-resolved',
  });
});

test('normalizes both known host runtimes case-insensitively', () => {
  assert.strictEqual(runtime.normalizeHostRuntime('Claude'), 'claude');
  assert.strictEqual(runtime.normalizeHostRuntime(' CODEX '), 'codex');
});

test('identity seam resolves native strictly from the Claude host', () => {
  assert.deepStrictEqual(resolveWorkerIdentity({
    host_runtime: ' Claude ',
    worker_engine: ' NATIVE ',
  }), {
    host_runtime: 'claude',
    worker_engine: 'native',
    resolved_engine: 'claude',
  });
});

test('identity seam resolves native strictly from the Codex host', () => {
  assert.deepStrictEqual(resolveWorkerIdentity({
    host_runtime: 'CODEX',
    worker_engine: 'native',
  }), {
    host_runtime: 'codex',
    worker_engine: 'native',
    resolved_engine: 'codex',
  });
});

test('identity seam preserves an explicit concrete engine across hosts', () => {
  assert.deepStrictEqual(resolveWorkerIdentity({
    host_runtime: 'claude',
    worker_engine: 'codex',
  }), {
    host_runtime: 'claude',
    worker_engine: 'codex',
    resolved_engine: 'codex',
  });
  assert.strictEqual(resolveWorkerIdentity({
    host_runtime: 'codex',
    worker_engine: 'claude',
  }).resolved_engine, 'claude');
});

test('identity seam keeps named diagnostics for invalid identity input', () => {
  expectCode('invalid-host-runtime', () => resolveWorkerIdentity({
    host_runtime: 'cursor',
  }));
  expectCode('invalid-worker-engine', () => resolveWorkerIdentity({
    worker_engine: 'gpt',
  }));
});

test('identity seam ignores mode, routing, model, and preference-shaped fields', () => {
  const identity = resolveWorkerIdentity({
    host_runtime: 'codex',
    worker_engine: 'native',
    worker_mode: 'not-a-runtime-mode',
    dispatch_engine: 'claude',
    model: 'claude-opus-5',
    route: { engine: 'claude' },
    workers: { 'execute-task': 'claude' },
  });
  assert.deepStrictEqual(identity, {
    host_runtime: 'codex',
    worker_engine: 'native',
    resolved_engine: 'codex',
  });
  assert(!Object.prototype.hasOwnProperty.call(identity, 'worker_mode'));
});

test('identity validation order remains host then worker engine', () => {
  expectCode('invalid-host-runtime', () => resolveWorkerIdentity({
    host_runtime: 'invalid-host',
    worker_engine: 'invalid-engine',
  }));
  expectCode('invalid-worker-engine', () => resolveWorker({
    worker_engine: 'invalid-engine',
    worker_mode: 'invalid-mode',
  }));
});

test('native resolves strictly from the Claude host', () => {
  const result = runtime.resolveWorker({ host_runtime: 'claude', worker_engine: 'native' });
  assert.strictEqual(result.resolved_engine, 'claude');
  assert.strictEqual(result.worker_mode, 'native');
});

test('native resolves strictly from the Codex host', () => {
  const result = runtime.resolveWorker({ host_runtime: 'codex', worker_engine: 'native' });
  assert.strictEqual(result.resolved_engine, 'codex');
  assert.strictEqual(result.worker_mode, 'native');
});

test('native resolution never uses model family as a fallback provider', () => {
  const result = runtime.resolveWorker({ host_runtime: 'codex', worker_engine: 'native' });
  assert.strictEqual(result.resolved_engine, 'codex');
  assert.notStrictEqual(result.resolved_engine, runtime.runtimeFromModel('claude-opus-5'));
});

test('all worker engines are explicit closed values', () => {
  assert.strictEqual(runtime.normalizeWorkerEngine('native'), 'native');
  assert.strictEqual(runtime.normalizeWorkerEngine('claude'), 'claude');
  assert.strictEqual(runtime.normalizeWorkerEngine('codex'), 'codex');
  assert.strictEqual(runtime.normalizeWorkerEngine('agy'), 'agy');
});

test('all worker modes are explicit closed values', () => {
  assert.strictEqual(runtime.normalizeWorkerMode('native'), 'native');
  assert.strictEqual(runtime.normalizeWorkerMode('sidecar'), 'sidecar');
});

test('unknown host has a deterministic diagnostic instead of a fallback', () => {
  expectCode('invalid-host-runtime', () => runtime.resolveWorker({ host_runtime: 'cursor' }));
});

test('unknown engine has a deterministic diagnostic instead of a fallback', () => {
  expectCode('invalid-worker-engine', () => runtime.resolveWorker({ worker_engine: 'gpt' }));
});

test('unknown mode has a deterministic diagnostic instead of a fallback', () => {
  expectCode('invalid-worker-mode', () => runtime.resolveWorker({ worker_mode: 'remote' }));
});

test('direct cross-host calls do not derive a mode when it is omitted', () => {
  expectCode('native-engine-host-mismatch', () => resolveWorker({
    host_runtime: 'claude',
    worker_engine: 'codex',
  }));
  expectCode('native-engine-host-mismatch', () => resolveWorker({
    host_runtime: 'codex',
    worker_engine: 'claude',
  }));
});

test('a native mode cannot silently switch from Claude to Codex', () => {
  expectCode('native-engine-host-mismatch', () => runtime.resolveWorker({
    host_runtime: 'claude', worker_engine: 'codex', worker_mode: 'native',
  }));
});

test('a native mode cannot silently switch from Codex to Claude', () => {
  expectCode('native-engine-host-mismatch', () => runtime.resolveWorker({
    host_runtime: 'codex', worker_engine: 'claude', worker_mode: 'native',
  }));
});

test('native engine cannot be disguised as a sidecar', () => {
  expectCode('native-sidecar-conflict', () => runtime.resolveWorker({
    host_runtime: 'claude', worker_engine: 'native', worker_mode: 'sidecar', sidecar: true,
  }));
});

test('cross-host sidecar must be explicitly declared', () => {
  expectCode('sidecar-declaration-required', () => runtime.resolveWorker({
    host_runtime: 'claude', worker_engine: 'codex', worker_mode: 'sidecar',
  }));
});

test('same-host sidecar recursion is refused when implicit', () => {
  expectCode('implicit-recursion-refused', () => runtime.resolveWorker({
    host_runtime: 'codex', worker_engine: 'codex', worker_mode: 'sidecar',
  }));
});

test('declared Codex sidecar is represented without granting permission', () => {
  const result = runtime.resolveWorker({
    host_runtime: 'claude', worker_engine: 'codex', worker_mode: 'sidecar', sidecar_declared: true,
  });
  assert.strictEqual(result.resolved_engine, 'codex');
  assert.strictEqual(result.sidecar_declared, true);
  assert.strictEqual(result.reason_code, 'sidecar-declared');
});

test('declared same-host sidecar is a caller-declared combination', () => {
  const result = runtime.resolveWorker({
    host_runtime: 'codex', worker_engine: 'codex', worker_mode: 'sidecar', sidecar: true,
  });
  assert.strictEqual(result.sidecar_declared, true);
  assert.strictEqual(result.resolved_engine, 'codex');
});

test('Claude sidecar can be declared from Codex', () => {
  const result = runtime.resolveWorker({
    host_runtime: 'codex', worker_engine: 'claude', worker_mode: 'sidecar', sidecar: true,
  });
  assert.strictEqual(result.resolved_engine, 'claude');
});

test('agy is a worker engine and requires an explicit sidecar declaration off-host', () => {
  expectCode('sidecar-declaration-required', () => runtime.resolveWorker({
    host_runtime: 'claude', worker_engine: 'agy', worker_mode: 'sidecar',
  }));
  const result = runtime.resolveWorker({
    host_runtime: 'claude', worker_engine: 'agy', worker_mode: 'sidecar', sidecar: true,
  });
  assert.strictEqual(result.resolved_engine, 'agy');
});

test('unit contract carries provider-neutral state', () => {
  const unit = runtime.normalizeUnit({ id: 'T01', type: 'execute-task', state: 'leased' });
  assert.deepStrictEqual(unit, { protocol_version: '1.0.0', id: 'T01', type: 'execute-task', state: 'leased' });
});

test('unit state defaults and invalid values are deterministic', () => {
  assert.strictEqual(runtime.normalizeUnit({}).state, 'queued');
  expectCode('invalid-unit-state', () => runtime.normalizeUnit({ state: 'waiting' }));
});

test('result contract has neutral statuses and a stable reason slot', () => {
  const result = runtime.normalizeResult({ status: 'failed', reason_code: 'verification-failed', output: { exit: 1 } });
  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.reason_code, 'verification-failed');
  assert.deepStrictEqual(result.output, { exit: 1 });
});

test('result defaults and rejects unknown statuses', () => {
  assert.strictEqual(runtime.normalizeResult({}).status, 'succeeded');
  expectCode('invalid-result-status', () => runtime.normalizeResult({ status: 'pending' }));
});

test('lifecycle contract has host-independent states', () => {
  const lifecycle = runtime.normalizeLifecycle({ state: 'accepted', reason_code: 'lease-acquired' });
  assert.strictEqual(lifecycle.state, 'accepted');
  assert.strictEqual(lifecycle.reason_code, 'lease-acquired');
});

test('lifecycle defaults and rejects unknown states', () => {
  assert.strictEqual(runtime.normalizeLifecycle({}).state, 'created');
  expectCode('invalid-lifecycle-state', () => runtime.normalizeLifecycle({ state: 'spawned' }));
});

test('security metadata only declares requirements', () => {
  const security = runtime.normalizeSecurityMetadata({
    role: 'reviewer', required_capabilities: ['repo.read', 'artifact.comment', 'repo.read'],
  });
  assert.deepStrictEqual(security.required_capabilities, ['repo.read', 'artifact.comment']);
  assert.strictEqual(security.role, 'reviewer');
  assert(!Object.prototype.hasOwnProperty.call(security, 'granted_capabilities'));
});

test('security defaults and rejects malformed capability metadata', () => {
  assert.deepStrictEqual(runtime.normalizeSecurityMetadata({}), {
    protocol_version: '1.0.0', role: 'worker', required_capabilities: [],
  });
  expectCode('invalid-security-role', () => runtime.normalizeSecurityMetadata({ role: 'admin' }));
  expectCode('invalid-security-role', () => runtime.normalizeSecurityMetadata({ required_capabilities: [''] }));
});

test('model family remains an adapter concern and never becomes host input', () => {
  assert.strictEqual(runtime.runtimeFromModel('claude-opus-5'), 'claude');
  assert.strictEqual(runtime.runtimeFromModel('gpt-5.6-terra'), 'codex');
  assert.strictEqual(runtime.runtimeFromModel('gemini-3'), null);
  assert.strictEqual(runtime.runtimeFromLegacyEngine('claude'), 'claude');
  assert.strictEqual(runtime.runtimeFromLegacyEngine('codex'), 'codex');
});

test('full contract composes each provider-neutral component', () => {
  const contract = runtime.validateRuntimeContract({
    host_runtime: 'codex',
    worker_engine: 'native',
    unit: { id: 'T01', type: 'execute-task', state: 'running' },
    result: { status: 'succeeded', output: 'ok' },
    lifecycle: { state: 'running' },
    security: { role: 'worker', required_capabilities: ['repo.read'] },
  });
  assert.strictEqual(contract.protocol_version, '1.0.0');
  assert.strictEqual(contract.worker.resolved_engine, 'codex');
  assert.strictEqual(contract.unit.state, 'running');
  assert.strictEqual(contract.result.output, 'ok');
});

test('schema version and executable protocol version cannot drift', () => {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  assert.strictEqual(schema.properties.protocol_version.const, runtime.PROTOCOL_VERSION);
  assert.strictEqual(schema.$defs.worker.properties.protocol_version.const, runtime.PROTOCOL_VERSION);
  assert.strictEqual(schema.$defs.unit.properties.protocol_version.const, runtime.PROTOCOL_VERSION);
});

test('schema host and worker enums cannot drift from the executable contract', () => {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  assert.deepStrictEqual(enumAt(schema, 'hostRuntime'), runtime.HOST_RUNTIMES);
  assert.deepStrictEqual(enumAt(schema, 'workerEngine'), runtime.WORKER_ENGINES);
  assert.deepStrictEqual(enumAt(schema, 'workerMode'), runtime.WORKER_MODES);
});

test('schema unit, result and lifecycle states cannot drift', () => {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  assert.deepStrictEqual(schema.$defs.unit.properties.state.enum, runtime.UNIT_STATES);
  assert.deepStrictEqual(schema.$defs.result.properties.status.enum, runtime.RESULT_STATUSES);
  assert.deepStrictEqual(schema.$defs.lifecycle.properties.state.enum, runtime.LIFECYCLE_STATES);
});

test('schema security roles cannot drift and has no grants field', () => {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  assert.deepStrictEqual(schema.$defs.security.properties.role.enum, runtime.SECURITY_ROLES);
  assert(!Object.prototype.hasOwnProperty.call(schema.$defs.security.properties, 'granted_capabilities'));
});

test('CLI emits a complete normalized contract', () => {
  const input = JSON.stringify({ host_runtime: 'codex', worker_engine: 'native' });
  const run = spawnSync(process.execPath, [scriptPath, input], { encoding: 'utf8' });
  assert.strictEqual(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout);
  assert.strictEqual(output.worker.host_runtime, 'codex');
  assert.strictEqual(output.worker.resolved_engine, 'codex');
  assert.strictEqual(output.unit.state, 'queued');
});

test('CLI exits nonzero with a stable reason code for invalid input', () => {
  const input = JSON.stringify({ host_runtime: 'unknown-host' });
  const run = spawnSync(process.execPath, [scriptPath, input], { encoding: 'utf8' });
  assert.strictEqual(run.status, 1);
  assert.match(run.stderr, /^invalid-host-runtime:/);
});

process.stdout.write(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
