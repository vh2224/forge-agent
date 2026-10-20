'use strict';
const assert = require('assert');
const { inspectArtifacts, schema } = require('./forge-unit-sidecar');
const result = questions => ({ status: 'partial', summary: 'Decision needed', questions, artifacts: [] });
const inspect = questions => inspectArtifacts(result(questions), [], [], Infinity, {}, { forbidArtifactsOnNonDone: true });
assert(inspect(['Legacy question?']).ok);
assert(inspect([{ id: 'decision', question: 'Which source?' }]).ok);
assert(schema.properties.questions.items.anyOf.some(row => row.type === 'object' && row.additionalProperties === false));
for (const value of [null, [], {}, { id: '', question: 'Q' }, { id: 'x', question: '' }, { id: 'x', question: 'Q', answer: 'forged' }, { id: 1, question: 'Q' }]) {
  assert.strictEqual(inspect([value]).reason, 'schema-invalid', JSON.stringify(value));
}
const limit = 16 * 1024;
assert(inspect(['a'.repeat(limit)]).ok);
assert.strictEqual(inspect(['a'.repeat(limit + 1)]).reason, 'payload-limit');
const overhead = Buffer.byteLength(JSON.stringify({ id: 'x', question: '' }));
assert(inspect([{ id: 'x', question: 'a'.repeat(limit - overhead) }]).ok);
assert.strictEqual(inspect([{ id: 'x', question: 'a'.repeat(limit - overhead + 1) }]).reason, 'payload-limit');
assert.strictEqual(inspect([{ id: 'x'.repeat(limit), question: 'Q' }]).reason, 'payload-limit');
assert.strictEqual(inspect([{ id: 'x', question: String.fromCodePoint(0x1f600).repeat(limit / 4) }]).reason, 'payload-limit');
assert.strictEqual(inspect(Array(33).fill('Q')).reason, 'payload-limit');
assert.strictEqual(inspectArtifacts({ ...result([{ id: 'x', question: 'Q' }]), status: 'done' }, [], []).reason, 'questions-on-done');
assert.strictEqual(inspectArtifacts(result([{ id: 'x', question: 'Q' }]), [], [], 1).reason, 'payload-limit');
console.log('stable-ID and legacy questions: strict schema, UTF-8 bytes, count, total payload and done invariants passed');

// Recovery must use the delivery contract of the actual unit, not execute's.
const sidecar = require('./forge-unit-sidecar');
assert.strictEqual(typeof sidecar.validateRecoveryRequest, 'function');
const research = { unitType: 'research-milestone', milestoneId: 'M001', route: {
  resolved_worker_engine: 'claude', worker_mode: 'sidecar', dispatch_allowed: true } };
assert.strictEqual(sidecar.validateRecoveryRequest(research).mode, 'artifacts');
assert.strictEqual(sidecar.validateRecoveryRequest({ ...research, unitType: 'plan-slice', sliceId: 'S01' }).mode, 'plan');
assert.strictEqual(sidecar.locations({ ...research, unitType: 'execute-task', sliceId: 'S01', taskId: 'T01' }).required[0],
  '.gsd/milestones/M001/slices/S01/tasks/T01/T01-SUMMARY.md');

async function recoveryContracts() {
  const fs = require('fs'), path = require('path'), crypto = require('crypto');
  const fixtures = require('./forge-code-roots.test'), roots = require('./forge-code-roots');
  const recovery = require('./forge-attempt-recovery'), xllm = require('./forge-xllm');
  const lab = fixtures.fixture();
  const runExecute = xllm.runExecute, runPlan = xllm.runPlan;
  const route = { host_runtime: 'codex', worker_engine: 'claude', resolved_worker_engine: 'claude', worker_mode: 'sidecar', sidecar_declared: true,
    dispatch_reason_code: 'sidecar-declared', dispatch_posture: 'cross-engine', dispatch_decision: 'allow',
    dispatch_allowed: true, model: 'claude-sonnet-5', model_resolved: 'claude-sonnet-5', effort: 'medium', tier: 'standard',
    chain: [{ id: 'claude-sonnet-5', engine: 'claude' }] };
  const request = { unitType: 'execute-task', scope: 'milestone', phase: 'execute', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01',
    cwd: lab.a, contextRoot: lab.owner, execution_contract: lab.contract, route,
    workflowId: 'fixture', dispatchId: 'baseline', resultFile: path.join(lab.dir, 'r.json'), prompt: 'Fixture only.' };
  const base = path.join(lab.owner, '.gsd/milestones/M001/slices/S01');
  fs.mkdirSync(path.join(base, 'tasks/T01'), { recursive: true });
  request.planFile = path.join(base, 'tasks/T01/T01-PLAN.md');
  fs.writeFileSync(request.planFile, fixtures.plan(lab.contract));
  fs.writeFileSync(path.join(base, 'S01-PLAN.md'), '# Slice\n- [ ] **T01** — fixture\n');
  const runs = require('./forge-runs');
  request.runId = 'fixture-run';
  request.claim = { schema_version: 2, generation: crypto.randomUUID(), execution_contract: lab.contract,
    paths: ['alpha', 'beta'].map(root_id => ({ root_id, path: 'same.txt' })) };
  request.gates = { plan: 'skipped', planSkipReason: 'interactive-off', claim: 'proceed', security: 'not-applicable' };
  runs.add(lab.owner, { id: request.runId, kind: 'milestone', session_id: 'fixture', write_claim: request.claim });
  let calls = 0;
  try {
    fs.writeFileSync(path.join(lab.a, 'preexisting.txt'), 'foreign baseline\n');
    // A legacy executor receipt is still a possible writer when fields vanish.
    const legacyFile = path.join(lab.dir, 'legacy.json');
    fs.writeFileSync(legacyFile, JSON.stringify({ phase: 'failed', provider_called: false }));
    assert.strictEqual(recovery.inspectReceipt(legacyFile, { request }).writer_possible, true);
    assert.strictEqual(recovery.inspectReceipt(legacyFile).writer_possible, 'unknown');
    assert.throws(() => sidecar.reconcileMilestoneAttempt(request, JSON.parse(fs.readFileSync(legacyFile))), /baseline-required/);
    xllm.runExecute = async () => {
      calls++;
      const receipt = JSON.parse(fs.readFileSync(request.resultFile + '.receipt.json'));
      assert(receipt.recovery_baseline, 'durable caller baseline must precede provider');
      assert.strictEqual(receipt.recovery_baseline.protected_roots.length, 2);
      fs.writeFileSync(path.join(lab.a, 'same.txt'), 'worker a\n');
      fs.writeFileSync(path.join(lab.b, 'same.txt'), 'worker b\n');
      throw Object.assign(Error('timeout fixture'), { code: 'claude-timeout' });
    };
    const refused = { ...request, dispatchId: 'blocked-baseline', resultFile: path.join(lab.dir, 'blocked.json') };
    fs.writeFileSync(refused.resultFile + '.reset-state.json', '{}');
    await assert.rejects(sidecar.runUnitSidecar(refused), /baseline-already-exists/);
    assert.strictEqual(calls, 0, 'baseline persistence refusal precedes provider');
    await assert.rejects(sidecar.runUnitSidecar(request), /timeout fixture/);
    assert.strictEqual(calls, 1);
    let receipt = JSON.parse(fs.readFileSync(request.resultFile + '.receipt.json'));
    assert(receipt.recovery_baseline && receipt.phase === 'failed');
    const stateFile = request.resultFile + '.recovery.json';
    await assert.rejects(sidecar.recoverUnitSidecar(request, { stateFile, receiptFile: request.resultFile + '.receipt.json' },
      { processProbe: () => 'alive' }), /process-receipt-inspection/);
    await assert.rejects(sidecar.recoverUnitSidecar(request, { stateFile, receiptFile: request.resultFile + '.receipt.json' },
      { processProbe: () => 'stopped' }), /writer-reconciliation/);
    assert.strictEqual(calls, 1, 'unknown ownership cannot start another provider');
    assert.strictEqual(fs.readFileSync(path.join(lab.a, 'same.txt'), 'utf8'), 'worker a\n');
    const partial = sidecar.reconcileMilestoneAttempt(request, receipt, { verifyOwnership: observed =>
      observed.root_id === 'alpha' && observed.path === 'same.txt' });
    assert.strictEqual(partial.ok, false, 'one pending root keeps the attempt unreconciled');
    assert.strictEqual(fs.readFileSync(path.join(lab.b, 'same.txt'), 'utf8'), 'worker b\n');
    const reset = sidecar.reconcileMilestoneAttempt(request, receipt, { verifyOwnership: observed =>
      observed.attempt === request.dispatchId && ['alpha', 'beta'].includes(observed.root_id) && observed.path === 'same.txt' });
    assert.strictEqual(reset.ok, true, JSON.stringify(reset));
    assert.deepStrictEqual(reset.roots.map(row => row.root_id), ['alpha', 'beta']);
    assert.strictEqual(fs.readFileSync(path.join(lab.a, 'same.txt'), 'utf8'), 'before\n');
    assert.strictEqual(fs.readFileSync(path.join(lab.b, 'same.txt'), 'utf8'), 'before\n');
    assert.strictEqual(fs.readFileSync(path.join(lab.a, 'preexisting.txt'), 'utf8'), 'foreign baseline\n');
    let nativeCalls = 0;
    await assert.rejects(sidecar.recoverUnitSidecar({ ...request, execution_contract: undefined },
      { stateFile, receiptFile: request.resultFile + '.receipt.json', correction: true },
      { processProbe: () => 'stopped', invokeNative() { nativeCalls++; } }), /held-claim-required/);
    for (const patch of [{ active: false }, { write_claim: { ...request.claim, released: true } },
      { write_claim: { ...request.claim, generation: 'replacement' } }]) {
      runs.update(lab.owner, request.runId, patch);
      await assert.rejects(sidecar.recoverUnitSidecar({ ...request, prompt: 'repaired packaging' },
        { stateFile, receiptFile: request.resultFile + '.receipt.json', correction: true },
        { processProbe: () => 'stopped', invokeNative() { nativeCalls++; } }), /claim-generation-stale/);
      runs.update(lab.owner, request.runId, { active: true, write_claim: request.claim });
    }
    assert.strictEqual(nativeCalls, 0, 'released/replaced/inactive live authority never reaches another writer');
    for (const [patch, error] of [
      [{ claim: { ...request.claim, released: true } }, /held-claim-required/],
      [{ gates: { ...request.gates, claim: 'blocked' } }, /gates-required/],
      [{ gates: { ...request.gates, plan: 'approved', planSkipReason: undefined } }, /plan-gate-required/],
    ]) assert.throws(() => sidecar.validateRecoveryRequest({ ...request, ...patch }), error);
    const narrower = { ...request.claim, paths: [{ root_id: 'alpha', path: 'same.txt' }] };
    runs.update(lab.owner, request.runId, { write_claim: narrower });
    assert.throws(() => sidecar.validateRecoveryRequest({ ...request, claim: narrower }), /held-claim-mismatch/);
    runs.update(lab.owner, request.runId, { write_claim: request.claim });
    const changed = structuredClone(receipt); changed.recovery_baseline.state_sha256 = 'forged';
    assert.throws(() => sidecar.reconcileMilestoneAttempt(request, changed, { verifyOwnership: () => true }), /baseline-binding/);
    assert.strictEqual(sidecar.milestonePlanFile(request), request.planFile);
    const legacy = path.join(base, 'tasks/T01-PLAN.md');
    fs.renameSync(request.planFile, legacy);
    assert.strictEqual(sidecar.milestonePlanFile({ ...request, planFile: legacy }), legacy, 'explicit legacy read only');
    fs.copyFileSync(legacy, request.planFile);
    assert.throws(() => sidecar.milestonePlanFile(request), /legacy-task-plan-conflict/);
    fs.unlinkSync(legacy);

    // Plan publication creates the exact source consumed by discovery/execution.
    const planning = { ...request, unitType: 'plan-slice', phase: 'plan', taskId: undefined, execution_contract: undefined,
      promptFile: request.planFile, dispatchId: 'plan', resultFile: path.join(lab.dir, 'p.json') };
    xllm.runPlan = async () => ({ status: 'done', slice_plan: { content: '# Slice\n- [ ] **T02** — fixture\n' },
      task_plans: [{ id: 'T02', content: fixtures.plan(lab.contract) }] });
    await sidecar.runUnitSidecar(planning);
    const canonicalPlan = path.join(base, 'tasks/T02/T02-PLAN.md');
    assert(fs.existsSync(canonicalPlan));
    assert(!fs.existsSync(path.join(base, 'tasks/T02-PLAN.md')));
    assert(require('./forge-parallelism').discoverTasks(base).some(task => task.id === 'T02' && task.planPath === canonicalPlan));
    assert.strictEqual(sidecar.milestonePlanFile({ ...request, taskId: 'T02', planFile: canonicalPlan }), canonicalPlan);
    // Offline research correction exercises the real recovery caller without
    // touching execution.prepare or requiring an execution contract.
    const readonly = { ...request, unitType: 'research-milestone', phase: 'research', sliceId: undefined, taskId: undefined,
      execution_contract: undefined, planFile: undefined, dispatchId: 'research', resultFile: path.join(lab.dir, 'q.json'),
      route: { ...route, resolved_worker_engine: 'codex', worker_engine: 'codex', worker_mode: 'native',
        model: 'gpt-5.6-sol', model_resolved: 'gpt-5.6-sol', config_ok: true,
        chain: [{ id: 'gpt-5.6-sol', engine: 'gpt' }] } };
    sidecar.beginArtifactAttempt(readonly);
    sidecar.failArtifactAttempt(readonly, 'context-budget-exceeded', 'adapter-failed', false);
    const executeApi = require('./forge-task-execution'), prepare = executeApi.prepare;
    executeApi.prepare = () => { throw Error('research must not execute.prepare'); };
    try {
      const changedRequest = { ...readonly, prompt: 'Corrected fixture only.' };
      const recovered = await sidecar.recoverUnitSidecar(changedRequest, {
        stateFile: readonly.resultFile + '.recovery.json', receiptFile: readonly.resultFile + '.receipt.json', correction: true }, {
        activeCapabilities: { available: true, tool: 'spawn_agent', source: 'fixture', models: ['gpt-5.6-sol'],
          reasoning_efforts: ['medium'], fork_turns: ['none'] } });
      assert(recovered.corrected);
      assert.strictEqual(recovered.result.action, 'invoke-native');
    } catch (error) {
      assert.notStrictEqual(error.message, 'research must not execute.prepare');
      // Never contact a real service for the fixture.
      throw error;
    } finally { executeApi.prepare = prepare; }
    console.log('PASS milestone baseline before provider, stripped legacy receipt, live/unknown writer, two-root trusted reset, tampering and canonical plan publication');
  } finally { xllm.runExecute = runExecute; xllm.runPlan = runPlan; lab.cleanup(); }
}
recoveryContracts().catch(error => { console.error(error); process.exitCode = 1; });
