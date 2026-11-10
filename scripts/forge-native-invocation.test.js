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
  await claudeEnvironmentJournalIdentity346();
  await claudeEffortEnvironmentAndResume346();
  await claudeArgumentPlanPublication346();
  // Capability observations here are synthetic fixtures, never live Claude claims.
  for (const effort of ['medium','high','xhigh','max']) {
    const argument = buildNativeInvocation({ hostRuntime:'claude',
      resolvedDispatch:dispatch('claude-opus-5-5',effort,'claude'),
      activeCapabilities:{...claudeCapabilities,effort_transports:['agent-argument'],reasoning_efforts:['low','medium','high','xhigh','max']},
      agentType:'forge-planner',prompt:'plan with exact effort' });
    assert.strictEqual(argument.ok,true,JSON.stringify(argument));
    assert.strictEqual(argument.args.effort,effort);
    assert.strictEqual(argument.telemetry.effort_argument,effort);
    assert.strictEqual(argument.telemetry.effort_binding_observed,null);
    assert.strictEqual(argument.telemetry.effort_applied,null);
    let calls=0;
    const delivered=await invokeNative({hostRuntime:'claude',resolvedDispatch:dispatch('claude-opus-5-5',effort,'claude'),
      activeCapabilities:{...claudeCapabilities,effort_transports:['agent-argument'],reasoning_efforts:['low','medium','high','xhigh','max']},
      agentType:'forge-planner',prompt:'synthetic native callback'},async args=>{calls++;assert.strictEqual(args.effort,effort);return{status:'done'};});
    assert.strictEqual(delivered.ok,true,JSON.stringify(delivered));assert.strictEqual(calls,1);
  }
  const unsupportedArgument=buildNativeInvocation({hostRuntime:'claude',resolvedDispatch:dispatch('claude-opus-5-5','max','claude'),
    activeCapabilities:{...claudeCapabilities,effort_transports:['agent-argument'],reasoning_efforts:['medium']},agentType:'forge-planner',prompt:'plan'});
  assert.strictEqual(unsupportedArgument.reason_code,'native-effort-unsupported');
  // The public memory failure receiver also validates the new closed telemetry.
  // This is local synthetic evidence, not a provider or plan-publication test.
  const memoryWork=fs.mkdtempSync(path.join(os.tmpdir(),'forge346-memory-'));
  const memoryOwner=path.join(memoryWork,'owner');fs.mkdirSync(memoryOwner);
  try {
    const route=dispatch('claude-opus-5-5','max','claude','opus');
    const argument=buildNativeInvocation({hostRuntime:'claude',resolvedDispatch:route,
      activeCapabilities:{...claudeCapabilities,effort_transports:['agent-argument'],reasoning_efforts:['max']},agentType:'forge-memory',prompt:'memory'});
    const request={cwd:memoryOwner,contextRoot:memoryOwner,unitType:'memory-extract',sourceUnitType:'execute-task',sourceUnitId:'T01',milestoneId:'M001',
      workflowId:'fixture346',dispatchId:'fixture346-memory',route,resultFile:path.join(memoryWork,'result.json'),
      nativeFailure:{reason_code:'fixture-worker-error',provider_called:true,telemetry:argument.telemetry}};
    const unit=require('./forge-unit-sidecar');
    const accepted=await unit.acceptNativeMemoryResult(request);
    assert.strictEqual(accepted.status,'failure');
    assert.strictEqual(JSON.parse(fs.readFileSync(request.resultFile+'.receipt.json')).failure.telemetry.effort_argument,'max');
    const foreign={...request,dispatchId:'fixture346-bad-memory',resultFile:path.join(memoryWork,'bad.json'),
      nativeFailure:{...request.nativeFailure,telemetry:{...argument.telemetry,effort_argument:'medium'}}};
    await assert.rejects(unit.acceptNativeMemoryResult(foreign),e=>e.code==='native-memory-telemetry-mismatch');
    assert.strictEqual(fs.existsSync(foreign.resultFile+'.receipt.json'),false);
  }finally{fs.rmSync(memoryWork,{recursive:true,force:true});}

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
  const flow = require('./forge-milestone-time-flow.test');
  const admission = require('./forge-milestone-time-admission');
  const timeFixture = flow.fixture();
  try {
    const request = { scope: 'milestone', contextRoot: timeFixture.cwd, cwd: timeFixture.cwd,
      milestoneId: 'M001', unitType: 'execute-task', taskId: 'T01' };
    const base = { hostRuntime: 'codex', resolvedDispatch: dispatch('gpt-6-sol', 'high', 'codex'),
      activeCapabilities: codexCapabilities, agentType: 'forge-executor', prompt: 'scoped fixture',
      telemetryIdentity: request, now: () => Date.parse('2026-11-01T12:00:00Z') + timeFixture.at };
    let called = 0;
    const callback = async () => { called++; return { status: 'done' }; };
    for (const agentType of ['forge-executor', 'forge-reviewer', 'forge-advocate']) {
      timeFixture.at = 1;
      admission.assertOwnerTransportEntry(base);
      const outcome = await invokeNative({ ...base, agentType, beforeInvoke: () => { timeFixture.at = 101; } }, callback);
      assert.strictEqual(outcome.ok, false); assert.strictEqual(outcome.reason_code, 'milestone-budget-exhausted');
      assert.strictEqual(outcome.provider_called, false);
      assert.strictEqual(outcome.diagnostic.layer, 'milestone-time-admission');
    }
    assert.strictEqual(called, 0);
    for (const stage of ['C:/fixture-private/provider-error bearer fixture-secret', { path: 'C:/fixture-private' }, 42, null]) {
      timeFixture.at = 1;
      const hostile = await invokeNative({ ...base, beforeInvoke: () => { throw Object.assign(new Error('x'), { code: 'fixture-failure', stage }); } }, callback);
      assert.strictEqual(hostile.ok, false); assert.strictEqual(hostile.diagnostic.layer, 'native-tool');
      assert(!JSON.stringify(hostile.diagnostic).includes('fixture-secret') && !JSON.stringify(hostile.diagnostic).includes('fixture-private'));
    }
    assert.strictEqual(called, 0);
    console.log('PASS T06 native first invocation and challenger/defense/rebuttal: selected below cap, actual callback refused beyond cap, zero host calls');
    timeFixture.at = 1;
    assert.strictEqual((await invokeNative(base, async () => { called++; timeFixture.at = 101; return { status: 'done' }; })).ok, true);
    assert.strictEqual(called, 1, 'after-invoke and publication do not repeat admission');
    const legacy = { ...base, telemetryIdentity: undefined };
    assert.strictEqual((await invokeNative(legacy, callback)).ok, true);
    const standalone = { ...base, telemetryIdentity: { ...request, scope: 'standalone-task', milestoneId: undefined } };
    assert.strictEqual((await invokeNative(standalone, callback)).ok, true);
    const foreign = await invokeNative({ ...base, milestoneTimeContext: { cwd: timeFixture.cwd, milestone: 'M002', unit: 'execute-task/T01' } }, callback);
    assert.strictEqual(foreign.reason_code, 'milestone-time-invalid'); assert.strictEqual(foreign.provider_called, false);
    const incomplete = await invokeNative({ ...base, telemetryIdentity: { ...request, milestoneId: undefined } }, callback);
    assert.strictEqual(incomplete.reason_code, 'milestone-time-invalid'); assert.strictEqual(incomplete.provider_called, false);
    assert.strictEqual(called, 3);
    console.log('PASS T06 native after-invoke allowed, standalone and absent context legacy unchanged, foreign budget context fails before host callback');
    const { notInvokedWitness } = require('./forge-native-invocation.js');
    const { digest } = require('./forge-code-roots');
    const memoryAgent = agentFixture('forge-memory', 'medium');
    try {
      const claudeBase = { hostRuntime: 'claude', resolvedDispatch: dispatch('claude-sonnet-5', 'medium', 'claude', 'sonnet'),
        activeCapabilities: claudeCapabilities, agentType: 'forge-memory', prompt: 'scoped fixture', telemetryIdentity: request,
        effortBinding: { transport: 'agent-frontmatter', agentPath: memoryAgent.filename, sourceFingerprint: memoryAgent.fingerprint },
        now: base.now };
      for (const options of [base, claudeBase]) {
        timeFixture.at = 101;
        const refusedOutcome = await invokeNative(options, callback);
        const witness = notInvokedWitness(refusedOutcome);
        assert(witness && Object.isFrozen(witness), options.hostRuntime);
        assert.deepStrictEqual({ ...witness }, { schema_version: 1, kind: 'native-not-invoked', reason_code: refusedOutcome.reason_code,
          layer: 'milestone-time-admission', provider_called: false, host_callbacks: 0,
          invocation_sha256: digest(JSON.stringify(buildNativeInvocation(options))), request_sha256: digest(request) });
        for (const copy of [JSON.parse(JSON.stringify(refusedOutcome)), { ...refusedOutcome }, { ok: false, provider_called: false, reason_code: refusedOutcome.reason_code }]) {
          assert.strictEqual(notInvokedWitness(copy), null, 'serialized or copied outcome carries no witness');
        }
        timeFixture.at = 1;
        assert.strictEqual(notInvokedWitness(await invokeNative(options, callback)), null, 'invoked success has no witness');
        const failedAfterCall = await invokeNative(options, async () => { called++; throw Object.assign(Error('fixture'), { code: 'fixture-host-failure', provider_called: false }); });
        assert.strictEqual(failedAfterCall.ok, false); assert.strictEqual(notInvokedWitness(failedAfterCall), null, 'entered callback never mints zero-call proof');
        assert.strictEqual(notInvokedWitness(await invokeNative({ ...options, telemetryIdentity: undefined }, callback)), null);
      }
      assert.strictEqual(called, 9);
    } finally { fs.rmSync(memoryAgent.dir, { recursive: true, force: true }); }
    console.log('PASS T10 both hosts: late guard refusal mints a frozen process-local zero-call witness bound to invocation and request; clones, flags, invoked or failed callbacks never do');
    // #341 review-leg guard in the supervised callback: after the time admission, before the host.
    const legContext = unit => ({ cwd: timeFixture.cwd, milestone: 'M001', unit });
    const legBase = { ...base, telemetryIdentity: undefined };
    let hostCalls = 0;
    const hostCallback = async () => { hostCalls++; return { status: 'done' }; };
    const legRefused = (outcome, code) => {
      assert.strictEqual(outcome.ok, false); assert.strictEqual(outcome.reason_code, code);
      assert.strictEqual(outcome.provider_called, false);
      assert.deepStrictEqual(outcome.diagnostic, { reason_code: code, layer: 'review-policy' });
      const witness = notInvokedWitness(outcome);
      assert(witness && witness.layer === 'review-policy' && witness.host_callbacks === 0 && witness.reason_code === code);
      assert(!JSON.stringify(outcome.diagnostic).includes(timeFixture.cwd));
    };
    const reviewFile = path.join(timeFixture.cwd, '.gsd/milestones/M001/slices/S01/S01-REVIEW.md');
    for (const agentType of ['forge-reviewer', 'forge-advocate']) {
      timeFixture.at = 1;
      legRefused(await invokeNative({ ...legBase, agentType, milestoneTimeContext: legContext('execute-task/T03') }, hostCallback), 'review-per-task-in-milestone');
      assert.strictEqual((await invokeNative({ ...legBase, agentType, milestoneTimeContext: legContext('complete-slice/S01') }, hostCallback)).ok, true,
        'complete-slice before its REVIEW.md reaches the host');
      fs.mkdirSync(path.dirname(reviewFile), { recursive: true }); fs.writeFileSync(reviewFile, '# S01 review\n');
      legRefused(await invokeNative({ ...legBase, agentType, milestoneTimeContext: legContext('complete-slice/S01') }, hostCallback), 'review-already-completed');
      fs.rmSync(reviewFile);
      timeFixture.at = 101;
      const timed = await invokeNative({ ...legBase, agentType, milestoneTimeContext: legContext('execute-task/T03') }, hostCallback);
      assert.strictEqual(timed.reason_code, 'milestone-budget-exhausted', 'time admission prevails over the guard');
      assert.strictEqual(timed.diagnostic.layer, 'milestone-time-admission'); assert.strictEqual(timed.provider_called, false);
    }
    assert.strictEqual(hostCalls, 2, 'only the two complete-slice legs before completion reached the host');
    const refusals = fs.readFileSync(path.join(timeFixture.cwd, '.gsd/forge/events.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean)
      .map(line => JSON.parse(line)).filter(row => row.event === 'review-leg-refusal');
    assert.deepStrictEqual(refusals.map(row => [row.reason_code, row.leg]), [['review-per-task-in-milestone', 'forge-reviewer'],
      ['review-already-completed', 'forge-reviewer'], ['review-per-task-in-milestone', 'forge-advocate'], ['review-already-completed', 'forge-advocate']]);
    timeFixture.at = 1;
    for (const key of ['agentType', 'agent_type', 'subagentType', 'subagent_type']) {
      for (const leg of ['forge-reviewer', 'forge-advocate']) {
        const aliased = { ...legBase, agentType: undefined, agent_type: undefined, subagentType: undefined, subagent_type: undefined, [key]: leg };
        const before = hostCalls;
        legRefused(await invokeNative({ ...aliased, milestoneTimeContext: legContext('execute-task/T03') }, hostCallback), 'review-per-task-in-milestone');
        fs.mkdirSync(path.dirname(reviewFile), { recursive: true }); fs.writeFileSync(reviewFile, '# S01 review\n');
        legRefused(await invokeNative({ ...aliased, milestoneTimeContext: legContext('complete-slice/S01') }, hostCallback), 'review-already-completed');
        fs.rmSync(reviewFile);
        assert.strictEqual(hostCalls, before, `${key} ${leg}: zero host callbacks on refusal`);
      }
    }
    timeFixture.at = 1;
    for (const options of [{ ...legBase, agentType: 'forge-executor', milestoneTimeContext: legContext('execute-task/T03') },
      { ...base, agentType: 'forge-reviewer' }, { ...legBase, agentType: 'forge-advocate' }]) {
      assert.strictEqual((await invokeNative(options, hostCallback)).ok, true, 'executor, telemetryIdentity only and absent context unchanged');
    }
    fs.writeFileSync(path.join(timeFixture.cwd, '.gsd/forge-prefs.jsonc'), JSON.stringify({ review: { milestone_task_review: true } }));
    assert.strictEqual((await invokeNative({ ...legBase, agentType: 'forge-reviewer', milestoneTimeContext: legContext('execute-task/T03') }, hostCallback)).ok, true,
      'review.milestone_task_review true lets the task leg proceed');
    assert.strictEqual(hostCalls, 6);
    console.log('PASS #341 native review legs: per-task and already-completed refused in the supervised callback after time admission, zero host calls, review-policy layer; executor, telemetry-only, absent context and pref unchanged');
  } finally { fs.rmSync(timeFixture.cwd, { recursive: true, force: true }); }
  process.stdout.write('forge-native-invocation: ok\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});

async function claudeArgumentPlanPublication346() {
  const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
  const controller=require('./forge-unit-controller'),state=require('./forge-state'),lease=require('./forge-unit-lease');
  const roots=require('./forge-code-roots'),unit=require('./forge-unit-sidecar'),xllm=require('./forge-xllm');
  const native=require('./forge-native-invocation'),{resolveDispatch}=require('./forge-dispatch-resolve');
  const {checkout,plan}=require('./forge-code-roots.test');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'forge346-plan-publication-'));
  const previous={};for(const k of ['HOME','USERPROFILE','CODEX_HOME','CLAUDE_CONFIG_DIR']){previous[k]=process.env[k];process.env[k]=path.join(home,'isolated-home');}
  let serial=0;
  try {
    for(const [risk,effort]of [['high','max'],['low','medium']]) {
      const area=path.join(home,risk),owner=path.join(area,'owner');fs.mkdirSync(owner,{recursive:true});
      const code=checkout(path.join(area,'code')),contract=roots.singleContract(owner,code);
      const milestone='M001',slice='S01',base=path.join(owner,'.gsd/milestones',milestone),sliceDir=path.join(base,'slices',slice);
      fs.mkdirSync(path.join(sliceDir,'tasks/T01'),{recursive:true});fs.mkdirSync(path.join(owner,'.gsd/forge'),{recursive:true});
      const roadmap=path.join(base,milestone+'-ROADMAP.md');fs.writeFileSync(roadmap,'# Roadmap\n- [ ] **S01: Existing task, newly planned slice** `risk:'+risk+'` `depends:[]`\n');
      const prefs={tier_models:Object.fromEntries(['light','standard','heavy','max'].map(t=>[t,['claude-opus-5-5']])),
        effort:{'plan-slice':'medium'},skip_discuss:true,skip_research:true,skip_slice_research:true};
      fs.writeFileSync(path.join(owner,'.gsd/forge-prefs.jsonc'),JSON.stringify(prefs));
      state.write(owner,{milestone,kind:'milestone',phase:'idle',active_slice:slice,active_task:'—',auto_mode:'on'});
      // A genuine preexisting task source is reused; this does NOT claim the
      // native artifacts receiver can publish NEW task-plan paths.
      const taskPlan=plan(contract),taskFile=path.join(sliceDir,'tasks/T01/T01-PLAN.md');fs.writeFileSync(taskFile,taskPlan);
      const returnedSlice=taskPlan+'\n# Slice S01\n- [ ] **T01** — Existing validated task\n';
      const route=resolveDispatch({cwd:owner,unitType:'plan-slice',unitId:slice,milestoneId:milestone,hostRuntime:'claude',roadmapPath:roadmap});
      assert.equal(route.dispatch_allowed,true,JSON.stringify({reason:route.dispatch_reason_code,prefs_ok:route.prefs_ok}));
      assert.equal(route.worker_mode,'native');assert.equal(route.model,'claude-opus-5-5');assert.equal(route.effort,effort);
      if(risk==='high')assert.equal(route.effort_reason,'risk-escalation:high');
      const capabilities={available:true,tool:'Agent',source:'synthetic-active-schema-fixture',model_aliases:['opus'],model_ids:['claude-opus-5-5'],
        effort_transports:['agent-argument'],reasoning_efforts:['low','medium','high','xhigh','max']};
      const options={hostRuntime:'claude',resolvedDispatch:route,activeCapabilities:capabilities,agentType:'forge-planner',prompt:'Synthetic fixture: return the existing task and new slice plan.'};
      // Compatibility precedes the actual controller lease; refusal is write-free.
      assert.equal(native.preflightNativeBinding(options).ok,true);
      const preferences={prefsReader:()=>({ok:true,prefs})};
      const selected=controller.select(owner,{milestone},preferences);assert(selected.unit,JSON.stringify(selected));assert.equal(selected.unit.type,'plan-slice');
      const begin=controller.beginSerial(owner,{milestone,unit:'plan-slice/S01',slice,host_runtime:'claude',session:'fixture346',owner_token:'fixture346-owner',idempotency_key:'begin346-'+risk},preferences);
      const request={unitType:'plan-slice',scope:'milestone',phase:'plan',milestoneId:milestone,sliceId:slice,cwd:code,contextRoot:owner,
        execution_contract:contract,hostRuntime:'claude',activeCapabilities:capabilities,route,workflowId:'fixture346',dispatchId:'native346-'+risk,
        resultFile:path.join(area,'result.json'),constraints:{auto_commit:false,deploy:false}};
      unit.beginArtifactAttempt(request);
      let calls=0;const returned={status:'done',summary:'Synthetic native plan',slice_plan:{filename:'S01-PLAN.md',content:returnedSlice},
        task_plans:[{id:'T01',filename:'T01-PLAN.md',content:taskPlan}]};
      assert.equal(xllm.validatePlanResult({...returned,task_plans:[{...returned.task_plans[0],filename:'../unsafe.md'}]}),false);
      const outcome=await native.invokeNative({...options,terminalResult:xllm.validatePlanResult},async args=>{
        calls++;assert.equal(args.model,route.model);assert.equal(args.effort,effort);return returned;
      });assert.equal(outcome.ok,true,JSON.stringify(outcome));assert.equal(calls,1);
      assert.equal(xllm.validatePlanResult(outcome.result),true);roots.validatePlan(outcome.result.task_plans[0].content,contract);
      assert.equal(fs.readFileSync(taskFile,'utf8'),outcome.result.task_plans[0].content);
      const artifactPath='.gsd/milestones/M001/slices/S01/S01-PLAN.md';
      const delivered=await unit.acceptArtifactResult(request,{status:'done',summary:outcome.result.summary,questions:[],
        artifacts:[{path:artifactPath,content:outcome.result.slice_plan.content}]},{providerCalled:true,telemetry:outcome.telemetry});
      assert.equal(delivered.record.phase,'ready');assert.equal(fs.readFileSync(path.join(owner,artifactPath),'utf8'),returnedSlice);
      assert.equal(delivered.record.route.model,route.model);assert.equal(delivered.record.telemetry.effort_argument,effort);
      const receipt=fs.readFileSync(request.resultFile+'.receipt.json');
      const completed=controller.complete(owner,{milestone,unit:'plan-slice/S01',slice,host_runtime:'claude',owner_token:begin.owner_token,generation:begin.generation,
        idempotency_key:'complete346-'+risk,result:{status:'succeeded',output:{result:delivered.result,
          publication_receipt:request.resultFile+'.receipt.json',receipt_sha256:crypto.createHash('sha256').update(receipt).digest('hex')}}},preferences);
      assert.equal(completed.ok,true);assert.equal(lease.observe(owner,'plan-slice/S01').lease,null);
      const resumed=controller.resume(owner,{idempotency_key:completed.transaction.idempotency_key},preferences);
      assert.equal(resumed.results[0].reason,'already-committed');assert.deepEqual(controller.pendingTransactions(owner),[]);
      assert.deepEqual(fs.readFileSync(request.resultFile+'.receipt.json'),receipt);
      const next=controller.select(owner,{milestone},preferences);assert.equal(next.unit.type,'execute-task');assert.equal(next.unit.id,'T01');
      console.log('PASS #346 '+risk+' slice -> '+effort+': native argument, validated returned plan, public S01 publication, controller complete/replay and next execution gate; existing task source reused, synthetic host only');serial++;
    }
    assert.equal(serial,2);
  } finally {
    for(const k of Object.keys(previous)){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}
    fs.rmSync(home,{recursive:true,force:true});
  }
}

async function claudeEffortEnvironmentAndResume346() {
  const caps={...claudeCapabilities,effort_transports:['agent-argument'],reasoning_efforts:['medium','max']};
  const options={hostRuntime:'claude',resolvedDispatch:dispatch('claude-opus-5-5','max','claude'),
    activeCapabilities:caps,agentType:'forge-planner',prompt:'Synthetic environment/resume fixture.'};
  const unknown=buildNativeInvocation(options);
  assert.equal(unknown.ok,true);assert(!unknown.diagnostics?.some(d=>d.code.startsWith('native-effort-environment-')));
  // No observation/diagnostic is not proof that the actual host variable is unset.
  assert.equal(unknown.telemetry.effort_argument,'max');assert.equal(unknown.telemetry.effort_applied,null);
  for(const override of [null,'max']) {
    const known=buildNativeInvocation({...options,activeCapabilities:{...caps,
      claude_effort_environment:{source:'synthetic-actual-host-environment',override}}});
    assert.equal(known.ok,true);assert(known.diagnostics.some(d=>d.code==='native-effort-environment-observed'&&d.override===override));
    assert.equal(known.telemetry.effort_applied,null,'matching/unset environment is not provider readback');
  }
  let calls=0;
  const conflictOptions={...options,activeCapabilities:{...caps,
    claude_effort_environment:{source:'synthetic-actual-host-environment',override:'medium'}}};
  const conflict=await invokeNative(conflictOptions,()=>{calls++;return{status:'done'};});
  assert.equal(conflict.reason_code,'native-effort-environment-conflict');assert.equal(conflict.provider_called,false);assert.equal(calls,0);
  const invalid=buildNativeInvocation({...options,activeCapabilities:{...caps,
    claude_effort_environment:{source:'synthetic-actual-host-environment',override:'unrecognized'}}});
  assert.equal(invalid.reason_code,'native-effort-environment-unverified');
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge346-native-resume-')));
  try {
    const matching={...options,activeCapabilities:{...caps,
      claude_effort_environment:{source:'synthetic-actual-host-environment',override:'max'}}};
    const lifecycle={journal:{root,file:path.join(root,'native.json'),authorize:()=>true}};
    const first=await invokeNative({...matching,lifecycle},args=>{calls++;assert.equal(args.effort,'max');throw Error('synthetic interrupted native host');});
    assert.equal(first.ok,false);assert.equal(calls,1);
    let resumes=0;
    lifecycle.adapter={capabilities:{resume:true},resume:()=>{resumes++;return{status:'done'};}};
    const refusedResume=await invokeNative({...conflictOptions,lifecycle},()=>assert.fail('must not launch'));
    assert.equal(refusedResume.reason_code,'native-effort-environment-conflict');assert.equal(resumes,0);
    const resumed=await invokeNative({...matching,lifecycle},()=>assert.fail('resume must not spawn another agent'));
    assert.equal(resumed.ok,true,JSON.stringify(resumed));assert.equal(resumes,1);assert.equal(calls,1);
    assert.equal(resumed.args.effort,'max');assert.equal(resumed.telemetry.effort_argument,'max');assert.equal(resumed.telemetry.effort_applied,null);
    console.log('PASS #346 Claude actual-host effort observation: unknown/observed-unset/matching/conflict, exact max argument and real journal resume API; synthetic host only, applied unknown');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}

async function claudeEnvironmentJournalIdentity346() {
  const supervision=require('./forge-native-supervision');
  const baseCaps={...claudeCapabilities,effort_transports:['agent-argument'],reasoning_efforts:['medium','max']};
  const cases=[
    [undefined,{source:'fresh-host',override:'max'}],
    [undefined,{source:'fresh-host',override:null}],
    [{source:'old-host-source',override:'max'},{source:'fresh-host-source',override:'max'}],
    [{source:'old-host-source',override:null},{source:'fresh-host-source',override:'max'}],
  ];
  const work=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge346-journal-id-')));
  const withEnvironment=(caps,observation)=>observation===undefined?caps:{...caps,claude_effort_environment:observation};
  try {
    for(const [i,[initial,fresh]]of cases.entries()) {
      // Actual request identity is immutable. Fresh observations belong to the
      // runtime invocation, not to a rewritten request or historical receipt.
      // This is a generic native-adapter telemetry identity, not a fabricated
      // milestone dispatch. No real Forge unit or controller is invoked here.
      const request={dispatchId:'synthetic-native-env-'+i,test_request_id:'immutable-adapter-fixture'};
      const originalRequest=JSON.stringify(request),file=path.join(work,'journal-'+i+'.json');
      const options={hostRuntime:'claude',resolvedDispatch:dispatch('claude-opus-5-5','max','claude'),
        activeCapabilities:withEnvironment(baseCaps,initial),agentType:'forge-planner',prompt:'Synthetic fixed native request.',telemetryIdentity:request};
      const lifecycle={journal:{root:work,file,authorize:()=>true}};let spawned=0,resumes=0;
      const first=await invokeNative({...options,lifecycle},args=>{spawned++;assert.equal(args.effort,'max');throw Error('synthetic interrupted host');});
      assert.equal(first.ok,false);assert.equal(spawned,1);
      const journal=JSON.parse(fs.readFileSync(file)),stable=JSON.parse(JSON.stringify(buildNativeInvocation(options)));
      if(stable.diagnostics){stable.diagnostics=stable.diagnostics.filter(d=>d.code!=='native-effort-environment-observed');if(!stable.diagnostics.length)delete stable.diagnostics;}
      assert.equal(journal.identity,supervision.digest(JSON.stringify({invocation:stable,identity:request})),'old/default identity and non-environment fields remain exact');
      lifecycle.adapter={capabilities:{resume:true},resume:()=>{resumes++;return{status:'done'};}};
      const beforeConflict=fs.readFileSync(file);
      const conflict=await invokeNative({...options,lifecycle,activeCapabilities:withEnvironment(baseCaps,{source:'fresh-host',override:'medium'})},()=>assert.fail('must not spawn'));
      assert.equal(conflict.reason_code,'native-effort-environment-conflict');assert.equal(conflict.provider_called,false);
      assert.equal(resumes,0);assert.equal(spawned,1);assert.deepEqual(fs.readFileSync(file),beforeConflict,'known conflict does not mutate/reuse journal');
      const changedEffort=await invokeNative({...options,lifecycle,resolvedDispatch:dispatch('claude-opus-5-5','medium','claude'),
        activeCapabilities:withEnvironment(baseCaps,{source:'fresh-host',override:'medium'})},()=>assert.fail('must not spawn'));
      assert.equal(changedEffort.reason_code,'native-journal-identity-or-clock');assert.equal(resumes,0,'argument/effort changes stay bound');
      const changedRequest=await invokeNative({...options,lifecycle,telemetryIdentity:{...request,dispatchId:request.dispatchId+'-changed'},
        activeCapabilities:withEnvironment(baseCaps,fresh)},()=>assert.fail('must not spawn'));
      assert.equal(changedRequest.reason_code,'native-journal-identity-or-clock');assert.equal(resumes,0,'request identity is never masked');
      const resumed=await invokeNative({...options,lifecycle,activeCapabilities:withEnvironment(baseCaps,fresh)},()=>assert.fail('must not respawn'));
      assert.equal(resumed.ok,true,JSON.stringify(resumed));assert.equal(resumes,1);assert.equal(spawned,1);
      assert.equal(resumed.args.effort,'max');assert.equal(resumed.telemetry.effort_argument,'max');assert.equal(resumed.telemetry.effort_applied,null);
      assert(resumed.diagnostics.some(d=>d.code==='native-effort-environment-observed'&&d.source===fresh.source&&d.override===fresh.override),'fresh observation remains in runtime result');
      assert.equal(JSON.stringify(request),originalRequest);
    }
    // Non-environment diagnostics are still inside the actual durable identity.
    const agent=agentFixture('forge-executor','medium');
    try {
      fs.appendFileSync(agent.filename,'');
      fs.writeFileSync(agent.filename,fs.readFileSync(agent.filename,'utf8').replace('effort: medium','effort: medium\nthinking: disabled'));
      const options={hostRuntime:'claude',resolvedDispatch:dispatch('claude-sonnet-5-5','medium','claude','sonnet'),
        activeCapabilities:{...claudeCapabilities,claude_effort_environment:{source:'host-environment',override:null}},agentType:'forge-executor',prompt:'fixture',
        effortBinding:{transport:'agent-frontmatter',agentPath:agent.filename,sourceFingerprint:'sha256:'+crypto.createHash('sha256').update(fs.readFileSync(agent.filename)).digest('hex')}};
      const original=buildNativeInvocation(options);assert(original.diagnostics.some(d=>d.code==='native-thinking-declaration-inert'));
      const file=path.join(work,'thinking.json');await invokeNative({...options,lifecycle:{journal:{root:work,file,authorize:()=>true}}},()=>{throw Error('synthetic interrupted host');});
      const stable={...original,diagnostics:original.diagnostics.filter(d=>d.code!=='native-effort-environment-observed')};
      assert.equal(JSON.parse(fs.readFileSync(file)).identity,supervision.digest(JSON.stringify({invocation:stable,identity:null})));
    }finally{fs.rmSync(agent.dir,{recursive:true,force:true});}
    console.log('PASS #346 stable journal identity: omitted->matching/unset, source refresh, unset->matching; fresh conflict zero calls, argument/request changes refused, other diagnostics bound; synthetic host only');
  } finally {fs.rmSync(work,{recursive:true,force:true});}
}
