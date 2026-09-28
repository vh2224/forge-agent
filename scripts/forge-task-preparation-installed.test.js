#!/usr/bin/env node
'use strict';

// Installed vertical regression. Every home, preference file, account and
// provider is a temporary fixture. The installed resolver, preparation caller,
// unit-sidecar guards, receipts and publishers remain production code.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const installer = require('./forge-installer');

const sourceRoot = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-preparation-installed-'));
const forgeHome = path.join(root, 'forge-home');
const claudeHome = path.join(root, 'claude-home');
const codexHome = path.join(root, 'codex-home');
const projectionRoot = path.join(root, 'projection-project');
let passed = 0;

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
}

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    process.stdout.write(`ok - ${name}\n`);
  }, error => {
    process.exitCode = 1;
    process.stderr.write(`not ok - ${name}\n${error.stack || error}\n`);
  });
}

function phaseContent(phase, taskId) {
  if (phase === 'brainstorm') return '# Brainstorm\n\n## Recommended Approach\n\nKeep one caller.\n\n## Alternatives Considered\n\nReuse the resolver.\n\n## Top Risks\n\nProjection drift.\n\n## Out of Scope\n\nReal providers.\n';
  if (phase === 'discuss') return '# Context\n\n## Decisions\n\nPreserve the configured route.\n\n## Open Questions\n\nNone.\n\n## Out of Scope\n\nChanging preferences.\n';
  if (phase === 'research') return "# Research\n\n## Summary\n\nThe installed path was exercised.\n\n## Don't Hand-Roll\n\nUse the resolver.\n\n## Relevant Code\n\nscripts/forge-task-preparation.js\n";
  return `---\ntier: max\neffort: high\nwrites: []\n---\n\n# Plan\n\n## Steps\n\n1. Exercise the installed caller.\n\n## Must-Haves\n\n- Installed caller delivers the task artifact.\n\n## Standards\n\n- Preserve the resolved route.\n\n## Files to Change\n\n- None; this is a fixture.\n`;
}

function configuredPrefs(model, unitType) {
  return {
    tier_models: { light: model, standard: model, heavy: model, max: model },
    routing: { default: { planner: {
      light: [model], standard: [model], heavy: [model], max: [model], fallback: model,
    } } },
    effort: { [unitType]: 'high' },
  };
}

function workspace(label, model, unitType) {
  const cwd = path.join(root, `workspace-${label}`);
  fs.mkdirSync(cwd, { recursive: true });
  write(path.join(cwd, '.gsd', 'forge-prefs.jsonc'), configuredPrefs(model, unitType));
  return cwd;
}

function requestFor(prep, projection, { label, phase, taskId, model, dispatchId, prompt, continuation,
  activeCapabilities, effortBinding, existingCwd, workflowId, resultFile }) {
  const contract = prep.PHASE_CONTRACTS[phase];
  const cwd = existingCwd || workspace(label, model, contract.unitType);
  const taskRoot = path.join(cwd, '.gsd', 'tasks', taskId);
  const resultRoot = path.join(root, 'results', label);
  fs.mkdirSync(taskRoot, { recursive: true });
  fs.mkdirSync(resultRoot, { recursive: true });
  const effectiveDispatch = dispatchId || `dispatch-${label}`;
  const bindings = {
    phase, taskId, cwd, contextRoot: cwd, workflowId: workflowId || `workflow-${label}`,
    dispatchId: effectiveDispatch,
    resultFile: resultFile || path.join(resultRoot, `${effectiveDispatch}.result.json`),
    constraints: { auto_commit: false, deploy: false }, prompt,
    inputs: { brief: `Installed fixture ${label}` },
    ...(activeCapabilities ? { activeCapabilities } : {}),
    ...(effortBinding ? { effortBinding } : {}),
    ...(continuation ? { continuation } : {}),
  };
  const bindingsFile = path.join(root, 'builder-inputs', `${label}-${effectiveDispatch}.json`);
  const requestFile = path.join(root, 'builder-outputs', `${label}-${effectiveDispatch}.json`);
  write(bindingsFile, bindings);
  fs.mkdirSync(path.dirname(requestFile), { recursive: true });
  const built = spawnSync(process.execPath, [projection.builderFile, bindingsFile, requestFile], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  Object.defineProperty(request, '_fixtureRequestFile', { value: requestFile, enumerable: false });
  return request;
}

function artifactEnvelope(prep, request) {
  return { status: 'done', summary: `${request.phase} installed delivery`, questions: [],
    artifacts: [{ path: prep.requiredArtifact(request), content: phaseContent(request.phase, request.taskId) }] };
}

function installedProjection(home, name) {
  const skill = fs.readFileSync(path.join(home, 'skills', 'forge-task', 'SKILL.md'), 'utf8');
  const section = skill.slice(skill.indexOf('### Canonical preparation caller'), skill.indexOf('### Step 4.5'));
  const match = section.match(/hostRuntime:\s*["'](claude|codex)["']/);
  assert(match, `preparation host is absent from ${home}`);
  assert.match(section, /forge-task-preparation\.js["']? --start/);
  assert.doesNotMatch(section, /worker_mode:native|workerMode:\s*["']native["']/);
  const builder = section.match(/<!-- forge:task-preparation-request:start -->\s*```js\s*([\s\S]*?)\s*```\s*<!-- forge:task-preparation-request:end -->/);
  assert(builder, `preparation request builder is absent from ${home}`);
  const builderFile = path.join(root, `projected-builder-${name}.js`);
  write(builderFile, builder[1] + '\n');
  return { host: match[1], builderFile, source: builder[1], section };
}

async function main() {
  fs.mkdirSync(projectionRoot, { recursive: true });
  const report = installer.install({
    repo: sourceRoot, runtime: 'both', forgeHome, claudeHome, codexHome,
    projectRoot: projectionRoot, userHome: root, noModelProbe: true,
    skipCapabilityCheck: true, env: { ...process.env, HOME: root, USERPROFILE: root },
  });
  assert.equal(report.ok, true);
  const helperPath = path.join(forgeHome, 'scripts', 'forge-task-preparation.js');
  assert(fs.existsSync(helperPath));
  assert(!fs.existsSync(path.join(forgeHome, 'scripts', path.basename(__filename))),
    'development integration suite must not be installed');

  const installedAccounts = require(path.join(forgeHome, 'scripts', 'forge-accounts.js'));
  installedAccounts.resolveLaunch = () => ({ name: 'fixture-account', token: 'fixture-token-never-real' });
  const provider = path.join(root, 'claude-provider-fixture.js');
  write(provider, `'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const instruction = args[args.indexOf('-p') + 1];
const prefix = 'Read the complete task prompt from this UTF-8 file: ';
const suffix = '. Follow it exactly and finish with its required worker-result block.';
const promptFile = JSON.parse(instruction.slice(prefix.length, -suffix.length));
const prompt = fs.readFileSync(promptFile, 'utf8');
fs.appendFileSync(path.join(process.cwd(), 'provider-observations.jsonl'), JSON.stringify({
  model: args[args.indexOf('--model') + 1], effort: args[args.indexOf('--effort') + 1],
  tools: args[args.indexOf('--tools') + 1], prompt
}) + '\\n');
const payload = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'provider-payload.json'), 'utf8'));
process.stdout.write(['---GSD-WORKER-RESULT---', 'status: ' + payload.status,
  'result_json: ' + JSON.stringify(payload), '---END-RESULT---'].join('\\n'));
`);
  const accountPreload = path.join(root, 'fixture-account-preload.js');
  write(accountPreload, `'use strict';
const accounts = require(${JSON.stringify(path.join(forgeHome, 'scripts', 'forge-accounts.js'))});
accounts.resolveLaunch = () => ({ name: 'fixture-account', token: 'fixture-token-never-real' });
`);
  const originalClaudeBin = process.env.FORGE_XLLM_CLAUDE_BIN;
  const originalForgeHome = process.env.FORGE_HOME;
  process.env.FORGE_XLLM_CLAUDE_BIN = provider;
  process.env.FORGE_HOME = forgeHome;

  // Load after stubbing the installed account lookup: forge-claude-sidecar
  // captures that function when the installed unit adapter is required.
  const prep = require(helperPath);
  const installedXllm = require(path.join(forgeHome, 'scripts', 'forge-xllm.js'));
  const originalCodex = installedXllm.invokeCodexAppServer;
  const codexPrompts = [];
  installedXllm.invokeCodexAppServer = async options => {
    codexPrompts.push(options.prompt);
    assert.equal(options.sandbox, 'read-only');
    assert.equal(options.model, 'gpt-5.6-sol');
    assert.equal(options.effort, 'high');
    const payload = JSON.parse(fs.readFileSync(path.join(options.cwd, 'provider-payload.json'), 'utf8'));
    return { finalText: JSON.stringify(payload) };
  };

  try {
    const claudeProjection = installedProjection(claudeHome, 'claude');
    const codexProjection = installedProjection(codexHome, 'codex');
    assert.equal(claudeProjection.host, 'claude');
    assert.equal(codexProjection.host, 'codex');

    await test('installed projections drive both cross-host adapters for every phase and publish task artifacts', async () => {
      const scenarios = [
        { label: 'brainstorm-gpt', phase: 'brainstorm', taskId: 'T-20260928151522-brainstorm-gpt', projection: claudeProjection, model: 'gpt-5.6-sol', expectedEffort: 'high' },
        { label: 'brainstorm-claude', phase: 'brainstorm', taskId: 'TASK-070', projection: codexProjection, model: 'claude-sonnet-5', expectedEffort: 'medium' },
        { label: 'discuss-gpt', phase: 'discuss', taskId: 'T-20260928151523-discuss-gpt', projection: claudeProjection, model: 'gpt-5.6-sol', expectedEffort: 'high' },
        { label: 'discuss-claude', phase: 'discuss', taskId: 'TASK-20260928-104227', projection: codexProjection, model: 'claude-sonnet-5', expectedEffort: 'medium' },
        { label: 'research-gpt', phase: 'research', taskId: 'TASK-071', projection: claudeProjection, model: 'gpt-5.6-sol', expectedEffort: 'high' },
        { label: 'research-claude', phase: 'research', taskId: 'T-20260928151524-research-claude', projection: codexProjection, model: 'claude-sonnet-5', expectedEffort: 'medium' },
        { label: 'plan-gpt', phase: 'plan', taskId: 'T-20260928151525-plan-gpt', projection: claudeProjection, model: 'gpt-5.6-sol', expectedEffort: 'high' },
        { label: 'plan-claude', phase: 'plan', taskId: 'T-20260928151526-plan-claude', projection: codexProjection, model: 'claude-sonnet-5', expectedEffort: 'medium' },
      ];
      for (const scenario of scenarios) {
        const sentinel = `phase-sentinel-${scenario.label}`;
        const request = requestFor(prep, scenario.projection, { ...scenario, prompt: sentinel });
        const payload = artifactEnvelope(prep, request);
        write(path.join(request.cwd, 'provider-payload.json'), payload);
        const result = await prep.prepareStandaloneTask(request);
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.transport, 'sidecar');
        assert.equal(result.provider_called, true);
        assert.equal(result.route.host_runtime, scenario.projection.host);
        assert.equal(result.route.resolved_worker_engine, scenario.model.startsWith('claude-') ? 'claude' : 'codex');
        assert.equal(result.route.model_resolved, scenario.model);
        assert.equal(result.route.effort, scenario.expectedEffort);
        if (scenario.model === 'claude-sonnet-5') assert.match(result.route.effort_reason, /clamped:model-cap/);
        assert.equal(result.route.worker_mode, 'sidecar');
        const artifact = path.join(request.cwd, prep.requiredArtifact(request).replace(/\//g, path.sep));
        assert.equal(fs.readFileSync(artifact, 'utf8'), phaseContent(scenario.phase, scenario.taskId));
        assert(!fs.existsSync(path.join(request.cwd, '.gsd', 'milestones')));
        const receipt = JSON.parse(fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8'));
        assert.equal(receipt.route_identity.model_resolved, scenario.model);
        assert.equal(receipt.route_identity.effort, scenario.expectedEffort);
        assert.equal(receipt.route_identity.worker_mode, 'sidecar');
        assert.equal(receipt.provider_called, true);
        const events = fs.readFileSync(path.join(request.cwd, '.gsd', 'forge', 'events.jsonl'), 'utf8')
          .trim().split(/\r?\n/).map(JSON.parse);
        const terminalEvent = events.find(event => event.event === 'sidecar-unit'
          && event.dispatch_id === request.dispatchId && event.status === 'done');
        assert(terminalEvent, `missing terminal route event for ${scenario.label}`);
        assert.equal(terminalEvent.provider_called, true);
        assert.equal(terminalEvent.host_runtime, scenario.projection.host);
        assert.equal(terminalEvent.worker_mode, 'sidecar');
        assert.equal(terminalEvent.model_resolved, scenario.model);
        assert.equal(terminalEvent.effort, scenario.expectedEffort);
        if (scenario.model.startsWith('claude-')) {
          const observations = fs.readFileSync(path.join(request.cwd, 'provider-observations.jsonl'), 'utf8')
            .trim().split(/\r?\n/).map(JSON.parse);
          assert.equal(observations.length, 1);
          assert.equal(observations[0].model, scenario.model);
          assert.equal(observations[0].effort, scenario.expectedEffort);
          assert.equal(observations[0].tools, 'Read,Glob,Grep');
          assert(observations[0].prompt.includes(sentinel), 'caller prompt did not reach Claude adapter');
        } else {
          assert(codexPrompts.at(-1).includes(sentinel), 'caller prompt did not reach Codex adapter');
        }
      }
    });

    await test('projected Codex request executes the installed start CLI through the Claude sidecar', async () => {
      const request = requestFor(prep, codexProjection, { label: 'cli-cross-host', phase: 'discuss',
        taskId: 'TASK-073', model: 'claude-sonnet-5', prompt: 'cli-sidecar-sentinel' });
      write(path.join(request.cwd, 'provider-payload.json'), artifactEnvelope(prep, request));
      const result = spawnSync(process.execPath, [helperPath, '--start', request._fixtureRequestFile], {
        encoding: 'utf8', windowsHide: true,
        env: { ...process.env, FORGE_HOME: forgeHome, FORGE_XLLM_CLAUDE_BIN: provider,
          NODE_OPTIONS: `--require=${accountPreload}` },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const output = JSON.parse(result.stdout.trim());
      assert.equal(output.action, 'complete', result.stdout);
      assert.equal(output.provider_called, true);
      assert.equal(output.route.model_resolved, 'claude-sonnet-5');
      assert.equal(output.route.effort, 'medium');
      const observation = JSON.parse(fs.readFileSync(path.join(request.cwd, 'provider-observations.jsonl'), 'utf8').trim());
      assert(observation.prompt.includes('cli-sidecar-sentinel'));
    });

    await test('reintroducing forced native in the installed request builder breaks cross-family delivery before provider work', async () => {
      const forcedSource = codexProjection.source.replace(
        'hostRuntime: "codex",', 'hostRuntime: "codex",\n  workerMode: "native",');
      assert.notEqual(forcedSource, codexProjection.source, 'renderer did not project the Codex host into the builder');
      const forcedBuilder = path.join(root, 'projected-builder-codex-forced-native.js');
      write(forcedBuilder, forcedSource + '\n');
      const forcedProjection = { ...codexProjection, builderFile: forcedBuilder };
      const request = requestFor(prep, forcedProjection, { label: 'forced-native', phase: 'discuss',
        taskId: 'TASK-074', model: 'claude-sonnet-5', prompt: 'must-not-reach-provider',
        activeCapabilities: { available: true, tool: 'collaboration.spawn_agent', source: 'fixture-tool-schema',
          models: ['gpt-5.6-sol'], reasoning_efforts: ['medium'], fork_turns: ['none'] } });
      write(path.join(request.cwd, 'provider-payload.json'), artifactEnvelope(prep, request));
      const result = await prep.prepareStandaloneTask(request);
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.provider_called, false);
      assert(!fs.existsSync(path.join(request.cwd, 'provider-observations.jsonl')));
    });

    await test('installed partial questions publish nothing and explicit continuation retains its answer', async () => {
      const first = requestFor(prep, claudeProjection, { label: 'partial', phase: 'discuss', taskId: 'TASK-072',
        model: 'gpt-5.6-sol', prompt: 'partial-sentinel' });
      write(path.join(first.cwd, 'provider-payload.json'), {
        status: 'partial', summary: 'One decision remains', questions: ['Which schema is authoritative?'], artifacts: [],
      });
      const partial = await prep.prepareStandaloneTask(first);
      assert.equal(partial.status, 'partial', JSON.stringify(partial));
      assert.equal(partial.provider_called, true);
      assert.deepEqual(partial.result.questions, ['Which schema is authoritative?']);
      assert(!fs.existsSync(path.join(first.cwd, prep.requiredArtifact(first).replace(/\//g, path.sep))));
      const priorReceipt = JSON.parse(fs.readFileSync(`${first.resultFile}.receipt.json`, 'utf8'));
      assert.deepEqual(priorReceipt.preparation_identity, { scope: first.scope, phase: first.phase,
        taskId: first.taskId, workflowId: first.workflowId });
      assert.equal(JSON.stringify(priorReceipt.preparation_identity), JSON.stringify({
        scope: first.scope, phase: first.phase, taskId: first.taskId, workflowId: first.workflowId,
      }));
      assert.equal(priorReceipt.dispatch_id, first.dispatchId);

      const dispatchId = `${first.dispatchId}-answer`;
      const resumed = requestFor(prep, claudeProjection, { label: 'partial-answer', phase: first.phase,
        taskId: first.taskId, model: 'gpt-5.6-sol', prompt: 'continuation-sentinel', dispatchId,
        existingCwd: first.cwd, workflowId: first.workflowId,
        resultFile: path.join(path.dirname(first.resultFile), `${dispatchId}.result.json`),
        continuation: { from_dispatch_id: first.dispatchId, result_file: first.resultFile,
          answers: ['The checked-in schema is authoritative.'] } });
      write(path.join(resumed.cwd, 'provider-payload.json'), artifactEnvelope(prep, resumed));
      const completed = await prep.prepareStandaloneTask(resumed);
      assert.equal(completed.status, 'done', JSON.stringify(completed));
      assert.equal(completed.provider_called, true);
      assert(codexPrompts.at(-1).includes('The checked-in schema is authoritative.'));
      assert(codexPrompts.at(-1).includes('continuation-sentinel'));
    });

    await test('installed native start, accept and replay retain original model and effort without re-resolution', async () => {
      const activeCapabilities = { available: true, tool: 'collaboration.spawn_agent', source: 'fixture-tool-schema',
        models: ['gpt-5.6-sol'], reasoning_efforts: ['high'], fork_turns: ['none'] };
      const request = requestFor(prep, codexProjection, { label: 'native', phase: 'brainstorm',
        taskId: 'T-20260928151524-native', model: 'gpt-5.6-sol', prompt: 'native-sentinel',
        activeCapabilities });
      const startProcess = spawnSync(process.execPath, [helperPath, '--start', request._fixtureRequestFile], {
        encoding: 'utf8', windowsHide: true, env: { ...process.env, FORGE_HOME: forgeHome },
      });
      assert.equal(startProcess.status, 0, startProcess.stderr || startProcess.stdout);
      const started = JSON.parse(startProcess.stdout.trim());
      assert.equal(started.action, 'invoke-native', JSON.stringify(started));
      assert.equal(started.invocation.args.model, 'gpt-5.6-sol');
      assert.equal(started.invocation.args.reasoning_effort, 'high');
      assert(started.invocation.args.message.includes('native-sentinel'));
      const telemetry = { ...started.invocation.telemetry,
        model_observed: 'gpt-5.6-sol', model_observed_source: 'fixture-native-result',
        effort_applied: 'high', effort_applied_source: 'fixture-native-result' };
      const acceptanceFile = path.join(root, 'native-acceptance.json');
      write(acceptanceFile, {
        route: started.route, rawResult: artifactEnvelope(prep, request),
        invocationTelemetry: telemetry, providerCalled: true,
      });
      const acceptProcess = spawnSync(process.execPath,
        [helperPath, '--accept-native', request._fixtureRequestFile, acceptanceFile], {
          encoding: 'utf8', windowsHide: true, env: { ...process.env, FORGE_HOME: forgeHome },
        });
      assert.equal(acceptProcess.status, 0, acceptProcess.stderr || acceptProcess.stdout);
      const accepted = JSON.parse(acceptProcess.stdout.trim());
      assert.equal(accepted.status, 'done', JSON.stringify(accepted));
      assert.equal(accepted.provider_called, true);
      const changed = configuredPrefs('claude-sonnet-5', prep.PHASE_CONTRACTS.brainstorm.unitType);
      write(path.join(request.cwd, '.gsd', 'forge-prefs.jsonc'), changed);
      let replayResolutions = 0;
      const replay = await prep.startStandaloneTaskPreparation(request, {
        resolveDispatch: () => { replayResolutions++; throw new Error('ready replay re-resolved preferences'); },
      });
      assert.equal(replay.replayed, true, JSON.stringify(replay));
      assert.equal(replay.provider_called, false);
      assert.equal(replay.route.model_resolved, 'gpt-5.6-sol');
      assert.equal(replay.route.effort, 'high');
      assert.equal(replayResolutions, 0);
      const receipt = JSON.parse(fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8'));
      assert.equal(receipt.provider_called, true);
      assert.equal(receipt.route_identity.model_resolved, 'gpt-5.6-sol');
      assert.equal(receipt.route_identity.worker_mode, 'native');
      assert.equal(receipt.route_identity.effort, 'high');
      assert.equal(receipt.telemetry.model_observed, 'gpt-5.6-sol');
      assert.equal(receipt.telemetry.effort_applied, 'high');
    });

    await test('installed native failure acceptance closes pre- and post-provider started receipts', async () => {
      for (const providerCalled of [false, true]) {
        const label = providerCalled ? 'native-failure-post-provider' : 'native-failure-pre-provider';
        const activeCapabilities = { available: true, tool: 'collaboration.spawn_agent', source: 'fixture-tool-schema',
          models: ['gpt-5.6-sol'], reasoning_efforts: ['high'], fork_turns: ['none'] };
        const request = requestFor(prep, codexProjection, { label, phase: 'brainstorm',
          taskId: providerCalled ? 'TASK-076' : 'TASK-075', model: 'gpt-5.6-sol',
          prompt: `${label}-sentinel`, activeCapabilities });
        const startProcess = spawnSync(process.execPath, [helperPath, '--start', request._fixtureRequestFile], {
          encoding: 'utf8', windowsHide: true, env: { ...process.env, FORGE_HOME: forgeHome },
        });
        assert.equal(startProcess.status, 0, startProcess.stderr || startProcess.stdout);
        const started = JSON.parse(startProcess.stdout.trim());
        assert.equal(started.action, 'invoke-native', JSON.stringify(started));
        const reason = providerCalled ? 'fixture-provider-exit' : 'fixture-native-tool-refused';
        const failure = { reason_code: reason, provider_called: providerCalled,
          ...(providerCalled ? { telemetry: started.invocation.telemetry } : {}) };
        const acceptanceFile = path.join(root, `${label}-acceptance.json`);
        write(acceptanceFile, { route: started.route, nativeFailure: failure });
        const acceptProcess = spawnSync(process.execPath,
          [helperPath, '--accept-native', request._fixtureRequestFile, acceptanceFile], {
            encoding: 'utf8', windowsHide: true, env: { ...process.env, FORGE_HOME: forgeHome },
          });
        assert.equal(acceptProcess.status, 1, acceptProcess.stderr || acceptProcess.stdout);
        const accepted = JSON.parse(acceptProcess.stdout.trim());
        assert.equal(accepted.reason_code, reason);
        assert.equal(accepted.provider_called, providerCalled);
        const receipt = JSON.parse(fs.readFileSync(`${request.resultFile}.receipt.json`, 'utf8'));
        assert.equal(receipt.phase, 'failed');
        assert.equal(receipt.failure.provider_called, providerCalled);
        assert.equal(receipt.failure.reason_code, reason);
      }
    });
  } finally {
    installedXllm.invokeCodexAppServer = originalCodex;
    if (originalClaudeBin === undefined) delete process.env.FORGE_XLLM_CLAUDE_BIN;
    else process.env.FORGE_XLLM_CLAUDE_BIN = originalClaudeBin;
    if (originalForgeHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = originalForgeHome;
  }
}

main().finally(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  if (!process.exitCode) process.stdout.write(`\n${passed} passed, 0 failed\n`);
});
