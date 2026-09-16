#!/usr/bin/env node
'use strict';

// No real account/CLI is used. Only the account lookup and external providers
// are substituted; controller, guard, resolver, artifacts and receipts are real.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bidirectional-'));
const accounts = require('./forge-accounts');
const originalLookup = accounts.resolveLaunch;
const token = 'fixture-only-never-a-real-account';
accounts.resolveLaunch = () => ({ name: 'fixture', token });
delete require.cache[require.resolve('./forge-claude-sidecar')];
const claude = require('./forge-claude-sidecar');
const xllm = require('./forge-xllm');
const unit = require('./forge-unit-sidecar');
const { resolveDispatch } = require('./forge-dispatch-resolve');
const { evaluateDispatchGuard } = require('./forge-dispatch-guard');
const { ARTIFACT_UNITS } = require('./forge-transport-capabilities');
const loop = require('./forge-long-workflow-adapter');
const state = require('./forge-state');
const originalCodex = xllm.invokeCodexAppServer;
const originalEnv = process.env.FORGE_XLLM_CLAUDE_BIN;
const fixture = path.join(root, 'provider.js');
fs.writeFileSync(fixture, `
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync('invocations.txt', 'spawn\\n');
fs.writeFileSync('argv.json', JSON.stringify(args));
const p = JSON.parse(fs.readFileSync('payload.json','utf8'));
if (p.failure === 'auth') { process.stderr.write('401 invalid token'); process.exit(1); }
if (p.failure === 'process') { process.stderr.write(process.env[${JSON.stringify(accounts.TOKEN_ENV)}]); process.exit(9); }
if (p.failure === 'invalid') { process.stdout.write('not a result'); process.exit(0); }
if (p.failure === 'wait') { setInterval(() => {}, 1000); }
else process.stdout.write(['---GSD-WORKER-RESULT---','status: '+p.status,'result_json: '+JSON.stringify(p),'---END-RESULT---'].join('\\n'));
`);
process.env.FORGE_XLLM_CLAUDE_BIN = fixture;
let sequence = 0;
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); }
function setup() {
  const cwd = path.join(root, `case-${++sequence}`); fs.mkdirSync(cwd);
  write(path.join(cwd, '.gsd/forge-prefs.jsonc'), { routing: { default: { planner: { heavy: ['claude-opus-5'], max: ['claude-fable-5'] }, executor: { standard: ['claude-sonnet-5'] } } }, tier_models: { standard: 'claude-sonnet-5', heavy: 'claude-opus-5', max: 'claude-fable-5' } });
  const m = '.gsd/milestones/M001';
  write(path.join(cwd, m, 'M001-ROADMAP.md'), '# Roadmap\n\n- [ ] **S01: Work**\n');
  write(path.join(cwd, m, 'M001-CONTEXT.md'), '# Decisions\n');
  write(path.join(cwd, m, 'slices/S01/S01-PLAN.md'), '# Plan\n\n- [ ] T01: Work\n');
  return cwd;
}
function request(cwd, unitType, engine = 'claude') {
  const host = engine === 'claude' ? 'codex' : 'claude';
  // Test Codex artifact delivery with a route produced from the configured tier.
  if (engine === 'codex') {
    write(path.join(cwd, '.gsd/forge-prefs.jsonc'), { tier_models: { light: 'gpt-5.6-sol', standard: 'gpt-5.6-sol', heavy: 'gpt-5.6-sol', max: 'gpt-5.6-sol' } });
  }
  const route = resolveDispatch({ cwd, unitType, hostRuntime: host });
  const r = { cwd, contextRoot: cwd, unitType, milestoneId: 'M001',
    route,
    workflowId: `workflow-${sequence}`, dispatchId: `dispatch-${sequence}-${unitType}`,
    resultFile: path.join(root, `result-${sequence}-${unitType}.json`), constraints: { auto_commit: false, deploy: false },
    promptFile: path.join(cwd, 'prompt.md') };
  if (/slice|plan-check|execute-task/.test(unitType)) r.sliceId = 'S01';
  if (unitType === 'execute-task') r.taskId = 'T01';
  write(r.promptFile, '# Selected unit\nHonor the operator constraints.');
  return r;
}
function payload(r) { return { status: 'done', summary: 'Fixture delivery', questions: [],
  artifacts: unit.locations(r).required.map(p => ({ path: p, content: r.unitType === 'plan-milestone' ? '# Roadmap\n\n- [ ] **S01: Work**\n' : '# Valid artifact\n\nFixture evidence.\n' })) }; }
async function rejects(fn, code) { await assert.rejects(fn, e => e.code === code, code); }

(async () => {
  for (const host of ['claude', 'codex']) for (const engine of ['claude', 'codex']) {
    for (const unitType of [...ARTIFACT_UNITS, 'plan-slice', 'execute-task', 'review-challenger', 'review-advocate', 'review-rebuttal']) {
      assert.strictEqual(evaluateDispatchGuard({ host_runtime: host, worker_engine: engine, unit_type: unitType }).dispatch_allowed, true);
    }
    assert.strictEqual(evaluateDispatchGuard({ host_runtime: host, worker_engine: engine, worker_mode: 'sidecar', unit_type: 'review-fix' }).reason_code, 'unsupported-sidecar-unit');
  }
  for (const engine of ['claude', 'codex']) for (const type of ARTIFACT_UNITS) {
    const cwd = setup(), r = request(cwd, type, engine), p = payload(r);
    write(path.join(cwd, 'payload.json'), p);
    let codexCalls = 0;
    xllm.invokeCodexAppServer = async options => {
      codexCalls++;
      assert.strictEqual(options.sandbox, 'read-only');
      assert.strictEqual(options.model, r.route.model);
      assert.strictEqual(options.effort, r.route.effort);
      assert(options.prompt.includes('auto_commit'));
      return { finalText: JSON.stringify(p) };
    };
    assert.strictEqual((await unit.runUnitSidecar(r)).status, 'done');
    for (const a of p.artifacts) assert.strictEqual(fs.readFileSync(path.join(cwd, a.path), 'utf8'), a.content);
    // Simulate an interrupted publication (receipt durable, a target not yet written).
    fs.unlinkSync(path.join(cwd, p.artifacts[0].path));
    // Only a originally-absent target can be replayed from absence.
    const receipt = JSON.parse(fs.readFileSync(r.resultFile + '.receipt.json'));
    if (receipt.artifacts[0].before !== null) write(path.join(cwd, p.artifacts[0].path), type === 'discuss-milestone' ? '# Decisions\n' : '# Roadmap\n\n- [ ] **S01: Work**\n');
    await unit.runUnitSidecar(r);
    if (engine === 'claude') {
      assert.strictEqual(fs.readFileSync(path.join(cwd, 'invocations.txt'), 'utf8'), 'spawn\n');
      const args = JSON.parse(fs.readFileSync(path.join(cwd, 'argv.json')));
      assert.strictEqual(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
      assert.strictEqual(args[args.indexOf('--effort') + 1], r.route.effort);
      assert(!JSON.stringify(args).includes(token));
    } else assert.strictEqual(codexCalls, 1);
    const events = fs.readFileSync(path.join(cwd, '.gsd/forge/events.jsonl'), 'utf8');
    assert(events.includes('"event":"dispatch"'));
    assert(!events.includes('worker-engine-fallback'));
    write(path.join(cwd, p.artifacts[0].path), 'another writer');
    await rejects(() => unit.runUnitSidecar(r), 'artifact-conflict');
  }
  const cwd = setup(), r = request(cwd, 'research-milestone');
  write(path.join(cwd, 'payload.json'), { status: 'partial', summary: 'Need input', artifacts: [], questions: ['Required decision?'] });
  const partial = await unit.runUnitSidecar(r);
  assert.strictEqual(partial.status, 'partial');
  assert(!fs.existsSync(path.join(cwd, unit.locations(r).required[0])));
  assert(!unit.validateArtifacts({ ...payload(r), questions: ['Unanswered'] }, unit.locations(r).allowed, unit.locations(r).required));
  assert(!unit.validateArtifacts({ ...payload(r), artifacts: [{ path: '.gsd/STATE.md', content: 'poison' }] }, unit.locations(r).allowed, []));
  assert.throws(() => unit.target(cwd, '.gsd/../escape.md'));
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(cwd, '.gsd/link'), 'junction');
  assert.throws(() => unit.target(cwd, '.gsd/link/STATE.md'), e => e.code === 'artifact-link-refused');

  for (const [failure, code] of [['auth', 'claude-auth-failed'], ['invalid', 'claude-invalid-result'], ['process', 'claude-exit-nonzero']]) {
    const dir = setup(), req = request(dir, 'research-milestone');
    write(path.join(dir, 'payload.json'), { failure });
    await rejects(() => unit.runUnitSidecar(req), code);
    const output = fs.readFileSync(req.resultFile, 'utf8');
    assert(!output.includes(token));
    await rejects(() => unit.runUnitSidecar(req), 'sidecar-attempt-interrupted');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'invocations.txt'), 'utf8'), 'spawn\n');
  }
  const waitDir = setup(); write(path.join(waitDir, 'payload.json'), { failure: 'wait' });
  const abort = new AbortController();
  const waiting = claude.invokeClaudeSidecar({ cwd: waitDir, prompt: 'Fixture', timeoutMs: 10000,
    signal: abort.signal, terminateChild: xllm.terminateOwnedProcessTree });
  setTimeout(() => abort.abort(), 150);
  await rejects(() => waiting, 'claude-cancelled');
  await rejects(() => claude.invokeClaudeSidecar({ cwd: waitDir, prompt: 'Fixture', timeoutMs: 5100,
    terminateChild: xllm.terminateOwnedProcessTree }), 'claude-timeout');
  await rejects(() => claude.invokeClaudeSidecar({ cwd: waitDir, prompt: 'Fixture', timeoutMs: 10000,
    sourceEnv: { ...process.env, FORGE_XLLM_CLAUDE_BIN: path.join(root, 'missing.exe') } }), 'claude-command-not-found');
  const concurrentDir = setup(), concurrentRequest = request(concurrentDir, 'research-milestone');
  const concurrentAbort = new AbortController(); concurrentRequest.signal = concurrentAbort.signal;
  write(path.join(concurrentDir, 'payload.json'), { failure: 'wait' });
  const active = unit.runUnitSidecar(concurrentRequest);
  await rejects(() => unit.runUnitSidecar(concurrentRequest), 'sidecar-attempt-interrupted');
  concurrentAbort.abort(); await rejects(() => active, 'claude-cancelled');

  const hangingServer = path.join(root, 'hanging-appserver.js');
  write(hangingServer, 'setInterval(() => {}, 1000);');
  const codexAbort = new AbortController();
  const codexPending = require('./forge-appserver-client').startAppServerTurn({
    cmd: process.execPath, args: [hangingServer], cwd: waitDir, timeoutMs: 10000,
    signal: codexAbort.signal,
  });
  setTimeout(() => codexAbort.abort(), 100);
  await assert.rejects(() => codexPending, /cancelled/);

  // Plan/execute use their production xllm paths, not the artifact schema.
  const planDir = setup();
  function git(args) {
    const result = spawnSync('git', args, { cwd: planDir, encoding: 'utf8', windowsHide: true });
    assert.strictEqual(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(['init', '-q']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  const startSha = git(['rev-parse', 'HEAD']);
  const planRequest = request(planDir, 'plan-slice');
  const planContent = '---\ncapability: readonly\nmust_haves:\n  truths: []\n  artifacts: []\n  key_links: []\nexpected_output: []\n---\n# Task\n\n## Standards\nFixture.\n';
  write(path.join(planDir, 'payload.json'), { status: 'done', summary: 'Plan fixture',
    slice_plan: { filename: 'S01-PLAN.md', content: '# Slice\n\n- [ ] T01: Fixture\n' },
    task_plans: [{ id: 'T01', filename: 'T01-PLAN.md', content: planContent }] });
  await unit.runUnitSidecar(planRequest);
  const planFile = path.join(planDir, '.gsd/milestones/M001/slices/S01/tasks/T01-PLAN.md');
  assert.strictEqual(fs.readFileSync(planFile, 'utf8'), planContent);
  const badPlan = { ...planRequest, dispatchId: 'bad-plan', resultFile: path.join(root, 'bad-plan.json') };
  write(path.join(planDir, 'payload.json'), { status: 'done', summary: 'Invalid plan',
    slice_plan: { filename: 'S01-PLAN.md', content: '# Slice' },
    task_plans: [{ id: 'T01', filename: 'T01-PLAN.md', content: '# No must haves' }] });
  await assert.rejects(() => unit.runUnitSidecar(badPlan), /must_haves/);
  const executeRequest = request(planDir, 'execute-task'); executeRequest.planFile = planFile;
  write(path.join(planDir, 'payload.json'), { status: 'done', summary: 'Execution fixture', must_haves_status: [], files_changed: [] });
  await unit.runUnitSidecar(executeRequest);
  assert.strictEqual(git(['rev-parse', 'HEAD']), startSha);
  assert(fs.readFileSync(path.join(planDir, '.gsd/milestones/M001/slices/S01/S01-PLAN.md'), 'utf8').includes('[x] T01'));
  const reviewOptions = { cwd: planDir, engine: 'claude', hostRuntime: 'codex', sidecarDeclared: true, timeoutSecs: 20, model: 'claude-sonnet-5' };
  // Nonempty diff is needed to exercise transport, not the empty-diff shortcut.
  write(path.join(planDir, 'tracked.txt'), 'before'); git(['add', 'tracked.txt']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture baseline']);
  write(path.join(planDir, 'tracked.txt'), 'after');
  write(path.join(planDir, 'payload.json'), { status: 'done', output: { objections: [] } });
  await xllm.runChallenge({ ...reviewOptions, diffCmd: 'git diff' });
  const inputFile = path.join(planDir, 'review.md'); write(inputFile, 'R1: fixture objection');
  for (const review of [xllm.runDefend, xllm.runRebuttal]) {
    write(path.join(planDir, 'payload.json'), { status: 'done', output: { verdicts: [] } });
    await review({ ...reviewOptions, inputFile });
  }

  // Actual controller/lease lifecycle: Codex selects research, delegates to a
  // mock Claude CLI, acknowledges completion, then selects plan-slice.
  const flowDir = setup(), flow = request(flowDir, 'research-milestone');
  fs.unlinkSync(path.join(flowDir, '.gsd/milestones/M001/slices/S01/S01-PLAN.md'));
  state.write(flowDir, { milestone: 'M001', phase: 'idle', active_slice: 'S01', active_task: '—', auto_mode: 'off' });
  const input = { cwd: flowDir, milestone: 'M001', workflow_id: flow.workflowId, owner_token: 'fixture-owner',
    prefsReader: () => ({ ok: true, prefs: {} }) };
  const selected = loop.invoke('codex', 'auto', 'next', input).result;
  assert.strictEqual(selected.unit.type, 'research-milestone');
  write(path.join(flowDir, 'payload.json'), payload(flow));
  const delivered = await unit.runUnitSidecar(flow);
  const completion = loop.invoke('codex', 'auto', 'complete', { ...input, result: delivered }, selected.snapshot).result;
  assert.strictEqual(completion.action, 'continue', JSON.stringify(completion));
  const replay = loop.invoke('codex', 'auto', 'complete', { ...input, result: delivered }, selected.snapshot).result;
  assert.strictEqual(replay.action, 'continue', JSON.stringify(replay));
  const next = loop.invoke('codex', 'auto', 'next', input, completion.snapshot).result;
  assert.strictEqual(next.unit.type, 'plan-slice', JSON.stringify(next));
  assert.strictEqual(next.snapshot.workflow_id, flow.workflowId);
  assert.strictEqual(next.host_runtime, 'codex');
  console.log('Bidirectional contracts, artifact replay/conflicts, failure classification and Codex forge-auto progression passed (fixture providers only).');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  accounts.resolveLaunch = originalLookup; xllm.invokeCodexAppServer = originalCodex;
  if (originalEnv === undefined) delete process.env.FORGE_XLLM_CLAUDE_BIN; else process.env.FORGE_XLLM_CLAUDE_BIN = originalEnv;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
});
