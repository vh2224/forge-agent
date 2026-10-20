'use strict';
// A selector runs exactly one recovery scenario; no arguments retain full coverage.
const scenarioSelectors = ['--recovery-contracts', '--pre-spawn-sidecar', '--pre-spawn-native'];
const scenarioArgs = process.argv.slice(2);
if (scenarioArgs.length > 1 || (scenarioArgs.length === 1 && !scenarioSelectors.includes(scenarioArgs[0]))) {
  console.error(`Usage: node forge-unit-sidecar.test.js [${scenarioSelectors.join('|')}]`);
  process.exit(1);
}
const selectedScenario = scenarioArgs[0];
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
    const procedure = require('./forge-procedure-context').loadProcedureContext({ cwd: lab.a, phase: 'execute-task', forgeHome: path.resolve(__dirname, '..') });
    for (const prompt of ['<!-- forge-procedure:core -->', '[DATA FROM "CUSTOM"]\nopen']) {
      const invalid = { ...request, prompt, dispatchId: 'invalid-composition', resultFile: path.join(lab.dir, 'invalid-composition.json') };
      await assert.rejects(sidecar.runUnitSidecar(invalid), /composition|DATA envelope/);
      assert(!fs.existsSync(invalid.resultFile + '.receipt.json'), 'invalid composition precedes receipt and provider');
    }
    xllm.runExecute = async options => {
      calls++;
      assert.strictEqual(options.scope, 'milestone');
      assert.strictEqual(options.cwd, lab.a);
      assert.strictEqual(options.procedureContext.procedureText, procedure.content);
      assert.deepStrictEqual(options.procedureContext.procedure_context.modules.map(row => row.id), ['core', 'verification', 'execution']);
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
    // A procedural segment must not manufacture a prepared execution context:
    // xllm uses its presence to select historical budgeting/schema semantics.
    xllm.runExecute = async options => {
      assert.strictEqual(options.executionContext, undefined);
      assert.strictEqual(options.procedureContext.procedureText, procedure.content);
      assert.deepStrictEqual(options.procedureContext.procedure_context.modules, procedure.modules);
      throw Error('legacy context boundary inspected');
    };
    const originalPlan = fs.readFileSync(request.planFile);
    try {
      fs.writeFileSync(request.planFile, fixtures.plan(roots.singleContract(lab.owner, lab.a)));
      await assert.rejects(sidecar.runUnitSidecar({ ...request, execution_contract: undefined,
        dispatchId: 'legacy-context', resultFile: path.join(lab.dir, 'legacy-context.json') }), /legacy context boundary inspected/);
    } finally { fs.writeFileSync(request.planFile, originalPlan); }
    // Exercise the actual nativeOptions closure with the recovery controller
    // substituted at its boundary. This exercises composition/the adapter;
    // recovery authority and end-to-end recovery are not exercised here.
    const recoverAttempt = recovery.recoverAttempt;
    const nativeRoute = { ...route, worker_mode: 'native', host_runtime: 'codex', resolved_worker_engine: 'codex', worker_engine: 'codex',
      model: 'gpt-6-sol', model_resolved: 'gpt-6-sol', config_ok: true };
    const capabilities = { available: true, tool: 'spawn_agent', source: 'fixture', models: ['gpt-6-sol'], reasoning_efforts: ['medium'], fork_turns: ['none'] };
    const customFile = path.join(lab.dir, 'custom-prompt.md');
    fs.writeFileSync(customFile, 'Custom recovery prompt');
    const artifact = require('./forge-prompt').materializePrompt({ cwd: lab.owner, codeDir: lab.a, forgeHome: path.resolve(__dirname, '..'),
      unitType: 'execute-task', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01', dispatchId: 'recovery-doublepass', autoCommit: false });
    const recoverCustom = patch => sidecar.recoverUnitSidecar({ ...request, prompt: undefined, ...patch }, {}, { activeCapabilities: capabilities });
    try {
      recovery.recoverAttempt = async options => options.validateInvocation(nativeRoute);
      for (const patch of [{ prompt: 'Custom recovery prompt' }, { promptFile: customFile }, { promptFile: artifact.prompt_path }]) {
        const invocation = await recoverCustom(patch);
        assert.strictEqual(invocation.ok, true, JSON.stringify(invocation));
        assert(invocation.args.message.includes(procedure.content));
        for (const id of ['core', 'verification', 'execution']) assert.strictEqual(invocation.args.message.split(`<!-- forge-procedure:${id} -->`).length - 1, 1);
      }
      for (const unitType of ['complete-slice', 'complete-milestone']) {
        const completion = require('./forge-prompt').renderPrompt({ cwd: lab.owner, codeDir: lab.a,
          forgeHome: path.resolve(__dirname, '..'), unitType, milestoneId: 'M001', sliceId: 'S01', autoCommit: false });
        const expected = require('./forge-procedure-context').loadProcedureContext({ cwd: lab.a, phase: unitType,
          forgeHome: require('path').resolve(__dirname, '..') });
        // The actual recovery nativeOptions closure and real native adapter are
        // exercised; only the recovery controller is replaced at its boundary.
        const invocation = await recoverCustom({ unitType, phase: 'complete', prompt: completion.prompt,
          procedure_context: completion.procedure_context });
        assert.strictEqual(invocation.ok, true, JSON.stringify(invocation));
        assert(invocation.args.message.includes(expected.content));
        assert(invocation.args.message.includes('FORGE_SCRIPTS_DIR: '));
        for (const id of ['core', 'verification', 'completion', 'recovery']) {
          assert.strictEqual(invocation.args.message.split(`<!-- forge-procedure:${id} -->`).length - 1, 1);
        }
        const bad = completion.prompt.replace('Never integrate;', 'Always integrate;');
        await assert.rejects(recoverCustom({ unitType, phase: 'complete', prompt: bad,
          procedure_context: completion.procedure_context }), /composition/);
      }
      const { content, ...metadata } = procedure;
      for (const prompt of ['<!-- forge-procedure:core -->', '[DATA FROM "CUSTOM"]\nopen',
        '[DATA FROM "CUSTOM"]\n' + content + '\n[END DATA]', '[DATA FROM "A"]\nvalue\n[END DATA FROM "B"]']) {
        await assert.rejects(recoverCustom({ prompt, procedure_context: metadata }), /composition|DATA envelope/);
        fs.writeFileSync(customFile, prompt);
        await assert.rejects(recoverCustom({ promptFile: customFile, procedure_context: metadata }), /composition|DATA envelope/);
      }
    } finally { recovery.recoverAttempt = recoverAttempt; }
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
    const replayable = { ...readonly, route, dispatchId: 'saved-replay', resultFile: path.join(lab.dir, 'saved.json') };
    sidecar.beginArtifactAttempt(replayable);
    const candidate = { status: 'partial', summary: 'Saved fixture response', questions: [], artifacts: [] };
    await sidecar.acceptArtifactResult(replayable, candidate, { providerCalled: true });
    const replayReceipt = replayable.resultFile + '.receipt.json', replayState = replayable.resultFile + '.recovery.json';
    recovery.captureFailure({ stateFile: replayState, receiptFile: replayReceipt, request: replayable,
      unit: 'research-milestone/M001', route: replayable.route, error: { code: 'publication-interrupted' } });
    const replayOptions = { stateFile: replayState, receiptFile: replayReceipt, environmentalCorrection: true };
    const replayRuntime = { processProbe: () => 'stopped',
      inspectPreSpawn() { throw Error('saved response must not use pre-spawn repair'); } };
    assert.strictEqual((await sidecar.recoverUnitSidecar(replayable, replayOptions, replayRuntime)).action, 'replay');
    const savedReceipt = JSON.parse(fs.readFileSync(replayReceipt));
    fs.writeFileSync(replayReceipt, JSON.stringify({ ...savedReceipt, phase: 'failed', saved_candidate: {
      result: candidate, sha256: roots.digest(JSON.stringify(candidate)) } }));
    await assert.rejects(sidecar.recoverUnitSidecar(replayable, replayOptions, replayRuntime), /artifact-reconciliation-required/,
      'saved candidates take canonical reconciliation, never pre-spawn repair');
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
      assert.strictEqual((recovered.result.invocation.args.message.match(/<!-- forge-procedure:core -->/g) || []).length, 1);
      assert(recovered.result.invocation.args.message.includes('<!-- forge-procedure:recovery -->'));
      const artifact = require('./forge-prompt').materializePrompt({ cwd: lab.owner, codeDir: lab.a, forgeHome: path.resolve(__dirname, '..'),
        unitType: 'research-milestone', milestoneId: 'M001', description: 'Synthetic ultraviolet research', dispatchId: 'research-materialized-recovery' });
      const materializedRequest = { ...readonly, prompt: 'Original broken packaging', promptFile: artifact.prompt_path,
        dispatchId: 'research-materialized', resultFile: path.join(lab.dir, 'materialized.json') };
      sidecar.beginArtifactAttempt(materializedRequest);
      sidecar.failArtifactAttempt(materializedRequest, 'context-budget-exceeded', 'adapter-failed', false);
      const original = fs.readFileSync(artifact.prompt_path, 'utf8');
      const correctedArtifact = original.replace('## ', '## Offline repaired ');
      // A tampered artifact refuses its recorded hash, even with imported markers.
      fs.writeFileSync(artifact.prompt_path, correctedArtifact);
      const caps = { available: true, tool: 'spawn_agent', source: 'fixture', models: ['gpt-5.6-sol'], reasoning_efforts: ['medium'], fork_turns: ['none'] };
      await assert.rejects(sidecar.recoverUnitSidecar({ ...materializedRequest, prompt: undefined }, {
        stateFile: materializedRequest.resultFile + '.recovery.json', receiptFile: materializedRequest.resultFile + '.receipt.json', correction: true },
        { activeCapabilities: caps }), /inconsistent metadata or body hash/);
      fs.writeFileSync(artifact.prompt_path, original);
      const materialized = await sidecar.recoverUnitSidecar({ ...materializedRequest, prompt: undefined }, {
        stateFile: materializedRequest.resultFile + '.recovery.json', receiptFile: materializedRequest.resultFile + '.receipt.json', correction: true },
        { activeCapabilities: caps });
      const finalPrompt = materialized.result.invocation.args.message;
      assert.strictEqual((finalPrompt.match(/<!-- forge-procedure:core -->/g) || []).length, 1);
      assert.strictEqual((finalPrompt.match(/<!-- forge-procedure:preparation -->/g) || []).length, 1);
      assert.strictEqual((finalPrompt.match(/<!-- forge-procedure:recovery -->/g) || []).length, 1);
      assert(finalPrompt.includes('<!-- forge-procedure:recovery -->'));

    } catch (error) {
      assert.notStrictEqual(error.message, 'research must not execute.prepare');
      // Never contact a real service for the fixture.
      throw error;
    } finally { executeApi.prepare = prepare; }
    console.log('PASS milestone baseline before provider, stripped legacy receipt, live/unknown writer, two-root trusted reset, tampering and canonical plan publication');
  } finally { xllm.runExecute = runExecute; xllm.runPlan = runPlan; lab.cleanup(); }
}
async function preSpawnRecoveryContracts(nativeInitial = false) {
  const fs = require('fs'), path = require('path'), crypto = require('crypto');
  const fixtures = require('./forge-code-roots.test'), roots = require('./forge-code-roots');
  const recovery = require('./forge-attempt-recovery'), reset = require('./forge-surgical-reset');
  const lease = require('./forge-unit-lease'), runs = require('./forge-runs');
  const lab = fixtures.fixture();
  const contract = roots.validateContract({ ...lab.contract, code_roots: [lab.contract.code_roots[0]] });
  const route = { unit_type: 'execute-task', host_runtime: 'codex', resolved_worker_engine: 'claude', worker_engine: 'claude',
    worker_mode: 'sidecar', model: 'claude-sonnet-5', model_resolved: 'claude-sonnet-5', effort: 'medium', tier: 'standard',
    dispatch_allowed: true, config_ok: true,
    chain: [{ id: 'claude-sonnet-5', engine: 'claude' }, { id: 'gpt-6.1-sol', engine: 'gpt' }] };
  if (nativeInitial) Object.assign(route, { resolved_worker_engine: 'codex', worker_engine: 'codex', worker_mode: 'native',
    model: 'gpt-6-sol', model_resolved: 'gpt-6-sol',
    chain: [{ id: 'gpt-6-sol', engine: 'gpt' }, { id: 'gpt-6.1-sol', engine: 'gpt' }] });
  const base = path.join(lab.owner, '.gsd/milestones/M001/slices/S01');
  fs.mkdirSync(path.join(base, 'tasks/T01'), { recursive: true });
  const planFile = path.join(base, 'tasks/T01/T01-PLAN.md');
  fs.writeFileSync(planFile, fixtures.plan(contract));
  fs.writeFileSync(path.join(base, 'S01-PLAN.md'), '# Slice\n- [ ] **T01** fixture\n');
  const request = { unitType: 'execute-task', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01',
    cwd: lab.a, contextRoot: lab.owner, route, workflowId: 'fixture', dispatchId: 'before-spawn',
    resultFile: path.join(lab.dir, 'pre-spawn.json'), planFile, prompt: 'Offline fixture only.' };
  const claim = { schema_version: 2, generation: crypto.randomUUID(), execution_contract: contract,
    paths: [{ root_id: 'alpha', path: 'same.txt' }] };
  if (nativeInitial) request.execution_contract = contract;
  const executionAuthority = { execution_contract: contract, claim, runId: 'pre-spawn-run',
    gates: { plan: 'skipped', planSkipReason: 'interactive-off', claim: 'proceed', security: 'not-applicable' } };
  runs.add(lab.owner, { id: executionAuthority.runId, kind: 'milestone', session_id: 'fixture', write_claim: claim });
  const receiptFile = request.resultFile + '.receipt.json', stateFile = request.resultFile + '.recovery.json';
  const baselineFile = path.join(lab.dir, 'original-predispatch.json');
  fs.writeFileSync(baselineFile, JSON.stringify(reset.captureAttemptSnapshot(lab.a)));
  fs.writeFileSync(receiptFile, JSON.stringify({ phase: 'failed', dispatch_id: request.dispatchId,
    fingerprint: sidecar.artifactFingerprint(request), recovery_identity_sha256: roots.digest(recovery.requestIdentity(recovery.canonicalRequest(request))),
    failure: { reason_code: 'execution-protected-snapshot-unstable', provider_called: false } }));
  const initial = recovery.captureFailure({ stateFile, receiptFile, request, unit: 'execute-task/T01', route, contract: nativeInitial ? contract : undefined,
    error: { code: 'execution-protected-snapshot-unstable', provider_called: false }, layer: 'protected-snapshot' });
  const now = initial.deadline_at + 1;
  const receiptBytes = fs.readFileSync(receiptFile), baselineBytes = fs.readFileSync(baselineFile), stateBytes = fs.readFileSync(stateFile);
  const held = lease.acquire(lab.owner, initial.unit, { hostRuntime: 'codex', ownerToken: 'fixture-owner', ttlMs: 300000 });
  let window = lease.openProtectedWindow(lab.owner, initial.unit, held.owner_token, held.generation, { durationMs: 300000 });
  let calls = 0, stageCalls = 0, deltaCalls = 0;
  const authority = recovery.createAuthority(reference => ({ reference, status: 'resolved', answer: 'authorize', resolved_at: new Date().toISOString() }));
  const runtime = {
    executionAuthority, activeCapabilities: { available: true, tool: 'spawn_agent', source: 'fixture', models: ['gpt-6-sol', 'gpt-6.1-sol'], reasoning_efforts: ['medium'], fork_turns: ['none'] },
    processProbe: () => 'stopped',
    inspectPreSpawn: async challenge => { stageCalls++; return { binding_sha256: roots.digest(challenge), stage: 'before-provider-spawn', process: 'stopped',
      process_reference: 'fixture:awaited-adapter-exit', stage_reference: 'fixture:observed-stack-before-spawn',
      baseline: { path: baselineFile, sha256: roots.digest(baselineBytes), provenance_reference: 'fixture:captured-before-failure' } }; },
    inspectPreSpawnDelta: async challenge => { deltaCalls++; return { binding_sha256: roots.digest(challenge),
      classification: 'no-failed-worker-writes', evidence_reference: 'fixture:independent-all-root-journal' }; },
    validateEnvironmentalCorrection: async challenge => ({ binding_sha256: roots.digest(challenge), ok: true,
      repair: 'bounded-held-lease-window', lease_window: window, evidence_reference: 'fixture:lease-test',
      offline_check: { command: 'node scripts/forge-unit-lease.test.js', passed: true, exit_code: 0 } }),
    resolveDispatch: () => ({ ...route, chain: route.chain, source: 'fixture-resolver' }),
    recoveryAuthorization: { reference: 'fixture:standing', adapter: {
      readStandingAuthorization: () => ({ expires_at: now + 100000 }),
      issueRecoveryException: (reference, scope) => authority.issue(reference, scope, () => now) } },
    invokeNative: async (next, binding) => { calls++; assert.strictEqual(next.route.model, 'gpt-6.1-sol');
      assert.strictEqual(binding.args.model, 'gpt-6.1-sol');
      assert(binding.args.message.includes('<!-- forge-procedure:recovery -->'));
      assert.strictEqual((binding.args.message.match(/<!-- forge-procedure:core -->/g) || []).length, 1);
      return { fixture_only: true, provider_contact: false }; },
  };
  const options = { stateFile, receiptFile, environmentalCorrection: true, clock: () => now };
  const invoke = (patch = {}, input = request, recoveryPatch = {}) => sidecar.recoverUnitSidecar(input, { ...options, ...recoveryPatch }, { ...runtime, ...patch });
  const restore = () => { fs.writeFileSync(stateFile, stateBytes); fs.writeFileSync(receiptFile, receiptBytes); fs.writeFileSync(baselineFile, baselineBytes); };
  const rejected = async (patch, expected, input) => { restore(); await assert.rejects(invoke(patch, input), expected); assert.strictEqual(calls, 0); };
  try {
    if (nativeInitial) {
      await rejected({ activeCapabilities: undefined }, /execution-route-incompatible/);
      await rejected({ activeCapabilities: { ...runtime.activeCapabilities, models: ['foreign'] } }, /execution-route-incompatible/);
      await rejected({ activeCapabilities: undefined }, /execution-route-incompatible/,
        { ...request, nativeInvocation: { ok: true, args: { model: 'gpt-6.1-sol' } }, approved: true });
    }
    await rejected({ inspectPreSpawn: undefined }, /inspector-required/);
    await rejected({ processProbe: () => 'alive' }, /process-receipt-inspection/);
    await rejected({ inspectPreSpawn: async () => ({ stage: 'before-provider-spawn', process: 'stopped', approved: true }) }, /unproved/);
    await rejected({ inspectPreSpawn: async c => ({ ...await runtime.inspectPreSpawn(c), stage: 'unknown' }) }, /unproved/);
    await rejected({ executionAuthority: { ...executionAuthority, claim: { ...claim, generation: 'foreign' } } }, /claim-generation-stale/);
    await rejected({ executionAuthority: { ...executionAuthority, execution_contract: lab.contract } }, /claim|root|writes/);
    await rejected({ inspectPreSpawn: async c => { c.roots[0].path = lab.b; return runtime.inspectPreSpawn(c); } }, /unproved/);
    await rejected({ inspectPreSpawn: async c => { fs.writeFileSync(receiptFile, '{}'); return runtime.inspectPreSpawn(c); } }, /inspection-changed/);
    await rejected({ inspectPreSpawn: async c => { fs.writeFileSync(stateFile, '{}'); return runtime.inspectPreSpawn(c); } }, /inspection-changed/);
    await rejected({ inspectPreSpawn: async c => ({ ...await runtime.inspectPreSpawn(c), baseline: { path: baselineFile, sha256: 'forged', provenance_reference: 'forged' } }) }, /baseline-binding/);
    await rejected({ inspectPreSpawnDelta: undefined }, /drift-unproved/);
    await rejected({ inspectPreSpawnDelta: async () => ({ independentChanges: true }) }, /drift-unproved/);
    await rejected({ validateEnvironmentalCorrection: async c => ({ ...await runtime.validateEnvironmentalCorrection(c), lease_window: JSON.parse(JSON.stringify(window)) }) }, /window-invalid/);
    await rejected({ validateEnvironmentalCorrection: async c => ({ ...await runtime.validateEnvironmentalCorrection(c), offline_check: { passed: true, exit_code: 0 } }) }, /repair-unproved/);
    await rejected({ validateEnvironmentalCorrection: async c => { fs.writeFileSync(path.join(lab.a, 'same.txt'), 'concurrent\n'); return runtime.validateEnvironmentalCorrection(c); } }, /inspection-changed/);
    fs.writeFileSync(path.join(lab.a, 'same.txt'), 'before\n');
    await rejected({ validateEnvironmentalCorrection: async c => { fs.writeFileSync(path.join(lab.owner, '.gsd/unrelated'), 'foreign'); return runtime.validateEnvironmentalCorrection(c); } }, /protected/);
    fs.unlinkSync(path.join(lab.owner, '.gsd/unrelated'));
    await rejected({}, /pre-spawn-binding/, { ...request, dispatchId: 'foreign' });
    for (const saved of nativeInitial ? [] : [{ phase: 'ready' }, { phase: 'failed', saved_candidate: { sha256: 'fixture' } }]) {
      restore(); fs.writeFileSync(receiptFile, JSON.stringify({ ...JSON.parse(receiptBytes), ...saved }));
      await assert.rejects(invoke({ inspectPreSpawn() { throw Error('replay must skip repair inspection'); } }), /identity-mismatch/,
        'legacy root migration applies only to proved pre-spawn repair, not unvalidated saved-response authority');
    }
    restore();
    const wrongFailure = JSON.parse(receiptBytes); wrongFailure.failure.reason_code = 'invalid-payload';
    fs.writeFileSync(receiptFile, JSON.stringify(wrongFailure));
    await assert.rejects(invoke(), /pre-spawn-binding/);
    restore();
    const changed = JSON.parse(receiptBytes); changed.pid = process.pid; fs.writeFileSync(receiptFile, JSON.stringify(changed));
    await assert.rejects(invoke(), /process-receipt-inspection/);
    restore();
    const pending = JSON.parse(stateBytes); pending.pending_questions = [{ id: 'human', question: 'Functional decision?', status: 'pending' }]; fs.writeFileSync(stateFile, JSON.stringify(pending));
    assert.strictEqual((await invoke()).action, 'pending-questions'); assert.strictEqual(calls, 0);
    restore();
    // Prove later HEAD/untracked/deleted/renamed deltas are presented explicitly.
    fs.writeFileSync(path.join(lab.a, 'repair.txt'), 'independent repair\n');
    fixtures.command('git', ['add', 'repair.txt'], lab.a); fixtures.command('git', ['commit', '-qm', 'independent fixture repair'], lab.a);
    fs.writeFileSync(path.join(lab.a, 'untracked.txt'), 'independent\n');
    fs.renameSync(path.join(lab.a, 'same.txt'), path.join(lab.a, 'renamed.txt'));
    let driftSeen = false;
    const handed = await invoke({ invokeNative: undefined, inspectPreSpawnDelta: async c => { driftSeen = c.vcs_drift
      && c.before.start_sha !== c.current.start_sha && c.current.pre_dirty.length >= 3 && c.claimed[0].sha256 === null;
      return runtime.inspectPreSpawnDelta(c); } });
    assert(driftSeen, 'all-root VCS delta and explicit missing claimed path reach independent inspector');
    assert.strictEqual(handed.result.action, 'reattest-native-handoff');
    assert.strictEqual(handed.result.invocation, undefined, 'pending reservation has no executable native arguments');
    assert.strictEqual(handed.action, 'reattest-native-handoff');
    assert.deepStrictEqual(Object.keys(handed).sort(), ['action', 'provider_called', 'reservation_sha256', 'result']);
    assert.deepStrictEqual(Object.keys(handed.result).sort(), ['action', 'provider_called', 'reservation_sha256']);
    assert(!JSON.stringify(handed).includes('invocation'), 'no nesting of the phase-one response exposes executable arguments');
    const resumeReservation = { sha256: handed.result.reservation_sha256 };
    await assert.rejects(invoke({ invokeNative: undefined }, request, { resumeReservation: { sha256: 'foreign' } }), /reservation-invalid/);
    await assert.rejects(invoke({ invokeNative: undefined, inspectPreSpawn: undefined }, request, { resumeReservation }), /inspector-required/);
    await assert.rejects(invoke({ invokeNative: undefined, activeCapabilities: { ...runtime.activeCapabilities, models: ['foreign'] } }, request, { resumeReservation }), /model|adapter|capability|route/);
    await assert.rejects(invoke({ invokeNative: undefined, resolveDispatch: () => ({ ...route, effort: 'high' }) }, request, { resumeReservation }), /provenance|route/);
    window.close();
    window = lease.openProtectedWindow(lab.owner, initial.unit, held.owner_token, held.generation, { durationMs: 300000 });
    const ready = await invoke({ invokeNative: undefined }, request, { resumeReservation });
    assert.strictEqual(ready.result.action, 'invoke-native');
    ready.result.assertReady();
    assert.strictEqual(JSON.parse(fs.readFileSync(stateFile)).reservations.length, 1);
    await assert.rejects(invoke({ invokeNative: undefined }, request, { resumeReservation }), /reservation-invalid/);
    fs.writeFileSync(path.join(lab.a, 'untracked.txt'), 'changed after handoff\n');
    assert.throws(() => ready.result.assertReady(), /inspection-changed/);
    await assert.rejects(invoke(), /retry-exhausted/);
    restore();
    const recovered = await invoke();
    assert.strictEqual(calls, 1); assert(recovered.corrected);
    assert.strictEqual(recovered.sidecar_remaining_ms, 0);
    assert.strictEqual(recovered.result.result.provider_contact, false);
    const saved = JSON.parse(fs.readFileSync(stateFile));
    assert.strictEqual(saved.started_at, initial.started_at); assert.strictEqual(saved.deadline_at, initial.deadline_at);
    assert.strictEqual(saved.roots_sha256, initial.roots_sha256, 'original root identity is retained');
    assert.strictEqual(saved.reservations[0].correction.kind, 'environment');
    assert.deepStrictEqual(fs.readFileSync(receiptFile), receiptBytes); assert.deepStrictEqual(fs.readFileSync(baselineFile), baselineBytes);
    if (nativeInitial) {
      // Plain caller correction has possible-writer semantics. Capture an
      // actual current reset baseline, rather than reuse pre-spawn testimony.
      const original = { ...request, dispatchId: 'native-offline', resultFile: path.join(lab.dir, 'native-offline.json') };
      const correctionReceipt = original.resultFile + '.receipt.json', correctionState = original.resultFile + '.recovery.json';
      const resetFile = original.resultFile + '.reset-state.json';
      const resetState = reset.initState(resetFile, { cwd: lab.a, attempt: original.dispatchId, executionContract: contract });
      const { reconciliation, ...baseline } = resetState;
      const execution = require('./forge-task-execution');
      const receipt = { phase: 'failed', dispatch_id: original.dispatchId, fingerprint: sidecar.artifactFingerprint(original),
        recovery_identity_sha256: roots.digest(recovery.requestIdentity(recovery.canonicalRequest(original))),
        failure: { reason_code: 'context-budget-exceeded', provider_called: false } };
      receipt.recovery_baseline = { schema_version: 1, state_file: resetFile, state_sha256: roots.digest(baseline),
        execution_contract: contract, fingerprint: receipt.fingerprint, dispatch_id: original.dispatchId,
        input: { path: planFile, sha256: roots.digest(fs.readFileSync(planFile)) },
        protected_owner: execution.protectedSnapshot(contract.owner),
        protected_roots: contract.code_roots.map(root => ({ root_id: root.id, path: root.path, snapshot: execution.protectedSnapshot(root.path) })) };
      fs.writeFileSync(correctionReceipt, JSON.stringify(receipt));
      const correction = recovery.captureFailure({ stateFile: correctionState, receiptFile: correctionReceipt, request: original,
        unit: initial.unit, route, contract, error: { code: 'context-budget-exceeded', provider_called: false }, layer: 'caller' });
      let correctedCalls = 0;
      const corrected = await sidecar.recoverUnitSidecar({ ...original, prompt: 'Offline corrected caller packaging.' },
        { stateFile: correctionState, receiptFile: correctionReceipt, correction: true, clock: () => correction.started_at + 1 },
        { executionAuthority, activeCapabilities: runtime.activeCapabilities, processProbe: () => 'stopped', verifyOwnership: () => false,
          invokeNative: async (next, binding) => {
        correctedCalls++; assert.strictEqual(next.route.model, 'gpt-6-sol');
        assert.strictEqual(binding.args.model, 'gpt-6-sol');
        assert(binding.args.message.includes('<!-- forge-procedure:recovery -->'));
        return { fixture_only: true, provider_contact: false };
      } });
      assert.strictEqual(correctedCalls, 1); assert.strictEqual(corrected.corrected, true);
      assert.strictEqual(JSON.parse(fs.readFileSync(correctionState)).deadline_at, correction.deadline_at);
    }
    assert(stageCalls > 5 && deltaCalls > 5);
    console.log('PASS ' + (nativeInitial ? 'native-initial R4 authority/correction/resume: ' : '') + 'pre-spawn trusted inspection, immutable challenge, full root delta, native after original deadline, pending questions, handoff guard and one correction across restart');
  } finally { window.close(); lab.cleanup(); }
}
async function runScenarios() {
  if (!selectedScenario || selectedScenario === '--recovery-contracts') await recoveryContracts();
  if (!selectedScenario || selectedScenario === '--pre-spawn-sidecar') await preSpawnRecoveryContracts();
  if (!selectedScenario || selectedScenario === '--pre-spawn-native') await preSpawnRecoveryContracts(true);
}
runScenarios().catch(error => { console.error(error); process.exitCode = 1; });
