#!/usr/bin/env node
'use strict';

// Opt-in effort for the review legs (challenge, defense, rebuttal).
//
// Absent effort preference → legacy effort delivery: no argv, no cost.
// Explicit native Claude thinking preferences still pass the model-policy guard.
// Present preference → one delivery plan, never a silent downgrade:
//   - external leg on Codex (app-server) or the Claude CLI: the model policy
//     clamps the value when the model is known and `--effort <v>` is returned
//     for the caller's forge-xllm command line;
//   - native Claude leg (reviewer/advocate, external→Claude fallback, rebuttal
//     resumed with SendMessage, engine workflow): the effort lives in the agent
//     frontmatter, so the observed binding must match or the leg is refused
//     before launch (`native-effort-binding-mismatch`);
//   - native Codex leg (host codex): the effort is the `reasoning_effort`
//     argument of the active tool, checked against the capabilities the caller
//     observed from that tool;
//   - agy: there is no effort transport, so an explicit value is refused
//     (`effort-transport-unsupported`) instead of being promised.
// Native legs require capabilities observed from the active tool; this helper
// never assumes a default tool, so a missing observation is a named refusal.
// An invalid value is refused visibly (`review-effort-invalid`). A refusal is
// the stage's existing unavailability path; no worker is ever substituted.
//
// This helper never launches anything. `effort_planned` is what the caller
// will pass; `effort_sent` stays null here and is recorded by the caller only
// after the leg was actually launched with that argument. `effort_applied` is
// always null: no transport reads back what a provider applied.

const fs = require('fs');
const path = require('path');
const { readPrefsCached } = require('./forge-prefs.js');
const modelPolicy = require('./forge-model-policy.js');

const LEGS = Object.freeze({ challenge: 'challenge_effort', defense: 'defense_effort', rebuttal: 'rebuttal_effort' });
const TRANSPORTS = Object.freeze(['app-server', 'claude-cli', 'claude-native', 'codex-native', 'agy-cli']);
const ENGINE_TRANSPORTS = Object.freeze({
  codex: ['app-server', 'codex-native'], claude: ['claude-cli', 'claude-native'], agy: ['agy-cli'],
  workflow: ['claude-native'],
});

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function usage(message) {
  const error = new Error(message);
  error.code = 'invalid-arguments';
  return error;
}

function baseResult(leg) {
  return {
    leg, configured: false, effort_requested: null, effort_resolved: null, effort_planned: null,
    effort_sent: null, effort_applied: null, argv: [], native_args: null, reason: null, diagnostics: [], refusal: null,
  };
}

function refuse(result, code, hint, fields) {
  const diagnostic = { code, layer: 'review-effort', ...(fields || {}) };
  return { ...result, argv: [], native_args: null, effort_planned: null, effort_sent: null,
    diagnostics: [...result.diagnostics, diagnostic], refusal: { code, hint } };
}

function readJsonInput(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(fs.readFileSync(value, 'utf8')); }
  catch { return { invalid: true }; }
}

function nativeDispatch(model, effort, host) {
  return { model, model_requested: model, model_resolved: model, effort, host_runtime: host,
    resolved_worker_engine: host, worker_mode: 'native', dispatch_engine: host, dispatch_allowed: true, config_ok: true };
}

function claudeNative(planned, ctx) {
  const { leg, key, requested, resolved, model, binding, capabilities } = ctx;
  if (!binding || binding.invalid) {
    return refuse(planned, 'native-effort-binding-missing',
      `O leg nativo ${leg} exige a observação do agente (--binding-json) para entregar review.${key}; nada foi lançado.`,
      { requested, host: 'claude', transport: 'claude-native' });
  }
  const agentType = text(binding.agentType || binding.agent_type);
  const invocation = require('./forge-native-invocation.js');
  const effortBinding = { transport: 'agent-frontmatter', agentPath: binding.agentPath || binding.agent_path,
    sourceFingerprint: binding.sourceFingerprint || binding.source_fingerprint };
  // Observation first (same bytes, same fingerprint) so a refusal can name the
  // binding it saw; the full native preflight then checks the capabilities the
  // caller observed, the alias and the thinking binding. Nothing is invoked.
  const observed = invocation.observeClaudeAgentBinding({ agentType, agentPath: effortBinding.agentPath,
    sourceFingerprint: effortBinding.sourceFingerprint });
  let verdict;
  if (!observed.ok) verdict = { ok: false, reason_code: observed.reason_code };
  else if (observed.effort !== resolved) verdict = { ok: false, reason_code: 'native-effort-binding-mismatch' };
  else if (!model) verdict = { ok: false, reason_code: 'native-model-missing' };
  else {
    verdict = invocation.preflightNativeBinding({ hostRuntime: 'claude', resolvedDispatch: nativeDispatch(model, resolved, 'claude'),
      activeCapabilities: capabilities, agentType, effortBinding });
  }
  if (!verdict.ok) {
    const observedEffort = observed.ok ? observed.effort : null;
    return refuse(planned, verdict.reason_code,
      `review.${key} = ${requested} (resolvido ${resolved}) não pode ser entregue ao agente ${agentType || '(sem agente)'}`
      + `${observedEffort ? ` (binding observado: effort ${observedEffort})` : ''} no host claude `
      + `(${verdict.reason_code}, camada native-binding). `
      + 'A definição do agente não foi reescrita; o leg segue o caminho de indisponibilidade do estágio.',
      { requested, resolved, agent: agentType || null, binding_observed: observedEffort, host: 'claude', transport: 'claude-native' });
  }
  // A frontmatter thinking declaration is inert (inherited from the session):
  // it is surfaced as a diagnostic, never as a refusal or a delivered binding.
  return { ...planned, effort_planned: `agent-frontmatter:${observed.effort}`, argv: [],
    diagnostics: [...planned.diagnostics, ...(Array.isArray(verdict.diagnostics) ? verdict.diagnostics : [])],
    ...(verdict.telemetry && verdict.telemetry.model_version_proof ? { model_version_proof: verdict.telemetry.model_version_proof } : {}) };
}

function codexNative(planned, ctx) {
  const { leg, key, requested, resolved, model, capabilities, agentType } = ctx;
  if (!model || !agentType) {
    return refuse(planned, 'invalid-native-invocation-input',
      `O leg nativo ${leg} no host codex exige --model e --agent-type para planejar review.${key}; nada foi lançado.`,
      { requested, host: 'codex', transport: 'codex-native' });
  }
  const verdict = require('./forge-native-invocation.js').preflightNativeBinding({ hostRuntime: 'codex',
    resolvedDispatch: nativeDispatch(model, resolved, 'codex'), activeCapabilities: capabilities, agentType });
  if (!verdict.ok) {
    return refuse(planned, verdict.reason_code,
      `review.${key} = ${requested} (resolvido ${resolved}) não pode ser entregue ao agente nativo ${agentType} no host codex `
      + `(${verdict.reason_code}, camada native-capabilities). Nenhum worker foi trocado.`,
      { requested, resolved, agent: agentType, host: 'codex', transport: 'codex-native' });
  }
  return { ...planned, effort_planned: resolved, argv: [], native_args: { reasoning_effort: resolved } };
}

/**
 * Resolve one review leg's effort delivery plan.
 * @param {{leg:string, engine:string, transport:string, model?:string, binding?:object|string,
 *   capabilities?:object|string, agentType?:string, cwd?:string, prefs?:object}} input
 */
function resolveReviewEffort(input) {
  const options = input || {};
  const leg = text(options.leg).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(LEGS, leg)) throw usage(`--leg must be one of ${Object.keys(LEGS).join('|')}`);
  const engine = text(options.engine).toLowerCase();
  const transport = text(options.transport).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(ENGINE_TRANSPORTS, engine)) throw usage('--engine must be codex|claude|agy|workflow');
  if (!TRANSPORTS.includes(transport) || !ENGINE_TRANSPORTS[engine].includes(transport)) {
    throw usage(`--transport ${transport || '(missing)'} is not a transport of engine ${engine}`);
  }
  const loaded = options.prefs ? { ok: true, prefs: options.prefs } : readPrefsCached(options.cwd || process.cwd());
  if (!loaded.ok) {
    const error = new Error(`Cannot resolve review effort: ${JSON.stringify(loaded.errors)}`);
    error.code = 'review-prefs-invalid';
    throw error;
  }
  const prefs = loaded.prefs || {};
  const review = prefs.review && typeof prefs.review === 'object' ? prefs.review : {};
  const key = LEGS[leg];
  const result = baseResult(leg);
  const model = text(options.model);
  // Operator preferences are independent of an opt-in review effort and of the
  // inert thinking declaration in an agent's frontmatter. Validate them even
  // when the leg keeps its legacy effort delivery (no binding read or launch).
  if (transport === 'claude-native') {
    const thinkingKey = modelPolicy.thinkingPrefKey(model);
    const mode = prefs.thinking && prefs.thinking[thinkingKey];
    const thinking = modelPolicy.evaluateThinking({ model, effort: review[key],
      mode: typeof mode === 'string' ? mode.trim().toLowerCase() : mode, transport });
    if (!thinking.ok) {
      return refuse(result, thinking.reason_code,
        `A preferência thinking.${thinkingKey} não é compatível com ${model} no leg nativo ${leg}; nada foi lançado.`,
        thinking.diagnostics[0]);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(review, key) || review[key] === null || review[key] === undefined) return result;

  const requested = text(review[key]).toLowerCase();
  const configured = { ...result, configured: true, effort_requested: requested || null, reason: `review.${key}` };
  if (!modelPolicy.EFFORT_SCALE.includes(requested)) {
    return refuse(configured, 'review-effort-invalid',
      `review.${key} = ${JSON.stringify(review[key])} não é um esforço válido (low|medium|high|xhigh|max); o leg ${leg} não foi lançado.`,
      { requested: review[key] });
  }
  if (transport === 'agy-cli') {
    return refuse(configured, 'effort-transport-unsupported',
      `review.${key} = ${requested} não tem transporte no agy; o esforço não seria entregue. Remova a chave ou use outro challenger; nenhum worker foi trocado.`,
      { requested, engine, transport });
  }
  const policy = modelPolicy.applyEffortPolicy({ model, effort: requested });
  const diagnostics = model ? policy.diagnostics : [{ code: 'model-policy-unknown', model: null }];
  const planned = { ...configured, effort_resolved: policy.effort, diagnostics };
  if (policy.unsupported) {
    return refuse(planned, 'effort-unsupported-by-model',
      `review.${key} = ${requested} não é documentado para ${model}; o leg ${leg} não foi lançado e o valor não foi rebaixado.`,
      { requested, model, transport });
  }
  const ctx = { leg, key, requested, resolved: policy.effort, model,
    binding: readJsonInput(options.binding), capabilities: readJsonInput(options.capabilities),
    agentType: text(options.agentType) };
  if (ctx.capabilities && ctx.capabilities.invalid) ctx.capabilities = null;
  if (transport === 'claude-native') return claudeNative(planned, ctx);
  if (transport === 'codex-native') return codexNative(planned, ctx);
  // External leg: the caller forwards these argv to forge-xllm, which passes
  // --effort to the Claude CLI argv or to the app-server turn params.
  return { ...planned, effort_planned: policy.effort, argv: ['--effort', policy.effort] };
}

function parseArgs(argv) {
  const parsed = { json: false };
  const names = { '--leg': 'leg', '--engine': 'engine', '--transport': 'transport', '--model': 'model',
    '--binding-json': 'binding', '--capabilities-json': 'capabilities', '--agent-type': 'agentType', '--cwd': 'cwd' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json') { parsed.json = true; continue; }
    if (!Object.prototype.hasOwnProperty.call(names, flag) || argv[index + 1] === undefined) throw usage(`argumento inválido: ${flag}`);
    parsed[names[flag]] = argv[index + 1];
    index += 1;
  }
  if (parsed.cwd) parsed.cwd = path.resolve(parsed.cwd);
  return parsed;
}

module.exports = { LEGS, TRANSPORTS, resolveReviewEffort, parseArgs };

if (require.main === module) {
  try {
    const result = resolveReviewEffort(parseArgs(process.argv.slice(2)));
    for (const item of result.diagnostics) process.stderr.write(`⚠ review-effort ${result.leg}: ${item.code}\n`);
    if (result.refusal) process.stderr.write(`✗ ${result.refusal.code}: ${result.refusal.hint}\n`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.refusal) process.exitCode = 3;
  } catch (error) {
    process.stderr.write(`forge-review-effort: ${error.code || 'failed'}: ${error.message}\n`);
    process.exitCode = 2;
  }
}
