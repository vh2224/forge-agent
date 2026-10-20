#!/usr/bin/env node
'use strict';

// Every transport is stubbed before loading its caller. These fixtures never
// resolve an account, launch an inference process or read the real user profile.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const lab = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-final-telemetry-')));
const homeBefore = process.env.HOME, profileBefore = process.env.USERPROFILE;
const home = path.join(lab, 'home');
fs.mkdirSync(home);
process.env.HOME = home;
process.env.USERPROFILE = home;
const claude = require('./forge-claude-sidecar');
const originalClaude = claude.invokeClaudeSidecar;
let claudeStub = () => { throw Error('unexpected fixture invocation'); };
const fixtureClaudeRequest = options => ({ cmd: 'fixture-claude', args: ['--model', options.model, '--effort', options.effort] });
claude.invokeClaudeSidecar = options => {
  // Simulate the adapter's final boundary; real argv is exercised in its suite.
  api.observeFinal(options, fixtureClaudeRequest(options), options.prompt, 'claude-cli');
  return claudeStub(options);
};
const appserver = require('./forge-appserver-client');
const originalTurn = appserver.startAppServerTurn;
const api = require('./forge-attempt-telemetry');
const native = require('./forge-native-invocation');
const xllm = require('./forge-xllm');
const prep = require('./forge-task-preparation');
const recovery = require('./forge-attempt-recovery');
const stateApi = require('./forge-xllm-state');
const promptApi = require('./forge-prompt');
const { command } = require('./forge-code-roots.test');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const secret = 'SYNTHETIC-CREDENTIAL-DO-NOT-PERSIST';
let sequence = 0, passed = 0;
function fixture(model = 'claude-sonnet-5', hostRuntime = 'codex') {
  const root = path.join(lab, `case-${++sequence}`), cwd = path.join(root, 'code');
  const contextRoot = path.join(root, 'owner'), results = path.join(root, 'results');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(contextRoot, '.gsd'), { recursive: true });
  fs.mkdirSync(results);
  command('git', ['init', '-q'], cwd);
  command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '-qm', 'fixture'], cwd);
  fs.writeFileSync(path.join(contextRoot, '.gsd/forge-prefs.jsonc'), JSON.stringify({
    tier_models: { light: model, standard: model, heavy: model, max: model },
    effort: { 'plan-slice': 'medium', 'discuss-milestone': 'medium', 'research-milestone': 'medium' },
    token_budget: { coding_standards: 128 } }));
  return { schema_version: 1, cwd, contextRoot, hostRuntime, scope: 'standalone-task', phase: 'brainstorm',
    taskId: `T-20261019${String(sequence).padStart(6, '0')}-fixture`, workflowId: `workflow-${sequence}`,
    dispatchId: `fixture-${sequence}`, resultFile: path.join(results, 'result.json'),
    constraints: { auto_commit: false, deploy: false }, inputs: { brief: 'Synthetic request' } };
}
function route(model = 'gpt-6-sol', worker = 'codex') {
  return { model, model_requested: model, model_resolved: model, effort: 'medium',
    dispatch_engine: worker, host_runtime: worker, resolved_worker_engine: worker,
    worker_mode: 'native', dispatch_allowed: true, config_ok: true };
}
const capabilities = { available: true, tool: 'spawn_agent', source: 'fixture-tool-schema',
  models: ['gpt-6-sol'], reasoning_efforts: ['medium'], fork_turns: ['none'] };
function nativeOptions(prompt) {
  return { hostRuntime: 'codex', resolvedDispatch: route(), activeCapabilities: capabilities,
    agentType: 'forge-worker', taskName: 'final_fixture', prompt };
}
function checkMeasurement(measurement, bytes, structured = false) {
  const buffer = Buffer.from(structured ? JSON.stringify(bytes) : bytes, 'utf8');
  assert.equal(measurement.status, 'observed');
  assert.equal(measurement.bytes, buffer.length);
  assert.equal(measurement.sha256, sha(buffer));
}
async function test(name, fn) {
  await fn(); passed++; process.stdout.write(`ok - ${name}\n`);
}
const timeout = () => Object.assign(Error(`timeout token=${secret}`), {
  code: 'claude-timeout', stderr: `Authorization: Bearer ${secret}`, diagnostic: { reason: `token=${secret}` } });

async function main() {
  await test('unknown, real zero, UTF-8 prompt files and unreadable files are distinct', () => {
    const missing = api.captureFinal();
    assert.equal(missing.context.status, 'unknown');
    assert.equal(missing.context.bytes, null); assert.equal(missing.context.sha256, null);
    checkMeasurement(api.measure('', 'inline'), '');
    const file = path.join(lab, 'unicode.txt'), text = 'ação 🧪 漢字\r\n';
    fs.writeFileSync(file, text);
    checkMeasurement(api.captureFinal({ promptFile: file }).context, text);
    for (const promptFile of [path.join(lab, 'absent.txt'), lab]) {
      const context = api.captureFinal({ promptFile }).context;
      assert.equal(context.bytes, null); assert.equal(context.sha256, null);
      assert.equal(context.diagnostic, 'prompt-file-unreadable');
    }
    const cyclic = {}; cyclic.self = cyclic;
    assert.equal(api.measure(cyclic, 'structured', true).diagnostic, 'measurement-failed');
  });
  await test('native exact 9995-byte argument and structured request precede callback failure', async () => {
    const text = 'ação 🧪' + 'x'.repeat(9995 - Buffer.byteLength('ação 🧪'));
    let packaged, observed;
    const options = { ...nativeOptions(text), budgets: { coding_standards: 128 },
      telemetryIdentity: { unitType: 'execute-task', scope: 'milestone', phase: 'execute', dispatchId: 'native-fixture',
        cwd: lab, planFile: path.join(lab, 'T01-PLAN.md') },
      onPackagedContext: value => { packaged = value; } };
    const result = await native.invokeNative(options, args => {
      observed = args; assert(packaged, 'capture must precede tool callback'); throw timeout();
    });
    assert.equal(result.provider_called, 'unknown');
    assert.equal(result.reason_code, 'claude-timeout');
    checkMeasurement(packaged.final_evidence.context, observed.message);
    assert.equal(packaged.bytes, 9995);
    checkMeasurement(result.final_evidence.request, observed, true);
    assert.equal(result.final_evidence.model_sent, 'gpt-6-sol');
    assert.equal(result.final_evidence.model_observed, null);
    assert.equal(result.final_evidence.effort, 'medium');
    assert.equal(result.final_evidence.host, 'codex');
    assert.equal(result.final_evidence.worker, 'codex');
    assert.equal(result.final_evidence.transport, 'native-tool');
    assert.equal(result.final_evidence.paths.planFile, options.telemetryIdentity.planFile);
    assert.equal(result.final_evidence.stage, 'invoked');
    assert(Number.isFinite(result.final_evidence.duration_ms));
    assert(!JSON.stringify(result.final_evidence).includes(text));
    assert(!JSON.stringify(result).includes(secret));
    const refused = await native.invokeNative(nativeOptions(text));
    assert.equal(refused.provider_called, false);
    assert.equal(refused.final_evidence.context.bytes, null, 'no callback means no observed input');
    const success = await native.invokeNative({ ...options, readback: () => ({ model: 'gpt-6-sol', source: 'fixture-host' }) }, () => 'ok');
    assert.equal(success.final_evidence.model_observed, 'gpt-6-sol');
    assert.equal(success.final_evidence.stage, 'returned');
  });
  await test('Claude plan promptFile includes final framing at exactly 23297 bytes on timeout', async () => {
    const request = fixture();
    const file = path.join(request.contextRoot, 'plan-context.txt');
    const suffix = '\n\nReturn only this worker-result block:\n---GSD-WORKER-RESULT---\nstatus: <done|partial|blocked>\nresult_json: <single-line JSON>\n---END-RESULT---\nUse the requested result JSON as result_json.';
    const prefix = 'Pesquisa 🧪 requisitos e decisões.';
    const context = prefix + 'x'.repeat(23297 - Buffer.byteLength(xllm.buildPlanPrompt(prefix) + suffix));
    fs.writeFileSync(file, context);
    let observed, packaged;
    claudeStub = options => { observed = options; assert(packaged); throw timeout(); };
    await assert.rejects(xllm.runPlan({ cwd: request.cwd, contextRoot: request.contextRoot,
      engine: 'claude', model: 'claude-sonnet-5', effort: 'medium', hostRuntime: 'codex', sidecarDeclared: true,
      planContextFile: file, resultFile: request.resultFile, telemetryIdentity: { ...request, unitType: 'plan-slice', promptFile: file },
      telemetryRoute: { ...route('claude-sonnet-5', 'claude'), host_runtime: 'codex' },
      onPackagedContext: value => { packaged = value; } }), /timeout/);
    assert.equal(Buffer.byteLength(observed.prompt), 23297);
    assert(observed.prompt.endsWith(suffix));
    assert(observed.prompt.includes(context));
    checkMeasurement(packaged.final_evidence.context, observed.prompt);
    checkMeasurement(packaged.final_evidence.request, fixtureClaudeRequest(observed), true);
    assert.equal(packaged.budgets.coding_standards, 128);
    assert.equal(packaged.final_evidence.provider_called, 'unknown');
  });
  await test('Codex request uses actual thread/turn parameters and keeps pre-turn request unknown', async () => {
    const request = fixture('gpt-6-sol', 'claude'), captures = [];
    const text = 'inline 🧪 request';
    let actual;
    appserver.startAppServerTurn = options => {
      assert.equal(captures[0].final_evidence.request.bytes, null);
      actual = { threadParams: options.threadParams, turnParams: options.turnParams('thread-fixture') };
      return Promise.reject(timeout());
    };
    await assert.rejects(xllm.invokeCodexAppServer({ cwd: request.cwd, prompt: text, model: 'gpt-6-sol',
      effort: 'medium', timeoutSecs: 1, sandbox: 'read-only', schema: { type: 'object' },
      telemetryIdentity: request, telemetryRoute: { ...route(), host_runtime: 'claude' },
      onPackagedContext: value => captures.push(value) }), /timeout/);
    assert.equal(captures.length, 2);
    checkMeasurement(captures[1].final_evidence.request, actual, true);
    checkMeasurement(captures[1].final_evidence.context, actual.turnParams.input[0].text);
    assert.equal(captures[1].final_evidence.model_observed, null);
    assert.equal(captures[1].final_evidence.provider_called, 'unknown');
  });
  await test('standalone sidecar and native failures retain final evidence in receipt/recovery after restart', async () => {
    for (const transport of ['sidecar', 'native']) {
      const request = fixture(transport === 'native' ? 'gpt-6-sol' : 'claude-sonnet-5');
      request.phase = 'research';
      request.promptFile = path.join(request.contextRoot, 'research.txt');
      fs.writeFileSync(request.promptFile, 'SYNTHETIC-PROMPT-DO-NOT-PERSIST 🧪');
      let observed;
      claudeStub = options => { observed = options.prompt; throw timeout(); };
      if (transport === 'native') request.activeCapabilities = capabilities;
      const result = await prep.prepareStandaloneTask(request, transport === 'native' ? {
        invokeNative: args => { observed = args.message; throw timeout(); } } : {});
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.provider_called, 'unknown');
      const receipt = JSON.parse(fs.readFileSync(request.resultFile + '.receipt.json'));
      const stateFile = request.resultFile + '.recovery.json';
      const restored = stateApi.loadRecovery(stateFile), attempt = restored.attempts.at(-1);
      checkMeasurement(receipt.final_evidence.context, observed);
      checkMeasurement(attempt.final_evidence.context, observed);
      assert.equal(attempt.failure_class, 'timeout');
      assert.equal(attempt.timeout_cause, 'indeterminate');
      assert.equal(attempt.provider_called, 'unknown');
      assert.equal(attempt.final_evidence.scope, 'standalone-task');
      assert.equal(attempt.final_evidence.phase, 'research');
      assert.equal(fs.realpathSync.native(attempt.receipt), fs.realpathSync.native(request.resultFile + '.receipt.json'));
      assert.equal(fs.realpathSync.native(attempt.result), fs.realpathSync.native(request.resultFile));
      assert.equal(attempt.next_action, 'inspect-process-receipt-roots');
      assert.equal(attempt.budgets.coding_standards, 128);
      assert(attempt.reason_code && attempt.layer && Number.isFinite(attempt.duration_ms));
      const persisted = fs.readFileSync(stateFile, 'utf8') + JSON.stringify(receipt);
      assert(!persisted.includes(secret));
      assert(!persisted.includes('SYNTHETIC-PROMPT-DO-NOT-PERSIST'));
      assert(!persisted.includes('Authorization:'));
    }
  });
  await test('absent callback and legacy state do not fabricate measurements; correction links before/after', async () => {
    const request = fixture();
    const delivered = { ...request, unitType: 'research-milestone', scope: 'milestone', milestoneId: 'M001',
      route: { ...route('claude-sonnet-5', 'claude'), host_runtime: 'codex' }, prompt: 'intermediate only' };
    delete delivered.taskId;
    const stateFile = path.join(path.dirname(request.resultFile), 'unknown-state.json');
    const before = recovery.captureFailure({ stateFile, request: delivered, unit: 'research-milestone/M001',
      route: delivered.route, error: { code: 'context-budget-exceeded', provider_called: false, stderr: secret } });
    assert.equal(before.attempts[0].context_bytes, null);
    assert.equal(before.attempts[0].request_bytes, null);
    assert.equal(before.attempts[0].model_sent, 'unknown');
    const session = recovery.createRecovery({ unit: before.unit, roots_sha256: before.roots_sha256, state: before });
    const corrected = api.captureFinal({ context: 'corrected', request: { prompt: 'corrected' },
      budgets: { coding_standards: 64 }, route: delivered.route });
    const next = await session.next({ inspection: { process_stopped: true, receipt_checked: true, writer_possible: false },
      correction: { offline_validated: true, evidence_reference: 'fixture-check', request_sha256: corrected.request.sha256 },
      validateInvocation: async () => ({ ok: true }) });
    assert.equal(next.action, 'invoke');
    session.reserve(next, corrected.request.sha256);
    session.record({ ...before.attempts[0], final_evidence: corrected,
      request_sha256: corrected.request.sha256, request_bytes: corrected.request.bytes,
      context_sha256: corrected.context.sha256, context_bytes: corrected.context.bytes,
      context_measurement: corrected.context.method, budgets: corrected.budgets });
    const after = session.snapshot().attempts.at(-1);
    assert.equal(after.previous_attempt.context_sha256, null);
    assert.equal(after.previous_attempt.request_sha256, null);
    assert.equal(after.reservation.corrected, true);
    assert.equal(after.reservation.correction.evidence_reference, 'fixture-check');
    assert.equal(after.context_measurement, 'utf8-sha256');
    assert.deepEqual(after.budgets, { coding_standards: 64 });
    const legacy = structuredClone(before); delete legacy.attempts[0].final_evidence;
    assert.deepEqual(recovery.createRecovery({ unit: before.unit, roots_sha256: before.roots_sha256,
      state: legacy }).snapshot().attempts[0].context_bytes, null);
    assert(!JSON.stringify(after).includes(secret));
  });
  await test('real compositor budgets optional standards and preserves mandatory sentinels through final native packaging', async () => {
    const request = fixture('gpt-6-sol');
    const templates = path.join(lab, 'templates'); fs.mkdirSync(templates);
    fs.writeFileSync(path.join(templates, 'execute-task.md'), '{CS_LINT}\n{CS_STRUCTURE}\n{CS_RULES}\n{description}');
    const sentinels = ['RESEARCH-SENTINEL', 'DECISIONS-SENTINEL', 'REQUIREMENTS-SENTINEL',
      'QUESTION-SENTINEL', 'SECURITY-CHECKLIST-SENTINEL'];
    const rendered = promptApi.renderPrompt({ cwd: request.contextRoot, unitType: 'execute-task',
      milestoneId: 'M001', sliceId: 'S01', taskId: 'T01', templateDir: templates,
      description: sentinels.join('\n'), autoCommit: false, standardsMaxTokens: 128,
      standards: { CS_LINT: 'OPTIONAL-LINT '.repeat(500), CS_STRUCTURE: 'OPTIONAL-STRUCTURE '.repeat(500),
        CS_RULES: 'OPTIONAL-RULES '.repeat(500) } });
    assert(rendered.prompt.includes('.gsd/CODING-STANDARDS.md'));
    assert(rendered.prompt.length < 1600);
    let actual;
    const result = await native.invokeNative(nativeOptions(rendered.prompt), args => { actual = args.message; return 'ok'; });
    for (const sentinel of sentinels) assert(actual.includes(sentinel), sentinel);
    checkMeasurement(result.final_evidence.context, actual);
    const sanitized = api.sanitizeFinal({ ...result.final_evidence, prompt: secret, argv: [secret], stderr: secret,
      unit_type: 'execute-task', paths: { ...result.final_evidence.paths, unitType: secret, prompt: secret },
      model_sent: 'claude-sonnet-4-6[1m]', model_observed: 'claude-sonnet-4-6[1m]' });
    assert(!JSON.stringify(sanitized).includes(secret));
    assert.equal(sanitized.unit_type, 'execute-task');
    assert.equal(sanitized.model_sent, 'claude-sonnet-4-6[1m]');
    assert.equal(sanitized.model_observed, 'claude-sonnet-4-6[1m]');
  });
  process.stdout.write(`PASS ${passed} final telemetry contracts (simulated transports, no providers)\n`);
}
main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; }).finally(() => {
  claude.invokeClaudeSidecar = originalClaude;
  appserver.startAppServerTurn = originalTurn;
  if (homeBefore === undefined) delete process.env.HOME; else process.env.HOME = homeBefore;
  if (profileBefore === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = profileBefore;
  fs.rmSync(lab, { recursive: true, force: true });
});
