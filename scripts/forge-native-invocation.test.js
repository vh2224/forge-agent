#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  validateActiveCapabilities,
  observeClaudeAgentBinding,
  buildNativeInvocation,
  preflightNativeBinding,
  invokeNative: invokeNativeRaw,
} = require('./forge-native-invocation.js');
// Legacy fixture adapter explicitly promises terminal payloads; an agent id
// alone is an acknowledgment and does not satisfy this contract.
const invokeNative = (options, callback) => invokeNativeRaw({
  terminalResult: value => value?.status === 'done', ...options }, callback);
const { resolveDispatch } = require('./forge-dispatch-resolve.js');

const codexCapabilities = Object.freeze({
  available: true,
  tool: 'spawn_agent',
  source: 'test-active-tool',
  models: ['gpt-6-luna', 'gpt-5.6-sol', 'gpt-6-sol'],
  reasoning_efforts: ['low', 'medium', 'high'],
  fork_turns: ['none', '3'],
});

const claudeCapabilities = Object.freeze({
  available: true,
  tool: 'Agent',
  source: 'test-active-tool',
  model_aliases: ['haiku', 'sonnet', 'opus'],
  effort_transports: ['agent-frontmatter'],
});

function fingerprint(filename) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')}`;
}

function agentFixture(agentType, effort) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-binding-'));
  const filename = path.join(dir, `${agentType}.md`);
  fs.writeFileSync(filename, `---\nname: ${agentType}\nmodel: claude-sonnet-5\neffort: ${effort}\n---\nfixture\n`);
  return { dir, filename, fingerprint: fingerprint(filename) };
}

function dispatch(model, effort, engine, alias) {
  return {
    model,
    model_requested: model,
    model_resolved: model,
    alias: alias === undefined ? null : alias,
    effort,
    dispatch_engine: engine,
    host_runtime: engine,
    resolved_worker_engine: engine,
    worker_mode: 'native',
    dispatch_allowed: true,
    config_ok: true,
  };
}

async function main() {
  assert.strictEqual(validateActiveCapabilities('codex', codexCapabilities).ok, true);
  assert.strictEqual(validateActiveCapabilities('codex', null).reason_code, 'native-capabilities-missing');

  const mediumTransportUnits = [
    { unitType: 'memory-extract', agentType: 'forge-memory' },
    { unitType: 'complete-slice', agentType: 'forge-completer' },
    { unitType: 'complete-milestone', agentType: 'forge-completer' },
  ];
  for (const model of ['gpt-6-luna', 'gpt-5.6-sol']) {
    const routeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-native-route-'));
    fs.mkdirSync(path.join(routeRoot, '.gsd', 'forge'), { recursive: true });
    fs.writeFileSync(path.join(routeRoot, '.gsd', 'forge-prefs.jsonc'), JSON.stringify({
      tier_models: { light: model },
      effort: { 'memory-extract': 'medium', 'complete-slice': 'medium', 'complete-milestone': 'medium' },
    }));
    try {
      for (const unit of mediumTransportUnits) {
        const taskName = `${unit.unitType}-${model}-dispatch`;
        const nativeRoute = resolveDispatch({ cwd: routeRoot, unitType: unit.unitType, hostRuntime: 'codex' });
        const built = buildNativeInvocation({
          hostRuntime: 'codex', resolvedDispatch: nativeRoute,
          activeCapabilities: codexCapabilities, taskName,
          agentType: unit.agentType, prompt: `Run ${unit.unitType}.`,
        });
        assert.strictEqual(built.ok, true, `${unit.unitType}/${model}: ${JSON.stringify(built)}`);
        assert.strictEqual(built.args.model, model);
        assert.strictEqual(built.args.reasoning_effort, 'medium');
        assert.strictEqual(built.args.fork_turns, 'none');
        assert.match(built.args.task_name, /^[a-z0-9_]+$/);
        assert.strictEqual(built.telemetry.model_resolved, model);
        assert.strictEqual(built.telemetry.model_argument, model);
        assert.strictEqual(built.telemetry.effort_resolved, 'medium');
        assert.strictEqual(built.telemetry.effort_argument, 'medium');
        assert.strictEqual(built.telemetry.model_observed, null);

        const remoteRoute = resolveDispatch({ cwd: routeRoot, unitType: unit.unitType, hostRuntime: 'claude' });
        assert.strictEqual(remoteRoute.worker_mode, 'sidecar');
        const refusedNative = buildNativeInvocation({
          hostRuntime: 'claude', resolvedDispatch: remoteRoute,
          activeCapabilities: claudeCapabilities, taskName,
          agentType: unit.agentType, prompt: `Run ${unit.unitType}.`,
        });
        assert.strictEqual(refusedNative.reason_code, 'native-route-identity-mismatch',
          `${unit.unitType}/${model} must remain on the declared sidecar transport`);
      }
    } finally {
      fs.rmSync(routeRoot, { recursive: true, force: true });
    }
  }

  const unsupportedModel = buildNativeInvocation({
    hostRuntime: 'codex',
    resolvedDispatch: dispatch('gpt-unknown', 'medium', 'codex'),
    activeCapabilities: codexCapabilities,
    agentType: 'forge-memory',
    prompt: 'memory',
  });
  assert.strictEqual(unsupportedModel.reason_code, 'native-model-unsupported');

  const unknownRequest = dispatch('gpt-6-luna', 'medium', 'codex');
  unknownRequest.model_requested = null;
  const requestUnknown = buildNativeInvocation({
    hostRuntime: 'codex', resolvedDispatch: unknownRequest,
    activeCapabilities: codexCapabilities, agentType: 'forge-memory', prompt: 'memory',
  });
  assert.strictEqual(requestUnknown.ok, true, JSON.stringify(requestUnknown));
  assert.strictEqual(requestUnknown.telemetry.model_requested, null,
    'an absent requested model must not be invented from the resolved model');
  assert.strictEqual(requestUnknown.telemetry.model_resolved, 'gpt-6-luna');

  const unsupportedEffort = buildNativeInvocation({
    hostRuntime: 'codex',
    resolvedDispatch: dispatch('gpt-6-luna', 'max', 'codex'),
    activeCapabilities: codexCapabilities,
    agentType: 'forge-memory',
    prompt: 'memory',
  });
  assert.strictEqual(unsupportedEffort.reason_code, 'native-effort-unsupported');

  const inheritedAll = buildNativeInvocation({
    hostRuntime: 'codex',
    resolvedDispatch: dispatch('gpt-6-luna', 'medium', 'codex'),
    activeCapabilities: codexCapabilities,
    agentType: 'forge-memory',
    prompt: 'memory',
    forkTurns: 'all',
  });
  assert.strictEqual(inheritedAll.reason_code, 'native-fork-turns-invalid');

  const invalidTaskName = buildNativeInvocation({
    hostRuntime: 'codex',
    resolvedDispatch: dispatch('gpt-6-luna', 'medium', 'codex'),
    activeCapabilities: codexCapabilities,
    taskName: '---', agentType: '---', prompt: 'memory',
  });
  assert.strictEqual(invalidTaskName.reason_code, 'native-task-name-invalid');

  const compatibleAgent = agentFixture('forge-memory', 'medium');
  const effortBinding = {
    transport: 'agent-frontmatter',
    agentPath: compatibleAgent.filename,
    sourceFingerprint: compatibleAgent.fingerprint,
  };
  const observed = observeClaudeAgentBinding({
    agentType: 'forge-memory', agentPath: compatibleAgent.filename,
    sourceFingerprint: compatibleAgent.fingerprint,
  });
  assert.strictEqual(observed.ok, true, JSON.stringify(observed));
  assert.strictEqual(observed.effort, 'medium');
  assert.strictEqual(observed.source, fs.realpathSync(compatibleAgent.filename));

  const claude = buildNativeInvocation({
    hostRuntime: 'claude',
    resolvedDispatch: dispatch('claude-sonnet-5', 'medium', 'claude', 'sonnet'),
    activeCapabilities: claudeCapabilities,
    agentType: 'forge-memory', prompt: 'memory', effortBinding,
  });
  assert.strictEqual(claude.ok, true, JSON.stringify(claude));
  assert.deepStrictEqual(claude.args, { subagent_type: 'forge-memory', prompt: 'memory', model: 'sonnet' });
  assert.strictEqual(claude.telemetry.effort_argument, null);
  assert.strictEqual(claude.telemetry.effort_transport, 'agent-frontmatter');
  assert.strictEqual(claude.telemetry.effort_binding_observed, 'medium');
  assert.strictEqual(claude.telemetry.effort_applied, null);
  assert.strictEqual(claude.telemetry.effort_binding_observed_fingerprint, compatibleAgent.fingerprint);

  const aliasAbsent = buildNativeInvocation({
    hostRuntime: 'claude',
    resolvedDispatch: dispatch('claude-sonnet-5', 'medium', 'claude'),
    activeCapabilities: claudeCapabilities,
    agentType: 'forge-memory', prompt: 'memory', effortBinding,
  });
  assert.strictEqual(aliasAbsent.ok, true, JSON.stringify(aliasAbsent));
  assert.strictEqual(aliasAbsent.args.model, 'sonnet', 'missing route alias is derived from the full model id');

  const contradictoryAlias = buildNativeInvocation({
    hostRuntime: 'claude',
    resolvedDispatch: dispatch('claude-opus-5', 'medium', 'claude', 'sonnet'),
    activeCapabilities: claudeCapabilities,
    agentType: 'forge-memory', prompt: 'memory', effortBinding,
  });
  assert.strictEqual(contradictoryAlias.reason_code, 'native-claude-alias-mismatch');

  let claudeCallbackArgs = null;
  const invokedClaude = await invokeNative({
    hostRuntime: 'claude',
    resolvedDispatch: dispatch('claude-sonnet-5', 'medium', 'claude', 'sonnet'),
    activeCapabilities: claudeCapabilities,
    agentType: 'forge-memory', prompt: 'memory', effortBinding,
  }, async (args) => {
    claudeCallbackArgs = args;
    return { status: 'done' };
  });
  assert.strictEqual(invokedClaude.ok, true, JSON.stringify(invokedClaude));
  assert.strictEqual(claudeCallbackArgs.prompt, 'memory');
  assert.strictEqual(claudeCallbackArgs.model, 'sonnet');

  const promptHeader = buildNativeInvocation({
    hostRuntime: 'claude',
    resolvedDispatch: dispatch('claude-sonnet-5', 'medium', 'claude', 'sonnet'),
    activeCapabilities: { ...claudeCapabilities, effort_transports: ['prompt-header', 'agent-frontmatter'] },
    agentType: 'forge-memory', prompt: 'memory',
    effortBinding: { transport: 'prompt-header', effort: 'medium', source: 'prompt' },
  });
  assert.strictEqual(promptHeader.reason_code, 'native-effort-prompt-header-not-api');

  const realMemoryAgent = path.join(__dirname, '..', 'agents', 'forge-memory.md');
  const mismatchedFrontmatter = buildNativeInvocation({
    hostRuntime: 'claude',
    resolvedDispatch: dispatch('claude-sonnet-5', 'medium', 'claude', 'sonnet'),
    activeCapabilities: claudeCapabilities,
    agentType: 'forge-memory', prompt: 'memory',
    effortBinding: {
      transport: 'agent-frontmatter', agentPath: realMemoryAgent,
      sourceFingerprint: fingerprint(realMemoryAgent),
    },
  });
  assert.strictEqual(mismatchedFrontmatter.reason_code, 'native-effort-binding-mismatch');

  const staleFingerprint = buildNativeInvocation({
    hostRuntime: 'claude',
    resolvedDispatch: dispatch('claude-sonnet-5', 'medium', 'claude', 'sonnet'),
    activeCapabilities: claudeCapabilities,
    agentType: 'forge-memory', prompt: 'memory',
    effortBinding: {
      transport: 'agent-frontmatter', agentPath: compatibleAgent.filename,
      sourceFingerprint: `sha256:${'0'.repeat(64)}`,
    },
  });
  assert.strictEqual(staleFingerprint.reason_code, 'native-effort-binding-fingerprint-mismatch');

  const unboundClaude = buildNativeInvocation({
    hostRuntime: 'claude',
    resolvedDispatch: dispatch('claude-sonnet-5', 'medium', 'claude', 'sonnet'),
    activeCapabilities: claudeCapabilities,
    agentType: 'forge-memory',
    prompt: 'memory',
  });
  assert.strictEqual(unboundClaude.reason_code, 'native-effort-binding-missing');

  fs.rmSync(compatibleAgent.dir, { recursive: true, force: true });

  const nonNative = dispatch('gpt-6-luna', 'medium', 'codex');
  nonNative.worker_mode = 'sidecar';
  assert.strictEqual(buildNativeInvocation({
    hostRuntime: 'codex', resolvedDispatch: nonNative,
    activeCapabilities: codexCapabilities, agentType: 'forge-memory', prompt: 'memory',
  }).reason_code, 'native-route-identity-mismatch');

  const unconfirmed = dispatch('gpt-6-luna', 'medium', 'codex');
  delete unconfirmed.dispatch_allowed;
  assert.strictEqual(buildNativeInvocation({
    hostRuntime: 'codex', resolvedDispatch: unconfirmed,
    activeCapabilities: codexCapabilities, agentType: 'forge-memory', prompt: 'memory',
  }).reason_code, 'resolved-dispatch-refused');

  const degraded = {
    config_ok: false, dispatch_allowed: false,
    dispatch_reason_code: 'routing-runtime-error',
  };
  assert.strictEqual(buildNativeInvocation({
    hostRuntime: 'codex', resolvedDispatch: degraded,
    activeCapabilities: codexCapabilities, agentType: 'forge-memory', prompt: 'memory',
  }).reason_code, 'routing-runtime-error');

  let callbackArgs = null;
  const invoked = await invokeNative({
    hostRuntime: 'codex',
    resolvedDispatch: dispatch('gpt-6-luna', 'medium', 'codex'),
    activeCapabilities: codexCapabilities,
    taskName: 'memory_extract',
    agentType: 'forge-memory',
    prompt: 'memory',
  }, async (args) => {
    callbackArgs = args;
    return { status: 'done' };
  });
  assert.strictEqual(callbackArgs.model, 'gpt-6-luna');
  assert.strictEqual(callbackArgs.task_name, 'memory_extract');
  assert.match(callbackArgs.task_name, /^[a-z0-9_]+$/);
  assert.strictEqual(callbackArgs.reasoning_effort, 'medium');
  assert.strictEqual(callbackArgs.fork_turns, 'none');
  assert.strictEqual(invoked.telemetry.model_observed, null,
    'agent id is not provider model readback');

  const workerClaimsReadback = await invokeNative({
    hostRuntime: 'codex',
    resolvedDispatch: dispatch('gpt-6-sol', 'medium', 'codex'),
    activeCapabilities: codexCapabilities,
    agentType: 'forge-memory',
    prompt: 'memory',
  }, async () => ({
    status: 'done',
    model_readback: { model: 'gpt-6-sol', source: 'provider-response' },
  }));
  assert.strictEqual(workerClaimsReadback.telemetry.model_observed, null,
    'worker result content is never authoritative model readback');

  const withReadback = await invokeNative({
    hostRuntime: 'codex',
    resolvedDispatch: dispatch('gpt-6-sol', 'medium', 'codex'),
    activeCapabilities: codexCapabilities,
    agentType: 'forge-memory',
    prompt: 'memory',
    readback: async () => ({ model: 'gpt-6-sol', source: 'trusted-native-adapter' }),
  }, async () => ({ status: 'done' }));
  assert.strictEqual(withReadback.telemetry.model_observed, 'gpt-6-sol');
  assert.strictEqual(withReadback.telemetry.model_observed_source, 'trusted-native-adapter');

  const secret = 'credential=do-not-return-this-value';
  const failed = await invokeNative({
    hostRuntime: 'codex',
    resolvedDispatch: dispatch('gpt-6-sol', 'medium', 'codex'),
    activeCapabilities: codexCapabilities,
    agentType: 'forge-memory',
    prompt: 'memory',
  }, async () => {
    throw new Error(secret);
  });
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.reason_code, 'native-invocation-failed');
  assert(!JSON.stringify(failed).includes(secret), 'provider errors must not leak credentials');

  // Model policy on the native Claude path. The alias `sonnet` for Sonnet 5.5 is
  // recorded as alias-only; it never becomes an observed model version.
  const policyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-policy-'));
  function policyAgent(name, lines) {
    const filename = path.join(policyDir, `${name}.md`);
    fs.writeFileSync(filename, `---\nname: forge-executor\n${lines.join('\n')}\n---\nfixture\n`);
    return { transport: 'agent-frontmatter', agentPath: filename, sourceFingerprint: fingerprint(filename) };
  }
  const plainBinding = policyAgent('plain', ['model: claude-sonnet-5', 'effort: medium']);
  const observedPlain = observeClaudeAgentBinding({ agentType: 'forge-executor', agentPath: plainBinding.agentPath,
    sourceFingerprint: plainBinding.sourceFingerprint });
  assert.strictEqual(observedPlain.thinking, null, 'absent frontmatter thinking is reported as null');
  const adaptiveBinding = policyAgent('adaptive', ['model: claude-sonnet-5', 'thinking: adaptive', 'effort: medium']);
  const observedAdaptive = observeClaudeAgentBinding({ agentType: 'forge-executor', agentPath: adaptiveBinding.agentPath,
    sourceFingerprint: adaptiveBinding.sourceFingerprint });
  assert.strictEqual(observedAdaptive.thinking, 'adaptive');
  assert.strictEqual(observedAdaptive.source_fingerprint, adaptiveBinding.sourceFingerprint,
    'thinking is read from the same fingerprinted bytes');

  const sonnet55 = buildNativeInvocation({
    hostRuntime: 'claude', resolvedDispatch: dispatch('claude-sonnet-5-5', 'medium', 'claude', 'sonnet'),
    activeCapabilities: claudeCapabilities, agentType: 'forge-executor', prompt: 'fix', effortBinding: plainBinding,
  });
  assert.strictEqual(sonnet55.ok, true, JSON.stringify(sonnet55));
  assert.strictEqual(sonnet55.args.model, 'sonnet');
  assert.strictEqual(sonnet55.telemetry.model_version_proof, 'alias-only');
  assert.deepStrictEqual(sonnet55.telemetry.policy_diagnostics.map((item) => item.code), ['native-alias-not-version-proof']);
  assert.strictEqual(sonnet55.telemetry.model_observed, null, 'alias-only never fills the observed model');
  assert.strictEqual(sonnet55.telemetry.effort_applied, null, 'alias-only never fills the applied effort');

  // A frontmatter `thinking:` line is not a documented per-subagent control
  // (subagents inherit thinking from the session): it never refuses a launch
  // and is reported as an inert legacy declaration, outside the telemetry.
  const disabledBinding = policyAgent('disabled', ['model: claude-sonnet-5', 'thinking: disabled', 'effort: medium']);
  const inertDeclaration = buildNativeInvocation({
    hostRuntime: 'claude', resolvedDispatch: dispatch('claude-sonnet-5-5', 'medium', 'claude', 'sonnet'),
    activeCapabilities: claudeCapabilities, agentType: 'forge-executor', prompt: 'fix', effortBinding: disabledBinding,
  });
  assert.strictEqual(inertDeclaration.ok, true, JSON.stringify(inertDeclaration));
  assert.notStrictEqual(inertDeclaration.reason_code, 'native-thinking-binding-incompatible');
  assert.deepStrictEqual(inertDeclaration.diagnostics.map((item) => [item.code, item.declared, item.policy_code]),
    [['native-thinking-declaration-inert', 'disabled', 'thinking-disabled-incompatible']]);
  assert(!('thinking' in inertDeclaration.args), 'no thinking argument is invented for the native tool');
  assert.deepStrictEqual(Object.keys(inertDeclaration.telemetry), Object.keys(sonnet55.telemetry),
    'the declaration never enters the adapter telemetry envelope');
  const adaptive55 = buildNativeInvocation({
    hostRuntime: 'claude', resolvedDispatch: dispatch('claude-sonnet-5-5', 'medium', 'claude', 'sonnet'),
    activeCapabilities: claudeCapabilities, agentType: 'forge-executor', prompt: 'fix', effortBinding: adaptiveBinding,
  });
  assert.strictEqual(adaptive55.ok, true);
  assert(!('diagnostics' in adaptive55), 'a compatible declaration adds nothing');

  // Explicit operator intent is different: the resolver refuses Sonnet 5.5 +
  // thinking disabled before any native invocation, and the adapter honors it.
  const intentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-native-intent-'));
  fs.mkdirSync(path.join(intentRoot, '.gsd', 'forge'), { recursive: true });
  fs.writeFileSync(path.join(intentRoot, '.gsd', 'forge-prefs.jsonc'), JSON.stringify({
    tier_models: { light: 'claude-sonnet-5-5', standard: 'claude-sonnet-5-5' },
    effort: { 'memory-extract': 'medium' }, thinking: { sonnet_phases: 'disabled' },
  }));
  const intentRoute = resolveDispatch({ cwd: intentRoot, unitType: 'memory-extract', hostRuntime: 'claude' });
  fs.rmSync(intentRoot, { recursive: true, force: true });
  assert.strictEqual(intentRoute.model_resolved, 'claude-sonnet-5-5', 'the model is never substituted');
  assert.strictEqual(intentRoute.dispatch_allowed, false);
  assert.strictEqual(intentRoute.dispatch_reason_code, 'thinking-disabled-incompatible');
  const intentRefused = buildNativeInvocation({
    hostRuntime: 'claude', resolvedDispatch: intentRoute, activeCapabilities: claudeCapabilities,
    agentType: 'forge-executor', prompt: 'fix', effortBinding: adaptiveBinding,
  });
  assert.strictEqual(intentRefused.reason_code, 'thinking-disabled-incompatible');
  assert.strictEqual(intentRefused.args, null);

  // Full model ids: sent unchanged only when the ACTIVE tool capabilities list
  // them. The alias-only mark disappears on that path; the observed model stays
  // unknown because an argument is not a provider readback.
  const idCapabilities = { ...claudeCapabilities, model_ids: ['claude-sonnet-5-5', 'claude-sonnet-5'] };
  const exact55 = buildNativeInvocation({
    hostRuntime: 'claude', resolvedDispatch: dispatch('claude-sonnet-5-5', 'medium', 'claude', 'sonnet'),
    activeCapabilities: idCapabilities, agentType: 'forge-executor', prompt: 'fix', effortBinding: plainBinding,
  });
  assert.strictEqual(exact55.ok, true, JSON.stringify(exact55));
  assert.strictEqual(exact55.args.model, 'claude-sonnet-5-5');
  assert.strictEqual(exact55.telemetry.model_argument, 'claude-sonnet-5-5');
  assert.strictEqual(exact55.telemetry.model_observed, null);
  assert(!('model_version_proof' in exact55.telemetry));
  assert.deepStrictEqual(Object.keys(exact55.telemetry), Object.keys(claude.telemetry));
  const unlistedId = buildNativeInvocation({
    hostRuntime: 'claude', resolvedDispatch: dispatch('claude-sonnet-5-5', 'medium', 'claude', 'sonnet'),
    activeCapabilities: { ...claudeCapabilities, model_ids: ['claude-sonnet-5'] }, agentType: 'forge-executor',
    prompt: 'fix', effortBinding: plainBinding,
  });
  assert.strictEqual(unlistedId.args.model, 'sonnet', 'an unlisted id keeps the alias path');
  assert.strictEqual(unlistedId.telemetry.model_version_proof, 'alias-only');
  const noAliasId = buildNativeInvocation({
    hostRuntime: 'claude', resolvedDispatch: dispatch('claude-sonnet-5-5', 'medium', 'claude', 'sonnet'),
    activeCapabilities: { ...claudeCapabilities, model_aliases: [], model_ids: ['claude-sonnet-5-5'] },
    agentType: 'forge-executor', prompt: 'fix', effortBinding: plainBinding,
  });
  assert.strictEqual(noAliasId.args.model, 'claude-sonnet-5-5', 'a listed id needs no alias support');
  assert.strictEqual(buildNativeInvocation({
    hostRuntime: 'claude', resolvedDispatch: dispatch('claude-sonnet-5-5', 'medium', 'claude', 'sonnet'),
    activeCapabilities: { ...claudeCapabilities, model_aliases: [] }, agentType: 'forge-executor',
    prompt: 'fix', effortBinding: plainBinding,
  }).reason_code, 'native-model-unsupported', 'no static default makes a model available');
  assert.strictEqual(validateActiveCapabilities('claude', { ...claudeCapabilities, model_ids: 'claude-sonnet-5-5' }).reason_code,
    'native-capabilities-invalid');

  // effort_requested is the resolver's additive pre-clamp value when present.
  const clampedRoute = { ...dispatch('claude-sonnet-5', 'medium', 'claude', 'sonnet'), effort_requested: 'high' };
  assert.strictEqual(buildNativeInvocation({
    hostRuntime: 'claude', resolvedDispatch: clampedRoute, activeCapabilities: claudeCapabilities,
    agentType: 'forge-executor', prompt: 'fix', effortBinding: plainBinding,
  }).telemetry.effort_requested, 'high');
  assert.strictEqual(claude.telemetry.effort_requested, 'medium', 'absent additive field keeps the legacy value');

  // Existing models keep the exact previous envelope, including thinking: disabled.
  const legacyDisabled = buildNativeInvocation({
    hostRuntime: 'claude', resolvedDispatch: dispatch('claude-sonnet-5', 'medium', 'claude', 'sonnet'),
    activeCapabilities: claudeCapabilities, agentType: 'forge-executor', prompt: 'fix', effortBinding: disabledBinding,
  });
  assert.strictEqual(legacyDisabled.ok, true, JSON.stringify(legacyDisabled));
  assert(!('model_version_proof' in legacyDisabled.telemetry), 'legacy models gain no new telemetry key');
  assert(!('policy_diagnostics' in legacyDisabled.telemetry), 'legacy models gain no new telemetry key');
  assert.deepStrictEqual(Object.keys(legacyDisabled.telemetry), Object.keys(claude.telemetry));

  const effortMismatch55 = buildNativeInvocation({
    hostRuntime: 'claude', resolvedDispatch: dispatch('claude-sonnet-5-5', 'high', 'claude', 'sonnet'),
    activeCapabilities: claudeCapabilities, agentType: 'forge-executor', prompt: 'fix', effortBinding: plainBinding,
  });
  assert.strictEqual(effortMismatch55.reason_code, 'native-effort-binding-mismatch', 'effort mismatch code unchanged');

  // preflightNativeBinding: same verdict, no callback, no side effects.
  const before = fs.readFileSync(plainBinding.agentPath, 'utf8');
  const preflightOk = preflightNativeBinding({
    hostRuntime: 'claude', resolvedDispatch: dispatch('claude-sonnet-5', 'medium', 'claude', 'sonnet'),
    activeCapabilities: claudeCapabilities, agentType: 'forge-executor', effortBinding: plainBinding,
  });
  assert.strictEqual(preflightOk.ok, true, JSON.stringify(preflightOk));
  assert.strictEqual(preflightOk.preflight, true);
  assert.strictEqual(preflightOk.args, null, 'no launch arguments without a real prompt');
  const preflightMismatch = preflightNativeBinding({
    hostRuntime: 'claude', resolvedDispatch: dispatch('claude-sonnet-5', 'high', 'claude', 'sonnet'),
    activeCapabilities: claudeCapabilities, agentType: 'forge-executor', effortBinding: plainBinding,
  });
  assert.strictEqual(preflightMismatch.reason_code, 'native-effort-binding-mismatch');
  assert.strictEqual(fs.readFileSync(plainBinding.agentPath, 'utf8'), before, 'preflight never rewrites the binding');
  fs.rmSync(policyDir, { recursive: true, force: true });

  const options = { hostRuntime: 'codex', resolvedDispatch: dispatch('gpt-6-luna', 'medium', 'codex'),
    activeCapabilities: codexCapabilities, agentType: 'forge-worker', prompt: 'Fixture only.', forkTurns: 'none' };
  let ackReadback = 0;
  const acknowledged = await invokeNative({ ...options, readback: () => { ackReadback++; return null; } },
    async () => ({ agent_id: 'ack-is-not-a-result' }));
  assert.strictEqual(acknowledged.ok, false, 'ack must not be accepted as terminal');
  assert.strictEqual(acknowledged.reason_code, 'native-terminal-unobserved');
  assert.strictEqual(ackReadback, 0, 'ack must not reach readback');
  const resumeDir=fs.mkdtempSync(path.join(os.tmpdir(),'native-resume-evidence-'));
  for (const boundary of ['after-invoke','readback']) {
    const lifecycle={journal:{root:fs.realpathSync.native(resumeDir),file:path.join(fs.realpathSync.native(resumeDir),boundary+'.json'),authorize:()=>true}};
    await invokeNative({...options,lifecycle},()=>{throw Error('interrupted fixture');});
    lifecycle.adapter={capabilities:{resume:true},resume:()=>({status:'done'})};
    const resumedFailure=await invokeNative({...options,lifecycle,
      assertInvocation:stage=>{if(stage===boundary)throw Object.assign(Error('fixture'),{code:'fixture-guard'});},
      readback:()=>{if(boundary==='readback')throw Object.assign(Error('fixture'),{code:'fixture-readback'});return null;},
    },()=>assert.fail('resume must not launch'));
    assert.equal(resumedFailure.ok,false);
    assert.equal(resumedFailure.provider_called,true,'observed resumed terminal survives later failure');
    assert.equal(resumedFailure.final_evidence.provider_called,true);
  }
  assert.strictEqual((await invokeNative(options)).provider_called, false);
  let refusedCalls = 0;
  const unsupported = await invokeNative({ ...options, activeCapabilities: { ...codexCapabilities, models: [] } },
    () => { refusedCalls++; });
  assert.strictEqual(unsupported.provider_called, false); assert.strictEqual(refusedCalls, 0);
  const unknown = await invokeNative(options, () => { throw Object.assign(Error('secret fixture'), { code: 'host-timeout' }); });
  assert.strictEqual(unknown.provider_called, 'unknown');
  assert.deepStrictEqual(unknown.diagnostic, { reason_code: 'host-timeout', layer: 'native-lifecycle' });
  assert(!JSON.stringify(unknown).includes('secret fixture'));
  for (const rejection of [null, undefined, 'secret rejection', 42, false]) {
    const failed = await invokeNative(options, () => Promise.reject(rejection));
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.reason_code, 'native-invocation-failed');
    assert.strictEqual(failed.provider_called, 'unknown');
    assert.strictEqual(failed.final_evidence.stage, 'invoked');
    assert(!JSON.stringify(failed).includes('secret rejection'));
  }

  // S03/T02: readable task name per dispatch. codexTaskName keeps its bytes.
  const { humanTaskName, codexTaskName } = require('./forge-native-invocation.js');
  assert.strictEqual(codexTaskName('Execute-Task/T01'), 'execute_task_t01');
  assert.strictEqual(codexTaskName('', 'forge-memory'), 'forge_memory');
  assert.strictEqual(codexTaskName('__A..B__'), 'a_b');
  const hex8 = value => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 8);
  const nameShape = /^[a-z0-9]+(_[a-z0-9]+)*$/;
  const nameVectors = [
    ['short unit', { unitId: 'S03/T02', title: 'Identidade nativa', attempt: 'dispatch-1' },
      `s03_t02_identidade_nativa_${hex8('dispatch-1')}`],
    ['milestone unit keeps t03', { unitId: 'M-20261028132636-experiencia/S03/T03', title: 'Modelo de leitura', attempt: 'a' },
      `experiencia_s03_t03_modelo_de_leitura_${hex8('a')}`],
    ['long standalone id keeps its useful end', { unitId: 'T-20260928000001-fixture-long-standalone-name', title: 'Plano', attempt: 'b' },
      `long_standalone_name_plano_${hex8('b')}`],
    ['accented title', { unitId: 'S01/T01', title: 'Ação rápida çé', attempt: 'c' }, `s01_t01_acao_rapida_ce_${hex8('c')}`],
    ['emoji title', { unitId: 'S01/T01', title: '🚀 Lançar painel 😀', attempt: 'd' }, `s01_t01_lancar_painel_${hex8('d')}`],
    ['empty title', { unitId: 'S03/T02', title: '', attempt: 'e' }, `s03_t02_${hex8('e')}`],
    ['numeric attempt', { unitId: 'S03/T02', title: 'Nome', attempt: 7 }, `s03_t02_nome_${hex8('7')}`],
    ['title without unit', { title: 'Só título', attempt: 'f' }, `so_titulo_${hex8('f')}`],
  ];
  for (const [label, input, expected] of nameVectors) {
    const name = humanTaskName(input);
    assert.strictEqual(name, expected, label);
    assert.strictEqual(humanTaskName(input), name, `${label}: deterministic`);
    assert.strictEqual(codexTaskName(name), name, `${label}: idempotent under codexTaskName`);
    assert.match(name, nameShape, label);
    assert(name.length <= 64, label);
    assert.match(name, new RegExp(`_${hex8(input.attempt)}$`), label);
  }
  const longTitle = 'Identidade nativa sanitizador de linha unico nome humano por despacho retorno real do host no journal';
  const longName = humanTaskName({ unitId: 'M-20261028132636-experiencia/S03/T02', title: longTitle, attempt: 'dispatch-s03-t02' });
  assert(longName.length <= 64 && nameShape.test(longName), longName);
  const titlePart = longName.slice('experiencia_s03_t02_'.length, -9);
  const normalizedTitle = codexTaskName(longTitle);
  assert(longName.startsWith('experiencia_s03_t02_') && normalizedTitle.startsWith(titlePart)
    && normalizedTitle[titlePart.length] === '_', `cut at a word boundary: ${longName}`);
  assert.strictEqual(humanTaskName({ unitId: 'x'.repeat(40), title: 'y'.repeat(80), attempt: 'g' }).length <= 64, true);
  for (const attempt of [null, undefined, '']) assert.strictEqual(humanTaskName({ unitId: 'S03/T02', title: 'Nome', attempt }), null);
  assert.strictEqual(humanTaskName({ unitId: '', title: '😀 ---', attempt: 'h' }), null, 'empty unit and title');
  assert.strictEqual(humanTaskName(), null);
  const attemptNames = new Set(Array.from({ length: 64 }, (_, index) => humanTaskName({ unitId: 'S03/T02', title: 'Nome', attempt: `dispatch-${index}` })));
  assert.strictEqual(attemptNames.size, 64, 'distinct attempts give distinct names');
  const preparationSource = fs.readFileSync(path.join(__dirname, 'forge-task-preparation.js'), 'utf8');
  assert(!preparationSource.includes('humanTaskName'), 'preparation keeps its own naming');
  assert(preparationSource.includes(".digest('hex').slice(0, 16);"), 'preparation keeps its 16-hex suffix');
  console.log('PASS S03/T02 humanTaskName vectors: ASCII fold, unit tail at _ boundary, title cut at word boundary, 8-hex attempt suffix, deterministic, distinct, idempotent, null without attempt');

  const humanName = humanTaskName({ unitId: 'S03/T02', title: 'Identidade nativa', attempt: 'dispatch-1' });
  const codexHuman = buildNativeInvocation({ hostRuntime: 'codex', resolvedDispatch: dispatch('gpt-6-luna', 'medium', 'codex'),
    activeCapabilities: codexCapabilities, taskName: humanName, agentType: 'forge-executor', prompt: 'Fixture only.', forkTurns: 'none' });
  assert.deepStrictEqual(Object.keys(codexHuman.args), ['task_name', 'message', 'agent_type', 'model', 'reasoning_effort', 'fork_turns']);
  assert.strictEqual(codexHuman.args.task_name, humanName);
  const humanAgent = agentFixture('forge-memory', 'medium');
  const humanBinding = { transport: 'agent-frontmatter', agentPath: humanAgent.filename, sourceFingerprint: humanAgent.fingerprint };
  const claudeHuman = buildNativeInvocation({ hostRuntime: 'claude', resolvedDispatch: dispatch('claude-sonnet-5', 'medium', 'claude', 'sonnet'),
    activeCapabilities: claudeCapabilities, taskName: humanName, agentType: 'forge-memory', prompt: 'memory', effortBinding: humanBinding });
  assert.deepStrictEqual(claudeHuman.args, { subagent_type: 'forge-memory', prompt: 'memory', model: 'sonnet' }, JSON.stringify(claudeHuman));
  assert.deepStrictEqual(preflightNativeBinding({ hostRuntime: 'codex', resolvedDispatch: dispatch('gpt-6-luna', 'medium', 'codex'),
    activeCapabilities: codexCapabilities, taskName: humanName, agentType: 'forge-executor' }).args, null);
  console.log('PASS S03/T02 native arguments: Codex receives exactly the six keys with the human task_name, Claude keeps subagent_type, prompt and model');

  // Observer: a frozen Forge capability in the third callback argument only.
  const hostValue = '/root/experience_s02_t07_334497b58af1';
  const observing = { ...options, taskName: humanName, telemetryIdentity: { dispatchId: 'dispatch-observer' } };
  let seenArgs, seenObserver, observerResult;
  const observedRun = await invokeNative(observing, async (args, invocation, observer) => {
    seenArgs = args; seenObserver = observer; observerResult = observer.hostIdentity(hostValue);
    assert.strictEqual(invocation.args, args);
    return { status: 'done' };
  });
  assert.strictEqual(observedRun.ok, true, JSON.stringify(observedRun));
  assert.deepStrictEqual(Object.keys(seenArgs), ['task_name', 'message', 'agent_type', 'model', 'reasoning_effort', 'fork_turns']);
  assert(Object.isFrozen(seenObserver));
  assert.deepStrictEqual(Object.keys(seenObserver), ['hostIdentity']);
  assert.deepStrictEqual(observerResult, { ok: true });
  const expectedIdentity = { value: hostValue, source: 'host-tool-return', observed_ms: observedRun.host_identity.observed_ms,
    dispatch_id: 'dispatch-observer', conflict: false };
  assert(Number.isSafeInteger(expectedIdentity.observed_ms) && expectedIdentity.observed_ms >= 0);
  assert.deepStrictEqual(observedRun.host_identity, expectedIdentity);
  assert.deepStrictEqual(observedRun.lifecycle.host_identity, expectedIdentity);
  const quietOptions = { ...options, taskName: humanName, telemetryIdentity: { dispatchId: 'dispatch-observer' } };
  const twoArguments = await invokeNative(quietOptions, async (args, invocation) => ({ status: 'done', seen: [args.task_name, invocation.ok] }));
  const ignoresThird = await invokeNative(quietOptions, async () => ({ status: 'done', seen: [humanName, true] }));
  const legacyKeys = ['ok', 'host_runtime', 'tool', 'args', 'telemetry', 'reason_code', 'hint', 'provider_called', 'result', 'lifecycle', 'final_evidence'];
  for (const run of [twoArguments, ignoresThird]) {
    assert.deepStrictEqual(Object.keys(run), legacyKeys);
    assert(!('host_identity' in run.lifecycle));
    assert.deepStrictEqual(run.telemetry, observedRun.telemetry, 'telemetry does not change with observation');
    assert.deepStrictEqual(Object.keys(run.final_evidence), Object.keys(observedRun.final_evidence));
  }
  const timeless = run => JSON.stringify({ ...run, final_evidence: { ...run.final_evidence, captured_at: 0, duration_ms: 0 },
    lifecycle: { ...run.lifecycle, start_wall_ms: 0, last_wall_ms: 0, deadline_wall_ms: 0 } });
  assert.strictEqual(timeless(twoArguments), timeless(ignoresThird), 'old and new callbacks give the same result after normalizing time');
  const observedFailure = await invokeNative(observing, async (args, invocation, observer) => {
    observer.hostIdentity(hostValue); throw Object.assign(Error('fixture'), { code: 'fixture-host-failure' });
  });
  assert.strictEqual(observedFailure.ok, false);
  assert.deepStrictEqual({ ...observedFailure.host_identity, observed_ms: 0 }, { ...expectedIdentity, observed_ms: 0 });
  assert.strictEqual(observedFailure.final_evidence.native_lifecycle.host_identity.value, hostValue);
  for (const mode of ['readback-throws', 'readback-invalid', 'after-invoke-throws', 'after-readback-throws']) {
    for (const observe of [true, false]) {
      let originalInvocation;
      const failed = await invokeNative({ ...observing,
        readback: () => {
          if (mode === 'readback-throws') throw Object.assign(Error('fixture'), { code: 'fixture-readback' });
          return mode === 'readback-invalid' ? [] : null;
        },
        assertInvocation: stage => {
          if (mode === `${stage}-throws`) throw Object.assign(Error('fixture'), { code: 'fixture-guard' });
        },
      }, async (args, invocation, observer) => {
        originalInvocation = invocation;
        if (observe) observer.hostIdentity(hostValue);
        return { status: 'done' };
      });
      assert.strictEqual(failed.ok, false, mode);
      if (observe) {
        assert.strictEqual(failed.lifecycle.host_identity.value, hostValue, mode);
        assert.deepStrictEqual(failed.final_evidence.native_lifecycle, failed.lifecycle, mode);
        const bound = require('./forge-agent-identity').identityFromLifecycle({
          lifecycle: failed.lifecycle, request: observing.telemetryIdentity, invocation: originalInvocation,
        });
        assert.strictEqual(bound.ok, true, mode);
        assert.strictEqual(bound.fields.agent_id, hostValue, mode);
      } else {
        assert(!('host_identity' in failed), mode);
        assert(!('lifecycle' in failed), 'legacy post-supervision failure shape remains unchanged');
        assert(!('native_lifecycle' in failed.final_evidence), mode);
      }
    }
  }
  console.log('PASS S03/T02 post-supervision failure identity: readback throw/invalid and both assertion boundaries preserve lifecycle binding only when observed');
  const silentFailure = await invokeNative(observing, async () => { throw Object.assign(Error('fixture'), { code: 'fixture-host-failure' }); });
  assert(!('host_identity' in silentFailure) && !('host_identity' in silentFailure.lifecycle));
  let claudeObserver;
  const claudeObserved = await invokeNative({ hostRuntime: 'claude', resolvedDispatch: dispatch('claude-sonnet-5', 'medium', 'claude', 'sonnet'),
    activeCapabilities: claudeCapabilities, agentType: 'forge-memory', prompt: 'memory', effortBinding: humanBinding },
  async (args, invocation, observer) => { claudeObserver = observer; assert.deepStrictEqual(Object.keys(args), ['subagent_type', 'prompt', 'model']);
    return { status: 'done' }; });
  assert.strictEqual(claudeObserved.ok, true); assert.strictEqual(typeof claudeObserver.hostIdentity, 'function');
  assert(!('host_identity' in claudeObserved));
  fs.rmSync(humanAgent.dir, { recursive: true, force: true });
  const invocationSource = fs.readFileSync(path.join(__dirname, 'forge-native-invocation.js'), 'utf8');
  assert(invocationSource.includes('terminal: options.terminalResult') && invocationSource.includes('terminalResult'));
  console.log('PASS S03/T02 invokeNative observer: third argument only, frozen hostIdentity, host_identity on success and failure only when observed, old callbacks unchanged');
  process.stdout.write('forge-native-invocation: ok\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
