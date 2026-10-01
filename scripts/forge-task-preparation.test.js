#!/usr/bin/env node
'use strict';

// Hermetic provider fixtures only. No account store, real provider, user prefs,
// installation or WDMA path is read by this suite.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-task-preparation-'));
const oldHome = process.env.HOME;
const oldUserProfile = process.env.USERPROFILE;
const isolatedHome = path.join(root, 'home');
fs.mkdirSync(isolatedHome);
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
const prep = require('./forge-task-preparation');
const unit = require('./forge-unit-sidecar');
const xllm = require('./forge-xllm');
const { resolveDispatch } = require('./forge-dispatch-resolve');
let sequence = 0;
let passed = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    process.stdout.write(`ok - ${name}\n`);
  }, error => {
    process.stderr.write(`not ok - ${name}\n${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

function fixture(options = {}) {
  const caseRoot = path.join(root, `case-${++sequence}`);
  const cwd = path.join(caseRoot, 'code');
  const contextRoot = path.join(caseRoot, 'owner');
  const results = path.join(caseRoot, 'results');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(contextRoot, '.gsd'), { recursive: true });
  fs.mkdirSync(results, { recursive: true });
  const model = options.model || 'claude-sonnet-5';
  const effort = options.effort || 'medium';
  fs.writeFileSync(path.join(contextRoot, '.gsd', 'forge-prefs.jsonc'), JSON.stringify({
    tier_models: { light: model, standard: model, heavy: model, max: model },
    effort: {
      'plan-slice': effort, 'discuss-milestone': effort,
      'research-milestone': effort, 'plan-milestone': effort,
    },
  }));
  const taskId = options.taskId || `T-20260928${String(sequence).padStart(6, '0')}-fixture`;
  return { schema_version: 1, scope: 'standalone-task', phase: options.phase || 'brainstorm',
    taskId, cwd, contextRoot, hostRuntime: options.hostRuntime || 'codex',
    workflowId: `workflow-${sequence}`, dispatchId: `dispatch-${sequence}`,
    resultFile: path.join(results, `result-${sequence}.json`),
    constraints: { auto_commit: false, deploy: false },
    inputs: { brief: `Fixture ${sequence}` },
  };
}

function artifactPath(request) {
  return path.join(request.contextRoot, prep.requiredArtifact(request).replace(/\//g, path.sep));
}

function content(phase, taskId) {
  if (phase === 'brainstorm') return '# Brainstorm\n\n## Recommended Approach\n\nUse one caller.\n\n## Alternatives Considered\n\nKeep resolver.\n\n## Top Risks\n\nRoute drift.\n\n## Out of Scope\n\nReal providers.\n';
  if (phase === 'discuss') return '# Context\n\n## Decisions\n\nUse receipts.\n\n## Open Questions\n\nNone.\n\n## Out of Scope\n\nInstall.\n';
  if (phase === 'research') return "# Research\n\n## Summary\n\nMeasured internally.\n\n## Don't Hand-Roll\n\nReuse resolver.\n\n## Relevant Code\n\nscripts/.\n";
  return `---\ntier: standard\neffort: medium\nwrites:\n  - scripts/x.js\n---\n\n# Plan\n\n## Steps\n\n1. Implement.\n\n## Must-Haves\n\n- The command passes.\n\n## Standards\n\n- Reuse existing helpers.\n\n## Files to Change\n\n- scripts/x.js — implementation.\n`;
}

function envelope(request, overrides = {}) {
  return { status: 'done', summary: `${request.phase} complete`, questions: [],
    artifacts: [{ path: prep.requiredArtifact(request), content: content(request.phase, request.taskId) }],
    ...overrides };
}

function framed(value, status = value.status) {
  return `---GSD-WORKER-RESULT---\nstatus: ${status}\nresult_json: ${JSON.stringify(value)}\n---END-RESULT---`;
}

function codexCapabilities() {
  return { available: true, tool: 'collaboration.spawn_agent', source: 'fixture-tool-schema',
    models: ['gpt-5.6-sol'], reasoning_efforts: ['medium', 'high'], fork_turns: ['none'] };
}

async function main() {
  await test('four phases use the actual caller, configured Claude sidecar and exact task-local formats', async () => {
    for (const phase of Object.keys(prep.PHASE_CONTRACTS)) {
      const request = fixture({ phase, hostRuntime: 'codex', model: 'claude-sonnet-5' });
      const phasePrompt = `UNIQUE-${phase}-PHASE-INSTRUCTIONS`;
      if (phase === 'research') {
        request.promptFile = path.join(request.contextRoot, 'research-prompt.md');
        fs.writeFileSync(request.promptFile, phasePrompt);
      } else request.prompt = phasePrompt;
      let calls = 0;
      const result = await prep.prepareStandaloneTask(request, { invokeSidecar: async delivery => {
        calls++;
        assert.equal(delivery.route.model_resolved, 'claude-sonnet-5');
        assert.equal(delivery.route.effort, 'medium');
        assert.equal(delivery.route.worker_mode, 'sidecar');
        assert.equal(delivery.route.unit_type, prep.PHASE_CONTRACTS[phase].unitType);
        assert(delivery.prompt.includes(phasePrompt));
        return envelope(request);
      } });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.transport, 'sidecar');
      assert.equal(calls, 1);
      assert.equal(fs.readFileSync(artifactPath(request), 'utf8'), content(phase, request.taskId));
      assert(!fs.existsSync(path.join(request.contextRoot, '.gsd', 'milestones')));
      const receipt = JSON.parse(fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8'));
      assert.equal(receipt.route_identity.model_resolved, 'claude-sonnet-5');
      assert.equal(receipt.route_identity.effort, 'medium');
      assert.equal(receipt.provider_called, true);
    }
  });

  await test('production Codex sidecar receives the complete prompt and persists continuation dispatch identity', async () => {
    const request = fixture({ phase: 'discuss', hostRuntime: 'claude', model: 'gpt-5.6-sol' });
    request.prompt = 'UNIQUE-PRODUCTION-SIDECAR-PROMPT';
    const partial = { status: 'partial', summary: 'Need a choice', questions: ['Choose the source'], artifacts: [] };
    const original = xllm.invokeCodexAppServer;
    const identityLines = [];
    const announce = require('./forge-sidecar-identity').createAnnouncer({ write: line => identityLines.push(line) });
    let calls = 0;
    xllm.invokeCodexAppServer = async options => {
      calls++;
      assert(options.prompt.includes(request.prompt));
      assert.equal(options.sandbox, 'read-only');
      options.onHeartbeat(43210);
      return { finalText: JSON.stringify(calls === 1 ? partial : envelope(request)) };
    };
    try {
      const first = await prep.prepareStandaloneTask(request, { announce });
      assert.equal(first.status, 'partial', JSON.stringify(first));
      assert.equal(first.provider_called, true);
      assert.deepStrictEqual(identityLines.map(line => line.match(/^\[forge-sidecar\] (\w+)/)[1]), ['solicitado', 'iniciado']);
      assert(identityLines.every(line => line.includes('fase=discuss')));
      assert(identityLines[1].includes('pid=43210'));
      assert(!identityLines.join('').includes(request.prompt));
      const receipt = JSON.parse(fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8'));
      assert.equal(receipt.dispatch_id, request.dispatchId);
      assert.equal(receipt.provider_called, true);
      const firstEvents = fs.readFileSync(path.join(request.contextRoot, '.gsd', 'forge', 'events.jsonl'), 'utf8')
        .trim().split(/\r?\n/).map(line => JSON.parse(line));
      assert.equal(firstEvents.filter(event => event.event === 'sidecar-unit').at(-1).provider_called, true);
      const continuation = { ...request, prompt: 'UNIQUE-PRODUCTION-SIDECAR-PROMPT-CONTINUED',
        dispatchId: `${request.dispatchId}-continued`, resultFile: request.resultFile.replace('.json', '-continued.json'),
        continuation: { from_dispatch_id: request.dispatchId, result_file: request.resultFile,
          answers: ['Use the checked-in source.'] } };
      const second = await prep.prepareStandaloneTask(continuation);
      assert.equal(second.ok, true, JSON.stringify(second));
      assert.equal(calls, 2);
    } finally { xllm.invokeCodexAppServer = original; }
  });

  await test('GPT configured on Claude selects Codex sidecar without changing identity', async () => {
    const request = fixture({ phase: 'research', hostRuntime: 'claude', model: 'gpt-5.6-sol' });
    const result = await prep.prepareStandaloneTask(request, { invokeSidecar: async delivery => {
      assert.equal(delivery.route.resolved_worker_engine, 'codex');
      assert.equal(delivery.route.worker_mode, 'sidecar');
      assert.equal(delivery.route.model_resolved, 'gpt-5.6-sol');
      return envelope(request);
    } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.route.model_requested, 'gpt-5.6-sol');
  });

  await test('Codex native start, framed accept and ready replay resolve once and invoke once', async () => {
    const request = fixture({ phase: 'brainstorm', hostRuntime: 'codex', model: 'gpt-5.6-sol' });
    request.activeCapabilities = codexCapabilities();
    let resolverCalls = 0;
    const started = await prep.startStandaloneTaskPreparation(request, {
      resolveDispatch: options => { resolverCalls++; return resolveDispatch(options); },
    });
    assert.equal(started.action, 'invoke-native', JSON.stringify(started));
    assert.equal(started.invocation.args.model, 'gpt-5.6-sol');
    assert.equal(started.invocation.args.reasoning_effort, 'medium');
    const accepted = await prep.acceptStandaloneTaskPreparation(request, {
      route: started.route, rawResult: framed(envelope(request)),
      invocationTelemetry: started.invocation.telemetry, providerCalled: true,
    });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.equal(resolverCalls, 1);
    const replay = await prep.startStandaloneTaskPreparation(request, {
      resolveDispatch: () => { throw Error('ready replay must not resolve'); },
    });
    assert.equal(replay.replayed, true, JSON.stringify(replay));
    assert.equal(replay.provider_called, false);
    assert.equal(resolverCalls, 1);
  });

  await test('Codex native names are distinct per dispatch, stable per attempt and keep model/effort', async () => {
    const nativeApi = require('./forge-native-invocation');
    const base = fixture({ phase: 'research', hostRuntime: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
    base.activeCapabilities = codexCapabilities();
    // Distinct dispatch ids whose sanitized text is identical.
    const ids = ['attempt-Retry-1', 'attempt_retry_1', 'attempt.retry.1'];
    assert.equal(new Set(ids.map(id => nativeApi.codexTaskName(id))).size, 1);
    const requests = ids.map((dispatchId, index) => ({ ...base, dispatchId,
      resultFile: path.join(path.dirname(base.resultFile), `attempt-${index}.json`) }));
    // Codex keeps a completed agent registered and refuses a reused name before the provider.
    function spawnRegistry() {
      const names = new Set();
      return name => {
        if (names.has(name)) throw Object.assign(Error(`agent name already exists: ${name}`), { code: 'agent-name-exists' });
        names.add(name);
      };
    }
    const spawn = spawnRegistry();
    const spawned = [];
    for (const request of requests) {
      const result = await prep.prepareStandaloneTask(request, { invokeNative: async args => {
        spawn(args.task_name);
        spawned.push(args);
        return framed(envelope(request));
      } });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.transport, 'native');
      assert.equal(result.route.model_resolved, 'gpt-5.6-sol');
      assert.equal(result.route.effort, 'high');
    }
    assert.equal(spawned.length, 3);
    assert.equal(new Set(spawned.map(args => args.task_name)).size, 3);
    const readable = `${nativeApi.codexTaskName(`preparation_research_${base.taskId}`)}_`;
    const unnamed = args => { const rest = { ...args }; delete rest.task_name; return rest; };
    for (const args of spawned) {
      assert(args.task_name.startsWith(readable), args.task_name);
      assert.match(args.task_name, /_[0-9a-f]{16}$/);
      assert.deepEqual(unnamed(args), unnamed(spawned[0]));
      assert.equal(args.model, 'gpt-5.6-sol');
      assert.equal(args.reasoning_effort, 'high');
      assert.equal(args.agent_type, 'forge-researcher');
      assert.equal(args.fork_turns, 'none');
    }

    // The legacy phase/task name collides on the second dispatch through the same adapter.
    const route = JSON.parse(fs.readFileSync(`${requests[0].resultFile}.receipt.json`, 'utf8')).route;
    const legacySpawn = spawnRegistry();
    const legacy = requests.slice(0, 2).map(request => nativeApi.buildNativeInvocation({
      ...prep.nativeOptions(request, route, prep.buildPreparationPrompt(request)),
      taskName: `preparation_${request.phase}_${request.taskId}` }).args.task_name);
    assert.equal(legacy[0], legacy[1]);
    legacySpawn(legacy[0]);
    assert.throws(() => legacySpawn(legacy[1]), error => error.code === 'agent-name-exists');

    // The same dispatch always derives the same name, including from a fresh copy.
    for (const [index, request] of requests.entries()) {
      for (const copy of [request, JSON.parse(JSON.stringify(request))]) {
        const again = nativeApi.buildNativeInvocation(prep.nativeOptions(copy, route, prep.buildPreparationPrompt(copy)));
        assert.equal(again.ok, true);
        assert.equal(again.args.task_name, spawned[index].task_name);
        assert.equal(again.args.model, 'gpt-5.6-sol');
        assert.equal(again.args.reasoning_effort, 'high');
      }
    }

    // Accepted replay of every dispatch spawns no agent and never re-resolves.
    for (const request of requests) {
      const replay = await prep.prepareStandaloneTask(request, {
        resolveDispatch: () => { throw Error('ready replay must not resolve'); },
        invokeNative: async () => { throw Error('ready replay must not spawn'); },
      });
      assert.equal(replay.replayed, true, JSON.stringify(replay));
      assert.equal(replay.provider_called, false);
      assert.equal(replay.route.model_resolved, 'gpt-5.6-sol');
      assert.equal(replay.route.effort, 'high');
    }
    assert.equal(spawned.length, 3);
    assert.equal(fs.readFileSync(artifactPath(base), 'utf8'), content('research', base.taskId));
  });

  await test('Claude native uses observed frontmatter effort and the same acceptance boundary', async () => {
    const request = fixture({ phase: 'discuss', hostRuntime: 'claude', model: 'claude-sonnet-5' });
    const agent = path.join(path.dirname(request.resultFile), 'forge-discusser.md');
    fs.writeFileSync(agent, '---\nname: forge-discusser\neffort: medium\n---\n');
    request.activeCapabilities = { available: true, tool: 'Agent', source: 'fixture-tool-schema',
      model_aliases: ['sonnet'], effort_transports: ['agent-frontmatter'] };
    request.effortBinding = { transport: 'agent-frontmatter', agentPath: agent,
      sourceFingerprint: `sha256:${crypto.createHash('sha256').update(fs.readFileSync(agent)).digest('hex')}` };
    let calls = 0;
    const result = await prep.prepareStandaloneTask(request, { invokeNative: async args => {
      calls++;
      assert.equal(args.model, 'sonnet');
      assert.equal(args.subagent_type, 'forge-discusser');
      return framed(envelope(request));
    } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.transport, 'native');
    assert.equal(calls, 1);
  });

  await test('canonical, sequential and dashed timestamp task IDs publish without a milestone', async () => {
    for (const taskId of ['T-20260928151522-canonical', 'TASK-007', 'TASK-20260928-104227']) {
      const request = fixture({ phase: 'discuss', taskId });
      const result = await prep.prepareStandaloneTask(request, { invokeSidecar: async () => envelope(request) });
      assert.equal(result.ok, true, `${taskId}: ${JSON.stringify(result)}`);
      assert(fs.existsSync(artifactPath(request)));
    }
  });

  await test('partial questions publish nothing and explicit continuation uses a new fingerprint and prompt', async () => {
    const request = fixture({ phase: 'discuss' });
    const partial = { status: 'partial', summary: 'Need a decision',
      questions: ['Which source is authoritative?'], artifacts: [] };
    const first = await prep.prepareStandaloneTask(request, { invokeSidecar: async () => partial });
    assert.equal(first.status, 'partial');
    assert.deepEqual(first.result.questions, partial.questions);
    assert(!fs.existsSync(artifactPath(request)));
    const continuation = { ...request, dispatchId: `${request.dispatchId}-answer`,
      resultFile: request.resultFile.replace('.json', '-answer.json'),
      continuation: { from_dispatch_id: request.dispatchId, result_file: request.resultFile,
        answers: ['The checked-in schema is authoritative.'] } };
    let prompt = '';
    const resumed = await prep.prepareStandaloneTask(continuation, { invokeSidecar: async delivery => {
      prompt = delivery.prompt;
      return envelope(continuation);
    } });
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert(prompt.includes('The checked-in schema is authoritative.'));
    fs.unlinkSync(`${request.resultFile}.receipt.json`);
    fs.unlinkSync(request.resultFile);
    const replay = await prep.startStandaloneTaskPreparation(continuation, {
      resolveDispatch: () => { throw Error('completed continuation replay must not resolve'); },
    });
    assert.equal(replay.replayed, true, JSON.stringify(replay));
  });

  await test('continuations require a matching pending receipt and exact question answers', async () => {
    const prior = fixture({ phase: 'discuss' });
    const partial = { status: 'partial', summary: 'Need a decision', questions: ['One?'], artifacts: [] };
    await prep.prepareStandaloneTask(prior, { invokeSidecar: async () => partial });
    function continuation(overrides = {}) {
      return { ...prior, dispatchId: `${prior.dispatchId}-${++sequence}`,
        resultFile: path.join(path.dirname(prior.resultFile), `continued-${sequence}.json`),
        continuation: { from_dispatch_id: prior.dispatchId, result_file: prior.resultFile, answers: ['Answer'] },
        ...overrides };
    }
    const forged = [
      continuation({ continuation: { from_dispatch_id: 'missing',
        result_file: path.join(path.dirname(prior.resultFile), 'missing.json'), answers: ['Answer'] } }),
      continuation({ taskId: `T-20260928151522-wrong-${sequence}` }),
      continuation({ phase: 'research' }),
      continuation({ dispatchId: prior.dispatchId }),
    ];
    let calls = 0;
    for (const request of forged) {
      const result = await prep.prepareStandaloneTask(request, { invokeSidecar: async () => { calls++; return envelope(request); } });
      assert.equal(result.ok, false);
      assert.equal(result.provider_called, false);
    }
    const completed = fixture({ phase: 'discuss' });
    await prep.prepareStandaloneTask(completed, { invokeSidecar: async () => envelope(completed) });
    const afterDone = { ...completed, dispatchId: `${completed.dispatchId}-continued`,
      resultFile: completed.resultFile.replace('.json', '-continued.json'),
      continuation: { from_dispatch_id: completed.dispatchId, result_file: completed.resultFile, answers: ['Answer'] } };
    const refused = await prep.prepareStandaloneTask(afterDone, { invokeSidecar: async () => { calls++; return envelope(afterDone); } });
    assert.equal(refused.reason_code, 'preparation-continuation-not-pending');
    assert.equal(calls, 0);
  });

  await test('changed continuation under the same dispatch conflicts without provider work', async () => {
    const request = fixture({ phase: 'discuss' });
    let calls = 0;
    await prep.prepareStandaloneTask(request, { invokeSidecar: async () => { calls++; return envelope(request); } });
    const changed = { ...request, inputs: { brief: 'changed under same dispatch' } };
    const result = await prep.prepareStandaloneTask(changed, { invokeSidecar: async () => { calls++; return envelope(changed); } });
    assert.equal(result.reason_code, 'dispatch-identity-conflict');
    assert.equal(calls, 1);
  });

  await test('native direct write before accept is refused even when bytes equal the returned artifact', async () => {
    const request = fixture({ phase: 'brainstorm', model: 'gpt-5.6-sol' });
    request.activeCapabilities = codexCapabilities();
    fs.mkdirSync(path.dirname(artifactPath(request)), { recursive: true });
    fs.writeFileSync(artifactPath(request), content(request.phase, request.taskId));
    const started = await prep.startStandaloneTaskPreparation(request);
    fs.writeFileSync(artifactPath(request), content(request.phase, request.taskId));
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(artifactPath(request), future, future);
    const result = await prep.acceptStandaloneTaskPreparation(request, {
      route: started.route, rawResult: framed(envelope(request)),
      invocationTelemetry: started.invocation.telemetry, providerCalled: true,
    });
    assert.equal(result.reason_code, 'artifact-direct-write-detected');
    assert.equal(JSON.parse(fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8')).phase, 'failed');
  });

  await test('native writes to bounded Forge control files are refused without claiming a source sandbox', async () => {
    const request = fixture({ phase: 'research', model: 'gpt-5.6-sol' });
    request.activeCapabilities = codexCapabilities();
    const state = path.join(request.contextRoot, '.gsd', 'STATE.md');
    fs.writeFileSync(state, '# Before\n');
    const started = await prep.startStandaloneTaskPreparation(request);
    fs.writeFileSync(state, '# Written by native worker\n');
    const result = await prep.acceptStandaloneTaskPreparation(request, {
      route: started.route, rawResult: framed(envelope(request)),
      invocationTelemetry: started.invocation.telemetry, providerCalled: true,
    });
    assert.equal(result.reason_code, 'artifact-direct-write-detected');

    const grouped = fixture({ phase: 'research', model: 'gpt-5.6-sol' });
    grouped.activeCapabilities = codexCapabilities();
    const container = path.join(grouped.contextRoot, '.gsd', 'milestones', 'epoch.md');
    fs.mkdirSync(path.dirname(container), { recursive: true });
    fs.writeFileSync(container, '# Grouped milestone bytes\n');
    const groupedStart = await prep.startStandaloneTaskPreparation(grouped);
    fs.writeFileSync(container, '# Modified grouped milestone bytes\n');
    const groupedResult = await prep.acceptStandaloneTaskPreparation(grouped, {
      route: groupedStart.route, rawResult: framed(envelope(grouped)),
      invocationTelemetry: groupedStart.invocation.telemetry, providerCalled: true,
    });
    assert.equal(groupedResult.reason_code, 'artifact-direct-write-detected');
  });

  await test('wrong phase formats, non-done artifacts and malformed final native frames are refused', async () => {
    const wrong = fixture({ phase: 'brainstorm' });
    const wrongEnvelope = envelope(wrong);
    wrongEnvelope.artifacts[0].content = content('plan', wrong.taskId);
    assert.equal((await prep.prepareStandaloneTask(wrong, { invokeSidecar: async () => wrongEnvelope })).ok, false);

    const emptySection = fixture({ phase: 'research' });
    const emptyEnvelope = envelope(emptySection);
    emptyEnvelope.artifacts[0].content = "# Research\n\n## Summary\n\n## Don't Hand-Roll\n\nReuse resolver.\n\n## Relevant Code\n\nscripts/.\n";
    assert.equal((await prep.prepareStandaloneTask(emptySection, { invokeSidecar: async () => emptyEnvelope })).ok, false);

    for (const mutate of [
      value => value.replace('tier: standard', 'tier: banana'),
      value => value.replace('effort: medium', 'effort: banana'),
      value => value.replace('effort: medium', 'effort: medium\neffort: high'),
      value => `${value}\n## Deferred\n\nLater.\n`,
    ]) {
      const invalidPlan = fixture({ phase: 'plan' });
      const invalidEnvelope = envelope(invalidPlan);
      invalidEnvelope.artifacts[0].content = mutate(invalidEnvelope.artifacts[0].content);
      assert.equal((await prep.prepareStandaloneTask(invalidPlan,
        { invokeSidecar: async () => invalidEnvelope })).ok, false);
    }

    const nonDone = fixture({ phase: 'research' });
    const poisoned = envelope(nonDone, { status: 'partial', questions: ['Need input'] });
    assert.equal((await prep.prepareStandaloneTask(nonDone, { invokeSidecar: async () => poisoned })).ok, false);

    const native = fixture({ phase: 'brainstorm', model: 'gpt-5.6-sol' });
    native.activeCapabilities = codexCapabilities();
    const started = await prep.startStandaloneTaskPreparation(native);
    const malformed = `${framed(envelope(native))}\n---GSD-WORKER-RESULT---\nstatus: done`;
    const rejected = await prep.acceptStandaloneTaskPreparation(native, { route: started.route,
      rawResult: malformed, invocationTelemetry: started.invocation.telemetry, providerCalled: true });
    assert.equal(rejected.ok, false);
    assert.notEqual(rejected.reason_code, 'preparation-published');
  });

  await test('invalid scope, IDs, capability and symlink targets fail before a provider call', async () => {
    for (const mutate of [
      request => { request.scope = 'milestone'; },
      request => { request.taskId = '../escape'; },
      request => { request.phase = 'unknown'; },
    ]) {
      const request = fixture(); mutate(request);
      let calls = 0;
      const result = await prep.prepareStandaloneTask(request, { invokeSidecar: async () => { calls++; return envelope(request); } });
      assert.equal(result.provider_called, false);
      assert.equal(calls, 0);
    }
    const unsupported = fixture();
    const result = await prep.prepareStandaloneTask(unsupported, { resolveDispatch: options => ({
      ...resolveDispatch(options), resolved_worker_engine: 'agy', worker_mode: 'sidecar', sidecar_declared: true,
    }), invokeSidecar: async () => { throw Error('must not call'); } });
    assert.equal(result.reason_code, 'unsupported-sidecar-unit');
    assert.equal(result.provider_called, false);

    const linked = fixture();
    const taskRoot = path.join(linked.contextRoot, '.gsd', 'tasks');
    fs.mkdirSync(taskRoot, { recursive: true });
    fs.symlinkSync(path.dirname(linked.resultFile), path.join(taskRoot, linked.taskId), process.platform === 'win32' ? 'junction' : 'dir');
    let calls = 0;
    const linkedResult = await prep.prepareStandaloneTask(linked, { invokeSidecar: async () => { calls++; return envelope(linked); } });
    assert.equal(linkedResult.ok, false);
    assert.equal(calls, 0);
  });

  await test('duplicate, extra, oversized and secret-bearing results never publish', async () => {
    const cases = [
      request => { const value = envelope(request); value.artifacts.push(value.artifacts[0]); return value; },
      request => { const value = envelope(request); value.artifacts.push({ path: '.gsd/STATE.md', content: '# poison' }); return value; },
      request => envelope(request, { summary: 'x'.repeat(unit.MAX_ARTIFACT_PAYLOAD_BYTES + 1) }),
      request => envelope(request, { summary: 'x'.repeat(64 * 1024 + 1) }),
      request => ({ status: 'partial', summary: 'Need input', questions: ['x'.repeat(16 * 1024 + 1)], artifacts: [] }),
      request => envelope(request, { summary: 'credential=fixture-secret-never-persist' }),
    ];
    for (const make of cases) {
      const request = fixture({ phase: 'research' });
      const result = await prep.prepareStandaloneTask(request, { invokeSidecar: async () => make(request) });
      assert.equal(result.ok, false);
      assert(!fs.existsSync(artifactPath(request)));
      const durable = fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8');
      assert(!durable.includes('fixture-secret-never-persist'));
    }
  });

  await test('provider failures remain distinct from preflight refusal and record provider_called', async () => {
    const preflight = fixture({ phase: 'brainstorm', model: 'gpt-5.6-sol' });
    preflight.activeCapabilities = { ...codexCapabilities(), models: [] };
    const refused = await prep.prepareStandaloneTask(preflight, { invokeNative: async () => { throw Error('not called'); } });
    assert.equal(refused.reason_code, 'native-model-unsupported');
    assert.equal(refused.provider_called, false);

    const provider = fixture({ phase: 'brainstorm', model: 'gpt-5.6-sol' });
    provider.activeCapabilities = codexCapabilities();
    const failed = await prep.prepareStandaloneTask(provider, { invokeNative: async () => { throw Error('fixture secret'); } });
    assert.equal(failed.reason_code, 'native-invocation-failed');
    assert.equal(failed.provider_called, true);
    const durable = fs.readFileSync(`${provider.resultFile}.receipt.json`, 'utf8');
    assert(!durable.includes('fixture secret'));

    const sidecar = fixture({ phase: 'research', model: 'claude-sonnet-5' });
    let sidecarCalls = 0;
    const first = await prep.prepareStandaloneTask(sidecar, { invokeSidecar: async () => {
      sidecarCalls++;
      throw Error('fixture injected provider failure');
    } });
    assert.equal(first.provider_called, true);
    const receiptBytes = fs.readFileSync(`${sidecar.resultFile}.receipt.json`, 'utf8');
    const replay = await prep.prepareStandaloneTask(sidecar, { invokeSidecar: async () => {
      sidecarCalls++;
      throw Error('must not call failed injected provider again');
    } });
    assert.equal(replay.replayed, true);
    assert.equal(replay.provider_called, false);
    assert.equal(replay.original_provider_called, true);
    assert.equal(sidecarCalls, 1);
    assert.equal(fs.readFileSync(`${sidecar.resultFile}.receipt.json`, 'utf8'), receiptBytes);
  });

  await test('production sidecar pre-spawn route refusal records provider_called false', async () => {
    const request = fixture({ phase: 'research', hostRuntime: 'codex', model: 'claude-sonnet-5' });
    const identityLines = [];
    const announce = require('./forge-sidecar-identity').createAnnouncer({ write: line => identityLines.push(line) });
    const result = await prep.prepareStandaloneTask(request, { announce, resolveDispatch: options => {
      const route = resolveDispatch(options);
      return { ...route, model: 'gpt-5.6-sol', model_requested: 'gpt-5.6-sol',
        model_resolved: 'gpt-5.6-sol', sidecar_model: 'gpt-5.6-sol' };
    } });
    assert.equal(result.reason_code, 'route-model-engine-mismatch');
    assert.equal(result.provider_called, false);
    assert.equal(identityLines.length, 1);
    assert.match(identityLines[0], /^\[forge-sidecar\] recusado fase=research /);
    assert(identityLines[0].includes('modelo_enviado=-'));
    assert(identityLines[0].includes('provider_called=false'));
    assert.equal(result.diagnostic.stage, 'transport');
    const receipt = JSON.parse(fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8'));
    assert.equal(receipt.failure.provider_called, false);
    const receiptBytes = fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8');
    let replayResolutions = 0;
    const replay = await prep.prepareStandaloneTask(request, { resolveDispatch: () => {
      replayResolutions++;
      throw Error('failed replay must not resolve');
    } });
    assert.equal(replay.replayed, true);
    assert.equal(replay.provider_called, false);
    assert.equal(replay.original_provider_called, false);
    assert.equal(replayResolutions, 0);
    assert.equal(fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8'), receiptBytes);
  });

  await test('production sidecar post-spawn failure records provider_called true in result, receipt and event', async () => {
    const request = fixture({ phase: 'research', hostRuntime: 'claude', model: 'gpt-5.6-sol' });
    const original = xllm.invokeCodexAppServer;
    let providerInvocations = 0;
    const identityLines = [];
    const announce = require('./forge-sidecar-identity').createAnnouncer({ write: line => identityLines.push(line) });
    xllm.invokeCodexAppServer = async options => {
      providerInvocations++;
      options.onHeartbeat(43211);
      const error = new Error('fixture provider exit');
      error.code = 'provider-exit';
      throw error;
    };
    try {
      const result = await prep.prepareStandaloneTask(request, { announce });
      assert.equal(result.reason_code, 'provider-exit');
      assert.equal(result.provider_called, true);
      assert.deepStrictEqual(identityLines.map(line => line.match(/^\[forge-sidecar\] (\w+)/)[1]), ['solicitado', 'iniciado', 'falhou']);
      assert(identityLines.every(line => line.includes('fase=research')));
      assert(identityLines[2].includes('causa=provider-exit provider_called=true'));
      const receipt = JSON.parse(fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8'));
      assert.equal(receipt.failure.provider_called, true);
      const events = fs.readFileSync(path.join(request.contextRoot, '.gsd', 'forge', 'events.jsonl'), 'utf8')
        .trim().split(/\r?\n/).map(line => JSON.parse(line));
      assert.equal(events.filter(event => event.event === 'sidecar-unit').at(-1).provider_called, true);
      const receiptBytes = fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8');
      const replayLines = [];
      const replay = await prep.prepareStandaloneTask(request, { announce: require('./forge-sidecar-identity')
        .createAnnouncer({ write: line => replayLines.push(line) }) });
      assert.equal(replay.replayed, true);
      assert.equal(replay.provider_called, false);
      assert.equal(replay.original_provider_called, true);
      assert.equal(replayLines.length, 1);
      assert.match(replayLines[0], /^\[forge-sidecar\] reaproveitado /);
      assert.equal(providerInvocations, 1);
      assert.equal(fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8'), receiptBytes);
    } finally { xllm.invokeCodexAppServer = original; }
  });

  await test('production sidecar separates output validation from publication conflict', async () => {
    const original = xllm.invokeCodexAppServer;
    const invalid = fixture({ phase: 'research', hostRuntime: 'claude', model: 'gpt-5.6-sol' });
    xllm.invokeCodexAppServer = async options => {
      options.onHeartbeat(43212);
      return { finalText: JSON.stringify({ status: 'done', summary: 'Incomplete', questions: [], artifacts: [] }) };
    };
    try {
      const result = await prep.prepareStandaloneTask(invalid);
      assert.equal(result.diagnostic.stage, 'validation');
      assert.equal(result.provider_called, true);
    } finally { xllm.invokeCodexAppServer = original; }

    const conflict = fixture({ phase: 'research', hostRuntime: 'claude', model: 'gpt-5.6-sol' });
    xllm.invokeCodexAppServer = async options => {
      options.onHeartbeat(43213);
      fs.mkdirSync(path.dirname(artifactPath(conflict)), { recursive: true });
      fs.writeFileSync(artifactPath(conflict), '# concurrent owner content\n');
      return { finalText: JSON.stringify(envelope(conflict)) };
    };
    try {
      const result = await prep.prepareStandaloneTask(conflict);
      assert.equal(result.diagnostic.stage, 'publication');
      assert.equal(result.provider_called, true);
      assert.equal(JSON.parse(fs.readFileSync(`${conflict.resultFile}.receipt.json`, 'utf8')).phase, 'ready');
    } finally { xllm.invokeCodexAppServer = original; }
  });

  await test('explicit native failure closes the started attempt without result parsing', async () => {
    const request = fixture({ phase: 'brainstorm', model: 'gpt-5.6-sol' });
    request.activeCapabilities = codexCapabilities();
    const started = await prep.startStandaloneTaskPreparation(request);
    const result = await prep.acceptStandaloneTaskPreparation(request, { route: started.route,
      nativeFailure: { reason_code: 'native-host-refused', provider_called: false } });
    assert.equal(result.reason_code, 'native-host-refused');
    assert.equal(result.provider_called, false);
    assert.equal(JSON.parse(fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8')).phase, 'failed');

    const called = fixture({ phase: 'brainstorm', model: 'gpt-5.6-sol' });
    called.activeCapabilities = codexCapabilities();
    const calledStart = await prep.startStandaloneTaskPreparation(called);
    const invalidTelemetry = await prep.acceptStandaloneTaskPreparation(called, { route: calledStart.route,
      nativeFailure: { reason_code: 'native-provider-failed', provider_called: true } });
    assert.equal(invalidTelemetry.reason_code, 'native-preparation-telemetry-invalid');
    assert.equal(invalidTelemetry.provider_called, true);
    const calledReceipt = JSON.parse(fs.readFileSync(`${called.resultFile}.receipt.json`, 'utf8'));
    assert.equal(calledReceipt.failure.provider_called, true);
  });
}

main().finally(() => {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldUserProfile;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  if (!process.exitCode) process.stdout.write(`\n${passed} passed, 0 failed\n`);
});
