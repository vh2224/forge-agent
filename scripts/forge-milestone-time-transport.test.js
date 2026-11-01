#!/usr/bin/env node
'use strict';

// Actual adapters, isolated owners and stub providers. No remote execution.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { digest } = require('./forge-code-roots');
const fixtures = require('./forge-code-roots.test');
const time = require('./forge-milestone-time');
const admission = require('./forge-milestone-time-admission');
const controller = require('./forge-unit-controller');
const recovery = require('./forge-attempt-recovery');
const resolver = require('./forge-dispatch-resolve');
const sidecar = require('./forge-unit-sidecar');
const xllm = require('./forge-xllm');
const BASE = Date.parse('2026-11-01T12:00:00Z'), M = 'M001';
let serial = 0, passed = 0;
const labs = [];
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const iso = value => new Date(value).toISOString();
async function test(name, fn) { await fn(); passed++; console.log('PASS T06 ' + name); }
function write(cwd, name, content) {
  const file = path.join(cwd, name); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)); return file;
}
function activate(cwd, base = BASE) {
  const questions = require('./forge-pending-questions'), id = 'budget-' + ++serial;
  const opened = questions.openQuestions({ cwd, milestone: M, unit: 'milestone-time/' + id,
    decision_set: 'milestone-time-activation', questions: [{ id, question: 'Fixture choice?' }] });
  questions.answer({ cwd, identity: opened.identity_sha256, answers: [{ id, answer: 'option:fixture', source: 'user-text' }] });
  const contract = { schema_version: 1, milestone: M, clock_policy: { id: 'forge-milestone-time-clock', version: 1 },
    option: { id: 'fixture', options_sha256: 'a'.repeat(64), label: 'Verified fixture' }, activated_at: iso(base),
    preselection_started_at: iso(base), ceiling_ms: 100,
    endpoint: { kind: 'verified-integrated-delivery', items: Object.fromEntries(time.ENDPOINT_ITEMS.map(k => [k, 'pending'])) },
    allocation: null, linked_task: null, chain_forecast: null };
  const live = { reference: 'live-' + id, status: 'resolved', answer: 'option:fixture', source: 'user-text',
    resolved_at: iso(base), question: { identity_sha256: opened.identity_sha256, id } };
  const handle = time.createDecisionAuthority(() => live).issue(live.reference,
    { milestone: M, kind: 'activation', request_sha256: digest(contract), expires_at: base + 60000 }, () => base);
  time.activateContract({ cwd, milestone: M, contract, now: base, handle });
}
function corpus(cwd) {
  const manifest = read(path.join(__dirname, '../shared/forge-procedures.json'));
  for (const item of manifest.modules.filter(row => row.status === 'ready')) {
    write(cwd, item.path, fs.readFileSync(path.join(__dirname, '..', item.path), 'utf8'));
  }
  write(cwd, 'shared/forge-procedures.json', manifest);
}
function fixture(contract = true, base = BASE) {
  const lab = fixtures.fixture(); labs.push(lab);
  fs.mkdirSync(path.join(lab.owner, '.gsd/forge'), { recursive: true });
  if (contract) activate(lab.owner, base);
  corpus(lab.a);
  const f = { ...lab, at: 1, base };
  const plan = write(lab.owner, '.gsd/milestones/M001/slices/S01/tasks/T01/T01-PLAN.md', fixtures.plan(lab.contract));
  write(lab.owner, '.gsd/milestones/M001/slices/S01/S01-PLAN.md', '# Slice\n- [ ] **T01** fixture\n');
  f.plan = plan;
  require('./forge-state').write(lab.owner, { milestone: M, kind: 'milestone', phase: 'idle', active_slice: 'S01', active_task: 'T01', auto_mode: 'on' });
  f.begin = controller.begin(lab.owner, { milestone: M, slice: 'S01', unit: 'plan-slice/S01',
    host_runtime: 'codex', owner_token: 'fixture', idempotency_key: 'before-cap' }, {
    now: () => base + f.at, prefsReader: () => ({ ok: true, prefs: {} }),
    inventoryReader: () => ({ slices: [{ id: 'S01', tasks: [{ id: 'T01' }] }] }) });
  assert.equal(f.begin.ok, true, JSON.stringify(f.begin));
  return f;
}
function request(f, engine, unitType = 'research-milestone') {
  const host = engine === 'claude' ? 'codex' : 'claude';
  const model = engine === 'claude' ? 'claude-sonnet-5' : 'gpt-6-sol';
  const tiers = Object.fromEntries(['light', 'standard', 'heavy', 'max'].map(tier => [tier, [model]]));
  write(f.owner, '.gsd/forge-prefs.jsonc', { tier_models: Object.fromEntries(
    ['light', 'standard', 'heavy', 'max'].map(tier => [tier, [model]])), routing: { default: { executor: tiers, planner: tiers } },
    effort: { 'plan-slice': 'medium' } });
  const id = 'budget-transport-' + ++serial;
  const r = { cwd: f.a, contextRoot: f.owner, milestoneId: M, scope: 'milestone',
    phase: unitType.split('-')[0], unitType, dispatchId: id, workflowId: 'fixture-workflow',
    resultFile: path.join(f.dir, id + '.json'), prompt: 'Isolated fixture only.' };
  if (unitType === 'plan-slice' || unitType === 'execute-task') r.sliceId = 'S01';
  if (unitType === 'plan-slice') r.promptFile = write(f.dir, id + '-prompt.md', 'Isolated fixture only.');
  if (unitType === 'execute-task') {
    r.phase = 'execute'; r.taskId = 'T01'; r.planFile = f.plan; r.execution_contract = f.contract;
    r.verification = { preferenceCommands: ['node --version'] }; r.runId = 'fixture-run';
    r.claim = { schema_version: 2, generation: 'budget-claim', execution_contract: f.contract,
      paths: ['alpha', 'beta'].map(root_id => ({ root_id, path: 'same.txt' })) };
    r.gates = { plan: 'skipped', planSkipReason: 'interactive-off', claim: 'proceed', security: 'not-applicable' };
    require('./forge-runs').add(f.owner, { id: r.runId, kind: 'milestone', session_id: 'fixture', write_claim: r.claim });
  }
  r.route = resolver.resolveDispatch({ cwd: f.owner, unitType, milestoneId: M,
    unitId: r.taskId || r.sliceId || M, planPath: r.planFile, hostRuntime: host });
  assert.equal(r.route.resolved_worker_engine, engine); assert.equal(r.route.worker_mode, 'sidecar');
  return r;
}
function runtime(f, stages = []) { return { now: () => f.base + f.at, announce: (stage, fields) => stages.push({ stage, ...fields }) }; }
function refusal(error) { assert(['milestone-budget-exhausted', 'milestone-budget-draining'].includes(error.code), error.code); assert.equal(error.provider_called, false); return true; }
async function stopped(f, r) {
  const stages = [];
  await assert.rejects(sidecar.runUnitSidecar(r, runtime(f, stages)), refusal);
  const receipt = read(r.resultFile + '.receipt.json');
  assert.equal(receipt.phase, 'failed'); assert(admission.TRANSPORT_REFUSAL_CODES.includes(receipt.failure.reason_code));
  assert.equal(receipt.failure.provider_called, false); assert.equal(receipt.failure.layer, 'milestone-time-admission');
  if (r.unitType === 'execute-task') {
    assert.equal(receipt.failure.possible_writes, false); assert.equal(receipt.failure.reconciliation_required, false);
  }
  assert(stages.some(row => row.stage === 'recusado' && row.provider_called === false));
  const state = read(r.resultFile + '.recovery.json'), last = state.attempts.at(-1);
  assert.equal(last.failure_class, 'caller'); assert.equal(last.layer, 'milestone-time-admission'); assert.equal(last.provider_called, false);
  let candidates = 0;
  const session = recovery.createRecovery({ unit: state.unit, roots_sha256: state.roots_sha256, state });
  const next = await session.next({ inspection: { process_stopped: true, receipt_checked: true, writer_possible: false },
    validateInvocation: () => { candidates++; return { ok: true }; } });
  assert.equal(next.action, 'stop'); assert.equal(next.reason_code, receipt.failure.reason_code); assert.equal(candidates, 0);
  assert.equal((await session.next({ inspection: { process_stopped: true, receipt_checked: true, valid_saved_response: true } })).action, 'replay');
}
async function main() {
  const f = fixture();
  const original = Object.fromEntries(['invokeClaudeTransport', 'invokeCodexAppServer', 'runPlan', 'runExecute', 'terminateOwnedProcessTree'].map(key => [key, xllm[key]]));
  const spawn = cp.spawn;
  let providers = 0, spawns = 0, kills = 0;
  const provider = async () => { providers++; throw Object.assign(Error('fixture provider reached'), { code: 'fixture-provider-reached', provider_called: true }); };
  for (const key of ['invokeClaudeTransport', 'invokeCodexAppServer', 'runPlan', 'runExecute']) xllm[key] = provider;
  cp.spawn = () => { spawns++; throw Error('unexpected provider spawn'); };
  xllm.terminateOwnedProcessTree = () => { kills++; throw Error('unexpected process termination'); };
  try {
    f.at = 101;
    for (const [engine, unit, seam] of [['claude', 'research-milestone', 'invokeClaudeTransport'], ['codex', 'research-milestone', 'invokeCodexAppServer'],
      ['claude', 'plan-slice', 'runPlan'], ['codex', 'execute-task', 'runExecute']]) {
      await test('controller begin below cap then ' + seam + ' refused beyond cap with failed receipt and recovery stop', async () => {
        await stopped(f, request(f, engine, unit)); assert.equal(providers, 0); assert.equal(spawns, 0); assert.equal(kills, 0);
      });
    }
    await test('every transport entry rechecks before recoveryReady; saved ready replay and publication remain allowed beyond cap', async () => {
      f.at = 1; const r = request(f, 'claude'); let ready = 0;
      xllm.invokeClaudeTransport = async options => {
        providers++; assert.equal(ready, 1); f.at = 101;
        assert.throws(() => options.enterTransport(), refusal);
        return { candidate: { status: 'partial', summary: 'fixture', questions: [], artifacts: [] } };
      };
      await sidecar.runUnitSidecar(r, { ...runtime(f), assertRecoveryReady: () => { ready++; } });
      assert.equal(ready, 1); assert.equal(providers, 1);
      assert.equal(read(r.resultFile + '.receipt.json').phase, 'ready');
      const replayed = await sidecar.runUnitSidecar(r, runtime(f));
      assert.equal(replayed.status, 'partial'); assert.equal(providers, 1);
      xllm.invokeClaudeTransport = provider; providers = 0;
    });
    await test('below cap and no-contract legacy each call the same stub provider exactly once', async () => {
      for (const current of [f, fixture(false)]) {
        current.at = current === f ? 1 : 10000;
        for (const [engine, unit] of [['claude', 'research-milestone'], ['codex', 'research-milestone'],
          ['claude', 'plan-slice'], ['codex', 'execute-task']]) {
        const r = request(current, engine, unit);
        const before = providers;
        await assert.rejects(sidecar.runUnitSidecar(r, runtime(current)), error => error.code === 'fixture-provider-reached');
        assert.equal(providers, before + 1);
        }
      }
      assert.equal(spawns, 0); assert.equal(kills, 0);
    });
  } finally { Object.assign(xllm, original); cp.spawn = spawn; }
  await test('real saved executed response replays verification and publication beyond cap without provider reentry', async () => {
    const current = fixture(), r = request(current, 'codex', 'execute-task');
    const verify = require('./forge-verify'), capture = verify.captureRootDelivery, execute = xllm.runExecute;
    let calls = 0;
    try {
      xllm.runExecute = async () => { calls++; current.at = 101; return {
        status: 'done', summary: 'Fixture response saved before verification.', files_changed: [], must_haves_status: [] }; };
      verify.captureRootDelivery = () => { throw Object.assign(Error('fixture verification interruption'), { code: 'fixture-verification-interrupted' }); };
      await assert.rejects(sidecar.runUnitSidecar(r, runtime(current)), error => error.code === 'fixture-verification-interrupted');
      assert.equal(read(r.resultFile + '.receipt.json').phase, 'executed');
      verify.captureRootDelivery = capture;
      const replayed = await sidecar.runUnitSidecar(r, runtime(current));
      assert.equal(replayed.status, 'done'); assert.equal(calls, 1);
      assert.equal(read(r.resultFile + '.receipt.json').phase, 'ready');
    } finally { verify.captureRootDelivery = capture; xllm.runExecute = execute; }
  });
  await recoveryEntries(f);
  await reviewEntries(f);
  await test('declared artifacts substantive without module stubs', () => {
    for (const [name, minimum] of [['forge-unit-sidecar.js', 3365], ['forge-attempt-recovery.js', 1090], ['forge-milestone-time-transport.test.js', 240]]) {
      const bytes = fs.readFileSync(path.join(__dirname, name), 'utf8'); assert(bytes.split('\n').length >= minimum);
      if (!name.endsWith('.test.js')) assert(!/TODO|TBD|FIXME/.test(bytes));
    }
  });
  console.log('PASS T06 transport suite ' + passed + ' checks; stub providers only; heavy consumers pending owner consolidation');
}
async function recoveryEntries(f) {
  await test('native delivery recovery rechecks after readiness before session start, consumption and host callback', async () => {
    const delivery = require('./forge-native-recovery-delivery');
    const saved = { recover: recovery.recoverAttempt, prepare: delivery.prepare, packagePrompt: delivery.packagePrompt, replay: delivery.replay };
    let calls = 0, starts = 0, consumed = 0;
    try {
      f.at = 1; const r = request(f, 'codex', 'execute-task');
      const route = { ...r.route, host_runtime: 'codex', resolved_worker_engine: 'codex', dispatch_engine: 'codex',
        worker_mode: 'native', model: 'gpt-6-sol', model_resolved: 'gpt-6-sol', config_ok: true };
      delivery.packagePrompt = (_request, prompt) => prompt;
      delivery.replay = () => null;
      delivery.prepare = () => ({ start: () => { starts++; return {}; }, returned: () => {} });
      recovery.recoverAttempt = async options => {
        const binding = await options.validateInvocation(route); assert.equal(binding.ok, true, binding.reason_code);
        const ready = () => { f.at = 101; }; ready.consumeInvocation = () => { consumed++; };
        const descriptor = await options.invoke(route, binding, null, ready, 'b'.repeat(64));
        return descriptor.invoke(async () => { calls++; return { status: 'done', summary: 'fixture', files_changed: [], must_haves_status: [] }; });
      };
      const receipt = write(f.dir, 'native-delivery-old-receipt.json', {});
      const outcome = await sidecar.recoverUnitSidecar(r, { transitions: [{ type: 'uninvoked-native-reservation' }],
        resumeReservation: { sha256: 'b'.repeat(64) }, stateFile: path.join(f.dir, 'native-delivery-state.json'), receiptFile: receipt },
      { ...runtime(f), assertBoundary: () => {}, activeCapabilities: { available: true, tool: 'spawn_agent',
        models: ['gpt-6-sol'], reasoning_efforts: ['medium'], fork_turns: ['none'] } });
      assert(admission.TRANSPORT_REFUSAL_CODES.includes(outcome.reason_code), outcome.reason_code);
      assert.equal(outcome.provider_called, false); assert.equal(calls, 0); assert.equal(starts, 0); assert.equal(consumed, 0);
    } finally { recovery.recoverAttempt = saved.recover; delivery.prepare = saved.prepare; delivery.packagePrompt = saved.packagePrompt; delivery.replay = saved.replay; }
  });
  await test('real Claude session resume reenters sidecar, refuses before provider and stops without another candidate', async () => {
    f.at = 1;
    const r = request(f, 'claude', 'plan-slice'), sessions = require('./forge-claude-session');
    const ref = sessions.createSessionRef({ id: sessions.newSessionId(), accountName: null,
      configDir: path.join(f.dir, 'fixture-profile', '.claude'), cwd: f.a, now: BASE });
    const originalPlan = xllm.runPlan;
    let calls = 0, kills = 0;
    const originalKill = xllm.terminateOwnedProcessTree;
    try {
      xllm.runPlan = async () => { calls++; throw Object.assign(Error('fixture active worker ceiling'), {
        code: 'budget-exceeded-while-active', provider_called: true, session: ref }); };
      await assert.rejects(sidecar.runUnitSidecar(r, runtime(f)), error => error.code === 'budget-exceeded-while-active');
      assert.equal(calls, 1);
      xllm.terminateOwnedProcessTree = () => { kills++; throw Error('unexpected termination'); };
      f.at = 101;
      const result = await sidecar.recoverUnitSidecar(r, { stateFile: r.resultFile + '.recovery.json', receiptFile: r.resultFile + '.receipt.json' },
        { ...runtime(f), processProbe: () => 'stopped', verifyOwnership: () => true });
      assert.equal(result.action, 'stop'); assert.equal(result.reason_code, 'budget-exceeded-resume-refused');
      assert.equal(result.provider_called, false); assert(admission.TRANSPORT_REFUSAL_CODES.includes(result.refusal), result.refusal);
      assert.equal(calls, 1); assert.equal(kills, 0);
      const state = read(r.resultFile + '.recovery.json');
      assert.equal(state.attempts.at(-1).reason_code, result.refusal);
      assert.equal(state.attempts.at(-1).provider_called, false);
      assert.equal(state.attempts.at(-1).layer, 'milestone-time-admission');
      assert.equal(state.reservations.length, 1);
      assert.equal(state.reservations[0].reason, 'same-session-resume');
    } finally { xllm.runPlan = originalPlan; xllm.terminateOwnedProcessTree = originalKill; }
  });
  await test('all transport refusal codes stop recovery before candidate, correction, resume or standing exception', async () => {
    const r = request(f, 'claude');
    for (const code of admission.TRANSPORT_REFUSAL_CODES) {
      const session = recovery.createRecovery({ unit: 'research-milestone/M001', roots_sha256: 'fixture', request: r });
      session.record({ reason_code: code, failure_class: 'caller', route: r.route, layer: 'milestone-time-admission', provider_called: false,
        request_sha256: 'fixture-request', context_sha256: 'fixture-context', request_bytes: 1, context_bytes: 1, duration_ms: 0, budgets: {} });
      const authority = recovery.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: iso(BASE) }));
      const exception = authority.issue('fixture-standing', { unit: 'research-milestone/M001', roots_sha256: 'fixture',
        purpose: 'sidecar-recovery', expires_at: BASE + 60000, routes: [recovery.routeKey(r.route)], gates_preserved: true }, () => BASE);
      const result = await session.next({ inspection: { process_stopped: true, receipt_checked: true, writer_possible: false },
        exception, correction: { approved: true }, validateInvocation: () => { throw Error('unexpected candidate'); } });
      assert.equal(result.action, 'stop'); assert.equal(result.reason_code, code);
      assert.equal(session.snapshot().attempts.length, 1); assert(!session.snapshot().reservations?.length);
    }
  });
  // The recovery owner still selects/reserves below cap. Its actual native and
  // resumed-sidecar callbacks must read the clock again when invoked later.
  await test('recovery native and sidecar reservations made below cap are refused on actual entry', async () => {
    const originalRecover = recovery.recoverAttempt;
    const originalClaude = xllm.invokeClaudeTransport;
    let hostCalls = 0, consumed = 0;
    try {
      for (const native of [true, false]) {
        f.at = 1; const r = request(f, 'claude');
        const route = native ? { ...r.route, host_runtime: 'codex', resolved_worker_engine: 'codex', dispatch_engine: 'codex',
          worker_mode: 'native', model: 'gpt-6-sol', model_resolved: 'gpt-6-sol', config_ok: true } : r.route;
        recovery.recoverAttempt = async options => {
          const binding = await options.validateInvocation(route); assert.equal(binding.ok, true, binding.reason_code);
          const ready = () => { if (native) f.at = 101; }; ready.consumeInvocation = () => { consumed++; };
          const decision = await options.invoke(route, binding, null, ready, 'fixture-reservation');
          if (native) return decision.invoke(async () => { hostCalls++; return { status: 'done' }; });
          return decision;
        };
        xllm.invokeClaudeTransport = async () => { hostCalls++; throw Error('unexpected provider'); };
        if (!native) recovery.recoverAttempt = async options => {
          const binding = await options.validateInvocation(route); assert.equal(binding.ok, true);
          f.at = 101; return options.invoke(route, binding, null, () => {}, 'fixture-reservation');
        };
        const value = sidecar.recoverUnitSidecar(r, {}, { ...runtime(f), activeCapabilities: { available: true, tool: 'spawn_agent',
          models: ['gpt-6-sol'], reasoning_efforts: ['medium'], fork_turns: ['none'] } });
        if (native) { const outcome = await value; assert(admission.TRANSPORT_REFUSAL_CODES.includes(outcome.reason_code), outcome.reason_code); assert.equal(outcome.provider_called, false); }
        else await assert.rejects(value, refusal);
      }
      assert.equal(hostCalls, 0); assert.equal(consumed, 0);
    } finally { recovery.recoverAttempt = originalRecover; xllm.invokeClaudeTransport = originalClaude; }
  });
}
async function reviewEntries(f) {
  await test('external challenge defense rebuttal API rechecks actual context with zero provider spawn', async () => {
    const client = require('./forge-appserver-client'), start = client.startAppServerTurn, spawn = cp.spawn;
    let calls = 0, spawns = 0;
    client.startAppServerTurn = () => { calls++; throw Object.assign(Error('fixture provider reached'), { code: 'fixture-provider-reached' }); };
    cp.spawn = () => { spawns++; throw Error('unexpected provider spawn'); };
    try {
    const context = { cwd: f.owner, milestone: M, unit: 'review-slice/S01' };
    f.at = 1; admission.assertOwnerTransportEntry({ milestoneTimeContext: context, now: () => BASE + f.at });
    f.at = 101;
    const input = write(f.dir, 'review-input.json', { objections: [] });
    for (const driver of [xllm.runChallenge, xllm.runDefend, xllm.runRebuttal]) {
      await assert.rejects(driver({ cwd: f.a, contextRoot: f.owner, milestoneTimeContext: context,
        now: () => BASE + f.at, engine: 'codex', hostRuntime: 'claude', sidecarDeclared: true,
        model: 'gpt-6-sol', effort: 'medium', diffCmd: 'git diff', inputFile: input }), refusal);
    }
    assert.throws(() => admission.assertOwnerTransportEntry({ contextRoot: f.owner,
      milestoneTimeContext: { ...context, cwd: f.a } }), error => error.code === 'milestone-time-invalid');
    assert.throws(() => admission.assertOwnerTransportEntry({ milestoneTimeContext: { ...context, now: BASE } }), error => error.code === 'milestone-time-invalid');
    assert.equal(calls, 0); assert.equal(spawns, 0);
    for (const scoped of [true, false]) {
      f.at = 1;
      await assert.rejects(xllm.runChallenge({ cwd: f.a, contextRoot: f.owner,
        ...(scoped ? { milestoneTimeContext: context } : {}), now: () => BASE + f.at,
        engine: 'codex', hostRuntime: 'claude', sidecarDeclared: true, model: 'gpt-6-sol', effort: 'medium', diffCmd: 'git diff' }),
      error => error.code === 'fixture-provider-reached');
    }
    assert.equal(calls, 2); assert.equal(spawns, 0);
    } finally { client.startAppServerTurn = start; cp.spawn = spawn; }
  });
  await test('external review CLI carries explicit budget identity and uses current clock before spawn', () => {
    const cliFixture = fixture(true, Date.now() - 1000);
    const input = write(cliFixture.dir, 'review-input.json', { objections: [] });
    const capture = path.join(cliFixture.dir, 'provider-entry.txt');
    const preload = write(cliFixture.dir, 'no-provider.cjs', "require('child_process').spawn = () => { throw Error('provider-spawn-forbidden'); };\n"
      + `require(${JSON.stringify(path.join(__dirname, 'forge-appserver-client.js'))}).startAppServerTurn = () => { require('fs').writeFileSync(${JSON.stringify(capture)}, 'entered'); throw Error('provider-spawn-forbidden'); };\n`);
    for (const mode of ['challenge', 'defend', 'rebuttal']) {
      const result = cp.spawnSync(process.execPath, ['--require', preload, path.join(__dirname, 'forge-xllm.js'),
        '--mode', mode, '--engine', 'codex', '--host-runtime', 'claude', '--sidecar-declared',
        '--model', 'gpt-6-sol', '--effort', 'medium', '--cwd', cliFixture.a, '--context-root', cliFixture.owner,
        '--diff-cmd', 'git diff', '--input', input, '--budget-owner', cliFixture.owner,
        '--budget-milestone', M, '--budget-unit', 'review-slice/S01'], { encoding: 'utf8', timeout: 20000 });
      assert.equal(result.status, 2, result.stderr); assert.equal(result.stdout, '');
      assert(/milestone-budget-(exhausted|draining)/.test(result.stderr), result.stderr);
      assert(!result.stderr.includes('provider-spawn-forbidden'), result.stderr);
      assert(result.stderr.includes('"provider_called":false'), result.stderr);
      assert(!fs.existsSync(capture));
    }
  });
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; })
  .finally(() => { for (const lab of labs) lab.cleanup(); });
