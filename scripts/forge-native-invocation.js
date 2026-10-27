#!/usr/bin/env node
'use strict';

// Host-specific argument adaptation for an already-resolved dispatch. This
// module does not choose a model and does not own a supported-model catalogue.
// The caller supplies the active tool capabilities observed for this session.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { modelToAlias } = require('./forge-model-alias.js');
const modelPolicy = require('./forge-model-policy.js');

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function stringSet(value) {
  return new Set(Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);
}

function codexTaskName(value, fallback) {
  return text(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function refusal(hostRuntime, reasonCode, hint) {
  return {
    ok: false,
    host_runtime: hostRuntime,
    tool: null,
    args: null,
    telemetry: null,
    reason_code: reasonCode,
    hint,
  };
}

function validateActiveCapabilities(hostRuntime, activeCapabilities) {
  const host = text(hostRuntime).toLowerCase();
  const caps = activeCapabilities;
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
    return refusal(host, 'native-capabilities-missing',
      'Supply capabilities observed from the active native tool before invocation.');
  }
  if (caps.available !== true || text(caps.tool) === '') {
    return refusal(host, 'native-tool-unavailable',
      `No active native tool was supplied for ${host || '(missing host)'}.`);
  }
  if (host === 'codex') {
    if (!Array.isArray(caps.models) || !Array.isArray(caps.reasoning_efforts) ||
        !Array.isArray(caps.fork_turns)) {
      return refusal(host, 'native-capabilities-invalid',
        'Codex capabilities must list models, reasoning_efforts and fork_turns from the active tool.');
    }
  } else if (host === 'claude') {
    if (!Array.isArray(caps.model_aliases) || !Array.isArray(caps.effort_transports)
        || (caps.model_ids !== undefined && !Array.isArray(caps.model_ids))) {
      return refusal(host, 'native-capabilities-invalid',
        'Claude capabilities must list model_aliases and effort_transports (and, optionally, model_ids) accepted by the active tool.');
    }
  } else {
    return refusal(host, 'native-host-unsupported', `Unsupported native host: ${host || '(missing)'}.`);
  }
  return { ok: true, host_runtime: host, capabilities: caps };
}

function baseTelemetry(dispatch, argument, effortArgument, capabilities) {
  const hasRequestedModel = Object.prototype.hasOwnProperty.call(dispatch, 'model_requested');
  return {
    model_requested: hasRequestedModel ? dispatch.model_requested : null,
    model_resolved: dispatch.model_resolved || dispatch.model || null,
    model_argument: argument || null,
    model_observed: null,
    model_observed_source: null,
    // The resolver's additive pre-clamp value when present; routes without it
    // keep the historical value (the resolved effort).
    effort_requested: dispatch.effort_requested || dispatch.effort || null,
    effort_resolved: dispatch.effort || null,
    effort_argument: effortArgument || null,
    effort_transport: null,
    effort_transport_value: null,
    effort_transport_source: null,
    effort_binding_observed: null,
    effort_binding_observed_source: null,
    effort_binding_observed_fingerprint: null,
    effort_applied: null,
    effort_applied_source: null,
    capabilities_source: text(capabilities.source) || 'caller-supplied',
  };
}

function frontmatterScalar(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${key}\\s*:\\s*(.+?)\\s*$`, 'm'));
  if (!match) return '';
  const value = match[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function observeClaudeAgentBinding(options) {
  const input = options || {};
  const agentType = text(input.agentType || input.agent_type);
  const agentPath = text(input.agentPath || input.agent_path);
  const suppliedFingerprint = text(input.sourceFingerprint || input.source_fingerprint)
    .replace(/^sha256:/i, '').toLowerCase();
  if (!agentType || !agentPath || !/^[0-9a-f]{64}$/.test(suppliedFingerprint)) {
    return refusal('claude', 'native-effort-binding-evidence-missing',
      'Claude frontmatter observation requires agentType, agentPath and its SHA-256 fingerprint.');
  }
  let realPath;
  let source;
  try {
    realPath = fs.realpathSync(agentPath);
    const stat = fs.statSync(realPath);
    if (!stat.isFile()) throw new Error('not-file');
    source = fs.readFileSync(realPath, 'utf8');
  } catch (_) {
    return refusal('claude', 'native-effort-binding-source-unreadable',
      'The supplied Claude agent definition could not be read as a regular file.');
  }
  const observedFingerprint = crypto.createHash('sha256').update(source).digest('hex');
  if (observedFingerprint !== suppliedFingerprint) {
    return refusal('claude', 'native-effort-binding-fingerprint-mismatch',
      'The supplied Claude agent definition changed after its evidence fingerprint was captured.');
  }
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return refusal('claude', 'native-effort-binding-frontmatter-invalid',
      'The supplied Claude agent definition has no bounded YAML frontmatter.');
  }
  const observedAgentType = frontmatterScalar(match[1], 'name');
  const observedEffort = frontmatterScalar(match[1], 'effort');
  if (observedAgentType !== agentType || !observedEffort) {
    return refusal('claude', 'native-effort-binding-agent-mismatch',
      `The observed agent frontmatter does not bind ${agentType} to an effort.`);
  }
  return {
    ok: true,
    transport: 'agent-frontmatter',
    agent_type: observedAgentType,
    effort: observedEffort,
    // Read from the same fingerprinted bytes; null when the agent declares none.
    thinking: frontmatterScalar(match[1], 'thinking') || null,
    source: realPath,
    source_fingerprint: `sha256:${observedFingerprint}`,
    observed: true,
  };
}

function buildNativeInvocation(options) {
  const input = options || {};
  const host = text(input.hostRuntime || input.host_runtime).toLowerCase();
  const dispatch = input.resolvedDispatch || input.resolved_dispatch;
  const checked = validateActiveCapabilities(host, input.activeCapabilities || input.active_capabilities);
  if (!checked.ok) return checked;
  if (!dispatch || typeof dispatch !== 'object' || Array.isArray(dispatch)) {
    return refusal(host, 'invalid-resolved-dispatch', 'A resolved dispatch object is required.');
  }
  if (dispatch.config_ok !== true || dispatch.dispatch_allowed !== true) {
    return refusal(host, dispatch.dispatch_reason_code || 'resolved-dispatch-refused',
      dispatch.dispatch_hint || 'The authoritative resolver did not affirm this dispatch.');
  }
  const routeHost = text(dispatch.host_runtime).toLowerCase();
  const resolvedWorker = text(dispatch.resolved_worker_engine).toLowerCase();
  const workerMode = text(dispatch.worker_mode).toLowerCase();
  if (routeHost !== host || resolvedWorker !== host || workerMode !== 'native') {
    return refusal(host, 'native-route-identity-mismatch',
      'Native invocation requires an affirmatively allowed native route for the same host and resolved worker.');
  }
  const dispatchHost = text(dispatch.dispatch_engine).toLowerCase();
  if (dispatchHost && dispatchHost !== host) {
    return refusal(host, 'native-engine-mismatch',
      `Resolved engine ${dispatchHost} cannot use the ${host} native adapter.`);
  }

  const caps = checked.capabilities;
  const model = text(dispatch.model_resolved || dispatch.model);
  const effort = text(dispatch.effort);
  const promptValue = input.prompt !== undefined ? input.prompt : input.message;
  const prompt = typeof promptValue === 'string' ? promptValue : '';
  const agentType = text(input.agentType || input.agent_type || input.subagentType || input.subagent_type);
  if (!model || prompt.trim() === '' || !agentType) {
    return refusal(host, 'invalid-native-invocation-input',
      'Resolved model, prompt and agent type are required.');
  }

  if (host === 'codex') {
    if (!stringSet(caps.models).has(model)) {
      return refusal(host, 'native-model-unsupported',
        `The active Codex tool did not report support for ${model}.`);
    }
    if (!stringSet(caps.reasoning_efforts).has(effort)) {
      return refusal(host, 'native-effort-unsupported',
        `The active Codex tool did not report support for reasoning effort ${effort}.`);
    }
    const forkTurns = text(input.forkTurns || input.fork_turns) || 'none';
    if (forkTurns === 'all' || (forkTurns !== 'none' && !/^[1-9][0-9]*$/.test(forkTurns))) {
      return refusal(host, 'native-fork-turns-invalid',
        'Codex model overrides require fork_turns none or a positive bounded history.');
    }
    if (!stringSet(caps.fork_turns).has(forkTurns)) {
      return refusal(host, 'native-fork-turns-unsupported',
        `The active Codex tool did not report support for fork_turns ${forkTurns}.`);
    }
    const taskName = codexTaskName(input.taskName || input.task_name, agentType);
    if (!taskName) {
      return refusal(host, 'native-task-name-invalid',
        'Codex task_name must contain at least one lowercase letter or digit after normalization.');
    }
    const args = {
      task_name: taskName,
      message: prompt,
      agent_type: agentType,
      model,
      reasoning_effort: effort,
      fork_turns: forkTurns,
    };
    const telemetry = baseTelemetry(dispatch, model, effort, caps);
    telemetry.effort_transport = 'native-argument';
    telemetry.effort_transport_value = effort;
    telemetry.effort_transport_source = text(caps.source) || 'caller-supplied';
    return {
      ok: true,
      host_runtime: host,
      tool: caps.tool,
      args,
      telemetry,
      reason_code: 'native-invocation-ready',
      hint: 'Invoke the active Codex tool with the structured arguments unchanged.',
    };
  }

  const canonicalAlias = modelToAlias(model);
  const alias = text(canonicalAlias.alias);
  // The Agent tool documents full model ids besides aliases, but availability
  // is a property of the ACTIVE tool: only an id listed in the caller-observed
  // `model_ids` is sent unchanged. Without that observation (alias-only
  // schemas, older callers) the alias path and its explicit limitation remain.
  // Nothing here is inferred from an installed CLI or a static default.
  const exactId = stringSet(caps.model_ids).has(model);
  const suppliedAlias = text(dispatch.alias);
  if (!exactId && (!canonicalAlias.mapped || !alias)) {
    return refusal(host, 'native-claude-alias-unmapped',
      `Resolved model ${model} has no Claude native-tool alias.`);
  }
  if (suppliedAlias && canonicalAlias.mapped && alias && suppliedAlias !== alias) {
    return refusal(host, 'native-claude-alias-mismatch',
      `Resolved model ${model} maps to Claude alias ${alias}, not ${suppliedAlias}.`);
  }
  if (!exactId && !stringSet(caps.model_aliases).has(alias)) {
    return refusal(host, 'native-model-unsupported',
      `The active Claude tool did not report support for alias ${alias}.`);
  }
  const modelArgument = exactId ? model : alias;
  const effortEvidence = input.effortBinding || input.effort_binding;
  const effortTransport = effortEvidence && typeof effortEvidence === 'object'
    ? text(effortEvidence.transport) : '';
  if (!effortTransport) {
    return refusal(host, 'native-effort-binding-missing',
      'Claude invocation requires a read-only observation of its real agent definition.');
  }
  if (effortTransport === 'prompt-header') {
    return refusal(host, 'native-effort-prompt-header-not-api',
      'Prompt text is not a Claude native reasoning-effort API or observed agent binding.');
  }
  if (effortTransport !== 'agent-frontmatter') {
    return refusal(host, 'native-effort-transport-unimplemented',
      `Claude effort transport ${effortTransport} has no native adapter.`);
  }
  if (!stringSet(caps.effort_transports).has(effortTransport)) {
    return refusal(host, 'native-effort-transport-unsupported',
      `The active Claude tool did not report effort transport ${effortTransport}.`);
  }
  const observedBinding = observeClaudeAgentBinding({
    agentType,
    agentPath: effortEvidence.agentPath || effortEvidence.agent_path || effortEvidence.source,
    sourceFingerprint: effortEvidence.sourceFingerprint || effortEvidence.source_fingerprint,
  });
  if (!observedBinding.ok) return observedBinding;
  if (observedBinding.effort !== effort) {
    return refusal(host, 'native-effort-binding-mismatch',
      `Observed ${agentType} frontmatter effort ${observedBinding.effort} does not match resolved effort ${effort}.`);
  }
  // A `thinking:` line in the agent frontmatter is NOT a documented subagent
  // control: subagents inherit thinking from the session. It is therefore a
  // legacy declaration, never a delivered binding, and cannot refuse a launch.
  // When it contradicts the model policy (Sonnet 5.5 + disabled) the caller
  // gets a separate diagnostic; explicit operator intent (the thinking pref)
  // is refused earlier by the resolver through the same policy.
  const diagnostics = [];
  if (observedBinding.thinking) {
    const thinking = modelPolicy.evaluateThinking({ model, effort, mode: observedBinding.thinking });
    if (!thinking.ok) {
      diagnostics.push({ code: 'native-thinking-declaration-inert', agent: agentType,
        declared: observedBinding.thinking, model, policy_code: thinking.reason_code, layer: 'native-binding' });
    }
  }
  const args = { subagent_type: agentType, prompt, model: modelArgument };
  const telemetry = baseTelemetry(dispatch, modelArgument, null, caps);
  telemetry.effort_transport = effortTransport;
  telemetry.effort_transport_value = observedBinding.effort;
  telemetry.effort_transport_source = observedBinding.source;
  telemetry.effort_binding_observed = observedBinding.effort;
  telemetry.effort_binding_observed_source = observedBinding.source;
  telemetry.effort_binding_observed_fingerprint = observedBinding.source_fingerprint;
  // An alias is not evidence of the executed model version. Only entries that
  // declare it (Sonnet 5.5) gain these keys, and only on the alias path; every
  // other model keeps the exact pre-existing telemetry envelope. A full-id
  // argument is still an adapter argument, never a provider observation.
  const native = modelPolicy.transportSupport({ model, transport: 'claude-native' });
  if (!exactId && native.version_proof === 'alias-only') {
    telemetry.model_version_proof = 'alias-only';
    telemetry.policy_diagnostics = native.diagnostics.filter((item) => item.code === 'native-alias-not-version-proof');
  }
  return {
    ok: true,
    host_runtime: host,
    tool: caps.tool,
    args,
    telemetry,
    reason_code: 'native-invocation-ready',
    hint: 'Invoke the active Claude tool with the structured arguments unchanged.',
    ...(diagnostics.length ? { diagnostics } : {}),
  };
}

// Early diagnosis for callers that must refuse before any launch (review legs,
// the review-fix runtime gate). Same verdict as buildNativeInvocation; no
// callback exists here, so nothing can be invoked. A caller without the final
// prompt yet gets a placeholder that only satisfies the shape check.
function preflightNativeBinding(options) {
  const input = options || {};
  const supplied = input.prompt !== undefined ? input.prompt : input.message;
  const hasPrompt = typeof supplied === 'string' && supplied.trim() !== '';
  const verdict = buildNativeInvocation({ ...input, prompt: hasPrompt ? supplied : '(preflight)' });
  return { ...verdict, args: hasPrompt ? verdict.args : null, preflight: true };
}

async function invokeNative(options, invoke) {
  const started = Date.now();
  const telemetryApi = require('./forge-attempt-telemetry');
  const invocation = buildNativeInvocation(options);
  if (!invocation.ok) return { ...invocation, provider_called: false,
    final_evidence: telemetryApi.captureFinal({ identity: options, route: options.resolvedDispatch }) };
  if (typeof invoke !== 'function') {
    return { ...refusal(invocation.host_runtime, 'native-tool-callback-missing',
      'An injected native tool callback is required.'), provider_called: false,
      final_evidence: telemetryApi.captureFinal({ identity: options, route: options.resolvedDispatch }) };
  }
  let packagedCallback;
  const evidence = telemetryApi.observeFinal({ ...options, onPackagedContext: value => { packagedCallback = options.onPackagedContext?.(value); }, model: invocation.telemetry.model_argument,
    effort: invocation.telemetry.effort_resolved }, invocation.args,
    invocation.args.prompt || invocation.args.message, 'native-tool');
  let invoked = false;
  let observedProvider;
  const initial = JSON.stringify(invocation);
  const assertBoundary = stage => {
    const current = buildNativeInvocation(options);
    if (!current.ok || JSON.stringify(current) !== initial || JSON.stringify(invocation) !== initial) {
      throw Object.assign(new Error('native-binding-changed'), { code: 'native-binding-changed' });
    }
    return current;
  };
  const assertGuard = async stage => {
    const current = assertBoundary(stage);
    await options.assertInvocation?.(stage, current);
  };
  try {
    await packagedCallback;
    await assertGuard('packaged');
    assertBoundary('packaged');
    if (options.beforeInvoke) await options.beforeInvoke(invocation);
    await assertGuard('before-invoke');
    assertBoundary('before-invoke');
    const supervision = require('./forge-native-supervision');
    const supervised = await supervision.supervise({ ...options.lifecycle,
      identity: supervision.digest(JSON.stringify({ invocation, identity: options.telemetryIdentity || null })),
      route: options.resolvedDispatch, terminal: options.terminalResult,
    }, () => { invoked = true; return invoke(invocation.args, invocation); });
    observedProvider = supervised.provider_called;
    if (!supervised.ok) return { ...invocation, ok: false, result: null,
      reason_code: supervised.reason_code === 'native-terminal-unobserved' && options.invalidTerminalReason
        ? options.invalidTerminalReason : supervised.reason_code,
      provider_called: supervised.provider_called, lifecycle: supervised.lifecycle,
      final_evidence: { ...evidence, stage: 'invoked', provider_called: supervised.provider_called,
        duration_ms: Date.now() - started, native_lifecycle: supervised.lifecycle },
      diagnostic: { reason_code: supervised.reason_code, layer: 'native-lifecycle' } };
    const result = supervised.result;
    await assertGuard('after-invoke');
    assertBoundary('after-invoke');
    const readback = typeof options.readback === 'function'
      ? await options.readback(result, invocation)
      : null;
    await assertGuard('after-readback');
    assertBoundary('after-readback');
    if (readback != null && (typeof readback !== 'object' || Array.isArray(readback)
        || readback.model !== undefined && typeof readback.model !== 'string'
        || readback.source !== undefined && typeof readback.source !== 'string')) {
      throw Object.assign(new Error('native-readback-invalid'), { code: 'native-readback-invalid' });
    }
    const observed = readback && typeof readback === 'object' ? text(readback.model) : '';
    const source = readback && typeof readback === 'object' ? text(readback.source) : '';
    return {
      ...invocation,
      provider_called: true,
      result,
      lifecycle: supervised.lifecycle,
      final_evidence: { ...evidence, stage: 'returned', provider_called: true, duration_ms: Date.now() - started,
        model_observed: observed && source ? telemetryApi.code(observed) : null },
      telemetry: {
        ...invocation.telemetry,
        model_observed: observed && source ? observed : null,
        model_observed_source: observed && source ? source : null,
      },
    };
  } catch (error) {
    error = error && typeof error === 'object' ? error : {};
    return {
      ...invocation,
      ok: false,
      result: null,
      reason_code: telemetryApi.code(error.code, 'native-invocation-failed'),
      final_evidence: { ...evidence, stage: 'invoked', duration_ms: Date.now() - started,
        provider_called: observedProvider ?? (invoked ? (typeof error.provider_called === 'boolean' ? error.provider_called : 'unknown') : false) },
      provider_called: observedProvider ?? (invoked ? (typeof error.provider_called === 'boolean' ? error.provider_called : 'unknown') : false),
      diagnostic: { reason_code: telemetryApi.code(error.code, 'native-tool-callback-failed'), layer: 'native-tool' },
      hint: 'The native tool callback failed; inspect the host diagnostic channel.',
    };
  }
}

module.exports = {
  validateActiveCapabilities,
  observeClaudeAgentBinding,
  buildNativeInvocation,
  preflightNativeBinding,
  invokeNative,
  codexTaskName,
};
