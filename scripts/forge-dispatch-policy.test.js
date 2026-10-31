#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const policy = require('./forge-dispatch-policy');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-policy-Ω space-'));
const workspace = path.join(temp, 'workspace Ω');
const homes = { claude: path.join(temp, 'Claude Home'), codex: path.join(temp, 'Codex Home') };
fs.mkdirSync(workspace, { recursive: true });
const all = ['workspace.read', 'workspace.write', 'workspace.apply', 'process.spawn', 'state.read', 'state.write', 'result.materialize', 'lease.manage', 'handoff.manage', 'lease.execute'];
function input(extra = {}) {
  return { role: 'worker', host_runtime: 'claude', worker_engine: 'native', worker_mode: 'native', operation: 'read', required_capabilities: [], available_capabilities: all, workspace_root: workspace, target: path.join(workspace, 'src', 'file.js'), spawn_cwd: workspace, runtime_homes: homes, ...extra };
}
function expect(extra, decision, reason) {
  const result = policy.decide(input(extra));
  assert.strictEqual(result.decision, decision, JSON.stringify(extra));
  assert.strictEqual(result.reason_code, reason, JSON.stringify(extra));
  assert.deepStrictEqual(result.grants, []);
  assert.strictEqual(result.permissions.credential_env, false);
  return result;
}

try {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'forge-dispatch-policy.schema.json'), 'utf8'));
  assert.strictEqual(schema.additionalProperties, false);
  assert.deepStrictEqual(schema.properties.reason_code.enum, policy.REASON_CODES);

  const fixtureRoot = path.join(__dirname, 'fixtures', 'dispatch-security');
  const published = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'role-matrix.json'), 'utf8'));
  const matrix = [];
  for (const platform of published.platforms) {
    for (const host of published.hosts) {
      for (const role of published.roles) {
        const result = expect({ platform, host_runtime: host, ...role }, 'allow', 'policy-allowed');
        assert.strictEqual(result.sandbox_mode, role.sandbox_mode);
        matrix.push(result);
      }
    }
  }
  assert.strictEqual(matrix.length, 24);
  for (const result of matrix.filter((item) => ['reviewer', 'observer'].includes(item.role))) {
    assert.strictEqual(result.sandbox_mode, 'read-only');
    assert.strictEqual(result.permissions.workspace_write, false);
    assert.strictEqual(result.permissions.apply, false);
    assert.strictEqual(result.permissions.spawn, false);
    assert.strictEqual(result.permissions.execution_lease, false);
  }
  assert(matrix.some((item) => item.host_runtime === 'claude' && item.projection.host === 'claude' && Array.isArray(item.projection.tools)));
  assert(matrix.some((item) => item.host_runtime === 'codex' && item.projection.host === 'codex' && item.projection.sandbox_mode === 'read-only'));

  const vectors = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'negative-vectors.json'), 'utf8')).vectors;
  for (const vector of vectors) {
    const dynamic = { ...vector };
    if (vector.target_kind === 'outside') dynamic.target = path.join(temp, 'outside.txt');
    if (vector.target_kind === 'gsd') dynamic.target = path.join(workspace, '.gsd', 'STATE.md');
    if (vector.target_kind === 'other-host-home') dynamic.target = path.join(homes.codex, 'config.toml');
    const result = expect(dynamic, 'deny', vector.reason_code);
    assert.strictEqual(result.projection, null);
  }
  expect({ role: 'worker', operation: 'write', sandbox_mode: 'read-only' }, 'deny', 'role-permission-denied');
  expect({ role: 'worker', operation: 'spawn', spawn_cwd: temp }, 'deny', 'target-outside-workspace');
  expect({ role: 'worker', host_runtime: 'codex', operation: 'write', target: path.join(homes.claude, 'settings.json') }, 'deny', 'cross-host-home');
  expect({ role: 'worker', required_capabilities: ['state.write'] }, 'deny', 'role-permission-denied');
  expect({ role: 'executor', operation: 'apply' }, 'allow', 'policy-allowed');

  const orchestrator = expect({ role: 'orchestrator', operation: 'write', target: path.join(workspace, '.gsd', 'result.json'), required_capabilities: ['state.write', 'result.materialize'] }, 'allow', 'policy-allowed');
  assert.strictEqual(orchestrator.permissions.state_write, true);
  assert.strictEqual(orchestrator.permissions.result_materialize, true);
  const secret = expect({ untrusted_output: { result: 'ordinary' }, token: 'never-echo', transcript: 'never-echo' }, 'allow', 'policy-allowed');
  assert(!JSON.stringify(secret).includes('never-echo'));

  const fromCatalog = policy.decide(input({ available_capabilities: [], capability_catalog: { capabilities: [{ capability_id: 'workspace.read', hosts: { claude: 'implemented', codex: 'common' } }] } }));
  assert.strictEqual(fromCatalog.decision, 'allow');
  const plannedOnly = policy.decide(input({ host_runtime: 'codex', available_capabilities: [], capability_catalog: { capabilities: [{ capability_id: 'workspace.read', hosts: { codex: 'planned' } }] } }));
  assert.strictEqual(plannedOnly.reason_code, 'capability-missing');
  // Catalog schema 1.1.0: unknown is fail-closed; distributed/demonstrated stay available.
  const unknownOnly = policy.decide(input({ host_runtime: 'codex', available_capabilities: [], capability_catalog: { capabilities: [{ capability_id: 'workspace.read', hosts: { codex: 'unknown' } }] } }));
  assert.strictEqual(unknownOnly.decision, 'deny');
  assert.strictEqual(unknownOnly.reason_code, 'capability-missing');
  const unknownManifest = policy.decide(input({ host_runtime: 'codex', available_capabilities: [], source_manifest: { sources: [{ capability: 'workspace.read', conditional: { codex: { status: 'unknown' } } }] } }));
  assert.strictEqual(unknownManifest.reason_code, 'capability-missing');
  for (const status of ['distributed', 'demonstrated']) {
    const projected = policy.decide(input({ host_runtime: 'codex', available_capabilities: [], capability_catalog: { capabilities: [{ capability_id: 'workspace.read', hosts: { codex: status } }] } }));
    assert.strictEqual(projected.decision, 'allow', status);
    assert.strictEqual(projected.reason_code, 'policy-allowed', status);
  }
  const absentHost = policy.decide(input({ host_runtime: 'codex', available_capabilities: [], capability_catalog: { capabilities: [{ capability_id: 'workspace.read', hosts: { claude: 'implemented' } }] } }));
  assert.strictEqual(absentHost.reason_code, 'capability-missing');
  assert.strictEqual(policy.decide(input({ role: undefined })).reason_code, 'invalid-role');
  assert.strictEqual(policy.decide(input({ worker_engine: 'unknown' })).reason_code, 'invalid-runtime-contract');

  let stdout = ''; const cli = policy.main([JSON.stringify(input())], (text) => { stdout += text; }, () => {});
  assert.strictEqual(cli, 0); assert.strictEqual(JSON.parse(stdout).decision, 'allow');
  console.log(`forge-dispatch-policy tests passed (${process.platform}; 2 hosts × 3 platforms)`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
