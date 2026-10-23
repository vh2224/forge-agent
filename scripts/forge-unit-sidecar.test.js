'use strict';
// A selector runs exactly one recovery scenario; no arguments retain full coverage.
const scenarioSelectors = ['--delivery-publication-limits', '--recovery-contracts', '--pre-spawn-sidecar', '--pre-spawn-native', '--no-progress-event', '--owner-event-reconcile', '--ceiling-route'];
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
function resolveContext(request) {
  request.route = require('./forge-dispatch-resolve').resolveDispatch({ cwd: request.contextRoot, unitType: request.unitType,
    milestoneId: request.milestoneId, unitId: request.taskId || request.sliceId || request.milestoneId,
    planPath: request.planFile, roadmapPath: request.roadmapFile, hostRuntime: 'codex' });
  return request;
}
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
  fs.writeFileSync(path.join(lab.owner, '.gsd/forge-prefs.jsonc'), JSON.stringify({ tier_models: Object.fromEntries(
    ['light', 'standard', 'heavy', 'max'].map(tier => [tier, ['claude-sonnet-5']])), effort: { 'plan-slice': 'medium' } }));
  resolveContext(request);
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
      assert.strictEqual(options.cwd, fs.realpathSync(lab.a));
      assert.strictEqual(options.procedureContext.procedureText, procedure.content);
      assert.deepStrictEqual(options.procedureContext.procedure_context.modules.map(row => row.id), ['core', 'verification', 'execution']);
      const receipt = JSON.parse(fs.readFileSync(request.resultFile + '.receipt.json'));
      assert(receipt.recovery_baseline, 'durable caller baseline must precede provider');
      assert.strictEqual(receipt.recovery_baseline.protected_roots.length, 2);
      fs.writeFileSync(path.join(lab.a, 'same.txt'), 'worker a\n');
      fs.writeFileSync(path.join(lab.b, 'same.txt'), 'worker b\n');
      throw Object.assign(Error('timeout fixture'), { code: 'claude-timeout' });
    };
    for (const incomplete of [route, { ...request.route, resolution_context: { ...request.route.resolution_context, unit_id: 'T99' } }]) {
      const missingContext = { ...request, route: incomplete, dispatchId: 'missing-context', resultFile: path.join(lab.dir, 'missing-context.json') };
      await assert.rejects(sidecar.runUnitSidecar(missingContext), /milestone-resolver-context-required/);
      assert.strictEqual(calls, 0, 'milestone context refusal precedes provider');
      assert(!fs.existsSync(missingContext.resultFile + '.receipt.json'));
    }
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
      await assert.rejects(sidecar.runUnitSidecar(resolveContext({ ...request, execution_contract: undefined,
        dispatchId: 'legacy-context', resultFile: path.join(lab.dir, 'legacy-context.json') })), /legacy context boundary inspected/);
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
      for (const mode of [{ correction: true }, { transitions: [{ type: 'resolver-context-omission', reference: 'fixture:claim-negative' }] }]) {
        await assert.rejects(sidecar.recoverUnitSidecar({ ...request, prompt: 'repaired packaging' },
          { stateFile, receiptFile: request.resultFile + '.receipt.json', ...mode },
          { processProbe: () => 'stopped', invokeNative() { nativeCalls++; } }), /claim-generation-stale/);
      }
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

    // R8: valid owner corpus cannot shadow the physical code corpus.
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/forge-procedures.json')));
    for (const folder of [lab.a, lab.owner]) {
      fs.mkdirSync(path.join(folder, 'shared'), { recursive: true });
      fs.writeFileSync(path.join(folder, 'shared/forge-procedures.json'), JSON.stringify(manifest));
      for (const module of manifest.modules.filter(row => row.status === 'ready'))
        fs.copyFileSync(path.join(__dirname, '..', module.path), path.join(folder, module.path));
    }
    const originalClaude = xllm.invokeClaudeTransport;
    let entered = 0, sent;
    try {
      xllm.invokeClaudeTransport = async options => {
        entered++; sent = options.prompt;
        return { candidate: { status: 'partial', summary: 'synthetic', questions: [], artifacts: [] } };
      };
      xllm.runPlan = async options => {
        entered++; sent = fs.readFileSync(options.planContextFile, 'utf8');
        return { status: 'partial', task_plans: [], slice_plan: { content: '# Fixture' } };
      };
      let attempt = 0;
      for (const input of ['prompt', 'promptFile', 'planContextFile', 'rendered']) {
        const phase = input === 'planContextFile' ? 'plan-slice' : 'research-milestone';
        const procedure = require('./forge-procedure-context').loadProcedureContext({ cwd: lab.a, phase });
        const modulePath = path.join(lab.a, procedure.modules[procedure.modules.length - 1].path);
        const bytes = fs.readFileSync(modulePath);
        for (const change of ['missing', 'changed-hash', 'tampered-body', 'tampered-materialized', 'plain', 'composed', 'materialized']) {
          if (input === 'rendered' && ['tampered-body', 'tampered-materialized', 'composed', 'materialized'].includes(change)) continue;
          const id = 'procedure-boundary-' + attempt++;
          let body = ['composed', 'tampered-body', 'tampered-materialized', 'materialized'].includes(change) ? 'fixture\n' + procedure.content : 'fixture';
          const { content, ...metadata } = procedure;
          if (['materialized', 'tampered-materialized'].includes(change)) body = '---\nprocedure_context: ' + JSON.stringify(metadata)
            + '\nfinal_prompt_sha256: ' + JSON.stringify(crypto.createHash('sha256').update(body).digest('hex')) + '\n---\n\n' + body;
          if (['tampered-body', 'tampered-materialized'].includes(change)) body = body.replace('Forge mandatory procedure core', 'TAMPERED core');
          const file = path.join(lab.dir, id + '.md'); fs.writeFileSync(file, body);
          const probe = { ...request, unitType: phase, phase: 'research', taskId: undefined, description: 'Synthetic research fixture',
            sliceId: phase === 'plan-slice' ? 'S01' : undefined, execution_contract: undefined,
            prompt: input === 'prompt' ? body : undefined, promptFile: ['promptFile', 'planContextFile'].includes(input) ? file : undefined,
            procedure_context: ['composed', 'tampered-body'].includes(change) ? metadata : undefined,
            dispatchId: id, resultFile: path.join(lab.dir, id + '.json') };
          const previous = entered;
          resolveContext(probe);
          try {
            if (change === 'missing') fs.unlinkSync(modulePath);
            if (change === 'changed-hash') fs.appendFileSync(modulePath, '\ntampered');
            if (['missing', 'changed-hash', 'tampered-body', 'tampered-materialized'].includes(change)) {
              await assert.rejects(sidecar.runUnitSidecar(probe), error => /^procedure-/.test(error.code), input + '/' + change);
              assert.strictEqual(entered, previous, 'invalid corpus/body stops before transport');
            } else {
              await sidecar.runUnitSidecar(probe);
              assert.strictEqual(entered, previous + 1);
              assert(sent.includes(procedure.content));
              for (const module of procedure.modules) assert.strictEqual(sent.split(`<!-- forge-procedure:${module.id} -->`).length - 1, 1);
              assert(!sent.startsWith('---'), 'materialized metadata removed');
            }
          } finally { fs.writeFileSync(modulePath, bytes); }
        }
      }
      console.log('R8 artifact/plan boundary: physical corpus, missing/hash/body failures and fresh single composition passed');
    } finally { xllm.invokeClaudeTransport = originalClaude; xllm.runPlan = runPlan; }

    // Plan publication creates the exact source consumed by discovery/execution.
    const planning = { ...request, unitType: 'plan-slice', phase: 'plan', taskId: undefined, execution_contract: undefined,
      promptFile: request.planFile, dispatchId: 'plan', resultFile: path.join(lab.dir, 'p.json') };
    xllm.runPlan = async () => ({ status: 'done', slice_plan: { content: '# Slice\n- [ ] **T02** — fixture\n' },
      task_plans: [{ id: 'T02', content: fixtures.plan(lab.contract) }] });
    await sidecar.runUnitSidecar(resolveContext(planning));
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
    assert.strictEqual(calls, 0, 'a reserved handoff cannot open another writer');
    assert.strictEqual(JSON.parse(fs.readFileSync(stateFile)).reservations.length, 1);
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
async function deliveryPublicationLimits() {
  const fs = require('fs'), os = require('os'), path = require('path');
  const delivery = require('./forge-delivery');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sidecar-delivery-size-')));
  try {
    const owner = path.join(root, 'owner'), code = path.join(root, 'code');
    fs.mkdirSync(owner); fs.mkdirSync(code);
    const request = { unitType: 'complete-milestone', milestoneId: 'M001', cwd: code, contextRoot: owner,
      workflowId: 'size-fixture', dispatchId: 'size-fixture', resultFile: path.join(root, 'result.json') };
    const loc = sidecar.locations(request), unit = { type: 'milestone', id: 'M001' };
    const plan = '# Milestone acceptance\n';
    fs.writeFileSync(path.join(owner, 'plan.md'), plan);
    // Build real canonical output rather than inflating an unvalidated JSON stub.
    const input = { schema_version: 1, unit, plan: 'plan.md', plan_fingerprint: delivery.sha256(plan),
      bindings: [], expected_children: [], additional_criteria: Array.from({ length: 425 }, (_, i) => ({
        id: `criterion-${i}`, text: `Observable acceptance ${i}: ${'evidence '.repeat(100)}`,
        reference: `acceptance#${i}`, type: 'functional',
      })) };
    const output = delivery.buildDelivery(input, { ownerRoot: owner, codeDir: code });
    assert.strictEqual(output.criteria.length, 425);
    const content = JSON.stringify(output, null, 2) + '\n';
    assert(Buffer.byteLength(content) > sidecar.MAX_ARTIFACT_BYTES);
    assert(Buffer.byteLength(content) < delivery.MAX_FILE_BYTES);
    const payload = { status: 'done', summary: 'Complete inventory', questions: [], artifacts: [
      { path: loc.required[0], content: '# Summary\n' },
      { path: loc.delivery.input, content: JSON.stringify(input) },
      { path: loc.delivery.output, content },
    ] };
    const inspectPayload = (value, max = Infinity) => sidecar.inspectArtifacts(value, loc.allowed, loc.required, max, loc.rules);
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    sidecar.beginArtifactAttempt(request);
    await assert.rejects(sidecar.acceptArtifactResult(request, payload, { providerCalled: true, maxPayloadBytes: bytes - 1 }),
      error => error.code === 'invalid-artifact-result' && error.message === 'payload-limit');
    assert(!fs.existsSync(path.join(owner, loc.delivery.output)), 'total cap refuses publication');
    const calibration = require('./forge-sidecar-calibration');
    const calibrationIdentity = { model: 'claude-fixture', effort: 'high', phase: 'artifacts' };
    const proposal = calibration.propose(calibrationIdentity, { initial_sample_ms: 100, gap_sample_ms: 200 });
    const commit = calibration.commit;
    let commitCalls = 0, accepted;
    calibration.commit = () => { commitCalls++; return { committed: false, diagnostic: 'calibration-busy' }; };
    try {
      accepted = await sidecar.acceptArtifactResult(request, payload, { providerCalled: true, maxPayloadBytes: bytes,
        telemetry: { calibration_proposal: proposal, observation: { phase: 'closed', input_tokens: 42, raw: 'private-text' } } });
    } finally { calibration.commit = commit; }
    assert.equal(accepted.result.transport_telemetry.observation.input_tokens, 42);
    assert(!JSON.stringify(accepted.result.transport_telemetry.observation).includes('private-text'));
    assert.equal(accepted.result.transport_telemetry.calibration_commit.diagnostic, 'calibration-busy');
    assert.equal(commitCalls, 3, 'accepted proposals get bounded automatic persistence retries');
    assert.equal(JSON.parse(fs.readFileSync(request.resultFile)).transport_telemetry.observation.input_tokens, 42);
    const firstReceipt = JSON.parse(fs.readFileSync(request.resultFile + '.receipt.json'));
    assert.deepEqual(firstReceipt.calibration_proposal, proposal, 'trusted proposal is durable before replay');
    assert.equal(calibration.read(calibrationIdentity).initial.count, 0);
    const replay = await sidecar.acceptArtifactResult(request, payload, { providerCalled: true,
      telemetry: { calibration_proposal: calibration.propose(calibrationIdentity, { initial_sample_ms: 999, gap_sample_ms: 999 }) } });
    assert.equal(replay.replayed, true);
    assert.equal(replay.result.transport_telemetry.observation.input_tokens, 42);
    assert.equal(replay.result.transport_telemetry.calibration_commit.committed, true);
    assert.equal(calibration.read(calibrationIdentity).initial.count, 1, 'same persisted proposal cannot learn twice');
    assert.deepEqual(JSON.parse(fs.readFileSync(request.resultFile + '.receipt.json')).calibration_proposal, proposal);
    assert.equal(inspectPayload({ ...payload, calibration_proposal: proposal }).reason, 'schema-invalid');
    assert.strictEqual(fs.readFileSync(path.join(owner, loc.delivery.output), 'utf8'), content);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(owner, loc.delivery.output))).criteria.length, 425);
    assert.strictEqual(JSON.parse(fs.readFileSync(request.resultFile + '.receipt.json')).phase, 'ready');
    const replace = (artifactPath, artifactContent) => ({ ...payload, artifacts: payload.artifacts.map(row =>
      row.path === artifactPath ? { ...row, content: artifactContent } : row) });
    const oversized = 'x'.repeat(sidecar.MAX_ARTIFACT_BYTES + 1);
    assert.strictEqual(inspectPayload(replace(loc.required[0], oversized)).reason, 'artifact-limit');
    assert.strictEqual(inspectPayload(replace(loc.required[0], content)).reason, 'artifact-limit', 'JSON cannot spoof a generic path');
    assert.strictEqual(inspectPayload(replace(loc.delivery.input, JSON.stringify({ ...input, padding: oversized }))).reason, 'artifact-limit');
    assert.strictEqual(inspectPayload(replace(loc.delivery.input, content)).reason, 'delivery-artifact-invalid');
    for (const kind of ['verification', 'artifact']) {
      const envelope = { schema_version: 1, unit, kind: kind === 'verification' ? kind : 'artifact', plan_fingerprint: input.plan_fingerprint,
        code_dir: code, revision: 'fixture', environment: 'node', captured_at: '2026-10-20T00:00:00Z', result: {}, padding: oversized };
      const value = { ...payload, artifacts: [...payload.artifacts, { path: loc.delivery[kind], content: JSON.stringify(envelope) }] };
      assert.strictEqual(inspectPayload(value).reason, 'artifact-limit');
    }
    // Valid JSON whitespace exercises the exact UTF-8 byte boundary without changing the contract.
    const atCap = content + ' '.repeat(delivery.MAX_FILE_BYTES - Buffer.byteLength(content));
    assert(inspectPayload(replace(loc.delivery.output, atCap)).ok);
    assert.strictEqual(inspectPayload(replace(loc.delivery.output, atCap + ' ')).reason, 'artifact-limit');
    for (const invalid of ['{', JSON.stringify({ ...output, generated_by: 'spoof' }),
      JSON.stringify({ ...output, schema_version: 2 }), JSON.stringify({ ...output, criteria: {} }),
      JSON.stringify({ ...output, unit: { type: 'milestone', id: 'M999' } })]) {
      assert.strictEqual(inspectPayload(replace(loc.delivery.output, invalid)).reason, 'delivery-artifact-invalid');
    }
    const wrongPath = { ...payload, artifacts: payload.artifacts.map(row => row.path === loc.delivery.output
      ? { ...row, path: '.gsd/milestones/M999/M999-DELIVERY.json' } : row) };
    assert.strictEqual(inspectPayload(wrongPath).reason, 'artifact-path-invalid');
    assert.strictEqual(inspectPayload({ ...payload, artifacts: [...payload.artifacts, payload.artifacts[2]] }).reason, 'artifact-duplicate');
    assert.strictEqual(inspectPayload({ ...payload, artifacts: Array(33).fill(payload.artifacts[2]) }).reason, 'artifact-limit');
    assert(inspectPayload(payload, bytes).ok);
    assert.strictEqual(inspectPayload(payload, bytes - 1).reason, 'payload-limit');
    assert.strictEqual(inspectPayload(payload, sidecar.MAX_ARTIFACT_PAYLOAD_BYTES).reason, 'payload-limit');
    console.log(`PASS complete-milestone publication: 425 canonical criteria, ${Buffer.byteLength(content)} DELIVERY bytes; generic/input/envelope, reader cap, spoof/schema/path/count/duplicate and total payload limits`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
// The owner turns a worker no-progress transition into one closed
// sidecar-no-progress line per episode, through its own event channel.
async function noProgressEventContracts() {
  const fs = require('fs'), path = require('path'), crypto = require('crypto');
  const fixtures = require('./forge-code-roots.test'), xllm = require('./forge-xllm'), runs = require('./forge-runs');
  const runExecute = xllm.runExecute;
  const SENTINEL = 'T05_PRIVATE_TOOL_ARGUMENT_SENTINEL_4e7a';
  const FINGERPRINT = 'a1b2c3d4e5f60718';
  const EVENT_KEYS = ['dispatch_id', 'event', 'fingerprint_sha256', 'model', 'repeats', 'ts', 'unit', 'worker_engine', 'workflow_id'];
  const loop = (fingerprint = FINGERPRINT) => ({ from: 'working', to: 'slow-suspect', at_ms: 1000, reason: 'no-progress',
    detail: SENTINEL, progress: { repeats: 5, fingerprint_sha256: fingerprint, command: `echo ${SENTINEL}` } });
  const repeated = { ...loop(), from: 'slow-suspect' };
  const toolUnproven = { from: 'slow-suspect', to: 'slow-suspect', at_ms: 2000, reason: 'tool-unproven' };
  const proofUnavailable = { from: 'slow-suspect', to: 'slow-suspect', at_ms: 3000, reason: 'proof-unavailable' };
  const working = { from: 'slow-suspect', to: 'working', at_ms: 1500, reason: null };
  const route = { host_runtime: 'codex', worker_engine: 'claude', resolved_worker_engine: 'claude', worker_mode: 'sidecar', sidecar_declared: true,
    dispatch_reason_code: 'sidecar-declared', dispatch_posture: 'cross-engine', dispatch_decision: 'allow',
    dispatch_allowed: true, model: 'claude-sonnet-5', model_resolved: 'claude-sonnet-5', effort: 'medium', tier: 'standard',
    chain: [{ id: 'claude-sonnet-5', engine: 'claude' }] };
  // One temporary owner + two code roots per case: each case is a fresh unit.
  async function runCase(id, transitions, hooks = {}) {
    const lab = fixtures.fixture();
    try {
      const request = { unitType: 'execute-task', scope: 'milestone', phase: 'execute', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01',
        cwd: lab.a, contextRoot: lab.owner, execution_contract: lab.contract, route,
        workflowId: 'no-progress-fixture', dispatchId: id, resultFile: path.join(lab.dir, `${id}.json`), prompt: 'Fixture only.',
        verification: { preferenceCommands: ['node -e "process.exit(0)"'] } };
      const base = path.join(lab.owner, '.gsd/milestones/M001/slices/S01');
      fs.mkdirSync(path.join(base, 'tasks/T01'), { recursive: true });
      request.planFile = path.join(base, 'tasks/T01/T01-PLAN.md');
      fs.writeFileSync(request.planFile, fixtures.plan(lab.contract));
      fs.writeFileSync(path.join(base, 'S01-PLAN.md'), '# Slice\n- [ ] **T01** — fixture\n');
      fs.writeFileSync(path.join(lab.owner, '.gsd/forge-prefs.jsonc'), JSON.stringify({ tier_models: Object.fromEntries(
        ['light', 'standard', 'heavy', 'max'].map(tier => [tier, ['claude-sonnet-5']])), effort: { 'plan-slice': 'medium' } }));
      resolveContext(request);
      request.runId = `no-progress-${id}`;
      request.claim = { schema_version: 2, generation: crypto.randomUUID(), execution_contract: lab.contract,
        paths: ['alpha', 'beta'].map(root_id => ({ root_id, path: 'same.txt' })) };
      request.gates = { plan: 'skipped', planSkipReason: 'interactive-off', claim: 'proceed', security: 'not-applicable' };
      runs.add(lab.owner, { id: request.runId, kind: 'milestone', session_id: 'fixture', write_claim: request.claim });
      let seen = null;
      xllm.runExecute = async options => {
        seen = options;
        hooks.beforeTransitions?.(lab);
        for (const transition of transitions) {
          options.onLiveness(transition);
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        await hooks.afterTransitions?.(lab);
        fs.writeFileSync(path.join(lab.a, 'same.txt'), 'worker alpha\n');
        fs.writeFileSync(path.join(lab.b, 'same.txt'), 'worker beta\n');
        return { status: 'done', summary: 'Synthetic loop fixture', files_changed: ['alpha::same.txt', 'beta::same.txt'], must_haves_status: [] };
      };
      const result = await sidecar.runUnitSidecar(request);
      const eventsText = fs.readFileSync(path.join(lab.owner, '.gsd/forge/events.jsonl'), 'utf8');
      const events = eventsText.split('\n').filter(Boolean).map(line => JSON.parse(line));
      return { result, seen, eventsText, events, loops: events.filter(row => row.event === 'sidecar-no-progress'),
        unitEvents: events.filter(row => row.event === 'sidecar-unit'), request };
    } finally { xllm.runExecute = runExecute; lab.cleanup(); }
  }
  const base = await runCase('baseline', []);
  assert.strictEqual(base.result.status, 'done', JSON.stringify(base.result));
  assert.strictEqual(base.loops.length, 0);
  const terminalStatus = base.unitEvents[base.unitEvents.length - 1].status;

  // (a) two consecutive no-progress transitions are one episode; other reasons add nothing.
  const once = await runCase('episode-once', [loop(), repeated, toolUnproven, proofUnavailable]);
  assert.strictEqual(once.result.status, base.result.status);
  assert.strictEqual(once.loops.length, 1, once.eventsText);
  const line = once.loops[0];
  assert.deepStrictEqual(Object.keys(line).sort(), EVENT_KEYS);
  assert.strictEqual(line.repeats, 5);
  assert.strictEqual(line.fingerprint_sha256, FINGERPRINT);
  assert.strictEqual(line.dispatch_id, 'episode-once');
  assert.strictEqual(line.workflow_id, 'no-progress-fixture');
  assert.strictEqual(line.worker_engine, 'claude');
  assert.strictEqual(line.model, 'claude-sonnet-5');
  assert.strictEqual(line.unit, once.unitEvents[0].unit);
  assert(!once.eventsText.includes(SENTINEL), 'no tool argument, detail or prompt text reaches events.jsonl');
  assert(!JSON.stringify(line).includes(SENTINEL));
  // Ordered before the terminal owner event of the unit.
  const indexOf = row => once.events.indexOf(row);
  assert(indexOf(line) > indexOf(once.unitEvents[0]) && indexOf(line) < indexOf(once.unitEvents[once.unitEvents.length - 1]));
  assert.strictEqual(once.unitEvents[once.unitEvents.length - 1].status, terminalStatus);
  // The owner's result/receipt channel is excluded from local proof.
  const resultFile = once.seen.resultFile;
  assert.strictEqual(path.basename(resultFile), 'episode-once.json');
  assert(once.seen.localProofIgnore.includes(resultFile), JSON.stringify(once.seen.localProofIgnore));
  assert(once.seen.localProofIgnore.includes(`${resultFile}.receipt.json`), JSON.stringify(once.seen.localProofIgnore));
  assert.strictEqual(typeof once.seen.onLiveness, 'function');

  // (b) leaving the episode reopens it; an invalid fingerprint is omitted, never echoed.
  const twice = await runCase('episode-reopened', [loop(), working, loop(`NOT-HEX ${SENTINEL}`)]);
  assert.strictEqual(twice.result.status, base.result.status);
  assert.strictEqual(twice.loops.length, 2, twice.eventsText);
  assert.strictEqual(twice.loops[0].fingerprint_sha256, FINGERPRINT);
  assert.deepStrictEqual(Object.keys(twice.loops[1]).sort(), EVENT_KEYS.filter(key => key !== 'fingerprint_sha256'));
  assert(!twice.eventsText.includes(SENTINEL));

  // Other reasons never open an episode.
  const none = await runCase('other-reasons', [toolUnproven, proofUnavailable,
    { from: 'working', to: 'slow-suspect', at_ms: 4000, reason: 'silence' }]);
  assert.strictEqual(none.result.status, base.result.status);
  assert.strictEqual(none.loops.length, 0, none.eventsText);

  // (c) a failed append is best-effort: the unit result is unchanged.
  const foreign = lab => path.join(lab.owner, '.gsd/foreign-during-loop.json');
  const failed = await runCase('append-fails', [loop()], {
    beforeTransitions: lab => fs.writeFileSync(foreign(lab), '{}'),
    afterTransitions: async lab => { await new Promise(resolve => setTimeout(resolve, 20)); fs.unlinkSync(foreign(lab)); },
  });
  assert.strictEqual(failed.result.status, base.result.status, JSON.stringify(failed.result));
  assert.strictEqual(failed.loops.length, 0, 'a refused owner append writes nothing');
  assert.strictEqual(failed.unitEvents[failed.unitEvents.length - 1].status, terminalStatus);
  console.log('PASS sidecar-no-progress: one closed owner event per episode, reopened after exit, other reasons ignored, best-effort append, result/receipt excluded from local proof');
}
// R1/R2: the owner's authenticated no-progress append is reconciled into the
// preparation surface (no broker) and into the shared write-contract validation
// (owner == code root, events.jsonl tracked), while unrelated edits still fail.
async function ownerEventReconcileContracts() {
  const fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
  const fixtures = require('./forge-code-roots.test'), runs = require('./forge-runs'), roots = require('./forge-code-roots');
  const FINGERPRINT = 'a1b2c3d4e5f60718';
  const loop = { from: 'working', to: 'slow-suspect', at_ms: 1000, reason: 'no-progress',
    progress: { repeats: 5, fingerprint_sha256: FINGERPRINT } };
  const moduleKeys = () => Object.keys(require.cache).filter(key => /forge-(xllm|unit-sidecar|claude-sidecar|task-preparation)\.js$/.test(key));
  const saved = moduleKeys().map(key => [key, require.cache[key]]);
  for (const [key] of saved) delete require.cache[key];
  const claude = require('./forge-claude-sidecar');
  const realInvoke = claude.invokeClaudeSidecar;
  let adapter = null;
  claude.invokeClaudeSidecar = options => adapter(options);
  const fresh = require('./forge-unit-sidecar');
  const prep = require('./forge-task-preparation');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const route = { host_runtime: 'codex', worker_engine: 'claude', resolved_worker_engine: 'claude', worker_mode: 'sidecar', sidecar_declared: true,
    dispatch_reason_code: 'sidecar-declared', dispatch_posture: 'cross-engine', dispatch_decision: 'allow',
    dispatch_allowed: true, model: 'claude-sonnet-5', model_resolved: 'claude-sonnet-5', effort: 'medium', tier: 'standard',
    chain: [{ id: 'claude-sonnet-5', engine: 'claude' }] };
  try {
    // R2 - complete sidecar -> runExecute -> adapter path with owner == code root.
    async function runOwnerCase(id, extraWorkerWrite) {
      const lab = fixtures.fixture();
      try {
        const contract = roots.validateContract({ schema_version: 2, owner: lab.a, primary_root_id: 'alpha',
          code_roots: [{ id: 'alpha', path: lab.a }, { id: 'beta', path: lab.b }] });
        fs.mkdirSync(path.join(lab.a, '.gsd/forge'), { recursive: true });
        fs.writeFileSync(path.join(lab.a, '.gsd/forge/events.jsonl'), '{"event":"seed"}\n');
        fixtures.command('git', ['add', '-f', '.gsd/forge/events.jsonl'], lab.a);
        fixtures.command('git', ['commit', '-qm', 'track events'], lab.a);
        const request = { unitType: 'execute-task', scope: 'milestone', phase: 'execute', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01',
          cwd: lab.a, contextRoot: lab.a, execution_contract: contract, route,
          workflowId: 'owner-event-fixture', dispatchId: id, resultFile: path.join(lab.dir, id + '.json'), prompt: 'Fixture only.',
          verification: { preferenceCommands: ['node -e "process.exit(0)"'] } };
        const base = path.join(lab.a, '.gsd/milestones/M001/slices/S01');
        fs.mkdirSync(path.join(base, 'tasks/T01'), { recursive: true });
        request.planFile = path.join(base, 'tasks/T01/T01-PLAN.md');
        fs.writeFileSync(request.planFile, fixtures.plan(contract));
        fs.writeFileSync(path.join(base, 'S01-PLAN.md'), '# Slice\n- [ ] **T01** — fixture\n');
        fs.writeFileSync(path.join(lab.a, '.gsd/forge-prefs.jsonc'), JSON.stringify({ tier_models: Object.fromEntries(
          ['light', 'standard', 'heavy', 'max'].map(tier => [tier, ['claude-sonnet-5']])), effort: { 'plan-slice': 'medium' } }));
        request.route = require('./forge-dispatch-resolve').resolveDispatch({ cwd: lab.a, unitType: request.unitType,
          milestoneId: 'M001', unitId: 'T01', planPath: request.planFile, hostRuntime: 'codex' });
        request.runId = 'owner-event-' + id;
        request.claim = { schema_version: 2, generation: crypto.randomUUID(), execution_contract: contract,
          paths: ['alpha', 'beta'].map(root_id => ({ root_id, path: 'same.txt' })) };
        request.gates = { plan: 'skipped', planSkipReason: 'interactive-off', claim: 'proceed', security: 'not-applicable' };
        runs.add(lab.a, { id: request.runId, kind: 'milestone', session_id: 'fixture', write_claim: request.claim });
        adapter = async options => {
          options.onLiveness(loop);
          await sleep(40);
          fs.writeFileSync(path.join(lab.a, 'same.txt'), 'worker alpha\n');
          fs.writeFileSync(path.join(lab.b, 'same.txt'), 'worker beta\n');
          if (extraWorkerWrite) fs.appendFileSync(path.join(lab.a, '.gsd/forge/events.jsonl'), '{"event":"forged"}\n');
          return { candidate: { status: 'done', summary: 'Synthetic loop fixture', files_changed: ['alpha::same.txt', 'beta::same.txt'], must_haves_status: [] }, telemetry: null };
        };
        let outcome;
        try { outcome = { result: await fresh.runUnitSidecar(request) }; } catch (error) { outcome = { error }; }
        outcome.events = fs.readFileSync(path.join(lab.a, '.gsd/forge/events.jsonl'), 'utf8');
        return outcome;
      } finally { lab.cleanup(); }
    }
    const ok = await runOwnerCase('owner-event-ok', false);
    assert(!ok.error, ok.error && ok.error.stack);
    assert.strictEqual(ok.result.status, 'done', JSON.stringify(ok.result));
    assert.strictEqual(ok.events.split('\n').filter(line => line.includes('"sidecar-no-progress"')).length, 1, ok.events);
    const forged = await runOwnerCase('owner-event-forged', true);
    assert(forged.error || forged.result.status !== 'done', 'an arbitrary events.jsonl edit is still rejected');

    // R1 - standalone preparation without an owner broker publishes after no-progress.
    const stage = destination => {
      const source = path.resolve(__dirname, '..');
      const manifest = JSON.parse(fs.readFileSync(path.join(source, 'shared/forge-procedures.json'), 'utf8'));
      fs.mkdirSync(path.join(destination, 'shared'), { recursive: true });
      fs.copyFileSync(path.join(source, 'shared/forge-procedures.json'), path.join(destination, 'shared/forge-procedures.json'));
      for (const module of manifest.modules.filter(item => item.status === 'ready')) fs.copyFileSync(path.join(source, module.path), path.join(destination, module.path));
    };
    const caseRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-owner-event-prep-')));
    try {
      const cwd = path.join(caseRoot, 'code'), contextRoot = path.join(caseRoot, 'owner'), results = path.join(caseRoot, 'results');
      fs.mkdirSync(cwd, { recursive: true }); stage(cwd);
      fixtures.command('git', ['init', '-q'], cwd);
      fixtures.command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], cwd);
      fs.mkdirSync(path.join(contextRoot, '.gsd'), { recursive: true }); fs.mkdirSync(results);
      fs.writeFileSync(path.join(contextRoot, '.gsd/forge-prefs.jsonc'), JSON.stringify({
        tier_models: { light: 'claude-sonnet-5', standard: 'claude-sonnet-5', heavy: 'claude-sonnet-5', max: 'claude-sonnet-5' },
        effort: { 'plan-slice': 'medium', 'discuss-milestone': 'medium', 'research-milestone': 'medium', 'plan-milestone': 'medium' } }));
      const request = { schema_version: 1, scope: 'standalone-task', phase: 'research', taskId: 'T-20261023000000-ownerevent',
        cwd, contextRoot, hostRuntime: 'codex', workflowId: 'prep-owner-event', dispatchId: 'prep-owner-event',
        resultFile: path.join(results, 'result.json'), constraints: { auto_commit: false, deploy: false }, inputs: { brief: 'Fixture' } };
      const body = "# Research\n\n## Summary\n\nMeasured internally.\n\n## Don't Hand-Roll\n\nReuse resolver.\n\n## Relevant Code\n\nscripts/.\n";
      adapter = async options => {
        options.onLiveness(loop);
        await sleep(40);
        return { candidate: { status: 'done', summary: 'research complete', questions: [],
          artifacts: [{ path: prep.requiredArtifact(request), content: body }] }, telemetry: null };
      };
      const outcome = await prep.prepareStandaloneTask(request);
      assert.strictEqual(outcome.ok, true, JSON.stringify(outcome));
      const events = fs.readFileSync(path.join(contextRoot, '.gsd/forge/events.jsonl'), 'utf8');
      assert.strictEqual(events.split('\n').filter(line => line.includes('"sidecar-no-progress"')).length, 1, events);
      assert(fs.existsSync(path.join(contextRoot, prep.requiredArtifact(request))));
    } finally { fs.rmSync(caseRoot, { recursive: true, force: true }); }
    console.log('PASS owner-event reconcile: preparation without broker publishes after no-progress; owner==code-root real transport succeeds; forged events edit still rejected');
  } finally {
    claude.invokeClaudeSidecar = realInvoke;
    for (const key of moduleKeys()) delete require.cache[key];
    for (const [key, entry] of saved) require.cache[key] = entry;
  }
}
// The transport receives the safety ceiling resolved from the route, never a fixed 300.
async function ceilingRouteContracts() {
  const fs = require('fs'), path = require('path'), crypto = require('crypto');
  const fixtures = require('./forge-code-roots.test'), xllm = require('./forge-xllm'), runs = require('./forge-runs');
  const runExecute = xllm.runExecute;
  async function timeoutFor(id, shape) {
    const lab = fixtures.fixture();
    try {
      const request = { unitType: 'execute-task', scope: 'milestone', phase: 'execute', milestoneId: 'M001', sliceId: 'S01', taskId: 'T01',
        cwd: lab.a, contextRoot: lab.owner, execution_contract: lab.contract, workflowId: 'ceiling-fixture', dispatchId: id,
        resultFile: path.join(lab.dir, `${id}.json`), prompt: 'Fixture only.', verification: { preferenceCommands: ['node -e "process.exit(0)"'] } };
      const base = path.join(lab.owner, '.gsd/milestones/M001/slices/S01');
      fs.mkdirSync(path.join(base, 'tasks/T01'), { recursive: true });
      request.planFile = path.join(base, 'tasks/T01/T01-PLAN.md');
      fs.writeFileSync(request.planFile, fixtures.plan(lab.contract).replace('tier: standard', `tier: ${shape.tier || 'standard'}`));
      fs.writeFileSync(path.join(base, 'S01-PLAN.md'), '# Slice\n- [ ] **T01** — fixture\n');
      fs.writeFileSync(path.join(lab.owner, '.gsd/forge-prefs.jsonc'), JSON.stringify({ tier_models: Object.fromEntries(
        ['light', 'standard', 'heavy', 'max'].map(tier => [tier, ['claude-sonnet-5']])), effort: { 'plan-slice': 'medium' } }));
      resolveContext(request);
      const route = { ...request.route };
      delete route.workers_timeout; delete route.workers_timeout_source; delete route.workers_timeout_warning;
      request.route = { ...route, ...shape };
      request.runId = `ceiling-${id}`;
      request.claim = { schema_version: 2, generation: crypto.randomUUID(), execution_contract: lab.contract,
        paths: ['alpha', 'beta'].map(root_id => ({ root_id, path: 'same.txt' })) };
      request.gates = { plan: 'skipped', planSkipReason: 'interactive-off', claim: 'proceed', security: 'not-applicable' };
      runs.add(lab.owner, { id: request.runId, kind: 'milestone', session_id: 'fixture', write_claim: request.claim });
      let seen = null;
      xllm.runExecute = async options => {
        seen = options.timeoutSecs;
        fs.writeFileSync(path.join(lab.a, 'same.txt'), 'worker alpha\n');
        fs.writeFileSync(path.join(lab.b, 'same.txt'), 'worker beta\n');
        return { status: 'done', summary: 'Ceiling fixture', files_changed: ['alpha::same.txt', 'beta::same.txt'], must_haves_status: [] };
      };
      await sidecar.runUnitSidecar(request);
      return seen;
    } finally { xllm.runExecute = runExecute; lab.cleanup(); }
  }
  assert.strictEqual(await timeoutFor('standard-no-source', { tier: 'standard' }), 1800);
  assert.strictEqual(await timeoutFor('explicit-42', { workers_timeout: 42, workers_timeout_source: 'explicit' }), 42);
  assert.strictEqual(await timeoutFor('legacy-heavy-300', { tier: 'heavy', workers_timeout: 300 }), 3600);
  console.log('PASS ceiling route: transport timeoutSecs = ceilingFromRoute (standard 1800, explicit 42, legacy heavy 300 → 3600)');
}
async function runScenarios() {
  const fs = require('fs'), path = require('path'), os = require('os');
  const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-unit-profile-'))), previous = {};
  for (const key of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'FORGE_HOME']) previous[key] = process.env[key];
  process.env.HOME = process.env.USERPROFILE = profile;
  process.env.CODEX_HOME = path.join(profile, '.codex'); process.env.CLAUDE_CONFIG_DIR = path.join(profile, '.claude');
  process.env.FORGE_HOME = path.resolve(__dirname, '..');
  try {
    if (!selectedScenario || selectedScenario === '--delivery-publication-limits') await deliveryPublicationLimits();
    if (!selectedScenario || selectedScenario === '--recovery-contracts') await recoveryContracts();
    if (!selectedScenario || selectedScenario === '--pre-spawn-sidecar') await preSpawnRecoveryContracts();
    if (!selectedScenario || selectedScenario === '--pre-spawn-native') await preSpawnRecoveryContracts(true);
    if (!selectedScenario || selectedScenario === '--no-progress-event') await noProgressEventContracts();
    if (!selectedScenario || selectedScenario === '--owner-event-reconcile') await ownerEventReconcileContracts();
    if (!selectedScenario || selectedScenario === '--ceiling-route') await ceilingRouteContracts();
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
runScenarios().catch(error => { console.error(error); process.exitCode = 1; });
