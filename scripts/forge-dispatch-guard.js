#!/usr/bin/env node
'use strict';

// This guard owns posture only. Identity normalization, including the
// native -> host resolution rule, remains canonical in forge-runtime.
const { resolveWorkerIdentity } = require('./forge-runtime.js');

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
    posture: 'enforce',
    reason_code: REASON_CODES.CODEX_CLAUDE_UNROUTABLE,
    hint: 'Use um worker Codex roteável ou execute sob um host Claude.',
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

function enforcementEnabled(environment) {
  const env = environment && typeof environment === 'object' ? environment : {};
  return env.FORGE_RUNTIME_ENFORCE !== '0';
}

function errorResult(reasonCode, hint, enforcement, identity) {
  const known = identity || {};
  return {
    host_runtime: known.host_runtime || '',
    worker_engine: known.worker_engine || '',
    resolved_worker_engine: known.resolved_engine || '',
    leg: known.host_runtime && known.resolved_engine
      ? `${known.host_runtime}→${known.resolved_engine}`
      : '',
    posture: null,
    enforcement_enabled: enforcement,
    decision: 'error',
    dispatch_allowed: false,
    reason_code: reasonCode,
    hint,
    suppressed_action: null,
  };
}

/**
 * Evaluate one explicit dispatch identity. Pure: all inputs, including the
 * enforcement environment, are supplied by the caller and no I/O occurs.
 */
function evaluateDispatchGuard(input, environment) {
  const enforcement = enforcementEnabled(environment);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return errorResult(
      REASON_CODES.INVALID_RUNTIME_GUARD_INPUT,
      'Informe host_runtime e worker_engine explicitamente.',
      enforcement,
    );
  }
  if (typeof input.host_runtime !== 'string' || input.host_runtime.trim() === '' ||
      typeof input.worker_engine !== 'string' || input.worker_engine.trim() === '') {
    return errorResult(
      REASON_CODES.INVALID_RUNTIME_GUARD_INPUT,
      'Informe host_runtime e worker_engine explicitamente.',
      enforcement,
    );
  }

  let identity;
  try {
    identity = resolveWorkerIdentity(input);
  } catch (error) {
    return errorResult(
      REASON_CODES.INVALID_RUNTIME_GUARD_INPUT,
      `Corrija a identidade runtime antes do dispatch (${error.code || 'invalid-runtime-identity'}).`,
      enforcement,
    );
  }

  const leg = `${identity.host_runtime}→${identity.resolved_engine}`;
  if (!hasOwn(RUNTIME_POSTURE_MAP, leg)) {
    return errorResult(
      REASON_CODES.RUNTIME_POSTURE_UNMAPPED,
      `Nenhuma postura runtime foi configurada para ${leg}; adicione uma célula explícita antes do dispatch.`,
      enforcement,
      identity,
    );
  }

  const policy = RUNTIME_POSTURE_MAP[leg];
  const refusalActive = policy.posture === 'enforce' && enforcement;
  const refusalSuppressed = policy.posture === 'enforce' && !enforcement;
  return {
    host_runtime: identity.host_runtime,
    worker_engine: identity.worker_engine,
    resolved_worker_engine: identity.resolved_engine,
    leg,
    posture: policy.posture,
    enforcement_enabled: enforcement,
    decision: refusalActive ? 'refuse' : 'advisory',
    dispatch_allowed: !refusalActive,
    reason_code: policy.reason_code,
    hint: policy.hint,
    suppressed_action: refusalSuppressed ? 'refuse' : null,
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
    if (flag !== '--host-runtime' && flag !== '--worker-engine') {
      throw new RuntimeGuardInputError(`Opção desconhecida: ${flag}`);
    }
    if (seen.has(flag)) throw new RuntimeGuardInputError(`${flag} só pode ser informado uma vez`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new RuntimeGuardInputError(`${flag} exige um valor`);
    }
    seen.add(flag);
    if (flag === '--host-runtime') parsed.host_runtime = value;
    else parsed.worker_engine = value;
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

function main(argv, environment, streams) {
  const args = Array.isArray(argv) ? argv : [];
  const env = environment && typeof environment === 'object' ? environment : {};
  const io = streams || { stdout: process.stdout, stderr: process.stderr };
  const wantsJson = args.includes('--json');
  let result;
  try {
    const parsed = parseArgs(args);
    result = evaluateDispatchGuard(parsed, env);
  } catch (error) {
    result = errorResult(
      REASON_CODES.INVALID_RUNTIME_GUARD_INPUT,
      error && error.message ? error.message : 'Entrada inválida para o runtime guard.',
      enforcementEnabled(env),
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
  enforcementEnabled,
  evaluateDispatchGuard,
  parseArgs,
  exitCodeFor,
  main,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
