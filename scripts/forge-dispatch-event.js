#!/usr/bin/env node
'use strict';

// Single executable emitter for the `dispatch` event line.
//
// Every orchestration surface (forge-auto single + batch, forge-next, forge-task
// native/sidecar/review-fix) renders its dispatch record here instead of hand
// writing JSON in shell. Hand-written `echo` lines are how 151 distinct event
// shapes accumulated across 265 reviews, and how the runtime posture axes
// (`dispatch_reason_code`, `dispatch_posture`, the leg) ended up in zero of the
// five skill emissions while the resolver had computed them all along.
//
// The posture axes are not optional here: an event that cannot name its posture
// is refused (exit 2) rather than written half-blind.

const fs = require('fs');
const path = require('path');

const FLAGS = Object.freeze({
  '--route-json': 'routeJson',
  '--route-json-file': 'routeJsonFile',
  '--unit': 'unit',
  '--model': 'model',
  '--engine': 'engine',
  '--tier': 'tier',
  '--reason': 'reason',
  '--effort': 'effort',
  '--effort-reason': 'effortReason',
  '--domain': 'domain',
  '--route-source': 'routeSource',
  '--chain-len': 'chainLen',
  '--model-applied': 'modelApplied',
  '--host-runtime': 'hostRuntime',
  '--worker-mode': 'workerMode',
  '--resolved-worker-engine': 'resolvedWorkerEngine',
  '--dispatch-allowed': 'dispatchAllowed',
  '--dispatch-reason-code': 'dispatchReasonCode',
  '--dispatch-posture': 'dispatchPosture',
  '--dispatch-decision': 'dispatchDecision',
  '--slice': 'slice',
  '--milestone': 'milestone',
  '--input-tokens': 'inputTokens',
  '--output-tokens': 'outputTokens',
  '--batch-size': 'batchSize',
  '--batch-id': 'batchId',
  '--member-ref': 'memberRef',
  '--vcs': 'vcs',
  '--transport': 'transport',
  '--transport-version': 'transportVersion',
  '--transport-reason': 'transportReason',
  '--dispatch-id': 'dispatchId',
  '--attempt': 'attempt',
  '--ts': 'ts',
  '--events': 'events',
});

class DispatchEventError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DispatchEventError';
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!Object.prototype.hasOwnProperty.call(FLAGS, flag)) {
      throw new DispatchEventError(`Opção desconhecida: ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new DispatchEventError(`${flag} exige um valor`);
    parsed[FLAGS[flag]] = value;
    index += 1;
  }
  return parsed;
}

function text(value) {
  return value === undefined || value === null ? '' : String(value);
}

function present(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

// Shell passes everything as a string. `true`/`false` are the only truth values a
// resolver export can carry; anything else is a bug the emitter must not paper
// over with a truthy coercion.
function bool(value, field) {
  if (value === true || value === false) return value;
  const normalized = text(value).trim();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new DispatchEventError(`${field} deve ser true ou false (recebido: ${JSON.stringify(normalized)})`);
}

function number(value, field) {
  const normalized = text(value).trim();
  if (normalized === '') return 0;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) throw new DispatchEventError(`${field} deve ser numérico (recebido: ${JSON.stringify(normalized)})`);
  return parsed;
}

function readRoute(args) {
  let raw = args.routeJson;
  if (present(args.routeJsonFile)) raw = fs.readFileSync(args.routeJsonFile, 'utf8');
  if (!present(raw)) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DispatchEventError(`--route-json não é JSON válido (${(error && error.message) || error})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DispatchEventError('--route-json deve ser um objeto de contrato do resolver');
  }
  return parsed;
}

function pick(override, routeValue) {
  return present(override) ? String(override) : text(routeValue);
}

// Issue 343 U3a: a sidecar cohort member names its cohort and its own attempt. The two
// fields travel together with the cohort size; a partial or malformed set is refused, and
// a line without them keeps the exact previous key set.
const BATCH_ID = /^batch-[a-f0-9]{32}$/;
const MEMBER_REF = /^m[0-7]-[a-f0-9]{16}$/;
function cohortFields(args) {
  const named = [present(args.batchId), present(args.memberRef)];
  if (!named[0] && !named[1]) return null;
  if (!named[0] || !named[1]) throw new DispatchEventError('batch_id e member_ref vêm juntos: informe os dois ou nenhum');
  const batchId = String(args.batchId).trim(), memberRef = String(args.memberRef).trim();
  if (!BATCH_ID.test(batchId)) throw new DispatchEventError(`batch_id inválido (recebido: ${JSON.stringify(batchId)})`);
  if (!MEMBER_REF.test(memberRef)) throw new DispatchEventError(`member_ref inválido (recebido: ${JSON.stringify(memberRef)})`);
  const size = present(args.batchSize) ? number(args.batchSize, 'batch_size') : NaN;
  if (!Number.isInteger(size) || size < 2 || size > 8) throw new DispatchEventError('batch_size de um membro de cohort deve ser um inteiro de 2 a 8');
  return { batch_id: batchId, member_ref: memberRef };
}

/**
 * Build the dispatch event object. Pure: no I/O, no clock unless the caller
 * omitted `--ts` (then `now` is used, which the caller supplies in tests).
 */
function buildDispatchEvent(args, route, now) {
  if (!present(args.unit)) throw new DispatchEventError('--unit é obrigatório');

  const hostRuntime = pick(args.hostRuntime, route.host_runtime);
  const workerMode = pick(args.workerMode, route.worker_mode);
  const resolvedWorkerEngine = pick(args.resolvedWorkerEngine, route.resolved_worker_engine);
  const dispatchReasonCode = pick(args.dispatchReasonCode, route.dispatch_reason_code);
  const dispatchPosture = pick(args.dispatchPosture, route.dispatch_posture);
  const dispatchDecision = pick(args.dispatchDecision, route.dispatch_decision);
  const allowedSource = present(args.dispatchAllowed) ? args.dispatchAllowed : route.dispatch_allowed;
  if (allowedSource === undefined || allowedSource === null || text(allowedSource).trim() === '') {
    throw new DispatchEventError('dispatch_allowed ausente: informe --route-json ou --dispatch-allowed');
  }
  // Posture is the whole point of this emitter: a dispatch record that cannot
  // name its own verdict is refused rather than written without it. The three
  // verdict axes are checked here, before anything is rendered or appended,
  // because an empty string is exactly the shape a missing axis takes once it
  // has crossed a shell — a line carrying `"dispatch_posture":""` looks present
  // in the log and says nothing, which is the failure this emitter exists to
  // prevent. The resolver leaves `dispatch_posture` null only on legs it has
  // already refused (invalid contract, unmapped quadrant), so refusing to write
  // such a record removes no legitimate emission.
  for (const [field, value] of [
    ['host_runtime', hostRuntime],
    ['worker_mode', workerMode],
    ['resolved_worker_engine', resolvedWorkerEngine],
    ['dispatch_reason_code', dispatchReasonCode],
    ['dispatch_posture', dispatchPosture],
    ['dispatch_decision', dispatchDecision],
  ]) {
    if (!present(value)) throw new DispatchEventError(`${field} ausente: informe --route-json ou a flag correspondente`);
  }
  const cohort = cohortFields(args);

  const event = {
    ts: present(args.ts) ? String(args.ts) : now,
    event: 'dispatch',
    unit: String(args.unit),
    model: pick(args.model, route.model),
    host_runtime: hostRuntime,
    worker_mode: workerMode,
    dispatch_allowed: bool(allowedSource, 'dispatch_allowed'),
    tier: pick(args.tier, route.tier),
    reason: pick(args.reason, route.reason),
    effort: pick(args.effort, route.effort),
    effort_reason: pick(args.effortReason, route.effort_reason),
    engine: pick(args.engine, route.engine) || 'claude',
    domain: pick(args.domain, route.domain),
    route_source: pick(args.routeSource, route.route_source),
    chain_len: number(present(args.chainLen) ? args.chainLen : route.chain_len, 'chain_len'),
  };

  if (present(args.slice)) event.slice = String(args.slice);
  if (args.milestone !== undefined) event.milestone = String(args.milestone);
  if (present(args.inputTokens)) event.input_tokens = number(args.inputTokens, 'input_tokens');
  if (present(args.outputTokens)) event.output_tokens = number(args.outputTokens, 'output_tokens');
  event.model_applied = present(args.modelApplied) ? String(args.modelApplied) : null;
  if (present(args.batchSize)) event.batch_size = number(args.batchSize, 'batch_size');
  if (cohort) {
    event.batch_id = cohort.batch_id;
    event.member_ref = cohort.member_ref;
  }
  if (present(args.dispatchId)) event.dispatch_id = String(args.dispatchId);
  if (present(args.attempt)) event.attempt = number(args.attempt, 'attempt');
  event.vcs = present(args.vcs) ? String(args.vcs) : 'unknown';
  event.transport = present(args.transport) ? String(args.transport) : 'unknown';
  if (present(args.transportVersion)) event.transport_version = String(args.transportVersion);
  if (present(args.transportReason)) event.transport_reason = String(args.transportReason);

  // Durable posture axes — always present, after every legacy field, additive for
  // readers (only the optional model-policy keys below may follow them).
  event.resolved_worker_engine = resolvedWorkerEngine;
  event.leg = `${hostRuntime}→${resolvedWorkerEngine}`;
  event.dispatch_reason_code = dispatchReasonCode;
  event.dispatch_posture = dispatchPosture;
  event.dispatch_decision = dispatchDecision;
  // Model-policy telemetry, copied from the resolver contract only when the
  // route carries it: an older route (or a hand-built one) keeps the exact
  // previous key set. Requested ≠ resolved ≠ applied; nothing here is readback.
  if (present(route.effort_requested)) event.effort_requested = String(route.effort_requested);
  if (present(route.policy_version)) event.policy_version = String(route.policy_version);
  if (Array.isArray(route.policy_diagnostics)) event.policy_diagnostics = route.policy_diagnostics;
  return event;
}

function renderDispatchEvent(args, route, now) {
  // One line, no embedded newlines: appends stay atomic under PIPE_BUF.
  return `${JSON.stringify(buildDispatchEvent(args, route, now))}\n`;
}

async function appendDispatchEvent(broker, args, route, now = new Date().toISOString()) {
  require('./forge-artifact-reconciliation').assertBroker(broker);
  return broker.append(args.relativePath || '.gsd/forge/events.jsonl', renderDispatchEvent(args, route, now));
}

// The route axes a member event must carry exactly as the cohort decision resolved them for
// THIS member: a sibling's route, or another model, tier or effort, is never stamped on it.
const MEMBER_ROUTE_KEYS = Object.freeze(['model', 'tier', 'effort', 'worker_mode', 'resolved_worker_engine', 'host_runtime']);

/**
 * Issue 343 U3a: the dispatch event of one sidecar cohort member, appended only through the
 * live cohort broker (forge-artifact-reconciliation startBatchBroker) by that member's own
 * opaque handle. The cohort fields come from the broker's closed registry, never from the
 * caller: a caller value naming another batch, member, unit or dispatch is refused, and the
 * rest of the line is the same canonical builder (the Route stays derived from each member's
 * real events). The broker signs the line into the cohort's single stream.
 */
async function appendMemberDispatchEvent(broker, memberHandle, args, route, now = new Date().toISOString()) {
  const client = require('./forge-artifact-reconciliation').assertBatchBroker(broker);
  const member = client.memberIdentity(memberHandle);
  const input = { ...(args || {}) };
  delete input.relativePath;
  for (const [key, value] of [['batchId', member.batch_id], ['memberRef', member.member_ref], ['batchSize', member.batch_size],
    ['unit', member.unit], ['dispatchId', member.dispatch_id], ['milestone', member.milestone], ['slice', member.slice]]) {
    if (present(input[key]) && String(input[key]).trim() !== String(value)) {
      throw Object.assign(new DispatchEventError(`${key} não pertence a este membro do cohort`), { code: 'dispatch-event-member-mismatch' });
    }
    input[key] = String(value);
  }
  const event = buildDispatchEvent(input, route || {}, now);
  for (const key of MEMBER_ROUTE_KEYS) {
    if (event[key] !== member.route[key]) {
      throw Object.assign(new DispatchEventError(`${key} difere da rota resolvida deste membro`), { code: 'dispatch-event-member-route-mismatch' });
    }
  }
  return client.appendMember(memberHandle, (args && args.relativePath) || '.gsd/forge/events.jsonl', `${JSON.stringify(event)}\n`);
}

function main(argv, streams, now) {
  const io = streams || { stdout: process.stdout, stderr: process.stderr };
  const stamp = now || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  let line;
  let target = '';
  try {
    const args = parseArgs(Array.isArray(argv) ? argv : []);
    target = text(args.events);
    line = renderDispatchEvent(args, readRoute(args), stamp);
  } catch (error) {
    io.stderr.write(`${(error && error.message) || error}\n`);
    return 2;
  }
  if (target) {
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    fs.appendFileSync(target, line);
  } else {
    io.stdout.write(line);
  }
  return 0;
}

module.exports = { FLAGS, DispatchEventError, parseArgs, buildDispatchEvent, renderDispatchEvent, appendDispatchEvent,
  appendMemberDispatchEvent, main };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
