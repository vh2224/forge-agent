#!/usr/bin/env node
'use strict';

// This guard owns posture only. Identity normalization, including the
// native -> host resolution rule, remains canonical in forge-runtime.
const { resolveWorkerIdentity } = require('./forge-runtime.js');
const { capability } = require('./forge-transport-capabilities.js');

const REASON_CODES = Object.freeze({
  RUNTIME_POSTURE_OBSERVED: 'runtime-posture-observed',
  CODEX_CLAUDE_UNROUTABLE: 'codex-claude-unroutable',
  RUNTIME_POSTURE_UNMAPPED: 'runtime-posture-unmapped',
  INVALID_RUNTIME_GUARD_INPUT: 'invalid-runtime-guard-input',
});

// Policy is deliberately complete data, not a collection of leg-specific
// branches. Consumers can audit every supported host/worker quadrant here.
const RUNTIME_POSTURE_MAP = Object.freeze({
  'claude→claude': Object.freeze({
    posture: 'observe',
    reason_code: REASON_CODES.RUNTIME_POSTURE_OBSERVED,
    hint: 'Dispatch observed: the native Claude leg is routable.',
  }),
  'claude→codex': Object.freeze({
    posture: 'observe',
    reason_code: REASON_CODES.RUNTIME_POSTURE_OBSERVED,
    hint: 'Dispatch observed: the Codex worker is routed from the Claude host.',
  }),
  'codex→claude': Object.freeze({
    posture: 'observe',
    reason_code: REASON_CODES.RUNTIME_POSTURE_OBSERVED,
    hint: 'Claude delivery uses the account-backed sidecar contract for the selected unit.',
  }),
  'codex→codex': Object.freeze({
    posture: 'observe',
    reason_code: REASON_CODES.RUNTIME_POSTURE_OBSERVED,
    hint: 'Dispatch permitido, mas um host Codex criando outro worker Codex pode ser ineficiente.',
  }),
});

class RuntimeGuardInputError extends Error {
  constructor(detail) {
    super(detail);
    this.name = 'RuntimeGuardInputError';
    this.code = REASON_CODES.INVALID_RUNTIME_GUARD_INPUT;
  }
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function errorResult(reasonCode, hint, identity) {
  const known = identity || {};
  return {
    host_runtime: known.host_runtime || '',
    worker_engine: known.worker_engine || '',
    resolved_worker_engine: known.resolved_engine || '',
    leg: known.host_runtime && known.resolved_engine
      ? `${known.host_runtime}→${known.resolved_engine}`
      : '',
    posture: null,
    decision: 'error',
    dispatch_allowed: false,
    reason_code: reasonCode,
    hint,
  };
}

/**
 * Evaluate an explicit dispatch identity and its unit delivery contract.
 * Pure: no environment variable can enable a missing transport contract.
 */
function evaluateDispatchGuard(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return errorResult(
      REASON_CODES.INVALID_RUNTIME_GUARD_INPUT,
      'Informe host_runtime e worker_engine explicitamente.',
    );
  }
  if (typeof input.host_runtime !== 'string' || input.host_runtime.trim() === '' ||
      typeof input.worker_engine !== 'string' || input.worker_engine.trim() === '') {
    return errorResult(
      REASON_CODES.INVALID_RUNTIME_GUARD_INPUT,
      'Informe host_runtime e worker_engine explicitamente.',
    );
  }

  let identity;
  try {
    identity = resolveWorkerIdentity(input);
  } catch (error) {
    return errorResult(
      REASON_CODES.INVALID_RUNTIME_GUARD_INPUT,
      `Corrija a identidade runtime antes do dispatch (${error.code || 'invalid-runtime-identity'}).`,
    );
  }

  const leg = `${identity.host_runtime}→${identity.resolved_engine}`;
  if (!hasOwn(RUNTIME_POSTURE_MAP, leg)) {
    return errorResult(
      REASON_CODES.RUNTIME_POSTURE_UNMAPPED,
      `Nenhuma postura runtime foi configurada para ${leg}; adicione uma célula explícita antes do dispatch.`,
      identity,
    );
  }

  const policy = RUNTIME_POSTURE_MAP[leg];
  const sidecar = input.worker_mode === 'sidecar' || identity.host_runtime !== identity.resolved_engine;
  // Legacy identity-only callers can inspect posture. Actual dispatch callers
  // pass unit_type and receive the same capability decision as the transport.
  if (sidecar && (input.unit_type !== undefined || leg === 'codex→claude')) {
    const transport = capability(identity.resolved_engine, input.unit_type);
    if (!transport.supported) return {
      ...errorResult(transport.reason_code, transport.hint, identity),
      posture: 'enforce', decision: 'refuse',
    };
  }
  // Keep the posture axis for callers; capability refusal above is independent
  // of the historical identity-only observation map.
  const refusalActive = policy.posture === 'enforce';
  return {
    host_runtime: identity.host_runtime,
    worker_engine: identity.worker_engine,
    resolved_worker_engine: identity.resolved_engine,
    leg,
    posture: policy.posture,
    decision: refusalActive ? 'refuse' : 'advisory',
    dispatch_allowed: !refusalActive,
    reason_code: policy.reason_code,
    hint: policy.hint,
  };
}

function parseArgs(argv) {
  const parsed = { host_runtime: '', worker_engine: '', json: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json') {
      if (seen.has(flag)) throw new RuntimeGuardInputError('--json só pode ser informado uma vez');
      seen.add(flag);
      parsed.json = true;
      continue;
    }
    if (flag !== '--host-runtime' && flag !== '--worker-engine' && flag !== '--unit-type') {
      throw new RuntimeGuardInputError(`Opção desconhecida: ${flag}`);
    }
    if (seen.has(flag)) throw new RuntimeGuardInputError(`${flag} só pode ser informado uma vez`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new RuntimeGuardInputError(`${flag} exige um valor`);
    }
    seen.add(flag);
    if (flag === '--host-runtime') parsed.host_runtime = value;
    else if (flag === '--worker-engine') parsed.worker_engine = value;
    else parsed.unit_type = value;
    index += 1;
  }
  if (!parsed.host_runtime || !parsed.worker_engine) {
    throw new RuntimeGuardInputError('--host-runtime e --worker-engine são obrigatórios');
  }
  return parsed;
}

function exitCodeFor(result) {
  if (result.decision === 'error') return 2;
  return result.dispatch_allowed ? 0 : 1;
}

// `environment` is accepted for call-site stability and deliberately unused:
// posture depends on the identity only, so no ambient variable can change this
// verdict.
function main(argv, environment, streams) {
  const args = Array.isArray(argv) ? argv : [];
  const io = streams || { stdout: process.stdout, stderr: process.stderr };
  const wantsJson = args.includes('--json');
  let result;
  try {
    const parsed = parseArgs(args);
    result = evaluateDispatchGuard(parsed);
  } catch (error) {
    result = errorResult(
      REASON_CODES.INVALID_RUNTIME_GUARD_INPUT,
      error && error.message ? error.message : 'Entrada inválida para o runtime guard.',
    );
  }

  const code = exitCodeFor(result);
  if (wantsJson) {
    io.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const output = `${result.reason_code}: ${result.decision}\n${result.hint}\n`;
    (code === 0 ? io.stdout : io.stderr).write(output);
  }
  return code;
}

module.exports = {
  REASON_CODES,
  RUNTIME_POSTURE_MAP,
  RuntimeGuardInputError,
  evaluateDispatchGuard,
  parseArgs,
  exitCodeFor,
  main,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
