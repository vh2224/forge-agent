#!/usr/bin/env node
'use strict';

// Pure pre-dispatch policy. This module describes the minimum host projection;
// it never grants OS access, reads provider homes, or starts a subprocess.
const path = require('path');
const runtime = require('./forge-runtime');

const PROTOCOL_VERSION = '1.0.0';
const OPERATIONS = Object.freeze(['read', 'write', 'apply', 'spawn']);
const REASON_CODES = Object.freeze([
  'policy-allowed', 'invalid-request', 'invalid-role', 'invalid-operation',
  'invalid-runtime-contract', 'capability-missing', 'role-permission-denied',
  'sandbox-escalation-denied', 'target-required', 'target-outside-workspace',
  'protected-state-path', 'cross-host-home', 'untrusted-output-barrier',
  'ad-hoc-grant-denied',
]);
const OPERATION_CAPABILITY = Object.freeze({ read: 'workspace.read', write: 'workspace.write', apply: 'workspace.apply', spawn: 'process.spawn' });
const ROLE_POLICY = Object.freeze({
  orchestrator: Object.freeze({
    capabilities: Object.freeze(['workspace.read', 'workspace.write', 'workspace.apply', 'process.spawn', 'state.read', 'state.write', 'result.materialize', 'lease.manage', 'handoff.manage']),
    operations: Object.freeze(OPERATIONS.slice()), max_sandbox: 'workspace-write', execution_lease: true,
  }),
  worker: Object.freeze({
    capabilities: Object.freeze(['workspace.read', 'workspace.write', 'workspace.apply', 'process.spawn', 'lease.execute']),
    operations: Object.freeze(OPERATIONS.slice()), max_sandbox: 'workspace-write', execution_lease: true,
  }),
  reviewer: Object.freeze({ capabilities: Object.freeze(['workspace.read']), operations: Object.freeze(['read']), max_sandbox: 'read-only', execution_lease: false }),
  observer: Object.freeze({ capabilities: Object.freeze(['workspace.read']), operations: Object.freeze(['read']), max_sandbox: 'read-only', execution_lease: false }),
});

function own(value, key) { return Object.prototype.hasOwnProperty.call(value || {}, key); }
function list(value) { return Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()))] : []; }
function normalizeRole(value) { return value === 'executor' ? 'worker' : value; }
function inside(base, target) { const relative = path.relative(path.resolve(base), path.resolve(target)); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
// Fail-closed for `unknown` (catalog schema 1.1.0); `distributed` and
// `demonstrated` describe a projected surface and stay available.
function hostStatusAvailable(value) { return !['planned', 'unavailable', 'missing', 'unknown'].includes(String(value || '').toLowerCase()); }
function catalogCapabilities(input, host) {
  const found = new Set(list(input.available_capabilities));
  const catalog = input.capability_catalog;
  for (const capability of catalog && Array.isArray(catalog.capabilities) ? catalog.capabilities : []) {
    if (capability && typeof capability.capability_id === 'string' && capability.hosts && own(capability.hosts, host) && hostStatusAvailable(capability.hosts[host])) found.add(capability.capability_id);
  }
  const manifest = input.source_manifest;
  for (const source of manifest && Array.isArray(manifest.sources) ? manifest.sources : []) {
    const status = source && source.conditional && source.conditional[host] && source.conditional[host].status;
    if (source && typeof source.capability === 'string' && hostStatusAvailable(status)) found.add(source.capability);
  }
  return [...found].sort();
}
function containsControlData(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsControlData);
  return Object.entries(value).some(([key, child]) => /^(?:role|required_capabilities|available_capabilities|sandbox(?:_mode)?|grants?|permissions?|tools?|token|session|prompt|transcript|credentials?|env)$/i.test(key) || containsControlData(child));
}
function claudeTools(operation) {
  if (operation === 'read') return ['Read'];
  if (operation === 'write') return ['Read', 'Write'];
  if (operation === 'apply') return ['Read', 'Edit'];
  return ['Read', 'Bash'];
}
function base(input, normalized, decision, reason) {
  const role = normalized.role || null;
  const policy = ROLE_POLICY[role];
  return {
    protocol_version: PROTOCOL_VERSION,
    decision,
    reason_code: reason,
    role,
    host_runtime: normalized.host_runtime || null,
    worker_engine: normalized.worker_engine || null,
    resolved_engine: normalized.resolved_engine || null,
    operation: normalized.operation || null,
    required_capabilities: normalized.required_capabilities || [],
    sandbox_mode: decision === 'allow' ? normalized.sandbox_mode : 'read-only',
    permissions: {
      workspace_write: decision === 'allow' && (['write', 'apply'].includes(normalized.operation)
        || (normalized.operation === 'spawn' && normalized.sandbox_mode === 'workspace-write')),
      apply: decision === 'allow' && normalized.operation === 'apply',
      spawn: decision === 'allow' && normalized.operation === 'spawn',
      execution_lease: decision === 'allow' && Boolean(policy && policy.execution_lease),
      credential_env: false,
      state_write: decision === 'allow' && role === 'orchestrator' && normalized.required_capabilities.includes('state.write'),
      result_materialize: decision === 'allow' && role === 'orchestrator' && normalized.required_capabilities.includes('result.materialize'),
    },
    grants: [],
    projection: decision === 'allow' ? (normalized.host_runtime === 'claude'
      ? { host: 'claude', tools: claudeTools(normalized.operation), permission_mode: normalized.sandbox_mode }
      : { host: 'codex', sandbox_mode: normalized.sandbox_mode, inheritance: 'explicit' }) : null,
  };
}
function deny(input, normalized, reason) { return base(input, normalized, 'deny', reason); }

function decide(input = {}) {
  const normalized = { role: normalizeRole(input.role), operation: input.operation, required_capabilities: list(input.required_capabilities) };
  if (!ROLE_POLICY[normalized.role]) return deny(input, normalized, 'invalid-role');
  if (!OPERATIONS.includes(normalized.operation)) return deny(input, normalized, 'invalid-operation');
  let worker;
  try {
    worker = runtime.resolveWorker({ host_runtime: input.host_runtime, worker_engine: input.worker_engine, worker_mode: input.worker_mode, sidecar_declared: input.sidecar_declared });
  } catch (_) { return deny(input, normalized, 'invalid-runtime-contract'); }
  Object.assign(normalized, worker);
  const policy = ROLE_POLICY[normalized.role];
  const requestedGrants = list(input.requested_grants || input.grants);
  if (requestedGrants.length) return deny(input, normalized, 'ad-hoc-grant-denied');
  if (containsControlData(input.untrusted_output)) return deny(input, normalized, 'untrusted-output-barrier');
  if (!policy.operations.includes(normalized.operation)) return deny(input, normalized, 'role-permission-denied');
  const operationCapability = OPERATION_CAPABILITY[normalized.operation];
  if (!normalized.required_capabilities.includes(operationCapability)) normalized.required_capabilities.push(operationCapability);
  normalized.required_capabilities.sort();
  if (normalized.required_capabilities.some((capability) => !policy.capabilities.includes(capability))) return deny(input, normalized, 'role-permission-denied');
  const available = new Set(catalogCapabilities(input, normalized.host_runtime));
  if (normalized.required_capabilities.some((capability) => !available.has(capability))) return deny(input, normalized, 'capability-missing');
  const minimumSandbox = normalized.operation === 'read' ? 'read-only' : 'workspace-write';
  normalized.sandbox_mode = input.sandbox_mode || minimumSandbox;
  if (!['read-only', 'workspace-write'].includes(normalized.sandbox_mode) || (policy.max_sandbox === 'read-only' && normalized.sandbox_mode !== 'read-only')) return deny(input, normalized, 'sandbox-escalation-denied');
  if (['write', 'apply'].includes(normalized.operation) && normalized.sandbox_mode !== 'workspace-write') return deny(input, normalized, 'role-permission-denied');
  if (normalized.operation === 'spawn') {
    if (!input.workspace_root || !input.spawn_cwd) return deny(input, normalized, 'target-required');
    if (!inside(input.workspace_root, input.spawn_cwd)) return deny(input, normalized, 'target-outside-workspace');
  }
  if (['write', 'apply'].includes(normalized.operation)) {
    if (!input.workspace_root || !input.target) return deny(input, normalized, 'target-required');
    const foreignHost = normalized.host_runtime === 'claude' ? 'codex' : 'claude';
    if (input.runtime_homes && input.runtime_homes[foreignHost] && inside(input.runtime_homes[foreignHost], input.target)) return deny(input, normalized, 'cross-host-home');
    if (!inside(input.workspace_root, input.target)) return deny(input, normalized, 'target-outside-workspace');
    const relative = path.relative(path.resolve(input.workspace_root), path.resolve(input.target));
    if (normalized.role !== 'orchestrator' && relative.split(path.sep).includes('.gsd')) return deny(input, normalized, 'protected-state-path');
  }
  return base(input, normalized, 'allow', 'policy-allowed');
}

function main(argv = process.argv.slice(2), output = process.stdout.write.bind(process.stdout), error = process.stderr.write.bind(process.stderr)) {
  try {
    const raw = argv[0]; if (!raw || raw === '--help' || raw === '-h') { output('Usage: forge-dispatch-policy.js JSON\n'); return raw ? 0 : 2; }
    output(`${JSON.stringify(decide(JSON.parse(raw)))}\n`); return 0;
  } catch (cause) { error(`forge-dispatch-policy: invalid-request: ${cause.message}\n`); return 2; }
}
if (require.main === module) process.exitCode = main();
module.exports = { PROTOCOL_VERSION, OPERATIONS, REASON_CODES, ROLE_POLICY, catalogCapabilities, containsControlData, decide, main };
