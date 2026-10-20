'use strict';

// Integration boundaries only: existing unit suites retain their detailed negatives.
// Every provider is injected. The restart below is an OS process, not a new object.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
// Set isolation before loading modules which may cache preference sources.
if (!['--isolated', '--restart-fixture', '--milestone-restart'].includes(process.argv[2])) {
  const bootstrap = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-workflow-home-'));
  try {
    const run = spawnSync(process.execPath, [__filename, '--isolated'], { encoding: 'utf8', timeout: 120000,
      env: { ...process.env, HOME: bootstrap, USERPROFILE: bootstrap, CODEX_HOME: path.join(bootstrap, '.codex'),
        CLAUDE_CONFIG_DIR: path.join(bootstrap, '.claude'), FORGE_HOME: path.join(bootstrap, 'forge') } });
    process.stdout.write(run.stdout || ''); process.stderr.write(run.stderr || '');
    process.exitCode = run.status === 0 ? 0 : 1;
  } finally { fs.rmSync(bootstrap, { recursive: true, force: true }); }
} else {
const prep = require('./forge-task-preparation');
const interaction = require('./forge-interaction');
const personal = require('./forge-personal-context');
const controller = require('./forge-unit-controller');
const unit = require('./forge-unit-sidecar');
const xllm = require('./forge-xllm');

const capabilities = { available: true, tool: 'collaboration.spawn_agent', source: 'fixture',
  models: ['gpt-5.6-sol'], reasoning_efforts: ['medium'], fork_turns: ['none'] };
const reference = 'conversation:workflow-fixture';
const content = '# Brainstorm\n\n## Recommended Approach\n\nUse canonical callers.\n\n## Alternatives Considered\n\nRepeat transport.\n\n## Top Risks\n\nLost authority.\n\n## Out of Scope\n\nReal providers and UAT.\n';
function envelope(request) {
  return { status: 'done', summary: 'Fixture only', questions: [],
    artifacts: [{ path: prep.requiredArtifact(request), content }] };
}
function authority(profile, now, register) {
  const adapter = interaction.createRecoveryAuthorizationAdapter(observed => ({ ...observed,
    received: true, answer: 'authorize', resolved_at: now }), { resolveProfile: () => profile, clock: () => now });
  return { adapter, reference, ...(register ? { registration: { host: 'codex', section: 'user:forge-routing-continuity' } } : {}) };
}
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }
function child(args, env) {
  const run = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120000, env });
  assert.equal(run.status, 0, `${args.join(' ')}\n${run.stdout}\n${run.stderr}\n${run.error || ''}`);
  return run.stdout;
}
async function restart(file) {
  const saved = JSON.parse(fs.readFileSync(file));
  const { request, profile } = saved;
  const stateFile = request.resultFile + '.recovery.json', receiptFile = request.resultFile + '.receipt.json';
  const initial = JSON.parse(fs.readFileSync(stateFile));
  const now = initial.deadline_at + 1;
  request.activeCapabilities = capabilities;
  let calls = 0;
  const result = await prep.recoverStandaloneTask(request, { stateFile, receiptFile, clock: () => now }, {
    processProbe: () => 'stopped', recoveryAuthorization: authority(profile, now),
    invokeNative: async args => {
      calls++;
      assert.equal(args.model, 'gpt-5.6-sol'); assert.equal(args.reasoning_effort, 'medium');
      assert.equal(args.fork_turns, 'none');
      return `---GSD-WORKER-RESULT---\nstatus: done\nresult_json: ${JSON.stringify(envelope(request))}\n---END-RESULT---`;
    },
  });
  assert.equal(result.result.status, 'done'); assert.equal(result.sidecar_remaining_ms, 0);
  assert.equal(calls, 1); assert.equal(result.route.worker_mode, 'native');
  assert.equal(JSON.parse(fs.readFileSync(stateFile)).deadline_at, initial.deadline_at);
  const published = path.join(request.contextRoot, prep.requiredArtifact(request));
  const bytes = fs.readFileSync(published), stat = fs.statSync(published);
  const acceptedRequest = { ...request, recoveryStateFile: stateFile };
  // Replay the accepted dispatch through its canonical persisted receipt.
  const files = fs.readdirSync(path.dirname(request.resultFile)).filter(name => name.endsWith('.receipt.json'));
  const accepted = files.map(name => path.join(path.dirname(request.resultFile), name))
    .find(name => JSON.parse(fs.readFileSync(name)).phase === 'ready');
  assert(accepted, JSON.stringify(files));
  const receipt = JSON.parse(fs.readFileSync(accepted));
  acceptedRequest.resultFile = accepted.replace(/\.receipt\.json$/, '');
  acceptedRequest.dispatchId = receipt.dispatch_id;
  const replay = await prep.prepareStandaloneTask(acceptedRequest, {
    resolveDispatch() { throw Error('replay must not resolve'); },
    invokeNative() { throw Error('replay must not invoke'); },
  });
  assert.equal(replay.replayed, true, JSON.stringify(replay)); assert.equal(replay.provider_called, false);
  assert.deepEqual(fs.readFileSync(published), bytes); assert.equal(fs.statSync(published).mtimeMs, stat.mtimeMs);
  fs.writeFileSync(file + '.result.json', JSON.stringify({ pid: process.pid, calls, receipt: accepted, published,
    deadline_at: initial.deadline_at, sidecar_remaining_ms: result.sidecar_remaining_ms }));
}
async function main() {
  if (process.argv[2] === '--restart-fixture') return restart(process.argv[3]);
  if (process.argv[2] === '--milestone-restart') {
    const request = JSON.parse(fs.readFileSync(process.argv[3]));
    const receiptFile = request.resultFile + '.receipt.json';
    const receipt = JSON.parse(fs.readFileSync(receiptFile));
    const legacy = { ...receipt }; delete legacy.execution; delete legacy.reset_state_file;
    write(receiptFile, JSON.stringify(legacy));
    const recovery = require('./forge-attempt-recovery');
    assert.equal(recovery.inspectReceipt(receiptFile, { request }).writer_possible, true);
    let calls = 0;
    xllm.runExecute = async () => { calls++; throw Error('writer must remain blocked'); };
    for (const status of ['alive', 'stopped']) await assert.rejects(unit.recoverUnitSidecar(request,
      { stateFile: request.resultFile + '.recovery.json', receiptFile }, { processProbe: () => status }),
      status === 'alive' ? /process-receipt-inspection/ : /writer-reconciliation/);
    const partial = unit.reconcileMilestoneAttempt(request, legacy, { verifyOwnership: row => row.root_id === 'alpha' });
    assert.equal(partial.ok, false);
    await assert.rejects(unit.recoverUnitSidecar(request,
      { stateFile: request.resultFile + '.recovery.json', receiptFile }, { processProbe: () => 'stopped' }), /writer-reconciliation/);
    assert.equal(calls, 0);
    const tampered = structuredClone(legacy); tampered.recovery_baseline.state_sha256 = 'tampered';
    assert.throws(() => unit.reconcileMilestoneAttempt(request, tampered, { verifyOwnership: () => true }), /baseline-binding/);
    const absent = { ...legacy }; delete absent.recovery_baseline;
    assert.throws(() => unit.reconcileMilestoneAttempt(request, absent, { verifyOwnership: () => true }), /baseline-required/);
    const reset = unit.reconcileMilestoneAttempt(request, legacy, { verifyOwnership: row =>
      row.attempt === request.dispatchId && ['alpha', 'beta'].includes(row.root_id) && row.path === 'same.txt' });
    assert.equal(reset.ok, true);
    write(process.argv[3] + '.proof', JSON.stringify({ pid: process.pid, calls, roots: reset.roots.map(row => row.root_id) }));
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-recovery-workflow-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), FORGE_HOME: path.join(root, 'forge-home') };
  try {
    const roots = require('./forge-code-roots.test');
    for (const file of ['shared/forge-dispatch.md', 'shared/forge-bidirectional-sidecar.md',
      'skills/forge-task/SKILL.md', 'skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md']) {
      const contract = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      for (const token of ['createRecoveryAuthorizationAdapter', 'registerStandingAuthorization',
        'createRecoveryAuthority', 'recoverStandaloneTask', 'recoverUnitSidecar', 'captureMilestoneBaseline',
        'reconcileMilestoneAttempt', '60000ms', 'shared/forge-interaction.md']) assert(contract.includes(token), `${file}: ${token}`);
    }
    console.log('PASS canonical caller contracts share authority, phase adapter, caller baseline and historical budget references');
    const cwd = path.join(root, 'code'), owner = path.join(root, 'owner'); fs.mkdirSync(cwd);
    roots.command('git', ['init', '-q'], cwd);
    roots.command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], cwd);
    write(path.join(owner, '.gsd/forge-prefs.jsonc'), JSON.stringify({ tier_models: Object.fromEntries(
      ['light', 'standard', 'heavy', 'max'].map(tier => [tier, ['claude-sonnet-5', 'gpt-5.6-sol']])), effort: { 'plan-slice': 'medium' } }));
    write(path.join(home, '.codex/AGENTS.md'), '<!-- user:forge-routing-continuity:start -->\nFixture authority.\n<!-- user:forge-routing-continuity:end -->');
    const request = { schema_version: 1, scope: 'standalone-task', phase: 'brainstorm', taskId: 'T-20261019000000-workflow',
      cwd, contextRoot: owner, hostRuntime: 'codex', workflowId: 'workflow', dispatchId: 'timeout',
      resultFile: path.join(root, 'results/result.json'), constraints: { auto_commit: false, deploy: false }, inputs: { brief: 'Fixture only' } };
    fs.mkdirSync(path.dirname(request.resultFile));
    const failed = await prep.prepareStandaloneTask(request, { recoveryAuthorization: authority(home, Date.now(), true),
      invokeSidecar: async () => { throw Object.assign(Error('fixture timeout'), { code: 'claude-timeout' }); } });
    assert.equal(failed.ok, false); assert.equal(failed.provider_called, 'unknown');
    const saved = path.join(root, 'restart.json'); write(saved, JSON.stringify({ request, profile: home }));
    child([__filename, '--restart-fixture', saved], env);
    const proof = JSON.parse(fs.readFileSync(saved + '.result.json'));
    assert.notEqual(proof.pid, process.pid); assert.equal(proof.calls, 1); assert.equal(proof.sidecar_remaining_ms, 0);
    console.log('PASS R1/R2/R4: caller -> attested authority -> unknown timeout -> new process -> native after deadline -> one publication/replay');

    const f = require('./forge-personal-context.test').fixture();
    try {
      const work = f.work('TASK-001'); f.bind('TASK-001');
      const evidence = path.join(work.dir, 'receipt-reference.json'); write(evidence, JSON.stringify(proof));
      const checkpoint = { acceptances: [{ text: 'Plan accepted', source: work.source, resolved: true }],
        pending: [{ text: 'functional-source: Choose deployment environment', source: evidence }],
        lastResult: [{ text: 'Simulated provider contract verified; UAT pending', source: evidence }],
        nextAction: [{ text: 'Await functional-source answer and real UAT', source: evidence }] };
      assert.equal(personal.saveCheckpoint({ ...f.options, id: 'TASK-001', intent: 'checkpoint', checkpoint }).status, 'ok');
      assert.equal(personal.saveCheckpoint({ ...f.options, id: 'TASK-001', intent: 'checkpoint', checkpoint: {
        lastResult: checkpoint.lastResult, nextAction: checkpoint.nextAction } }).status, 'ok');
      const current = personal.readPersonalSnapshot(f.options).works[0];
      assert.equal(current.activity, 'inactive'); assert.equal(current.workStatus, 'pending');
      assert.equal(current.checkpoint.acceptances[0].resolved, true);
      assert(current.checkpoint.pending[0].text.includes('functional-source'));
      assert(current.nextAction.text.includes('real UAT'));
    } finally { f.cleanup(); }
    console.log('PASS R8: temporary personal checkpoint preserves acceptance, functional pending and evidenced result/next action; inactive is pending');

    const lab = roots.fixture(), originalPlan = xllm.runPlan;
    try {
      const milestoneId = 'M-20261019000000-workflow';
      const base = path.join(lab.owner, '.gsd/milestones', milestoneId), slice = path.join(base, 'slices/S01');
      const route = { host_runtime: 'codex', resolved_worker_engine: 'claude', worker_engine: 'claude', worker_mode: 'sidecar',
        sidecar_declared: true, dispatch_allowed: true, model: 'claude-sonnet-5', model_resolved: 'claude-sonnet-5', effort: 'medium', tier: 'standard',
        dispatch_reason_code: 'sidecar-declared', dispatch_decision: 'allow', dispatch_posture: 'cross-engine',
        chain: [{ id: 'claude-sonnet-5', engine: 'claude' }] };
      const planning = { scope: 'milestone', phase: 'plan', unitType: 'plan-slice', milestoneId, sliceId: 'S01',
        cwd: lab.a, contextRoot: lab.owner, route, workflowId: 'workflow', dispatchId: 'plan',
        resultFile: path.join(lab.dir, 'plan.json'), promptFile: path.join(lab.dir, 'prompt.md') };
      write(planning.promptFile, 'Synthetic plan only.');
      xllm.runPlan = async () => ({ status: 'done', slice_plan: { content: '# Slice\n- [ ] **T01** — First\n- [ ] **T02** — Second\n' },
        task_plans: ['T01', 'T02'].map((id, index) => ({ id, content: roots.plan(lab.contract)
          .replace('id: T-roots', `id: ${id}`)
          .replaceAll(`  - '${index ? 'alpha' : 'beta'}::same.txt'\n`, '')
          .replace(`    - path: '${index ? 'alpha' : 'beta'}::same.txt'\n      provides: 'Result'\n      min_lines: 1\n`, '') })) });
      await unit.runUnitSidecar(planning);
      const tasks = require('./forge-parallelism').discoverTasks(slice);
      assert.deepEqual(tasks.map(task => task.id), ['T01', 'T02']);
      for (const task of tasks) {
        assert.equal(task.planPath, path.join(slice, `tasks/${task.id}/${task.id}-PLAN.md`));
        assert(!fs.existsSync(path.join(slice, `tasks/${task.id}-PLAN.md`)));
      }
      const batch = JSON.parse(child([path.join(__dirname, 'forge-parallelism.js'), '--slice-plan', path.join(slice, 'S01-PLAN.md')], env));
      assert.equal(batch.mode, 'parallel'); assert.deepEqual(batch.batch.map(task => task.id), ['T01', 'T02']);
      const originalExecute = xllm.runExecute;
      try {
        const claim = { schema_version: 2, generation: require('crypto').randomUUID(), execution_contract: lab.contract,
          paths: [{ root_id: 'alpha', path: 'same.txt' }, { root_id: 'beta', path: 'same.txt' }] };
        const runId = 'workflow-run';
        require('./forge-runs').add(lab.owner, { id: runId, kind: 'milestone', session_id: 'fixture', write_claim: claim });
        const executionAuthority = { claim, runId,
          gates: { plan: 'skipped', planSkipReason: 'interactive-off', claim: 'proceed', security: 'not-applicable' } };
        const interrupted = { ...planning, phase: 'execute', unitType: 'execute-task', taskId: 'T01',
          ...executionAuthority,
          planFile: tasks[0].planPath, execution_contract: lab.contract, dispatchId: 'milestone-timeout',
          resultFile: path.join(lab.dir, 'interrupted.json'), prompt: 'Synthetic timeout only' };
        xllm.runExecute = async () => {
          const receipt = JSON.parse(fs.readFileSync(interrupted.resultFile + '.receipt.json'));
          assert.equal(receipt.recovery_baseline.protected_roots.length, 2, 'baseline persisted before writer');
          write(path.join(lab.a, 'same.txt'), 'Interrupted alpha\n');
          write(path.join(lab.b, 'same.txt'), 'Interrupted beta\n');
          throw Object.assign(Error('milestone timeout fixture'), { code: 'claude-timeout' });
        };
        await assert.rejects(unit.runUnitSidecar(interrupted), /milestone timeout fixture/);
        const restartFile = path.join(lab.dir, 'milestone-restart.json'); write(restartFile, JSON.stringify(interrupted));
        child([__filename, '--milestone-restart', restartFile], env);
        const resetProof = JSON.parse(fs.readFileSync(restartFile + '.proof'));
        assert.notEqual(resetProof.pid, process.pid); assert.equal(resetProof.calls, 0);
        assert.deepEqual(resetProof.roots, ['alpha', 'beta']);
        for (const codeRoot of [lab.a, lab.b]) assert.equal(fs.readFileSync(path.join(codeRoot, 'same.txt'), 'utf8'), 'before\n');
        console.log('PASS milestone timeout/restart: pre-spawn baseline, legacy conservative receipt, live/pending-root zero writer, missing/tampered baseline refusal and trusted two-root reset');
        let executionCalls = 0;
        xllm.runExecute = async () => {
          executionCalls++;
          write(path.join(lab.a, 'same.txt'), 'Synthetic milestone result\n');
          return { status: 'done', summary: 'Synthetic milestone writer', files_changed: ['alpha::same.txt'], must_haves_status: [] };
        };
        const execution = { ...planning, phase: 'execute', unitType: 'execute-task', taskId: 'T01',
          ...executionAuthority,
          planFile: tasks[0].planPath, execution_contract: lab.contract, dispatchId: 'milestone-success',
          resultFile: path.join(lab.dir, 'execution.json'), prompt: 'Synthetic only',
          verification: { preferenceCommands: ['node -e "require(\'fs\').accessSync(\'same.txt\')"'] } };
        const gateReady = path.join(lab.dir, 'gate-ready');
        execution.verification.preferenceCommands = [`node -e "require('fs').accessSync('${gateReady.replace(/\\/g, '/')}')"`];
        await assert.rejects(unit.runUnitSidecar(execution), /execution-verification-failed/);
        const receiptFile = execution.resultFile + '.receipt.json';
        const savedResponse = JSON.parse(fs.readFileSync(receiptFile));
        assert.equal(savedResponse.phase, 'executed');
        assert.equal(savedResponse.provider_called, true);
        assert.equal(savedResponse.delivery_capture, undefined, 'failed checks must be rerun, not cached as successful capture');
        const planBytes = fs.readFileSync(execution.planFile);
        fs.appendFileSync(execution.planFile, '\nChanged input\n');
        await assert.rejects(unit.runUnitSidecar(execution), /execution-input-changed/);
        fs.writeFileSync(execution.planFile, planBytes);
        write(path.join(lab.b, 'same.txt'), 'Foreign root drift\n');
        await assert.rejects(unit.runUnitSidecar(execution), /execution-replay-baseline-changed/);
        write(path.join(lab.b, 'same.txt'), 'before\n');
        write(path.join(lab.b, '.gsd/foreign.json'), '{}');
        await assert.rejects(unit.runUnitSidecar(execution), /execution-protected/);
        fs.rmSync(path.join(lab.b, '.gsd'), { recursive: true });
        assert.equal(executionCalls, 1, 'input/code/protected-root refusal cannot infer again');
        write(gateReady, 'Ready for independent verification\n');
        assert.equal((await unit.runUnitSidecar(execution)).status, 'done');
        const published = path.join(slice, 'tasks/T01/T01-DELIVERY.json');
        const publishedBytes = fs.readFileSync(published), publishedTime = fs.statSync(published).mtimeMs;
        const foreignOwner = path.join(lab.owner, '.gsd/foreign-ready.json');
        write(foreignOwner, '{}');
        await assert.rejects(unit.runUnitSidecar(execution), /execution-protected/);
        fs.unlinkSync(foreignOwner);
        assert.equal((await unit.runUnitSidecar(execution)).status, 'done');
        assert.equal(executionCalls, 1);
        assert.deepEqual(fs.readFileSync(published), publishedBytes);
        assert.equal(fs.statSync(published).mtimeMs, publishedTime);
        for (const rootId of ['alpha', 'beta']) for (const kind of ['VERIFICATION', 'ARTIFACT']) {
          const source = JSON.parse(fs.readFileSync(path.join(slice, `tasks/T01/T01-${kind}-${rootId}-ENVELOPE.json`)));
          assert.equal(source.root_id, rootId); assert.equal(source.result.passed, true);
        }
        console.log('PASS milestone execution: gate failure saves response; plan/code/protected-root drift refuses without inference; per-root real checks and single publication/replay');
        // Continue the controller fixture from its uncompleted task state.
        fs.unlinkSync(path.join(slice, 'tasks/T01/T01-SUMMARY.md'));
        write(path.join(slice, 'S01-PLAN.md'), '# Slice\n- [ ] **T01** First\n- [ ] **T02** Second\n');
      } finally { xllm.runExecute = originalExecute; }
      write(path.join(base, `${milestoneId}-ROADMAP.md`), '# Roadmap\n- [ ] **S01: Workflow**\n');
      const state = require('./forge-state');
      state.write(lab.owner, { milestone: milestoneId, kind: 'milestone', phase: 'execute-task', active_slice: 'S01', active_task: 'T01', next_action: 'execute', auto_mode: 'on' });
      const prefsReader = () => ({ ok: true, prefs: { skip_discuss: true, skip_research: true, skip_slice_research: true } });
      const inventory = controller.discoverInventory(lab.owner, milestoneId, state.read(lab.owner, milestoneId));
      assert.deepEqual(inventory.slices[0].tasks.map(task => task.id), ['T01', 'T02']);
      assert.equal(controller.select(lab.owner, { milestone: milestoneId }, { prefsReader }).unit.id, 'T01');
      const requestUnit = { milestone: milestoneId, unit: 'execute-task/T01', host_runtime: 'claude', session: 'synthetic', owner_token: 'fixture-owner' };
      const began = controller.begin(lab.owner, requestUnit, { prefsReader });
      const complete = controller.complete(lab.owner, { ...requestUnit, owner_token: began.owner_token, generation: began.generation,
        idempotency_key: 'workflow-completion-'.repeat(60), result: { status: 'succeeded', summary: 'Synthetic only' } }, { prefsReader });
      const handoff = controller.handoff(lab.owner, { unit: requestUnit.unit, next_host_runtime: 'codex' }, { prefsReader });
      assert.equal(handoff.reason, 'handoff-ready'); assert.equal(handoff.next_host_runtime, 'codex');
      assert.equal(controller.resume(lab.owner, { idempotency_key: complete.transaction.idempotency_key,
        owner_token: began.owner_token, generation: began.generation }, { prefsReader }).results[0].reason, 'already-committed');
      write(path.join(slice, 'tasks/T01/T01-SUMMARY.md'), '# Simulated T01 completed\n');
      assert.equal(require('./forge-parallelism').discoverTasks(slice)[0].done, true);
      // Controller consumes slice checkboxes while parallelism consumes SUMMARY.
      write(path.join(slice, 'S01-PLAN.md'), '# Slice\n- [x] **T01** — First\n- [ ] **T02** — Second\n');
      assert.equal(controller.select(lab.owner, { milestone: milestoneId }, { prefsReader }).unit.id, 'T02');
      const status = require('./forge-status').collect(lab.owner, { scope: 'workspace', milestoneId });
      assert.equal(status.scope, 'workspace');
      console.log('PASS R2/R6/R8: real plan publisher -> nested T01/T02 -> independent DAG batch -> controller begin/long-key complete/handoff/resume -> canonical summary/next T02/status');
    } finally { xllm.runPlan = originalPlan; lab.cleanup(); }

    // Reuse focused suites without copying their unit-level cases. Their child
    // process exit is mandatory and their named output remains in gate evidence.
    for (const suite of ['forge-task-preparation.test.js', 'forge-unit-sidecar.test.js',
      'forge-attempt-recovery.test.js', 'forge-unit-controller.test.js']) {
      process.stdout.write(child([path.join(__dirname, suite)], env));
      console.log(`PASS delegated contract suite ${suite}`);
    }
    assert.equal(typeof controller.begin, 'function'); assert.equal(typeof controller.resume, 'function');
    console.log('PASS R3/R5/R6/R7: focused caller/receipt/root/telemetry/controller/lease negatives above; no real provider or UAT');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
}
