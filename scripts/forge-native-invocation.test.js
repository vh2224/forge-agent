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
  invokeNative,
} = require('./forge-native-invocation.js');

const codexCapabilities = Object.freeze({
  available: true,
  tool: 'spawn_agent',
  source: 'test-active-tool',
  models: ['gpt-6-luna', 'gpt-6-sol'],
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

  for (const model of ['gpt-6-luna', 'gpt-6-sol']) {
    const built = buildNativeInvocation({
      hostRuntime: 'codex',
      resolvedDispatch: dispatch(model, 'medium', 'codex'),
      activeCapabilities: codexCapabilities,
      taskName: `Memory-${model}/Dispatch-ABC`,
      agentType: 'forge-memory',
      prompt: 'Return the bounded memory extraction envelope.',
    });
    assert.strictEqual(built.ok, true, JSON.stringify(built));
    assert.strictEqual(built.args.model, model);
    assert.strictEqual(built.args.reasoning_effort, 'medium');
    assert.strictEqual(built.args.fork_turns, 'none');
    assert.strictEqual(built.args.task_name, `memory_${model.replace(/-/g, '_')}_dispatch_abc`);
    assert.match(built.args.task_name, /^[a-z0-9_]+$/);
    assert.strictEqual(built.telemetry.model_argument, model);
    assert.strictEqual(built.telemetry.model_observed, null);
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

  process.stdout.write('forge-native-invocation: ok\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
