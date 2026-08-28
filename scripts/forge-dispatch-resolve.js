#!/usr/bin/env node
/**
 * forge-dispatch-resolve.js
 *
 * Shared dispatch resolver.  It folds the canonical bash wiring into one pure
 * call while deliberately delegating routing, model aliases, prefs parsing,
 * and legacy tier chains to their owning modules.
 *
 * Contract JSON (default and --json) is one line.  The first eleven keys are
 * stable and ordered: engine, model, alias, tier, domain, route_source,
 * chain, chain_len, reason, effort, effort_reason.  The remaining fields are
 * additive dispatch sidecar data.  CLI flags: --unit-type, --plan, --unit-id,
 * --milestone, --roadmap, --domain, --cwd, --json, and
 * --effort-<unit-type> <effort>.
 * Unexpected CLI failures degrade to a valid legacy-shaped contract and exit 0.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveRoute, readRoutingConfig } = require('./forge-routing.js');

function routingPresent(cwd) {
  try {
    const cfg = readRoutingConfig(cwd);
    return cfg.present === true && cfg.ok === true;
  } catch {
    return false;
  }
}
const { modelToAlias, modelFamily } = require('./forge-model-alias.js');
const { readPrefsCached } = require('./forge-prefs.js');
const { readTierChain, defaultTierModel } = require('./forge-tier-chain.js');
// Imported, not re-typed: forge-must-haves.js reads the same `domain:` key from
// the same frontmatter, and a second copy of the strip rule is how the two
// readers drift apart. Requires whitespace before the `#`, which is what
// separates a comment from a `#` inside the value.
const { stripInlineComment } = require('./forge-must-haves.js');
const { resolveWorkerIdentity, resolveWorker, RuntimeContractError } = require('./forge-runtime.js');
const { evaluateDispatchGuard } = require('./forge-dispatch-guard.js');

const TIER_DEFAULTS = {
  'memory-extract': 'light',
  'complete-slice': 'light',
  'complete-milestone': 'light',
  'research-milestone': 'standard',
  'research-slice': 'standard',
  'discuss-milestone': 'standard',
  'discuss-slice': 'standard',
  'execute-task': 'standard',
  // review-fix is a surgical, already-scoped edit. review-challenger and
  // review-advocate deliberately stay out: review.*_model owns them (two
  // sources would recreate audit B). plan-check remains deferred until wired.
  'review-fix': 'standard',
  'plan-milestone': 'max',
  'plan-slice': 'heavy',
};

const EFFORT_DEFAULTS = {
  'plan-milestone': 'medium',
  'plan-slice': 'medium',
  'discuss-milestone': 'medium',
  'discuss-slice': 'medium',
  'research-milestone': 'medium',
  'research-slice': 'medium',
  'execute-task': 'low',
  'review-fix': 'medium',
  'complete-slice': 'low',
  'complete-milestone': 'low',
  'memory-extract': 'low',
};

const EFFORT_RANK = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function claudeExecutableChain(chain, tier) {
  const source = Array.isArray(chain) ? chain : [];
  const kept = source.filter((member) => member && member.engine === 'claude' && member.mapped === true);
  if (kept.length > 0) return { chain: kept, substituted: kept.length !== source.length };
  if (source.length === 0) return { chain: source, substituted: false };
  const id = defaultTierModel(tier);
  const mapped = modelToAlias(id);
  return { chain: [{ id, alias: mapped.alias, mapped: mapped.mapped, engine: 'claude' }], substituted: true };
}

function firstFrontmatter(raw) {
  const match = String(raw || '').match(/^---[\s\S]*?---/);
  return match ? match[0] : '';
}

function frontmatterValue(block, pattern) {
  const match = block.match(pattern);
  return match && match[1] ? match[1].trim() : '';
}

// The five requested fields use the same regex shapes as the bash snippet.
// `slice` is also read solely to reproduce its ROADMAP domain lookup fallback.
function readPlanFrontmatter(planPath) {
  const empty = { tier: '', tag: '', domain: '', effort: '', worker: '', slice: '' };
  if (!planPath) return empty;
  let block = '';
  try {
    block = firstFrontmatter(fs.readFileSync(planPath, 'utf8'));
  } catch {
    return empty;
  }
  if (!block) return empty;
  // Canonical (skills/forge-auto/SKILL.md § Engine Resolution) lowercases the
  // frontmatter worker value before comparing; mirror it so `worker: Codex`
  // is honoured rather than falling through to claude.
  const worker = frontmatterValue(block, /^worker:[ \t]*(\S+)/m).toLowerCase();
  // Every value on this line-up is compared against an enum or used as a
  // lookup key downstream, so an inline YAML comment left in the value makes
  // the comparison fail SILENTLY: `tier: heavy  # refactor` resolved to an
  // unknown tier, produced an empty model chain, and the dispatch fell back
  // to the agent frontmatter model with no warning. Strip comments from all
  // of them, not just the one a second module happens to parse.
  return {
    tier: stripInlineComment(frontmatterValue(block, /^tier:\s*(.+)$/m)).trim(),
    tag: stripInlineComment(frontmatterValue(block, /^tag:\s*(.+)$/m)).trim(),
    domain: stripInlineComment(frontmatterValue(block, /^domain:[ \t]*(.+)$/m)).trim(),
    effort: stripInlineComment(frontmatterValue(block, /^effort:\s*(.+)$/m)).trim(),
    worker: worker === 'claude' || worker === 'codex' ? worker : '',
    slice: stripInlineComment(frontmatterValue(block, /^slice:\s*(.+)$/m)).trim(),
  };
}

function defaultRoadmapPath(milestoneId, cwd) {
  const id = text(milestoneId);
  return id ? path.join(cwd, '.gsd', 'milestones', id, `${id}-ROADMAP.md`) : null;
}

function roadmapDomain(roadmapPath, key) {
  if (!roadmapPath || !key) return '';
  try {
    const line = fs.readFileSync(roadmapPath, 'utf8').split(/\r?\n/).find((item) =>
      new RegExp(`\\b${key}\\b`).test(item) && /domain:[A-Za-z0-9_-]+/.test(item));
    const match = line && line.match(/domain:([A-Za-z0-9_-]+)/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function hasHighRisk(roadmapPath, unitId) {
  if (!roadmapPath || !unitId) return false;
  try {
    return new RegExp(`${unitId}.*risk:\\s*high`).test(fs.readFileSync(roadmapPath, 'utf8'));
  } catch {
    return false;
  }
}

function normalizeWorkers(prefs, unitType) {
  const workers = prefs && prefs.workers && typeof prefs.workers === 'object' ? prefs.workers : {};
  // Canonical WORKERS_ENGINE lowercases before the codex/claude comparison.
  const requested = text(workers[unitType]).toLowerCase();
  const workersEngine = requested === 'codex' || requested === 'claude' ? requested : 'claude';
  const timeout = Number(workers.timeout);
  return {
    workers_engine: workersEngine,
    workers_timeout: Number.isInteger(timeout) && timeout > 0 ? timeout : 1800,
    codex_model: typeof workers.codex_model === 'string' ? workers.codex_model : '',
  };
}

// dispatch_engine is the DISPATCH normalization of the resolved model family,
// distinct from `engine` (FAMILY, via modelFamily). It is the canonical trigger
// the orchestrator tests `== "codex"`. Map: gpt→codex, gemini→agy, everything
// else (claude / unknown family / null / '') → claude. Additive: never mutates
// `engine` or `chain[].engine` (readers depend on those staying family).
function dispatchEngineFor(family) {
  const f = text(family).toLowerCase();
  if (f === 'gpt') return 'codex';
  if (f === 'gemini') return 'agy';
  return 'claude';
}

// Thinking guard (single source — skills read the emitted thinking_header):
// - claude-fable-5 returns HTTP 400 on an explicit `thinking: disabled` at ANY
//   effort → always force adaptive.
// - claude-opus-5 has thinking on by default and accepts `thinking: disabled`
//   ONLY at effort `high` or below — pairing disabled with xhigh/max is a 400
//   → force adaptive when the resolved effort is xhigh/max.
// Empty string means "no override — honor the phase's thinking: pref".
function thinkingHeaderFor(model, effort) {
  const id = text(model);
  if (id.startsWith('claude-fable-5')) return 'adaptive';
  if (id.startsWith('claude-opus-5') && (effort === 'xhigh' || effort === 'max')) return 'adaptive';
  return '';
}

// The sidecar needs the concrete routed Codex model, while legacy workers
// continue to provide the flat codex_model fallback when no Codex chain leads.
function sidecarModelFor(dispatchEngine, chain, codexModel) {
  const first = Array.isArray(chain) ? chain[0] : null;
  if (dispatchEngine === 'codex' && first && first.id) return first.id;
  return codexModel || '';
}

// The dispatch resolver retains its legacy model/routing contract, but also
// projects the host/worker axes introduced by forge-runtime.  Accept both the
// library's camelCase convention and the wire-format snake_case names: this
// keeps direct JSON callers from needing a second adapter.
function runtimeInput(opts, camel, snake) {
  if (Object.prototype.hasOwnProperty.call(opts, camel)) return { provided: true, value: opts[camel] };
  if (Object.prototype.hasOwnProperty.call(opts, snake)) return { provided: true, value: opts[snake] };
  return { provided: false, value: undefined };
}

function runtimeFields(opts, dispatchEngine) {
  const o = opts || {};
  const hostRuntime = runtimeInput(o, 'hostRuntime', 'host_runtime');
  const workerEngine = runtimeInput(o, 'workerEngine', 'worker_engine');
  const workerMode = runtimeInput(o, 'workerMode', 'worker_mode');
  const sidecarDeclared = runtimeInput(o, 'sidecarDeclared', 'sidecar_declared');
  const input = {
    host_runtime: hostRuntime.value,
    worker_engine: workerEngine.value,
    worker_mode: workerMode.value,
    sidecar_declared: sidecarDeclared.value,
    sidecar: o.sidecar,
  };
  try {
    // An explicit mode is caller policy and must reach the canonical validator
    // untouched. With no mode, the adapter owns the projection from the
    // already-resolved route: fill a missing worker axis, compare concrete
    // identities through forge-runtime's seam, and declare only cross-host
    // sidecars that were selected by that route.
    if (!workerMode.provided) {
      if (!workerEngine.provided) input.worker_engine = dispatchEngine;
      const identity = resolveWorkerIdentity(input);
      input.worker_mode = identity.host_runtime === identity.resolved_engine ? 'native' : 'sidecar';
      if (input.worker_mode === 'sidecar') input.sidecar_declared = true;
    }
    const worker = resolveWorker(input);
    return {
      runtime_protocol_version: worker.protocol_version,
      host_runtime: worker.host_runtime,
      worker_engine: worker.worker_engine,
      worker_mode: worker.worker_mode,
      resolved_worker_engine: worker.resolved_engine,
      sidecar_declared: worker.sidecar_declared,
      worker_reason_code: worker.reason_code,
      dispatch_allowed: true,
      dispatch_reason_code: '',
    };
  } catch (error) {
    // Invalid runtime input must be visible to the caller as a deterministic
    // pre-dispatch refusal. Do not turn it into a Claude fallback: that would
    // violate the native-host and recursion guarantees of the core contract.
    const code = error instanceof RuntimeContractError || error.code ? error.code : 'invalid-runtime-contract';
    return {
      runtime_protocol_version: '',
      host_runtime: text(input.host_runtime).toLowerCase(),
      worker_engine: text(input.worker_engine).toLowerCase(),
      worker_mode: text(input.worker_mode).toLowerCase(),
      resolved_worker_engine: '',
      sidecar_declared: input.sidecar === true || input.sidecar_declared === true,
      worker_reason_code: code,
      dispatch_allowed: false,
      dispatch_reason_code: code,
    };
  }
}

// Runtime validation owns representability; the frozen guard owns posture.
// Keeping this as a separate step prevents a posture result from laundering a
// canonical forge-runtime error into a different guard diagnostic.  The
// environment is an explicit dependency so library callers remain pure and
// deterministic.  Only evaluateDispatchGuard interprets its enforcement key.
function composeRuntimePosture(runtime, environment) {
  if (!runtime || runtime.dispatch_allowed !== true) {
    const reasonCode = runtime && runtime.dispatch_reason_code
      ? runtime.dispatch_reason_code
      : 'invalid-runtime-contract';
    return {
      ...(runtime || {}),
      dispatch_allowed: false,
      dispatch_reason_code: reasonCode,
      dispatch_hint: `Corrija o contrato runtime antes do dispatch (${reasonCode}); nenhum worker alternativo foi selecionado.`,
      dispatch_posture: null,
      dispatch_decision: 'error',
    };
  }

  const guard = evaluateDispatchGuard({
    host_runtime: runtime.host_runtime,
    worker_engine: runtime.worker_engine,
  }, environment);
  return {
    ...runtime,
    dispatch_allowed: guard.dispatch_allowed,
    dispatch_reason_code: guard.reason_code,
    dispatch_hint: guard.hint,
    dispatch_posture: guard.posture,
    dispatch_decision: guard.decision,
  };
}

function resolveDispatch(opts, environment) {
  const o = opts || {};
  const unitType = text(o.unitType);
  const cwd = o.cwd || process.cwd();
  const plan = unitType === 'execute-task' ? readPlanFrontmatter(o.planPath) : readPlanFrontmatter(null);
  const roadmapPath = o.roadmapPath || defaultRoadmapPath(o.milestoneId, cwd);

  let tier = TIER_DEFAULTS[unitType] || 'standard';
  let reason = `unit-type:${unitType}`;
  if (unitType === 'execute-task' && plan.tier) {
    tier = plan.tier;
    reason = `frontmatter-override:${plan.tier}`;
  } else if (unitType === 'execute-task' && plan.tag === 'docs') {
    tier = 'light';
    reason = 'frontmatter-tag:docs';
  }
  if (unitType === 'plan-slice' && hasHighRisk(roadmapPath, o.unitId)) {
    tier = 'max';
    reason = 'risk-escalation:high';
  }

  const domainKey = unitType === 'execute-task' ? plan.slice : o.unitId;
  // Explicit caller/CLI domain (opts.domain / --domain) sits BELOW the plan
  // frontmatter (canonical precedence, shared/forge-dispatch.md § Domain metadata)
  // and ABOVE the ROADMAP grep. Additive: no existing caller passes `domain`,
  // so the frontmatter → roadmap → 'default' chain is unchanged when omitted.
  // It exists so callers with no plan/roadmap on disk (e.g. forge-phases.js,
  // the live resolution table) can still project a specific domain.
  const requestedDomain = (unitType === 'execute-task' && plan.domain) ||
    text(o.domain) || roadmapDomain(roadmapPath, domainKey) || 'default';
  const route = resolveRoute({
    unitType,
    tier,
    domain: requestedDomain,
    frontmatterTier: plan.tier || null,
    frontmatterWorker: plan.worker || null,
    cwd,
  });
  let chain = Array.isArray(route.chain) ? route.chain : [];
  let nonRoutableSubstitution = false;
  // Only execute-task and plan-slice have non-Claude adapters. Every other
  // phase is dispatched through Agent(), whose model parameter accepts only a
  // mapped Claude alias. Keep the resolver aligned with that executable
  // boundary: retain configured Claude members when possible, otherwise use
  // the canonical Claude model for the tier. Reporting the external family
  // here would make telemetry claim Codex while an in-process Claude agent ran.
  if (unitType !== 'execute-task' && unitType !== 'plan-slice') {
    const executable = claudeExecutableChain(chain, tier);
    chain = executable.chain;
    nonRoutableSubstitution = executable.substituted;
  }
  const prefsResult = readPrefsCached(cwd);
  const prefs = prefsResult && prefsResult.prefs ? prefsResult.prefs : {};
  const workers = normalizeWorkers(prefs, unitType);
  const workersExplicit = Boolean(prefs.workers && typeof prefs.workers === 'object'
    && Object.prototype.hasOwnProperty.call(prefs.workers, unitType));
  const routingBacked = route.source === 'routing' || /(?:^|; )routing-(?:hit|default)(?:;|$)/.test(route.reason || '');
  const legacyTierRoute = route.source === 'tier_models'
    || (route.source === 'frontmatter' && !plan.worker && !routingBacked);
  let explicitClaudeSubstitution = false;
  if (legacyTierRoute && workersExplicit && workers.workers_engine === 'claude') {
    const executable = claudeExecutableChain(chain, tier);
    chain = executable.chain;
    explicitClaudeSubstitution = executable.substituted;
  }
  const model = chain[0] && chain[0].id ? chain[0].id : '';

  let engine;
  let engineReason;
  if (routingBacked || (route.source === 'frontmatter' && Boolean(plan.worker))) {
    engine = chain[0] && chain[0].engine ? chain[0].engine : 'claude';
    engineReason = `route:${route.source}:${engine}`;
  } else if (plan.worker) {
    engine = plan.worker;
    engineReason = `frontmatter-worker:${plan.worker}`;
  } else if (workers.workers_engine !== 'claude') {
    engine = workers.workers_engine;
    engineReason = `workers.${unitType}:${engine}`;
  } else if (workersExplicit) {
    engine = 'claude';
    engineReason = explicitClaudeSubstitution
      ? `workers.${unitType}:claude|model-family-substituted`
      : `workers.${unitType}:claude`;
  } else if (!workersExplicit && chain[0] && chain[0].engine && chain[0].engine !== 'claude') {
    // tier_models is also allowed to carry a cross-provider model.  Treating
    // every non-routable phase as Claude here made a GPT-only tier catalogue
    // lie in the live phase matrix and could hand a GPT model id to a Claude
    // dispatch.  The model-family classifier in forge-routing owns this value.
    engine = chain[0].engine;
    engineReason = `tier-model-family:${engine}`;
  } else {
    engine = 'claude';
    engineReason = nonRoutableSubstitution ? 'non-routable-family-substituted:claude' : 'default:claude';
  }

  // Merged, never either-or. The CLI ALWAYS supplies an effortMap object (parseArgs
  // seeds `{}` and only fills the keys `--effort-<unit>` named), and `{}` is truthy —
  // so a ternary here made prefs.effort unreachable from every CLI caller, which is
  // every real caller: forge-auto/forge-next/forge-task invoke the resolver with no
  // --effort-* flag at all. The `effort` block of a user's prefs was silently inert,
  // always falling through to EFFORT_DEFAULTS. Merging keeps the flag an override of
  // the pref (its documented role) while restoring the pref as the base.
  const effortMap = { ...(prefs.effort || {}), ...(o.effortMap && typeof o.effortMap === 'object' ? o.effortMap : {}) };
  let effort = effortMap[unitType] !== undefined ? effortMap[unitType] : (EFFORT_DEFAULTS[unitType] || 'low');
  let effortReason = `unit-type:${unitType}`;
  if (unitType === 'execute-task' && plan.effort) {
    effort = plan.effort;
    effortReason = `frontmatter-effort:${plan.effort}`;
  }
  if (unitType === 'plan-slice' && reason === 'risk-escalation:high') {
    effort = 'max';
    effortReason = 'risk-escalation:high';
  }
  effort = text(effort);
  if (!Object.prototype.hasOwnProperty.call(EFFORT_RANK, effort)) {
    // Telemetry must not lie: without this annotation, effort_reason kept
    // saying `frontmatter-effort:<invalid>` while the value silently became
    // medium — a reader would believe the frontmatter was honoured.
    effortReason += `|invalid-effort-defaulted:${effort || '(empty)'}`;
    effort = 'medium';
  }
  const cap = /^claude-(haiku|sonnet)/.test(model) ? 'medium' : 'max';
  if (EFFORT_RANK[effort] > EFFORT_RANK[cap]) {
    effort = cap;
    effortReason += '|clamped:model-cap';
  }

  const alias = modelToAlias(model).alias;
  // modelFamily is the canonical family classifier; its invocation here keeps
  // this orchestration layer aligned with alias/routing model semantics.
  const family = modelFamily(model);
  if (family === null && route.source === 'routing' && !chain[0]) engine = 'claude';
  // Resolve this after routing/model-family work. The result is deliberately
  // additive: legacy engine/dispatch_engine/chain retain their 3.1.4 meaning.
  const dispatchEngine = dispatchEngineFor(engine);
  const runtime = composeRuntimePosture(runtimeFields(o, dispatchEngine), environment);
  return {
    engine,
    model,
    alias,
    tier,
    domain: route.domain_used || 'default',
    route_source: route.source || 'tier_models',
    chain,
    chain_len: chain.length,
    reason,
    effort,
    effort_reason: effortReason,
    model_applied: alias,
    engine_reason: engineReason,
    workers_engine: workers.workers_engine,
    workers_timeout: workers.workers_timeout,
    codex_model: workers.codex_model,
    plan_worker: plan.worker,
    // Raw resolver INPUTS replayed by the failure-taxonomy retry paths so
    // --next-after / tier escalation rebuild the identical routing chain.
    // domain_input is the INPUT domain (frontmatter → roadmap → 'default'),
    // NOT the effective `domain`/domain_used above.
    domain_input: requestedDomain,
    frontmatter_tier: plan.tier,
    thinking_header: thinkingHeaderFor(model, effort),
    // Additive: whether a parseable routing: block exists in the prefs cascade.
    // Consumed by the orchestrator's shadowing warning ("routing configured but
    // not applied") — previously a SECOND forge-routing.js --explain spawn per
    // dispatch, duplicating the resolution this call already performed.
    routing_present: routingPresent(cwd),
    // Additive dispatch trigger: normalized from the resolved top-level `engine`
    // (family). gpt→codex, gemini→agy, else→claude. Orchestrator branches gate
    // on this (`== "codex"`), NOT on `engine`/`chain[].engine` (kept family).
    dispatch_engine: dispatchEngine,
    // codex_model remains emitted separately as the legacy flat preference.
    sidecar_model: sidecarModelFor(dispatchEngine, chain, workers.codex_model),
    // Additive loud-stop surface (M008-CONTEXT #2): a malformed prefs layer must
    // not silently degrade to the claude/effort-default fallback. Callers inspect
    // prefs_ok; the CLI turns prefs_ok:false into a non-zero exit.
    prefs_ok: prefsResult ? prefsResult.ok !== false : true,
    prefs_errors: (prefsResult && prefsResult.errors) || [],
    ...runtime,
  };
}

function parseArgs(args) {
  const parsed = { unitType: '', planPath: null, unitId: '', milestoneId: '', roadmapPath: null, domain: '', cwd: process.cwd(), asJson: false, effortMap: {} };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === '--unit-type' && value !== undefined) { parsed.unitType = value; i += 1; }
    else if (flag === '--plan' && value !== undefined) { parsed.planPath = value; i += 1; }
    else if (flag === '--unit-id' && value !== undefined) { parsed.unitId = value; i += 1; }
    else if (flag === '--milestone' && value !== undefined) { parsed.milestoneId = value; i += 1; }
    else if (flag === '--roadmap' && value !== undefined) { parsed.roadmapPath = value; i += 1; }
    else if (flag === '--domain' && value !== undefined) { parsed.domain = value; i += 1; }
    else if (flag === '--cwd' && value !== undefined) { parsed.cwd = value; i += 1; }
    else if (flag === '--host-runtime' && value !== undefined) { parsed.hostRuntime = value; i += 1; }
    else if (flag === '--worker-engine' && value !== undefined) { parsed.workerEngine = value; i += 1; }
    else if (flag === '--worker-mode' && value !== undefined) { parsed.workerMode = value; i += 1; }
    else if (flag === '--sidecar-declared') parsed.sidecarDeclared = true;
    else if (flag === '--json') parsed.asJson = true;
    else if (flag.startsWith('--effort-') && value !== undefined) { parsed.effortMap[flag.slice('--effort-'.length)] = value; i += 1; }
  }
  return parsed;
}

function runCli(args, environment) {
  const parsed = parseArgs(args || []);
  const result = resolveDispatch(parsed, environment);
  process.stdout.write(JSON.stringify(result) + '\n');
  return result;
}

function degradedContract(args, environment) {
  const parsed = parseArgs(args || []);
  const unitType = parsed.unitType;
  const cwd = parsed.cwd || process.cwd();
  const tier = TIER_DEFAULTS[unitType] || 'standard';
  let chain = [];
  try {
    chain = readTierChain(tier, cwd).map((member) => ({
      id: member.id, alias: member.alias, mapped: member.mapped, engine: modelFamily(member.id),
    }));
  } catch { /* minimal ordered contract below */ }
  const model = chain[0] ? chain[0].id : '';
  const alias = modelToAlias(model).alias;
  const runtime = composeRuntimePosture(
    runtimeFields(parsed, dispatchEngineFor('claude')),
    environment,
  );
  return {
    engine: 'claude', model, alias, tier, domain: 'default', route_source: 'tier_models',
    chain, chain_len: chain.length, reason: 'routing-runtime-error; tier_models',
    // effort_reason used to claim `unit-type:<x>` here — but the unit type did
    // not decide this effort, the crash did. Name the real cause and mark the
    // whole contract degraded so consumers can tell it from a healthy resolve.
    degraded: true,
    effort: 'low', effort_reason: 'degraded:routing-runtime-error',
    model_applied: alias, engine_reason: 'default:claude', workers_engine: 'claude',
    workers_timeout: 1800, codex_model: '', plan_worker: '',
    domain_input: 'default', frontmatter_tier: '',
    thinking_header: thinkingHeaderFor(model, 'low'),
    // engine is hard-coded 'claude' here → dispatch_engine resolves to 'claude'.
    // Emitted explicitly via the same helper for contract stability.
    dispatch_engine: dispatchEngineFor('claude'),
    sidecar_model: sidecarModelFor(dispatchEngineFor('claude'), chain, ''),
    routing_present: false,
    prefs_ok: true, prefs_errors: [],
    ...runtime,
  };
}

// ── --shell-exports: single-parse emitter for the orchestrator skills ────────
//
// The dispatch skills used to burn 19 separate `node -e "JSON.parse(...)"`
// spawns extracting one field each from $ROUTE_JSON. This emits every shell
// variable the loop consumes in ONE pass, as eval-safe single-quoted
// assignments (embedded quotes escaped as '\''), so the skill runs:
//   eval "$(printf '%s' "$ROUTE_JSON" | node forge-dispatch-resolve.js --shell-exports)"
// The map is the contract: adding a consumer variable here is additive; the
// JSON output remains the canonical payload ($ROUTE_JSON.chain is still read
// directly by Branch C/D and the failure taxonomy).

const SHELL_EXPORT_MAP = [
  ['MODEL_ID', (r) => r.model],
  ['MODEL_ALIAS', (r) => r.alias || ''],
  ['TIER', (r) => r.tier],
  ['REASON', (r) => r.reason],
  ['DOMAIN_USED', (r) => r.domain],
  ['ROUTE_SOURCE', (r) => r.route_source],
  ['CHAIN_LEN', (r) => String(r.chain_len)],
  ['ENGINE', (r) => r.engine],
  ['DISPATCH_ENGINE', (r) => r.dispatch_engine || ''],
  ['ENGINE_REASON', (r) => r.engine_reason],
  ['EFFORT', (r) => r.effort],
  ['EFFORT_REASON', (r) => r.effort_reason],
  ['WORKERS_TIMEOUT', (r) => String(r.workers_timeout)],
  ['CODEX_MODEL', (r) => r.codex_model || ''],
  ['SIDECAR_MODEL', (r) => r.sidecar_model || ''],
  ['THINKING_HEADER', (r) => r.thinking_header || ''],
  ['DOMAIN', (r) => r.domain_input || ''],
  ['PLAN_TIER', (r) => r.frontmatter_tier || ''],
  ['PLAN_WORKER', (r) => r.plan_worker || ''],
  ['ROUTING_PRESENT', (r) => (r.routing_present ? 'true' : 'false')],
  // JSON-literal glue for the dispatch event line (string or null) — replaces
  // the bash `MODEL_APPLIED_JSON=$([ -n "$MODEL_ALIAS" ] && ...)` derivation.
  ['MODEL_APPLIED_JSON', (r) => (r.alias ? JSON.stringify(r.alias) : 'null')],
  ['unit_effort', (r) => r.effort],
  ['HOST_RUNTIME', (r) => r.host_runtime || ''],
  ['WORKER_ENGINE', (r) => r.worker_engine || ''],
  ['WORKER_MODE', (r) => r.worker_mode || ''],
  ['DISPATCH_ALLOWED', (r) => (r.dispatch_allowed === true ? 'true' : 'false')],
  ['DISPATCH_REASON_CODE', (r) => r.dispatch_reason_code || ''],
  ['DISPATCH_HINT', (r) => r.dispatch_hint || ''],
  ['DISPATCH_POSTURE', (r) => r.dispatch_posture || ''],
  ['DISPATCH_DECISION', (r) => r.dispatch_decision || ''],
  ['RESOLVED_WORKER_ENGINE', (r) => r.resolved_worker_engine || ''],
  ['SIDECAR_DECLARED', (r) => (r.sidecar_declared === true ? 'true' : 'false')],
];

function shellQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, "'\\''")}'`;
}

function shellExports(route) {
  return SHELL_EXPORT_MAP.map(([name, pick]) => `${name}=${shellQuote(pick(route))}`).join('\n');
}

module.exports = { resolveDispatch, parseArgs, runCli, degradedContract, dispatchEngineFor, sidecarModelFor, thinkingHeaderFor, runtimeFields, composeRuntimePosture, claudeExecutableChain, shellExports, TIER_DEFAULTS, EFFORT_DEFAULTS };

if (require.main === module) {
  // Exit 0 on success; exit 1 ONLY on a prefs loud-stop (M008-CONTEXT #2 — a
  // malformed prefs layer must halt the shell consumer rather than proceed on
  // the claude/effort-default fallback). The last-resort catch below still
  // emits the ordered contract and exits 0 for UNEXPECTED runtime errors.
  // --shell-exports: transform mode — reads a resolved contract JSON from
  // stdin and prints eval-safe shell assignments. No resolution happens here;
  // a malformed payload is a loud exit 2 (an eval of garbage must never run).
  if (process.argv.includes('--shell-exports')) {
    try {
      const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
      process.stdout.write(shellExports(payload) + '\n');
      process.exit(0);
    } catch (error) {
      process.stderr.write(JSON.stringify({ error: `--shell-exports: unparseable stdin payload (${(error && error.message) || error})` }) + '\n');
      process.exit(2);
    }
  }
  try {
    const result = runCli(process.argv.slice(2), process.env);
    process.exit(result && result.prefs_ok === false ? 1 : 0);
  } catch (error) {
    // The contract on stdout stays parseable for the shell consumer, but the
    // degradation itself must be loud: a crash that silently re-routes every
    // unit to the cheapest effort is exactly the failure mode the diagnosis
    // caught. stderr is free — the orchestrator surfaces it next to the JSON.
    process.stderr.write(JSON.stringify({
      warning: 'forge-dispatch-resolve degraded to the fallback contract',
      error: (error && error.message) || String(error),
    }) + '\n');
    process.stdout.write(JSON.stringify(degradedContract(process.argv.slice(2), process.env)) + '\n');
    process.exit(0);
  }
}
