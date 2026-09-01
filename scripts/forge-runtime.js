#!/usr/bin/env node
'use strict';

// Runtime-neutral protocol.  This module deliberately contains no process,
// filesystem or provider CLI calls: consumers decide how to enforce policy.

const { modelFamily, engineFamily } = require('./forge-model-alias.js');

const PROTOCOL_VERSION = '1.0.0';
const HOST_RUNTIMES = Object.freeze(['claude', 'codex']);
const WORKER_ENGINES = Object.freeze(['native', 'claude', 'codex', 'agy']);
const WORKER_MODES = Object.freeze(['native', 'sidecar']);
const UNIT_STATES = Object.freeze(['queued', 'leased', 'running', 'completed', 'failed', 'cancelled']);
const RESULT_STATUSES = Object.freeze(['succeeded', 'failed', 'cancelled']);
const LIFECYCLE_STATES = Object.freeze(['created', 'dispatched', 'accepted', 'running', 'terminal']);
const SECURITY_ROLES = Object.freeze(['orchestrator', 'worker', 'reviewer', 'observer']);
const REASON_CODES = Object.freeze([
  'default-claude-first',
  'native-resolved',
  'sidecar-declared',
  'invalid-host-runtime',
  'invalid-worker-engine',
  'invalid-worker-mode',
  'invalid-unit-state',
  'invalid-result-status',
  'invalid-lifecycle-state',
  'invalid-security-role',
  'native-engine-host-mismatch',
  'native-sidecar-conflict',
  'sidecar-declaration-required',
  'implicit-recursion-refused',
]);

class RuntimeContractError extends Error {
  constructor(code, detail) {
    super(`Contrato runtime inválido (${code}): ${detail}`);
    this.name = 'RuntimeContractError';
    this.code = code;
  }
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function absent(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function normalizeEnum(value, allowed, fallback, code, label) {
  if (absent(value)) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (allowed.includes(normalized)) return normalized;
  throw new RuntimeContractError(code, `${label} desconhecido: ${JSON.stringify(value)}`);
}

function normalizeHostRuntime(value) {
  return normalizeEnum(value, HOST_RUNTIMES, 'claude', 'invalid-host-runtime', 'host_runtime');
}

function normalizeWorkerEngine(value) {
  return normalizeEnum(value, WORKER_ENGINES, 'native', 'invalid-worker-engine', 'worker_engine');
}

function normalizeWorkerMode(value) {
  return normalizeEnum(value, WORKER_MODES, 'native', 'invalid-worker-mode', 'worker_mode');
}

function normalizeUnit(input) {
  const unit = input || {};
  const state = normalizeEnum(unit.state, UNIT_STATES, 'queued', 'invalid-unit-state', 'unit.state');
  if (!absent(unit.id) && typeof unit.id !== 'string') {
    throw new RuntimeContractError('invalid-unit-state', 'unit.id deve ser texto quando informado');
  }
  if (!absent(unit.type) && typeof unit.type !== 'string') {
    throw new RuntimeContractError('invalid-unit-state', 'unit.type deve ser texto quando informado');
  }
  return { protocol_version: PROTOCOL_VERSION, id: unit.id || '', type: unit.type || '', state };
}

function normalizeResult(input) {
  const result = input || {};
  const status = normalizeEnum(result.status, RESULT_STATUSES, 'succeeded', 'invalid-result-status', 'result.status');
  return {
    protocol_version: PROTOCOL_VERSION,
    status,
    reason_code: absent(result.reason_code) ? '' : String(result.reason_code),
    output: own(result, 'output') ? result.output : null,
  };
}

function normalizeLifecycle(input) {
  const lifecycle = input || {};
  const state = normalizeEnum(lifecycle.state, LIFECYCLE_STATES, 'created', 'invalid-lifecycle-state', 'lifecycle.state');
  return {
    protocol_version: PROTOCOL_VERSION,
    state,
    reason_code: absent(lifecycle.reason_code) ? '' : String(lifecycle.reason_code),
  };
}

function normalizeSecurityMetadata(input) {
  const metadata = input || {};
  const role = normalizeEnum(metadata.role, SECURITY_ROLES, 'worker', 'invalid-security-role', 'security.role');
  const requested = metadata.required_capabilities === undefined ? [] : metadata.required_capabilities;
  if (!Array.isArray(requested) || requested.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new RuntimeContractError('invalid-security-role', 'security.required_capabilities deve ser uma lista de textos não vazios');
  }
  return {
    protocol_version: PROTOCOL_VERSION,
    role,
    required_capabilities: Array.from(new Set(requested.map((entry) => entry.trim()))),
  };
}

// Resolve only the concrete worker identity. This is deliberately narrower
// than resolveWorker: dispatch adapters may use it while projecting legacy
// routing data without giving model/routing fields semantic weight in the
// runtime core.
//
// Keep the native -> host rule here as the single executable source. Callers
// that need worker-mode policy must pass the resulting identity back through
// resolveWorker instead of duplicating its validation rules.
function resolveWorkerIdentity(input) {
  const worker = input || {};
  const host_runtime = normalizeHostRuntime(worker.host_runtime);
  const worker_engine = normalizeWorkerEngine(worker.worker_engine);

  return {
    host_runtime,
    worker_engine,
    resolved_engine: worker_engine === 'native' ? host_runtime : worker_engine,
  };
}

// The explicit declaration is a caller assertion, never an authorization.
// Hosts remain able to enforce stricter policy in their own adapter layer.
function resolveWorker(input) {
  const worker = input || {};
  const identity = resolveWorkerIdentity(worker);
  const { host_runtime, worker_engine, resolved_engine: engine } = identity;
  const worker_mode = normalizeWorkerMode(worker.worker_mode);
  const sidecar_declared = worker.sidecar === true || worker.sidecar_declared === true;

  if (worker_engine === 'native' && worker_mode === 'sidecar') {
    throw new RuntimeContractError('native-sidecar-conflict', 'worker_engine native não pode usar worker_mode sidecar');
  }
  if (worker_mode === 'native' && engine !== host_runtime) {
    throw new RuntimeContractError('native-engine-host-mismatch', 'modo native exige engine igual ao host_runtime');
  }
  if (worker_mode === 'sidecar' && engine === host_runtime && !sidecar_declared) {
    throw new RuntimeContractError('implicit-recursion-refused', 'recursão para o mesmo host não pode ser implícita');
  }
  if (worker_mode === 'sidecar' && !sidecar_declared) {
    throw new RuntimeContractError('sidecar-declaration-required', 'sidecar exige declaração explícita do chamador');
  }

  return {
    protocol_version: PROTOCOL_VERSION,
    host_runtime,
    worker_engine,
    worker_mode,
    resolved_engine: engine,
    sidecar_declared,
    reason_code: worker_engine === 'native' ? 'native-resolved' :
      worker_mode === 'sidecar' ? 'sidecar-declared' : 'default-claude-first',
  };
}

function validateRuntimeContract(input) {
  const contract = input || {};
  return {
    protocol_version: PROTOCOL_VERSION,
    worker: resolveWorker(contract.worker || contract),
    unit: normalizeUnit(contract.unit),
    result: normalizeResult(contract.result),
    lifecycle: normalizeLifecycle(contract.lifecycle),
    security: normalizeSecurityMetadata(contract.security),
  };
}

function runtimeFromModel(model) {
  const family = modelFamily(model);
  return family === 'gpt' ? 'codex' : family === 'claude' ? 'claude' : null;
}

function runtimeFromLegacyEngine(engine) {
  const family = engineFamily(engine);
  return family === 'gpt' ? 'codex' : family === 'claude' ? 'claude' : null;
}

module.exports = {
  PROTOCOL_VERSION,
  HOST_RUNTIMES,
  WORKER_ENGINES,
  WORKER_MODES,
  UNIT_STATES,
  RESULT_STATUSES,
  LIFECYCLE_STATES,
  SECURITY_ROLES,
  REASON_CODES,
  RuntimeContractError,
  normalizeHostRuntime,
  normalizeWorkerEngine,
  normalizeWorkerMode,
  normalizeUnit,
  normalizeResult,
  normalizeLifecycle,
  normalizeSecurityMetadata,
  resolveWorkerIdentity,
  resolveWorker,
  validateRuntimeContract,
  runtimeFromModel,
  runtimeFromLegacyEngine,
};

if (require.main === module) {
  try {
    const input = process.argv[2] ? JSON.parse(process.argv[2]) : {};
    process.stdout.write(JSON.stringify(validateRuntimeContract(input)) + '\n');
  } catch (error) {
    process.stderr.write(`${error.code || 'invalid-runtime-contract'}: ${error.message}\n`);
    process.exit(1);
  }
}
