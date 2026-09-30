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
  invokeNative,
} = require('./forge-native-invocation.js');
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
    return { agent_id: 'claude-agent-1' };
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
    return { agent_id: 'agent-123' };
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
  }, async () => ({ agent_id: 'agent-456' }));
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

  process.stdout.write('forge-native-invocation: ok\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
